## Context

`AcpSessionRuntime.start()` either creates a session (`session/new`) or reattaches to one the
caller already knows about (`session/resume` or `session/load`). The session id comes from the
thread's stored resume cursor — for Kimi, `{ schemaVersion, instanceId, sessionId }` parsed by
`parseKimiResume`. There is no path by which T3 Code learns of a session id it did not mint.

Two resume primitives exist and they differ in a way that matters here:

- `session/resume` is lightweight and does not replay history.
- `session/load` replays the session's history as `session/update` notifications, which the runtime
  deliberately suppresses behind its replay gate.

For a session T3 Code created, suppressing replay is right — T3 Code already holds the transcript.
For an adopted foreign session, T3 Code holds nothing, so the same suppression means the thread
starts visually empty even though the agent has full context.

## Goals / Non-Goals

**Goals:**

- Let a user continue, inside T3 Code, a conversation they started in their own terminal.
- Reuse the existing resume cursor and resume path so adoption is not a second, parallel mechanism.
- Make the working-directory relationship between a session and a project explicit.

**Non-Goals:**

- Reconstructing a faithful T3 Code transcript from replayed history. That is a much larger piece of
  work and should not be smuggled in here.
- Deleting or renaming native sessions. Kimi exposes no `session/close` or delete operation, so T3
  Code cannot offer lifecycle management it has no primitive for.
- Continuous synchronization between a native session and a T3 Code thread.

## Decisions

### Gate strictly on the advertised capability

List is offered only when `agentCapabilities.sessionCapabilities.list` is present. No probing by
attempting the call and interpreting a `methodNotFound`.

### Adoption creates a new thread bound to the existing session

Adopting does not retrofit an existing thread. It creates a thread whose resume cursor points at the
chosen session id, then starts the session through the normal resume path. This keeps one thread
bound to at most one native session for its whole life, which the resume-cursor model already
assumes.

### An adopted thread starts with an explicit empty transcript, not a fake one

The thread shows that it was adopted from a native session and that prior turns live in the agent's
context but not in T3 Code's history. Fabricating timeline entries from replayed updates would
produce a transcript that looks authoritative and is not.

### Working directory is surfaced, never silently overridden

`session/list` returns each session's `cwd`. Adoption into a project whose directory differs is
allowed but must be shown, because the agent's file context and the thread's project would disagree.

## Risks / Trade-offs

- A user may reasonably expect adoption to bring the conversation across visually. It does not, and
  the surface has to say so plainly or it will read as data loss.
- `session/list` returns every session in the agent's home, which can be large and can include work
  from unrelated projects. Ordering by `updatedAt` and filtering by working directory are the
  minimum for this to be usable.
- Titles come from the agent and may be placeholders — the live probe returned `"New Session"` for
  every entry. The surface should fall back to working directory and timestamp rather than showing a
  wall of identical titles.

## Open Questions

- Should adoption default to filtering by the current project's directory, with an opt-in to show
  all sessions?
- Is there value in a later, separate change that replays `session/load` history into a read-only
  imported transcript? If so, this change should avoid foreclosing it.
