# NanoClaw is not responding — troubleshooting runbook

For: this server (Hetzner, `ubuntu-4gb-nbg1-1`), install at `~/nanoclaw-v2`,
service `nanoclaw-v2-a84d1e4b`. A second install (harvey's, `/home/harvey/nanoclaw`)
runs on the same machine and **shares the same root disk**.

Work top to bottom. Each step says what you're looking for and what to do if you find it.

---

## 0. Getting onto the machine

**If VS Code Remote won't connect, use a plain terminal:**

```bash
ssh amit@<server-ip>
```

Plain SSH needs almost nothing from the server. VS Code Remote has to start
its server under `~/.vscode-server` and write files there. **If the disk is full,
VS Code fails to connect but plain SSH still works.** That gap is itself a clue:
check the disk first (step 2).

If plain SSH also fails, go to the Hetzner console → server → **Console** (the
browser-based terminal) and log in there.

### Why the Hetzner graphs can look fine during an outage

The Hetzner graphs show CPU, disk **throughput/IOPS**, and network. None of them shows
**how full the disk is** or **whether a process is running**. A full disk or a host
that is crash-looping can look completely calm on every graph. Don't treat
"graphs look fine" as "the machine is fine".

---

## 1. Is the service running?

```bash
systemctl --user status nanoclaw-v2-a84d1e4b --no-pager -n 20
```

Look for:

| What you see | Meaning | Go to |
|---|---|---|
| `active (running)` with a recent "since" time and `restart counter is at N` | It's been crashing and restarting | Step 3 (logs) to see why |
| `active (running)` for a long time | Process is up; the problem is elsewhere | Step 3 |
| `failed` / `inactive` | Not running | Step 3, then step 5 to start it |

**Important:** "active (running)" does **not** mean it's working. After repeated
crashes the host deliberately waits up to **15 minutes** before starting (step 4).
During that wait the process is alive but does nothing.

---

## 2. Is the disk full? (check this early — it's cheap and common)

```bash
df -h /
```

- **Use% above ~95%** → this is very likely the problem. Go to [Disk full](#disk-full).
- Also check the volume that holds `groups/` and `data/`:
  ```bash
  df -h /mnt/HC_Volume_105707857
  ```

Memory too, while you're here:

```bash
free -h
```

---

## 3. Read the logs

Errors first (short, and the most useful file):

```bash
tail -n 60 ~/nanoclaw-v2/logs/nanoclaw.error.log
```

Full log, live:

```bash
tail -f ~/nanoclaw-v2/logs/nanoclaw.log
```

systemd's view (crashes, restarts):

```bash
journalctl --user -u nanoclaw-v2-a84d1e4b --no-pager -n 50
```

### What common lines mean

| Log line | Meaning | Action |
|---|---|---|
| `ENOSPC: no space left on device` | Disk full | [Disk full](#disk-full) |
| `Circuit breaker: delaying startup due to repeated crashes ... resumeAt=...` | Host crashed several times and is now waiting before it starts | Fix the cause, then [step 4](#4-the-startup-delay-circuit-breaker) |
| `Previous startup was not a clean shutdown` | Previous run crashed | Look **above** this line for the actual error |
| `Unhandled rejection` / a stack trace right before a restart | The crash itself | Read the `message:` field — that's the cause |
| WhatsApp `401` / `logged out` | WhatsApp session expired (~every 2 weeks) | [whatsapp-relink.md](whatsapp-relink.md) |
| `WhatsApp QR code — scan with WhatsApp` repeating every 20s, and nothing else | WhatsApp lost its login, **and startup is stuck waiting for it**, so no channel works | [Up but nothing responds](#up-but-nothing-responds-on-any-channel) |
| `Telegram polling request failed ... NetworkError` | Brief network blip | Usually ignore; only a problem if it repeats nonstop |
| `A pong wasn't received` (Slack) | Brief network blip | Usually ignore |
| `Killing container past absolute ceiling` | An agent container went 30 min without a heartbeat and was stopped | Normal housekeeping, not an outage. Ignore unless one agent stops answering |
| `Failed to stop session ... session realization failed` | A container didn't shut down cleanly | Check `docker ps` (step 6) for leftovers |

---

## 4. The startup delay (circuit breaker)

After repeated crashes within an hour, the host waits before starting:
0s, 0s, 10s, 30s, 2min, 5min, then **15min** for every crash after that. The state lives
in `~/nanoclaw-v2/data/circuit-breaker.json`.

Once you've **fixed the cause** (e.g. freed disk space), skip the wait:

```bash
rm ~/nanoclaw-v2/data/circuit-breaker.json
systemctl --user restart nanoclaw-v2-a84d1e4b
```

If you haven't fixed the cause, don't bother: it will crash again and the delay returns.

---

## 5. Restart and confirm it's healthy

```bash
systemctl --user restart nanoclaw-v2-a84d1e4b
tail -f ~/nanoclaw-v2/logs/nanoclaw.log
```

Healthy looks like: channel adapters connecting (WhatsApp, Telegram, Slack), no
repeated errors, and no new `restart counter` in `systemctl status` a few minutes later.
Then send your agent a test message.

---

## 6. Agent containers

Each conversation runs in its own Docker container named `ncl-a84d1e4b-sess-...`.

```bash
docker ps -s
```

- **SIZE column**: how much the container has written inside itself. Anything in the
  GBs is suspicious (see Disk full).
- Containers that are hours old when they should come and go are likely stuck.
  Stop one with `docker stop <name>`.

If one specific agent doesn't answer but others do, the problem is that agent's
session, not the host. See `/debug` in Claude Code.

---

## Up but nothing responds on any channel

Signs:
- `systemctl status` says `active (running)` and there's plenty of disk space.
- **No** channel replies (WhatsApp *and* Slack/Telegram).
- Your phone may still list NanoClaw under WhatsApp → Linked Devices. That doesn't prove
  the server still has a working login.

### Why it happens

At startup NanoClaw brings up its channels **one at a time**, and the WhatsApp step waits until
WhatsApp is logged in. If WhatsApp has no working login, it shows a QR code and waits for a scan
indefinitely. Slack, Telegram, and everything after it never start. One broken channel takes
down all of them.

### Check: is startup stuck on WhatsApp?

The log file has times but no dates, and it may end in blank padding, so plain `tail` can
mislead you. Show everything since the last startup, without the QR-code noise:

```bash
cd ~/nanoclaw-v2
N=$(grep -n 'NanoClaw starting' logs/nanoclaw.log | tail -1 | cut -d: -f1)
sed -n "${N},\$p" logs/nanoclaw.log | sed 's/\x1b\[[0-9;]*m//g' | tr -d '\000' \
  | grep '^\[' | grep -vE 'QR code|connection closed|Reconnecting|Fetched WA' | head -40
```

- **Stuck:** the output ends at `Channel adapter started channel="cli"`, and there's no
  `channel="whatsapp"`, `"slack"`, or `"telegram"` after it. Meanwhile the full log is
  repeating `WhatsApp QR code`.
- **Healthy:** you see `Channel adapter started` for every channel, followed by normal traffic.

Then check the WhatsApp login file:

```bash
wc -c store/auth/creds.json
```

`0` or "No such file" means the login is gone.

### Fix: re-link WhatsApp

1. Stop the service so it doesn't compete with the re-link:
   ```bash
   systemctl --user stop nanoclaw-v2-a84d1e4b
   ```
2. Move the broken login aside, so you can undo it if needed:
   ```bash
   mv store/auth store/auth.broken-$(date +%F) && mkdir store/auth
   ```
3. On the bot's phone, go to WhatsApp → Settings → Linked Devices and remove the old NanoClaw
   entry if it's listed. Then tap "Link a device".
4. In a real terminal, not Claude Code, so the QR code displays:
   ```bash
   pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr
   ```
   After it reports success, `wc -c store/auth/creds.json` should show a few KB.
   (A pairing code works too; see [whatsapp-relink.md](whatsapp-relink.md).)
5. Start the service:
   ```bash
   rm -f data/circuit-breaker.json
   systemctl --user start nanoclaw-v2-a84d1e4b
   ```
6. Check that every channel started:
   ```bash
   sleep 15; sed 's/\x1b\[[0-9;]*m//g' logs/nanoclaw.log | grep -E "Connected to WhatsApp|Channel adapter started" | tail -5
   ```
   You should see whatsapp, slack, and telegram, all timestamped now. Send a test message on
   each channel.

Once the new login works, delete the `store/auth.broken-*` folder.

### How the login gets lost

- **Disk full while WhatsApp saves its login.** The write fails partway and leaves
  `creds.json` empty (0 bytes). This happened on 2026-11-19.
- **WhatsApp logs the device out (401),** about every two weeks. NanoClaw deletes the dead
  credentials itself. See [whatsapp-relink.md](whatsapp-relink.md).

---

## Disk full

### Why the root disk fills even though data lives on the volume

`groups/` and `data/` live on the Hetzner volume, but these still go to the
**root disk** (`/`, 38G):

- **Docker images** (`/var/lib/containerd`, ~8G)
- **Files agents write inside their containers** (outside their mounted workspace),
  such as temp files, downloads, and browser caches. This space is freed automatically
  when the container is removed, so the disk can be full during an outage and fine
  an hour later.
- **Leftover `groups.old` / `data.old`** copies from the volume migration (~6G)
- **`.vscode-server`** for both amit and harvey (~4.5G each)
- **Harvey's install** and its files
- the 4G swapfile, logs, and npm cache

### 0. Check the disk monitor history first

A cron job (`~/.local/bin/disk-monitor.sh`, every 5 min) records disk usage, memory, and each
container's size. It writes one file per day to `~/nanoclaw-v2/data/disk-monitor/YYYY-MM-DD.log`
and keeps 7 days. This shows what happened *before* you logged in, which matters because
temporary container space may already be gone by then.

The files live on the Hetzner volume, so they keep being written when `/` is full. They're also
included in the nightly Google Drive backup (it archives all of `data/`).

How free space on `/` changed over time (the 4th column is "Avail"):

```bash
grep -h -A1 '=====' ~/nanoclaw-v2/data/disk-monitor/*.log | grep -E '=====|/dev/sdb1' | paste - - | awk '{print $2, $6, $7}'
```

Look for the point where free space starts dropping fast.

The largest container sizes recorded:

```bash
grep -h 'ncl-' ~/nanoclaw-v2/data/disk-monitor/*.log | sort -t$'\t' -k2 -h | tail
```

Then open that day's file and scroll to the time of the drop. The container whose SIZE grows
there is the cause:

```bash
less ~/nanoclaw-v2/data/disk-monitor/$(date -u +%F).log
```

To see what that agent was doing, find which agent group the session belongs to with
`ncl sessions get <sess-id>`. Then look at its recent conversation in
`data/v2-sessions/<agent-group>/<sess-id>/outbound.db`.

### 1. Find who is using it, right now, before it changes

```bash
docker ps -s                                   # is a container huge?
docker system df                               # images / build cache
du -xh --max-depth=1 ~ 2>/dev/null | sort -h | tail
```

Some folders (Docker's, harvey's home) aren't readable as amit. To measure them
read-only through Docker:

```bash
docker run --rm -v /:/h:ro alpine du -xsh /h/var/lib/docker /h/var/lib/containerd /h/home/harvey
```

### 2. Free space (safe options, in order)

```bash
docker image prune -f        # unused images
docker builder prune -f      # build cache
npm cache clean --force      # npm cache
```

Bigger wins that you should think about before running (they can't be undone):

```bash
rm -rf ~/nanoclaw-v2/groups.old ~/nanoclaw-v2/data.old   # pre-migration copies, ~6G
```

`~/.vscode-server/extensions` and `~/.vscode-server/data/CachedExtensionVSIXs` keep
old versions. Deleting old version folders there is safe; VS Code re-downloads what it needs.

To stop a container that's filling the disk:

```bash
docker stop <container-name>
```

### 3. Then restart

Use [step 4](#4-the-startup-delay-circuit-breaker) to clear the delay, then restart.

---

## Quick checklist (copy-paste)

```bash
systemctl --user status nanoclaw-v2-a84d1e4b --no-pager -n 5
df -h / /mnt/HC_Volume_105707857
free -h
tail -n 30 ~/nanoclaw-v2/logs/nanoclaw.error.log
docker ps -s
```

Ninety seconds with these five commands usually tells you which section to go to.

---

## Past incidents

- **2026-11-19:** Root disk hit 99%. WhatsApp failed to write its auth file (`ENOSPC`),
  the host crash-looped 9 times, and then the 15-min circuit breaker kicked in. The Hetzner
  graphs looked normal. VS Code Remote couldn't connect, but plain SSH could. About
  7G of temporary space freed itself within the hour, most likely from an agent container's
  internal writes. The permanent baseline (Docker images, `.old` folders, two
  `.vscode-server`s) left too little headroom.
  **Follow-on:** the `ENOSPC` hit while WhatsApp was saving its login and left
  `store/auth/creds.json` empty. After restarting, the service looked up, but startup was stuck
  on the WhatsApp QR code, so Slack and Telegram never started either. Fixed by re-linking
  WhatsApp. `store/` is not in the nightly backup, so there was no copy of the login to
  restore.
