# Reclaim database space

Database maintenance reclaims free space inside an existing V2 database. It keeps
all stored history. Run it on the server's machine with the desktop app and any
server using that data directory stopped.

Pass the exact database path each time. For example, in PowerShell:

```powershell
t3 maintenance estimate --database 'C:\path\to\userdata\statev2.sqlite'
t3 maintenance compact --database 'C:\path\to\userdata\statev2.sqlite'
t3 maintenance status --database 'C:\path\to\userdata\statev2.sqlite'
```

`estimate` reports free pages and the temporary disk requirement. Compaction
requires approximately three times the database size in free space, plus 64 MiB.
It creates and validates a compact recovery snapshot before rewriting the
database. The snapshot stays beside the database at the path printed by
`compact`; keeping it consumes disk space. Move it to backup storage or remove
it once you have verified the result and no longer need that recovery point.

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
