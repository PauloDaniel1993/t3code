## ADDED Requirements

### Requirement: Link task threads to a parent thread

The system SHALL expose a nullable `parentThreadId` on thread detail and thread shell projections. A
thread with a non-null `parentThreadId` is a task thread and SHALL otherwise behave as an ordinary
thread — openable, listable, steerable, settleable, archivable, and deletable.

#### Scenario: Ordinary thread projection

- **WHEN** a thread was not created as a task
- **THEN** its projected detail and shell expose `parentThreadId: null`, `task: null`, and
  `taskSummary: null` unless it owns tasks

#### Scenario: Task thread projection

- **WHEN** a thread was created by `thread.task.create`
- **THEN** its projected detail and shell expose the parent thread id and a `task` metadata object
  carrying title, prompt, resolved context spec, creator, status, requested/started/finished
  timestamps, result, and delivery state

#### Scenario: Parent rollup projection

- **WHEN** a thread owns one or more task threads
- **THEN** its projected detail and shell expose a `taskSummary` with total count, running count,
  latest result timestamp, and latest delivery timestamp

#### Scenario: Historical rows decode without task data

- **WHEN** a thread row was persisted before this change
- **THEN** it decodes with `parentThreadId: null`, `task: null`, and `taskSummary: null` rather than
  failing validation

### Requirement: Create a task as a child thread

The system SHALL create a task thread when `thread.task.create` is dispatched with an existing,
non-deleted, non-archived parent thread and a task thread id that does not already exist. The task
thread SHALL be created in the parent's project and SHALL inherit the parent's branch, worktree
path, runtime mode, and interaction mode. The task SHALL use the parent's model selection unless the
command supplies one.

#### Scenario: Successful creation

- **WHEN** `thread.task.create` is dispatched with a valid parent, a fresh task thread id, a title,
  a prompt, and a context spec
- **THEN** the system creates the task thread, emits `thread.task-created` on the task thread
  aggregate, appends a `task.created` activity to the parent, and starts the task's first turn with
  the materialized prompt

#### Scenario: Creator is recorded server-side

- **WHEN** the command arrives over the MCP tool surface
- **THEN** the recorded creator is `agent`
- **AND WHEN** the command arrives from a client dispatch
- **THEN** the recorded creator is `user`

#### Scenario: Task thread id already exists

- **WHEN** `thread.task.create` supplies a task thread id that already exists
- **THEN** the system rejects the command without mutating the parent or the existing thread

#### Scenario: Parent is not eligible

- **WHEN** the parent thread is missing, deleted, or archived
- **THEN** the system rejects the command with an actionable reason

#### Scenario: Nesting is limited to one level

- **WHEN** the requested parent thread itself has a non-null `parentThreadId`
- **THEN** the system rejects the command with a nesting-depth reason

#### Scenario: Model selection is not ready

- **WHEN** the supplied model selection references a provider instance that is not enabled, not
  configured, missing the model, or not ready
- **THEN** the system rejects the command with an actionable reason

#### Scenario: Concurrency cap is reached

- **WHEN** the parent already owns `THREAD_TASK_MAX_RUNNING` tasks in `queued` or `running` status
- **THEN** the system rejects the command with a concurrency reason and does not create a thread

#### Scenario: Lifetime cap is reached

- **WHEN** the parent has already owned `THREAD_TASK_MAX_TOTAL` tasks over its lifetime
- **THEN** the system rejects the command with a lifetime-cap reason

### Requirement: Materialize the task context spec at creation

The system SHALL support context specs of `full-thread`, `selected-messages` with an explicit
message id list, and `none`. The system SHALL resolve the spec against the parent's projected
transcript at creation time and prepend a delimited context block to the task prompt in the task
thread's first user message. The resolved spec SHALL be stored in task metadata.

#### Scenario: Full thread context

- **WHEN** the context spec is `full-thread`
- **THEN** the task's first message contains a delimited block of the parent's completed user,
  assistant, and system messages in chronological order, followed by the task prompt

#### Scenario: Selected messages context

- **WHEN** the context spec is `selected-messages` with ids that exist in the parent transcript
- **THEN** the context block contains only those messages, in transcript order, and the stored spec
  records the requested ids

#### Scenario: Selected message ids are invalid

- **WHEN** the id list is empty, exceeds `THREAD_TASK_MAX_SELECTED_MESSAGES`, or contains ids absent
  from the parent transcript
- **THEN** the system rejects the command with an actionable reason

#### Scenario: No context

- **WHEN** the context spec is `none`
- **THEN** the task's first message contains only the task prompt with no context block

#### Scenario: Context exceeds the budget

- **WHEN** the resolved context exceeds `THREAD_TASK_CONTEXT_MAX_CHARS`
- **THEN** the system trims oldest-first until it fits, preserves the task prompt intact, and
  records `contextTruncated: true` in task metadata

#### Scenario: Non-importable parent messages

- **WHEN** the parent transcript contains streaming assistant messages or optimistic client-only
  messages
- **THEN** those messages are excluded from the context block

#### Scenario: Attachments in context

- **WHEN** a selected parent message carries attachments
- **THEN** the context block includes attachment name, type, and size metadata and does not re-upload
  attachment bytes to the task provider

### Requirement: Track task status through the task lifecycle

The system SHALL project a `ThreadTaskStatus` of `queued`, `running`, `finished`, `failed`, or
`cancelled` for each task. Approval-pending, input-pending, and working presentation SHALL continue
to derive from the task thread's own session and latest turn rather than from this status.

#### Scenario: Queued to running

- **WHEN** the task thread's first turn starts
- **THEN** the task status becomes `running` and `thread.task-updated` is emitted on the task thread

#### Scenario: Successful completion

- **WHEN** the task's result is recorded with a `succeeded` outcome
- **THEN** the task status becomes `finished`

#### Scenario: Failed completion

- **WHEN** the task's result is recorded with a `failed` outcome
- **THEN** the task status becomes `failed`

#### Scenario: Cancellation

- **WHEN** `thread.task.cancel` is accepted for a task in `queued` or `running`
- **THEN** the system interrupts the task's turn, stops its provider session, and sets the status to
  `cancelled`

#### Scenario: Cancelling a settled task

- **WHEN** `thread.task.cancel` targets a task already in `finished`, `failed`, or `cancelled`
- **THEN** the system accepts the command as a no-op without changing status or re-delivering

### Requirement: Record a task result exactly once when the task settles

The system SHALL record a task result when an armed task thread reaches idle after having run at
least one turn — no running turn, latest turn in `completed` or `error`, and no pending approval or
user-input request. Recording SHALL emit `thread.task-finished` on the task thread aggregate and SHALL
disarm the task so a second recording cannot occur for the same arming.

#### Scenario: Task completes normally

- **WHEN** the task thread's turn completes and the thread has no pending approval or input request
- **THEN** the system records a result with outcome `succeeded`, the final assistant message id, a
  summary bounded by `THREAD_TASK_RESULT_SUMMARY_MAX_CHARS`, and a completion timestamp

#### Scenario: Task turn errors

- **WHEN** the task thread's latest turn ends in `error`
- **THEN** the system records a result with outcome `failed` and the failure detail as the summary

#### Scenario: Task is awaiting approval or input

- **WHEN** the task thread's turn completes but a pending approval or user-input request remains
- **THEN** the system does not record a result and the task stays `running`

#### Scenario: Result summary exceeds the bound

- **WHEN** the task's final assistant message is longer than
  `THREAD_TASK_RESULT_SUMMARY_MAX_CHARS`
- **THEN** the system keeps the tail of the message, marks the summary as truncated, and references
  the task thread for the full text

#### Scenario: Restart between recording and delivery

- **WHEN** the server restarts after `thread.task-finished` was persisted but before the parent turn
  start was dispatched
- **THEN** replay leaves the task in its recorded state and the pending delivery is retried once,
  without producing a second result recording

#### Scenario: Cancelled task

- **WHEN** a task is cancelled
- **THEN** the system records a result with outcome `cancelled` and a summary describing the
  cancellation

### Requirement: Wake the parent thread with the task result

When a result is recorded and the parent is eligible, the system SHALL dispatch a turn start on the
parent thread carrying a user-role message with `source: "task-result"` whose text is a deterministic
wrapper containing the task title, the original task prompt, the outcome, and the result summary.
The delivery outcome SHALL be recorded on the task.

#### Scenario: Parent has no live provider session

- **WHEN** the parent's session is idle, stopped, or was never started
- **THEN** the dispatched turn start starts or resumes the parent's provider session through the
  existing session-resume path and the parent continues from the injected message

#### Scenario: Parent is mid-turn

- **WHEN** the parent has a running turn at delivery time
- **THEN** the injected message is delivered as a steer into that running turn and no new turn
  boundary is created

#### Scenario: Parent is settled

- **WHEN** the parent is settled at delivery time
- **THEN** the delivery un-settles the parent with reason `activity` and the parent appears in the
  active list again

#### Scenario: Parent is snoozed

- **WHEN** the parent is snoozed at delivery time
- **THEN** the delivery un-snoozes the parent with reason `activity`

#### Scenario: Parent is archived or deleted

- **WHEN** the parent is archived or deleted at delivery time
- **THEN** the system skips delivery, records the skip reason, and does not create a message on the
  parent

#### Scenario: Delivery dispatch fails

- **WHEN** the parent turn start cannot be dispatched
- **THEN** the system records the delivery as skipped with a failure reason and appends a failure
  activity to the parent so the outcome is visible

#### Scenario: Result marked unread on the parent

- **WHEN** a delivery succeeds
- **THEN** the parent's `taskSummary` records the delivery timestamp so clients can mark the parent
  as having unread task results

#### Scenario: Explicit re-delivery

- **WHEN** a re-delivery is requested for an already-finished task
- **THEN** the system records a new delivery and dispatches a fresh parent turn start using the
  current result

### Requirement: Cascade parent lifecycle changes to task threads

The system SHALL apply parent lifecycle transitions to task threads according to the meaning of each
transition.

#### Scenario: Parent is settled

- **WHEN** the parent thread is settled while it owns running tasks
- **THEN** the tasks keep running and remain armed for delivery

#### Scenario: Parent is snoozed

- **WHEN** the parent thread is snoozed while it owns running tasks
- **THEN** the tasks keep running and remain armed for delivery

#### Scenario: Parent is archived

- **WHEN** the parent thread is archived
- **THEN** the system cancels its `queued` and `running` tasks, skips their pending deliveries with
  reason `parent-archived`, and archives the task threads with the parent

#### Scenario: Parent is deleted

- **WHEN** the parent thread is deleted
- **THEN** the system cascade-deletes its task threads through the existing thread deletion path

#### Scenario: Parent is unarchived

- **WHEN** an archived parent is unarchived
- **THEN** its task threads are unarchived with it and cancelled tasks are not restarted

#### Scenario: Task thread is archived or deleted directly

- **WHEN** a task thread is archived or deleted while its delivery is still pending
- **THEN** the system skips the delivery and updates the parent's `taskSummary` counts

### Requirement: Persist and replay task state

The system SHALL persist task linkage and metadata additively and SHALL reproduce identical task
projections from event replay.

#### Scenario: Additive migration on an existing database

- **WHEN** the fork migration runs against a database created before this change
- **THEN** it adds `parent_thread_id`, `task_json`, and `task_summary_json` columns and a
  parent-thread index to `projection_threads` without rewriting existing rows

#### Scenario: Migration is re-run

- **WHEN** the fork migration runs against a database that already has the columns
- **THEN** it completes without error and without altering data

#### Scenario: Replay reproduces task state

- **WHEN** the projection is rebuilt from the event log
- **THEN** each task thread projects the same status, result, and delivery state, and each parent
  projects the same `taskSummary`, as before the rebuild

#### Scenario: Parent lookup

- **WHEN** the projection is queried for a parent thread's tasks
- **THEN** the query resolves through the parent-thread index rather than a full table scan

### Requirement: Advertise task support for version skew

The system SHALL advertise a `threadTasks` execution-environment capability so clients can detect
servers that predate this change and suppress task affordances instead of dispatching commands the
server cannot handle.

#### Scenario: Capable server

- **WHEN** a client connects to a server that supports thread tasks
- **THEN** the environment descriptor reports `threadTasks: true`

#### Scenario: Older server

- **WHEN** a client connects to a server whose descriptor omits `threadTasks`
- **THEN** the client treats task support as unavailable and does not dispatch task commands
