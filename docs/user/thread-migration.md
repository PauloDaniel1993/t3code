# Threads from older T3 Code versions

On your first V2 launch, T3 Code copies the V1 database, `state.sqlite`, into `statev2.sqlite`
in the same data directory and migrates the copy. Your threads appear automatically, with full
transcripts imported as needed. You do not need to run an import command.

V1 continues using its original database while V2 uses the copy. The database import can run while
V1 is open. Opening V2 again resumes your V2 history. The copy happens only once: later conversations
and changes in either version do not sync to the other. Settings, attachments, and workspace files
remain shared.

The V2 desktop app uses a separate browser profile, so browser cookies and caches do not carry
over from V1. You may need to sign in again to websites opened inside the app.

<!-- fork(ticket-28:docs) -->

The migrated thread keeps its title, project, provider and model selection, permission and
interaction modes, branch or worktree, archive state, settlement state, snooze and pin state, and
linked pull request. T3 Code also brings over user and assistant messages, reasoning traces, their
timestamps, and supported attachments. Task threads retain their parent relationships, results and completion
status. Tasks that were queued or running become cancelled. Large histories
may appear in stages while the server imports transcripts.

The migration does not recreate the old provider's live session. It also does not convert old run
records, checkpoints and diffs, tool activity, approval history, or proposed plan history into the
new format. These items may be absent from a migrated timeline even though the conversation text is
present.

## Continuing a migrated thread

The first new message starts a fresh provider session. T3 Code selects intact user and assistant
messages using the same [handoff budget](./portable-handoffs.md) as a provider switch. Omitted text
remains in the thread and can be retrieved by the agent. The migration retains its separate
32,000-character recovery excerpt; neither that excerpt nor the handoff replaces the full imported
transcript.

Before continuing a long or important thread, read the recent transcript and include any older
requirements the agent still needs in your next message. Starting a new thread and pasting a short
handoff is also a good choice when the old conversation contains conflicting instructions.

## Keeping a recovery copy

<!-- fork(ticket-28:docs) -->

T3 Code will not start on a data directory that an older V2 build already imported without reasoning
traces and message sources. From a terminal, the server prints "Incompatible V1 import" with these steps.
The desktop app does not open and keeps restarting its server in the background; the message is in its
server log, `~/.t3/userdata/logs/server-child.log` for a default install
(`%USERPROFILE%\.t3\userdata\logs\server-child.log` on Windows).

To recover, quit the app or stop the server. Preserve and move `statev2.sqlite` and its
`statev2.sqlite-wal` and `statev2.sqlite-shm` siblings (if present) out of the data directory, then start
again. T3 Code will make a fresh copy from the untouched `state.sqlite`. Keep the moved files: work you
did in V2 after the earlier import remains there and will not appear in the fresh import. Preserve the
attachment files too; copying a database cannot restore files that were deleted.

An invalid task parent link leaves that task accessible as a top-level thread. Import warnings in the
server log identify the affected record; their original values remain in `fork_v1_import_warnings` in
`statev2.sqlite` for inspection from a stopped recovery copy.

T3 Code does not currently have a whole-thread export command. Before a major server update, stop
the server and copy its `userdata` directory to a safe location. The default is
`~/.t3/userdata`; a server started with `--home-dir <path>` uses `<path>/userdata`.

If a migrated transcript is missing from the app, keep that copy unchanged. You can inspect the
old transcript without starting a server against it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list recent legacy threads:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then print one transcript, replacing `<thread-id>` with the value from the first query:
<!-- fork(ticket-28:docs) -->

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant', 'reasoning')
ORDER BY created_at, message_id;
```

Open only the copied database. Do not edit it or point a newer or older server at your recovery
copy. If the affected environment is remote, make and inspect the copy on the machine that runs
that environment.
