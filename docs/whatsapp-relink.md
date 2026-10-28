# WhatsApp Re-link Runbook

Online copy: https://claude.ai/artifact/VDfovhv2niFApjobBGp9J2

## When to use this

Use this when the agents stop answering on WhatsApp but Telegram, Slack and the rest still work. It happens about every two weeks. The fix takes about 5 minutes and needs your phone.

Signs that WhatsApp has been logged out:

- WhatsApp messages get no reply, but other channels do.
- On your phone, under WhatsApp → Settings → Linked Devices, the NanoClaw device is gone.
- `store/auth/` in `~/nanoclaw-v2` is empty.

Run every command below from a terminal in `~/nanoclaw-v2`. Use a real terminal, not Claude Code: the QR code needs an interactive screen.

## Step 1: Confirm it was a logout

Check the log first, so you don't re-link when something else is wrong:

```bash
grep -i whatsapp logs/nanoclaw.log | grep -iE "closed|logged out|auth cleared|Connected" | tail -5
```

Read the last lines like this:

| What you see | Meaning | What to do |
| --- | --- | --- |
| `reason=401` then `WhatsApp logged out` and `auth cleared` | Device unlinked; credentials deleted | Go to Step 2 |
| `reason=428` (or 408, 515) followed by `Connected to WhatsApp` | Normal short drop; it reconnected itself | Nothing |
| `reason=428` with no `Connected` after it | Stuck reconnecting | Skip to Step 3 (restart only) |
| No WhatsApp lines at all | The service may be down | Check `systemctl --user status nanoclaw-v2-a84d1e4b` |

## Step 2: Re-link the device

Link the same WhatsApp number as before, so all your existing groups and wirings keep working. Pick one method.

**Option A: QR code** (easiest if the phone is next to you)

1. On the phone with the bot's number, open WhatsApp → Settings → Linked Devices → Link a device.
2. Run:

   ```bash
   pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method qr
   ```

3. Scan the QR that appears in the terminal. It refreshes about every 20 seconds, so scan the newest one.

**Option B: Pairing code** (no camera needed)

1. Run this with the bot's number, digits only, country code first, no `+`, spaces or dashes (e.g. `9725XXXXXXXX`):

   ```bash
   pnpm exec tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone 9725XXXXXXXX
   ```

2. On the phone, open WhatsApp → Settings → Linked Devices → Link a device → Link with phone number instead.
3. Type in the 8-character code the terminal shows.

Wait until the command reports success. Then check that the credentials file now exists:

```bash
ls store/auth/creds.json
```

## Step 3: Restart and verify

Restart the service so it loads the new credentials. The service is called `nanoclaw-v2-a84d1e4b`, not `nanoclaw`:

```bash
systemctl --user restart nanoclaw-v2-a84d1e4b
```

Wait about 10 seconds, then confirm it connected:

```bash
grep -i "Connected to WhatsApp" logs/nanoclaw.log | tail -1
```

The timestamp should be from just now. Finally, send a test message to one of your WhatsApp agents and check that it replies.

If you've pulled or changed code since the last restart, run `pnpm run build` before restarting, or the old build keeps running.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| QR or pairing code expired before you finished | `rm -rf store/auth/*`, then run Step 2 again |
| Command finishes but `store/auth/creds.json` is missing | The phone never confirmed. Clear `store/auth/` and run Step 2 again |
| Phone says "couldn't link device" | Remove any old NanoClaw entry under Linked Devices, then retry |
| Restarted, but no `Connected to WhatsApp` line | Check `logs/nanoclaw.error.log` for WhatsApp errors |
| Connected, but agents still don't reply | Make sure you linked the same number as before, not a different one |
| Still stuck | Open Claude Code in `~/nanoclaw-v2` and run `/debug` |

## Why this happens

NanoClaw connects to WhatsApp as a linked device, like WhatsApp Web. WhatsApp ends that link with a 401 when it decides the device is no longer trusted. NanoClaw then deletes the dead credentials on purpose, so it can't recover without you. The last logout was 2026-10-26 at 05:44.

These are the usual triggers, worth trying to make it happen less often:

- **The phone is offline for a long time.** WhatsApp drops linked devices if the main phone doesn't connect for about 14 days. Open WhatsApp on the bot's phone now and then, and keep it on Wi-Fi with battery optimisation off for WhatsApp.
- **The same number is linked to two NanoClaw copies.** Two clients sharing one session knock each other off. Link each number to only one install.
- **Someone removes the device** under Linked Devices on the phone.

If it keeps happening every two weeks even with the phone online, note the date each time. A regular rhythm points to WhatsApp's own session expiry, not something on this machine.
