## Context

T3 Code threads are event-sourced. Clients dispatch commands, `decider.ts` turns them into
orchestration events, `projector.ts` folds events into `projection_threads` and friends, and the web
app subscribes to shell and thread-detail streams. Provider work is driven by
`ProviderCommandReactor`, which reacts to `thread.turn-start-requested` by resolving a send request
and calling `ensureSessionForThread` — the same path that starts a fresh provider session, resumes a
stopped one from its persisted cursor, or steers an already-running turn.

The sidebar (`SidebarV2.tsx`) renders a flat, activity-sorted list of thread shells with snoozed and
settled shelves. It already has the two primitives this feature needs: an unread model
(`hasUnseenCompletion` compared against `uiStateStore.threadLastVisitedAtById`) and a wake pill for
snooze. Thread detail is an `Atom.family` keyed by thread with an idle TTL, so mounting a second
thread's detail alongside the active one is a supported operation, not a new subscription mechanism.

The MCP server is per-thread scoped: `McpSessionRegistry` mints an invocation scope carrying
`threadId`, `providerInstanceId`, and a capability set, and toolkits gate on
`requireMcpCapability`. Today the only capability is `preview`.

Two unimplemented proposals overlap this one. `add-provider-backed-subagents` covers the same
parent/child thread idea from a policy-and-profiles angle; `2026-07-02-provider-thread-handoff`
introduces a message `source` field. Neither has landed. This change is the UX-approved v1 of
parent/child threads and deliberately takes a narrower slice; the coordination is recorded in
decisions 8 and 9.

The approved UX is `experiments/thread-tasks-mockups/index.html` and `mockup.png`. Its "The design to
replicate" and "Semantics to carry into implementation" sections are treated as requirements; its
"Open questions for planning" are resolved in the decisions below.

## Goals / Non-Goals

**Goals:**

- Represent a task as a full thread with a `parentThreadId`, not a new lightweight entity.
- Let the parent's agent delegate through a normal provider tool call, with no new protocol method.
- Deliver task results back into the parent conversation and resume the parent, whatever state its
  provider session is in.
- Give the user a peek-and-steer surface that does not cost a navigation.
- Keep every task lifecycle transition server-authoritative and replay-stable.
- Bound delegation so a wake-up loop cannot run away.

**Non-Goals:**

- No nesting beyond one level — a task thread cannot own tasks.
- No separate worktree or branch per task in v1; tasks inherit the parent's.
- No LLM summarization of task results in v1; the delivered summary is deterministic truncation.
- No mini thread window on mobile, and no mobile-specific task layout.
- No task profiles, target allowlists, or per-target policy configuration.
- No cross-project tasks — a task lives in the parent's project.
- No approval gate before an agent creates a task in v1 (bounded by caps and runtime mode instead).
- No task templates, scheduling, retry, or dependency graphs between tasks.

## Decisions

### 1. A task is a thread; `parentThreadId` is the only new identity

The task has no id of its own. It is identified by its `ThreadId`, and the link is a nullable
`parentThreadId` on the thread shell and detail. Everything else about the relationship lives in a
`task: ThreadTaskMetadata | null` object on the child (title, prompt, context spec, creator, status,
result, delivery) and a `taskSummary: ThreadTaskSummary | null` rollup on the parent (total count,
running count, latest result timestamp, unread-results timestamp).

Task lifecycle events (`thread.task-created`, `thread.task-updated`, `thread.task-finished`) are
emitted on the **task thread's** aggregate, not the parent's, because the mini thread window streams
the task thread's detail subscription and needs live status there. The parent surfaces the same
lifecycle through `task.created` / `task.finished` activity rows and through its re-projected
`taskSummary` on the shell stream.

Alternatives considered:

- Emitting task events on the parent aggregate: rejected because the task thread's own subscriber
  would then only learn its status from a fresh snapshot, so the mini window could not stream.
- A separate `ThreadTaskId` aggregate with its own table: rejected because every task operation —
  open, steer, settle, archive, diff, checkpoint — is a thread operation, and a second identity
  would need mapping at each of those boundaries.
- Storing the link only on the parent as a child-id array: rejected because the child needs to know
  it is a task (to reject nested creation, to render its own header) and an array field makes the
  projection write non-local.

### 2. Task status is stored, but session sub-states stay derived

`ThreadTaskStatus` is `queued | running | finished | failed | cancelled` and is projected from task
events. It is deliberately coarse: approval-pending, input-pending, and "working" chrome continue to
be derived from the child thread's own `session` and `latestTurn` by the existing
`resolveSidebarV2Status`, so a task row and a normal thread row read identically.

The stored status exists for the two things derivation cannot answer: whether a result was already
delivered (so delivery is exactly-once) and whether a cancel was requested but the provider has not
yet stopped.

Alternatives considered:

- Fully derived status: rejected because exactly-once delivery needs a durable, replayable fact.
- A full parallel status machine mirroring session status: rejected as duplicated truth that would
  drift from `OrchestrationSession` on recovery paths.

### 3. Delivery fires once, on the task thread's first settled completion

A task is _armed_ from creation. When the task thread reaches idle — its latest turn is `completed`
or `error`, no turn is running, and it has no pending approval or user-input request — the server
records the result and disarms. A completed turn that ends awaiting approval or input does **not**
deliver; the child row surfaces its own Approval/Input status on the parent's group instead.

After delivery the task is `finished` (or `failed`). Steering the task from the mini window does not
re-arm it; the mini window instead offers an explicit "Return results again" action that records a
fresh delivery.

Alternatives considered:

- Re-arm on every steer: rejected because the user steering a task is already watching it, and
  auto-waking the parent on each nudge makes the parent transcript noisy.
- Deliver on every completed turn: same objection, worse.
- Require the agent to call an explicit `task_return` tool: rejected because the task agent has no
  reason to know it is a task, and a forgotten call leaves the parent waiting forever.

### 4. The parent is woken by a normal turn start carrying a `task-result` message

Delivery dispatches `thread.turn.start` on the parent with a synthetic user-role message whose
`source` is `task-result` and whose text is a deterministic wrapper: task title, the original task
prompt, the outcome, and the bounded result summary.

This is the whole wake-up mechanism. `ProviderCommandReactor.processTurnStartRequested` already
calls `buildSendTurnRequestForThread` → `ensureSessionForThread`, which starts a session that never
existed, resumes a stopped one from its persisted cursor, or steers a running turn. An idle or
stopped parent therefore needs no new resume path. Delivery into a running parent is a steer, which
is exactly the desired "wake it while it is mid-thought" behavior.

Because the injected row is a real message, it also un-settles and un-snoozes the parent through the
existing activity paths (`thread.unsettled(reason: "activity")`, `thread.unsnoozed(reason:
"activity")`) with no special casing.

Alternatives considered:

- A system-role message: rejected because provider adapters treat system content inconsistently and
  several drivers will not start a turn from one.
- A pure activity/system event with no message: rejected because a turn start requires a stored
  message to send, so this would mean a second, parallel provider-input path.
- Mutating provider input without storing a message: rejected because the parent transcript would
  then not explain why the agent suddenly changed topic, and replay would lose the cause.

The trade-off is that the parent transcript gains a user-role message the user did not type. The UI
mitigation is decision 12: the timeline renders it as the blue `Task finished` event row, not a user
bubble, with the injected text available on expand.

### 5. Context is materialized once, at creation, into the task's first message

`ThreadTaskContextSpec` is `{ kind: "full-thread" }`, `{ kind: "selected-messages", messageIds }`, or
`{ kind: "none" }`. The server resolves it against the parent's projected transcript at creation time
and prepends a bounded, clearly-delimited context block to the task prompt. The block is capped at
`THREAD_TASK_CONTEXT_MAX_CHARS` (60,000), trimmed oldest-first, and records `contextTruncated: true`
when trimming occurred. Streaming and optimistic messages are excluded; attachments contribute
metadata lines, not re-uploaded bytes.

Alternatives considered:

- A live reference to the parent transcript resolved at each task turn: rejected because the task
  would then see parent messages written after it started, making its output non-reproducible.
- Summarizing the context with a text-generation model: deferred. It adds a model dependency and a
  failure mode to a v1 whose main risk is elsewhere; deterministic truncation is auditable and the
  `handoff-compression` capability is the natural place to add it later.

### 6. The agent surface is an MCP toolkit, not a protocol method

A new `tasks` MCP capability and toolkit exposes `task_create`, `task_list`, and `task_cancel`. The
invocation scope already carries the calling thread id, so the parent is never a tool argument and
an agent cannot create tasks on someone else's thread.

`task_create` takes `title`, `prompt`, `context` (`full-thread | selected-messages | none`, with
`messageIds` for the second), and an optional `model` selecting a configured instance. It returns
immediately with the created `threadId` and status — it does not block on the task. Results come
back through the wake-up, so a blocking tool would only add a timeout to manage.

Alternatives considered:

- A JSON-RPC/ACP protocol method: rejected because it would have to be implemented per driver, while
  MCP already reaches every tool-capable provider through one server.
- A blocking `task_run` that returns the result: rejected because it holds a provider tool call open
  for the whole task, breaks on parent restart, and duplicates the wake-up path.
- Adding `task_read`: deferred. Results arrive automatically and `task_list` carries enough status
  for an agent to decide whether to wait.

### 7. Delegation is bounded by caps, not by an approval gate

Per parent thread: at most `THREAD_TASK_MAX_RUNNING = 5` tasks in `queued`/`running` at once and
`THREAD_TASK_MAX_TOTAL = 25` tasks over the thread's lifetime. Tasks inherit the parent's runtime
mode and interaction mode, so a read-only parent cannot spawn a write-capable task. A task thread
has `parentThreadId != null` and is rejected if it tries to create a task, which caps nesting at one
level.

The loop this guards against is real: a task result wakes the parent, whose agent creates another
task. The total cap makes that loop terminate.

Alternatives considered:

- An approval prompt before each agent-created task: rejected for v1 because the mockup's flow is
  "the agent splits the work and tells you", and an approval on every split makes delegation more
  expensive than doing the work inline. The caps plus inherited runtime mode carry the safety.
- A configurable settings surface for the caps: deferred; constants first, settings when someone
  hits them.

### 8. Naming avoids the existing provider-native "task"

`WorkLogEntry.taskId` and `workLogEntryIsTaskLike` in `session-logic.ts` already mean "provider-native
subagent/workflow task card" (Claude's Task tool, workflow runs). That concept is unrelated and is
not being replaced.

Everything in this change is prefixed: contract types are `ThreadTask*`, commands are `thread.task.*`,
events are `thread.task-*`, activity kinds are `task.created` / `task.finished`, and the projection
columns are `task_json` / `task_summary_json`. The MCP tool names stay short (`task_create`) because
they are already namespaced by the T3 Code MCP server and the model sees them in that context.

### 9. Message `source` is introduced here, shared with handoff later

`OrchestrationMessage` gains `source: Schema.optionalKey(OrchestrationMessageSource)` with values
`user | provider | system | task-result`, absent on historical rows and derived from role when
absent. `2026-07-02-provider-thread-handoff` proposes the same field with a `handoff-import` value;
whichever lands second extends the union rather than redefining the field. This change does not
depend on that one landing.

### 10. Cascades follow what each lifecycle verb means

- **Settle parent**: tasks keep running. Delivery still happens and un-settles the parent through
  the existing activity path. Settling is "I am done looking at this", not "stop the work".
- **Snooze parent**: identical — tasks keep running, delivery wakes the parent.
- **Archive parent**: running tasks are cancelled (interrupt + `cancelled` status) and pending
  delivery is skipped with reason `parent-archived`. Task rows archive with the parent.
- **Delete parent**: task threads are cascade-deleted through the existing thread deletion path.
- **Settle/archive/delete a task directly**: allowed, it is a thread. Archiving or deleting a task
  with a pending delivery skips the delivery; the parent row's count drops.

Alternatives considered:

- Cancelling children when the parent settles: rejected because auto-settle rules would then silently
  kill work the user asked for.
- Blocking parent archive while tasks run: rejected as a modal dead end; cancelling is recoverable
  (unarchive, re-create) and honest.

### 11. Nested sidebar rows are a grouping transform over the existing flat list

Task threads are removed from the top-level shell list and re-inserted immediately after their parent
row when the parent's group is expanded, keeping the parent's own sort position. Task rows never move
to the global Snoozed or Settled shelves — a settled task renders as a slim row inside its group.
Group expansion state is per parent thread in `uiStateStore`, defaulting to expanded while any task is
running or has undelivered results and collapsed otherwise.

The blue dot reuses the existing unread model: the parent's `taskSummary.latestResultAt` compared
against `threadLastVisitedAtById`. It is visually distinct from the amber `Woke` pill (snooze) and the
emerald `Done` pill (turn completion), which keep their current meanings.

### 12. The mini window streams live and steers with a deliberately small composer

Opening the mini window mounts the task thread's detail atom, so the status line, mini timeline, and
chips are live — the existing `Atom.family` idle TTL handles teardown when it closes. The steer
composer is plain text plus send: no attachments, no slash commands, no mentions, no model picker,
no approval panel. It dispatches the same `thread.turn.start` the full composer does, so
`composer-steering` semantics apply unchanged. Anything the small composer cannot express is one
click away behind `Open thread ↗`.

If the task is awaiting approval or user input, the mini window shows that state and directs the user
to open the full thread rather than inlining approval controls.

### 13. Manual creation has two entry points; message selection lives in the dialog

`+ New task` on the sidebar group and a `New task…` item in the active thread's actions menu both
open the same dialog: title, prompt, context picker, and optional model override. The context picker
offers Full thread (default), Selected messages, and No context; choosing Selected messages reveals
a scrollable list of the parent's transcript with checkboxes, newest first, capped at
`THREAD_TASK_MAX_SELECTED_MESSAGES` (100).

Selection lives in the dialog because the timeline has no message-selection model today — adding a
persistent multi-select mode to `MessagesTimeline` would be a larger, independently-designed change
that competes with existing hover actions and text selection. A per-message "New task from here"
hover action is the natural follow-up once the dialog exists.

### 14. Fork migration `004_ProjectionThreadTasks`

`ForkMigrations.ts` owns the fork's migration ledger and its rules: new fork migrations go in
`ForkMigrations/`, numbered sequentially, and must be idempotent. This change adds `004`, which
`PRAGMA table_info`-guards three additive columns on `projection_threads` (`parent_thread_id`,
`task_json`, `task_summary_json`) and one index on `parent_thread_id`.

Note that `2026-07-02-provider-thread-handoff` still describes a `999_ProviderThreadHandoff`
migration in the upstream ledger; that predates `ForkMigrations` and is not the convention followed
here.

## Risks / Trade-offs

- [Tasks share the parent's worktree, so concurrent tasks can conflict on files] -> v1 inherits the
  parent's branch and worktree; caps limit concurrency to 5; the mockup's read-oriented scenarios
  (audit, inventory, compare) are the intended first use. Per-task worktrees are the follow-up.
- [Wake-up loops burn tokens] -> one nesting level, 5 concurrent, 25 lifetime tasks per parent, and
  the parent's transcript shows every created task so the loop is visible.
- [A user-role message the user did not type] -> `source: "task-result"` makes it addressable in
  contracts; the timeline renders it as the blue lifecycle row with the text on expand.
- [Delivery fires twice after a crash mid-dispatch] -> delivery is recorded as a `thread.task-finished`
  event before the parent turn start is dispatched, and the reactor skips tasks whose delivery state
  is already `delivered`; the same guard makes replay idempotent.
- [A task never settles, so the parent waits forever] -> no timeout in v1. The parent row shows the
  running count and the user can cancel from the mini window. A per-task timeout is deferred.
- [Deterministic truncation loses the important part of a long result] -> the delivered summary keeps
  the tail of the final assistant message (where conclusions live) and the wrapper links the task
  thread, which holds the full text.
- [Nested rows complicate an already dense sidebar] -> only the parent row changes structurally;
  groups collapse; task rows never enter the global shelves.
- [Overlap with `add-provider-backed-subagents`] -> that change stays unimplemented and its remaining
  ideas (profiles, target allowlists, configurable policy) are follow-ups on top of this data model
  rather than a competing one.

## Migration Plan

1. Add contracts: `parentThreadId`, `ThreadTaskMetadata`, `ThreadTaskSummary`, `ThreadTaskStatus`,
   `ThreadTaskContextSpec`, `ThreadTaskResult`, message `source`, task commands and events, and the
   `threadTasks` environment capability.
2. Add fork migration `004_ProjectionThreadTasks` and register it in `ForkMigrations.ts`; projection
   reads and writes carry `null` for pre-existing rows.
3. Add decider and projector handling for the task commands and events, including cascade rules.
4. Add the task lifecycle reactor: detect task-thread settle, record the result, dispatch the parent
   wake-up turn start.
5. Add the `tasks` MCP capability, toolkit, and handlers.
6. Add client-runtime command helpers and shell/detail state for the new fields.
7. Add web sidebar nesting, mini thread window, timeline rows, and the creation dialog.
8. Verify with focused tests per package plus one integrated web pass through the `test-t3-app`
   skill.

Rollback strategy:

- Before user data depends on the feature, hide the UI entry points and stop advertising the
  `threadTasks` and `tasks` capabilities; existing task threads keep working as ordinary threads.
- The migration is additive and idempotent. After use, rolling back leaves task threads as normal
  orphan threads with an unread `parent_thread_id` column — recoverable, not lossy.

## Open Questions

No blocking v1 questions remain. Deferred follow-ups: per-task worktrees, LLM-summarized results,
per-task timeouts, `task_read`, a per-message "New task from here" action, configurable caps and
target allowlists, task profiles, mobile mini window, and nesting beyond one level.
