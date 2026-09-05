# Glossary

Terms whose meaning matters across T3 Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Attachments and thread work

### Attachment

A typed file associated with a message. [The orchestration contracts](../../packages/contracts/src/orchestration.ts) define `ChatAttachment` as the durable `image`, `document`, or generic `file` metadata stored in thread history, while `UploadChatAttachment` is the client-to-server form used before normalization. See [Normalizer.ts](../../apps/server/src/orchestration/Normalizer.ts).

### Linked pull request

Pull request metadata explicitly associated with a thread: project, repository, number, and URL. Clients use the link for thread status, and an environment can automatically settle the thread when that pull request merges. See [the contracts](../../packages/contracts/src/orchestration.ts) and [thread-sidebar.md](../user/thread-sidebar.md).

### Native agent

A provider's own in-session subagent. Unlike a task, it is not a thread and does not have an independently steerable transcript, model, or provider session. T3 Code observes its lifecycle through activities and projects a bounded current view onto the parent thread. See [the contracts](../../packages/contracts/src/orchestration.ts) and [nativeAgents.ts](../../packages/client-runtime/src/state/native-agents/nativeAgents.ts).

### Pending upload

A temporary attachment stored before its turn is accepted. It has a pending attachment ID and an expiring upload URL; normalization validates the complete attachment set, then claims accepted files into thread-owned IDs as part of staging the turn. See [the asset contracts](../../packages/contracts/src/assets.ts) and [Normalizer.ts](../../apps/server/src/orchestration/Normalizer.ts).

### Task

A child thread owned by a parent thread and running its own provider session. A task can be created by the user or the parent agent, receives explicitly selected context, and delivers its result back to the parent. Tasks cannot create nested tasks. See [the orchestration contracts](../../packages/contracts/src/orchestration.ts) and [the task contracts](../../packages/contracts/src/threadTasks.ts).

### Unsettled

The active state entered when a settled thread is restored or wakes because new activity arrives. The `thread.unsettled` event clears `settledAt`; `unsettledAt` records the latest re-entry so web and mobile place the thread at the top of the active list without changing its creation time. See [projector.ts](../../apps/server/src/orchestration/projector.ts) and [threadSort.ts](../../packages/client-runtime/src/state/threadSort.ts).

### Compaction

Replacing older provider-session context with a summary to reduce active token usage without changing the thread's durable timeline. Claude can compact automatically at a configured threshold, through `/compact`, or before resuming an older session. See [providers-claude.md](../user/providers-claude.md).

### Feedback

A Codex provider operation that uploads a thread and its Codex logs to OpenAI and returns a shareable feedback ID. Users invoke it with `/feedback`, optionally followed by a reason. See [ProviderService.ts](../../apps/server/src/provider/Layers/ProviderService.ts) and [providers-codex.md](../user/providers-codex.md).

## Wayfinder maps

### Wayfinder map

A directory of Markdown under a project's `.plan/`: one `map.md` describing an effort plus a `tickets/` directory of decision tickets. T3 Code normalises that on-disk graph for the read-only Map surface. See [wayfinder-maps.md](./wayfinder-maps.md).

### Ticket

One decision in a wayfinder map. Its effective status is derived rather than stored as ticket state, with precedence ruled out (`out_of_scope`) over `resolved`, then `claimed`, then `open`. T3 Code treats prose under `Ruled out` as out of scope and prose under `Answer` or `Resolution` as resolved; a bare heading leaves an otherwise open ticket open. A claimant makes it claimed, and the legacy `Status: closed` field also resolves a field-line ticket. See [wayfinder-maps.md](./wayfinder-maps.md).

### Frontier

A ticket that is neither resolved nor out of scope and whose every blocker is resolved or out of scope. The frontier is the map's answer to "what can I pick up now?" See [wayfinder-maps.md](./wayfinder-maps.md).

### Fog

A named area of a wayfinder effort that is not yet specified. A fog entry may name the ticket that will clear it. See [wayfinder-maps.md](./wayfinder-maps.md).

### Undermined

A ticket that is the target of an `undermines` edge from a ticket that is not resolved. See [wayfinder-maps.md](./wayfinder-maps.md).
