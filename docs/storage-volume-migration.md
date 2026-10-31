# Moving `groups/` and `data/` to the External Volume

## What this does

The main disk (`/dev/sda1`, 38 GB) filled up. This guide moves each NanoClaw install's two big folders, `groups/` and `data/`, onto the 20 GB Hetzner volume (`/dev/sdb`, mounted at `/mnt/HC_Volume_105707857`). Each folder is then **bind-mounted** back at its original path.

A bind mount makes a folder on the volume appear at the old path, so `~/nanoclaw-v2/groups` keeps its real path. NanoClaw, Docker, the mount allowlist and the daily backup script all work unchanged. A symlink wouldn't do this: NanoClaw's mount security resolves symlinks to their real path (`src/modules/mount-security/index.ts`), which would change what the containers see.

There are two installs on this server. Move them one at a time:

| Install | Linux user | Folder | Install ID (`SLUG`) | Service |
| --- | --- | --- | --- | --- |
| Yours | `amit` | `/home/amit/nanoclaw-v2` | `a84d1e4b` | `nanoclaw-v2-a84d1e4b` |
| Harvey's | `harvey` | `/home/harvey/nanoclaw` | `2c2eacd0` | `nanoclaw-v2-2c2eacd0` (confirm in step 0) |

Layout on the volume:

```
/mnt/HC_Volume_105707857/nanoclaw/
├── amit/    (amit:amit, 750)     → groups/, data/
└── harvey/  (harvey:harvey, 750) → groups/, data/
```

The `750` permissions keep each install private, as it was inside its home folder.

**Each install's agents are offline from step 2 to step 9 of its round.** The OneCLI gateway containers (`onecli`, `onecli-harvey` and their Postgres containers) stay up the whole time; they don't use these folders.

## Who runs what

Each step is marked with the account that runs it:

- **[install user]**: the install's own user, `amit` in round 1 and `harvey` in round 2, with no `sudo`. These steps only touch that user's own files.
- **[amit, sudo]**: steps that need root (locking folders, `/etc/fstab`, mounting). `harvey` can't use `sudo`, so you run these from your account in both rounds.

To get a shell as `harvey`, log in over SSH as `harvey`, or from your account run:

```bash
sudo machinectl shell harvey@
```

If you use `sudo -iu harvey` or `su - harvey` instead, `systemctl --user` may fail with `Failed to connect to bus`. Fix it in that shell with `export XDG_RUNTIME_DIR=/run/user/$(id -u)`.

Keep two terminals open for Harvey's round: one as `harvey`, one as you.

## Before you start

- The volume is resized to 20 GB and its filesystem is grown: `df -h /mnt/HC_Volume_105707857` shows about 19G free.
- You have a backup on Google Drive. Take it after step 2, while the service is stopped, so the databases are consistent. **[amit, sudo]**. The `gdrive:` remote is only set up in your account, so you also run Harvey's backup (with `sudo` to read Harvey's folder). `tar` streams straight into `rclone`, so no local disk space is needed:

  ```bash
  # Yours
  cd ~/nanoclaw-v2
  tar -czf - groups data | rclone rcat gdrive:NanoClaw/pre-move/amit-groups-data.tar.gz
  # Harvey's
  sudo tar -czf - -C /home/harvey/nanoclaw groups data | rclone rcat gdrive:NanoClaw/pre-move/harvey-groups-data.tar.gz
  # Check
  rclone ls gdrive:NanoClaw/pre-move
  ```

## Step 0: Check sizes and the service name [install user]

```bash
du -sh ~/nanoclaw-v2/{groups,data}     # as amit
du -sh ~/nanoclaw/{groups,data}        # as harvey
systemctl --user list-units --all 'nanoclaw*'
```

All four folders must fit comfortably in the volume's free space (about 19 GB). If Harvey's service has a different name than in the table above, use that name everywhere below.

## Step 1: Create the folders on the volume (once) [amit, sudo]

```bash
V=/mnt/HC_Volume_105707857/nanoclaw
sudo mkdir -p $V/amit $V/harvey
sudo chown amit:amit $V/amit && sudo chown harvey:harvey $V/harvey
sudo chmod 750 $V/amit $V/harvey
```

## Steps 2–9: Move one install (repeat per install)

Start each round by setting these variables **in every terminal you use for that round**. If you open a new terminal partway through, set them again.

```bash
# Round 1: yours
U=amit;   ROOT=/home/amit/nanoclaw-v2; SLUG=a84d1e4b
# Round 2: Harvey's
U=harvey; ROOT=/home/harvey/nanoclaw;  SLUG=2c2eacd0

DEST=/mnt/HC_Volume_105707857/nanoclaw/$U
```

### Step 2: Stop the install and its agent containers [install user]

Stopping the service does **not** stop its agent containers; NanoClaw cleans them up on its next start. Stop them yourself:

```bash
systemctl --user stop nanoclaw-v2-$SLUG
docker stop $(docker ps -q --filter label=nanoclaw-install=$SLUG)
docker ps --filter label=nanoclaw-install=$SLUG --format '{{.Names}}'
```

The last command must print nothing. Agents lose nothing: their conversations are in the session DBs under `data/` and resume on the next message.

### Step 3: Copy both folders onto the volume [install user]

```bash
rsync -aHAX --info=progress2 $ROOT/groups $ROOT/data $DEST/
```

- `-a` keeps permissions, timestamps and symlinks.
- `-H` keeps hard links as links.
- `-A -X` keep ACLs and extended attributes.

Write `groups data` **without** a trailing `/`: that copies the folders themselves into `$DEST`. With `groups/`, rsync would copy the folder's contents straight into `$DEST`. If the copy is interrupted, run the same command again; it copies only what's missing.

Each install has some `root`-owned empty folders under `data/v2-sessions/` (`.../group`, `.../agent`). Docker created them as mount points. Without root, rsync can't keep `root` as their owner, so the copies become owned by the install user. That's harmless: Docker mounts into them either way.

### Step 4: Check the copy [install user]

```bash
rsync -aHAXn --checksum --itemize-changes $ROOT/groups $ROOT/data $DEST/
```

This is a dry run (`-n`) that compares every file by content. **It should print nothing.** The only acceptable output is the `root`-owned `data/v2-sessions/.../group` and `.../agent` folders from step 3. If any other files are listed, stop and find out why before going on.

### Step 5: Keep the originals and create empty folders in their place [install user]

```bash
mv $ROOT/groups $ROOT/groups.old && mv $ROOT/data $ROOT/data.old
mkdir -m 775 $ROOT/groups $ROOT/data
ls -ld $ROOT/groups.old $ROOT/groups $ROOT/data.old $ROOT/data
```

The new folders should have the same owner and permissions as the `.old` ones. The `.old` folders are your fallback until step 11.

### Step 6: Lock the empty folders [amit, sudo]

```bash
sudo chattr +i $ROOT/groups $ROOT/data
lsattr -d $ROOT/groups $ROOT/data      # expect ----i---------e-------
```

The volume's mount entry has `nofail`. If the volume ever fails to attach at boot, NanoClaw would start against these empty folders and quietly create a new, empty database. Locking them (`+i`, immutable) makes NanoClaw fail loudly instead. Mounting on top of a locked folder still works. The `e` is the normal ext4 "extents" flag.

### Step 7: Add the bind mounts to `/etc/fstab` [amit, sudo]

Open it with `sudo nano /etc/fstab` and add this install's two lines after the existing `HC_Volume` line:

```
# Yours
/mnt/HC_Volume_105707857/nanoclaw/amit/groups   /home/amit/nanoclaw-v2/groups none bind,nofail,x-systemd.requires-mounts-for=/mnt/HC_Volume_105707857 0 0
/mnt/HC_Volume_105707857/nanoclaw/amit/data     /home/amit/nanoclaw-v2/data   none bind,nofail,x-systemd.requires-mounts-for=/mnt/HC_Volume_105707857 0 0
# Harvey's
/mnt/HC_Volume_105707857/nanoclaw/harvey/groups /home/harvey/nanoclaw/groups  none bind,nofail,x-systemd.requires-mounts-for=/mnt/HC_Volume_105707857 0 0
/mnt/HC_Volume_105707857/nanoclaw/harvey/data   /home/harvey/nanoclaw/data    none bind,nofail,x-systemd.requires-mounts-for=/mnt/HC_Volume_105707857 0 0
```

`x-systemd.requires-mounts-for` makes each bind mount wait for the volume. Then load the new entries:

```bash
sudo systemctl daemon-reload
sudo mount $ROOT/groups && sudo mount $ROOT/data
```

### Step 8: Check the mounts [install user]

```bash
findmnt $ROOT/groups
findmnt $ROOT/data
ls $ROOT/groups
```

The `SOURCE` column should show the volume's device with `[/nanoclaw/<user>/groups]` and `[/nanoclaw/<user>/data]`, for example `/dev/sdb[/nanoclaw/amit/groups]`. The device name (`sda` or `sdb`) can swap between boots; that's harmless, because `/etc/fstab` refers to the volume by ID and path, not by device name. The `ls` should list that install's group folders. Run `findmnt` once per path: given two paths, it reads them as the source and target of a single mount and prints nothing.

### Step 9: Start the install and test it [install user]

```bash
systemctl --user start nanoclaw-v2-$SLUG
tail -f $ROOT/logs/nanoclaw.error.log
```

Send that install's agent a message. Check that it replies **and** still remembers earlier context; that shows it's using the moved database.

Then go back to step 2 for the next install.

## Step 10: Reboot once (after both installs)

This proves the `/etc/fstab` entries work at boot. Both users have `Linger=yes`, so both services start by themselves.

**[amit, sudo]**

```bash
sudo reboot
```

After it's back up, check the mounts **[any user]**:

```bash
findmnt -t ext4 | grep nanoclaw          # expect 4 lines
```

Then check each service **[install user]**:

```bash
systemctl --user status nanoclaw-v2-$SLUG
```

## Step 11: Free the space (after a day of normal use) [install user]

Space on the main disk is only freed in this step.

```bash
rm -rf $ROOT/groups.old $ROOT/data.old
```

If `rm` reports `Permission denied` for anything inside a `root`-owned folder, remove what's left from your account: `sudo rm -rf $ROOT/groups.old $ROOT/data.old`. Then check with `df -h /`.

## Rollback (one install, any time before step 11)

Set the variables for that install in both terminals first.

**[install user]** Stop the install:

```bash
systemctl --user stop nanoclaw-v2-$SLUG
docker stop $(docker ps -q --filter label=nanoclaw-install=$SLUG)
```

**[amit, sudo]** Unmount and unlock:

```bash
sudo umount $ROOT/groups $ROOT/data
sudo chattr -i $ROOT/groups $ROOT/data
# Remove that install's two lines from /etc/fstab, then:
sudo systemctl daemon-reload
```

**[install user]** Put the originals back and start:

```bash
rmdir $ROOT/groups $ROOT/data
mv $ROOT/groups.old $ROOT/groups && mv $ROOT/data.old $ROOT/data
systemctl --user start nanoclaw-v2-$SLUG
```

Any changes the agents made after the move (new messages, memory) stay on the volume copy and are not carried back.

## Later

- **The service fails to start after a reboot** with permission errors in `groups/` or `data/`: the volume probably didn't attach. Check with `lsblk` and `findmnt /mnt/HC_Volume_105707857`, then with `sudo mount -a`. This is the lock from step 6 doing its job.
- **More space:** grow the volume in the Hetzner Console (it can only grow), then run `sudo resize2fs /dev/disk/by-id/scsi-0HC_Volume_105707857`. The bind mounts don't change.
- **Backups:** a `tar` of `$ROOT/groups` and `$ROOT/data` follows the bind mounts, so a backup script that uses the original paths needs no change.
