# Reclaim database space

Database maintenance reclaims free space inside an existing V2 database. It keeps
all stored history. Run it on the server's machine with the desktop app and any
server using that data directory stopped.

All four commands refuse a V1 file, an unrelated SQLite file, or a different
core schema version before any writable open. Even committed WAL data is read
without changing the database, WAL or SHM during refusal. A file that needs
rollback-journal recovery before it can be identified safely is also refused;
keep its journal and use SQLite recovery on a separate copy for inspection.

Pass the exact database path each time. For example, in PowerShell:

```powershell
t3 maintenance estimate --database 'C:\path\to\userdata\statev2.sqlite'
t3 maintenance compact --database 'C:\path\to\userdata\statev2.sqlite'
t3 maintenance status --database 'C:\path\to\userdata\statev2.sqlite'
```

`estimate` reports bytes in existing free pages, not savings from deleting old
history. Actual reclamation may differ because VACUUM also repacks pages. This
command does not run V2's logical event compactor.

Compaction requires free space on the **database's volume** for one retained
snapshot, one SQLite temporary copy, and one database-sized journal/WAL. The
reported requirement is three database sizes plus journal frame overhead and
64 MiB. SQLite's temporary directory is explicitly set to the database directory
and checked; SQLite does not use its usual OS temporary-directory selection.
`estimate` reports both selected directories, required bytes and available bytes.
No extra volume is used for snapshots.

It creates and validates a compact recovery snapshot before rewriting the
database. The snapshot stays beside the database at the path printed by
`compact`; keeping it consumes disk space. Move it to backup storage or remove
it once you have verified the result and no longer need that recovery point.

Progress goes to stderr as each phase starts and finishes, including elapsed
time and the remaining phases. Later validation estimates use the measured
source validation time; rewrite duration is unknown. Stdout remains JSON.
The final validation opens a fresh read-only connection while the exclusive
writer lock is still held.

Snapshots being copied or checked end in `.sqlite.incomplete`. Only a validated
snapshot gets its final `.sqlite` name. Interrupted copies are reported by
`status`, `estimate`, and `recover` with `usable: false`; they are never a
fallback. Once recovery succeeds you may remove those incomplete files. Keep
the current database's own `-wal`, `-shm` and `-journal` files with the database.

After an interrupted or failed attempt, stop the server and run:

```powershell
t3 maintenance recover --database 'C:\path\to\userdata\statev2.sqlite'
```

Recovery checks the current database and any validated snapshot. It keeps newer
committed work and never restores an old snapshot automatically. A `changed`
result means the current database differs from the saved snapshot. Missing or
damaged validated snapshots and unreadable journals require manual inspection;
keep all files until that is resolved. Run `compact` again after recovery to
finish reclaiming space.

A failed or interrupted **final validation** remains recorded in the journal
and blocks another compaction, even when later normal writes changed the file.
`recover` names the retained validated snapshot and refuses to clear that block.
After inspecting the current data and deciding to keep it, explicitly acknowledge:

```powershell
t3 maintenance recover --database 'C:\path\to\userdata\statev2.sqlite' --acknowledge-validation-failure
```

This rechecks integrity and the saved snapshot, records your acknowledgement,
and allows another compaction. It does not restore the snapshot or waive an
integrity failure. If the current data is suspect, preserve the files and resolve
that before acknowledging.
