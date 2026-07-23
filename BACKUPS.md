# Backups

The SQLite database holds every order, message, and payment reference. It lives
on one EBS volume. Until this is set up, losing that volume loses the business's
order history.

```bash
npm run backup
```

That takes a consistent snapshot of the live database (SQLite's online backup
API — **not** a file copy, which can corrupt a WAL database mid-write), verifies
it opens and passes an integrity check, gzips it, rotates old copies, and
uploads it off the box if configured.

## Make it automatic

```bash
crontab -e
```

Add (adjust the path if yours differs):

```cron
# Nightly database backup at 03:15
15 3 * * * cd /home/ubuntu/pochron-print-ordering && /usr/bin/node scripts/backup.js >> /home/ubuntu/backup.log 2>&1
```

Check it ran: `tail /home/ubuntu/backup.log`.

## Make it a real backup

A copy on the same disk protects against a bad deploy or a dropped table. It
does **not** protect against losing the volume or the instance — which is the
failure this exists for. Set an off-box destination:

```
BACKUP_S3_BUCKET=pochron-backups
BACKUP_S3_PREFIX=pochron-db
BACKUP_KEEP_DAYS=14
# Cloudflare R2 or any S3-compatible store:
# S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
# AWS_REGION=auto
# S3_ACCESS_KEY_ID=...
# S3_SECRET_ACCESS_KEY=...
```

Requires `npm i @aws-sdk/client-s3`. If the upload fails the script says so
loudly and exits non-zero, so a silent offsite failure never looks like success.

Ideally this bucket is on a **different account** from the server, so one
compromised or closed account can't take both.

## Restoring

```bash
gunzip -c backups/pochron-2026-07-23T04-09-13.db.gz > /tmp/restored.db
sqlite3 /tmp/restored.db "SELECT COUNT(*) FROM orders;"   # sanity check
pm2 stop pochron
cp /tmp/restored.db data/pochron.db
rm -f data/pochron.db-wal data/pochron.db-shm            # stale sidecars
pm2 start pochron
```

**Practise this once before you need it.** A backup you have never restored is a
hypothesis, not a backup.

## What is *not* backed up

Customer **original files**. With `STORAGE_DRIVER=local` they sit in
`data/uploads` and are excluded here because they are far too large to gzip
nightly. This is one of the strongest reasons to move originals to S3/R2, which
has its own durability and versioning. Until then, the orders survive a failure
but the photographs may not — and the promise made to customers is that their
original is always retained.

## Disk space

The same volume holds the database and (with local storage) the originals.
Multi-GB scans fill 30 GB quickly, and a full disk stops SQLite writing, which
risks the order records themselves. So the app refuses new uploads while a
reserve remains (`DISK_RESERVE_BYTES`, default 3 GB) and tells the customer to
contact the studio rather than failing obscurely.

Monitor it: `GET /api/health` reports `disk.usedPct` and `disk.freeBytes`.

```bash
curl -s https://order.pochronstudios.com/api/health | grep -o '"usedPct":[0-9.]*'
```

If that climbs past ~70%, move storage to R2 rather than growing the volume.
