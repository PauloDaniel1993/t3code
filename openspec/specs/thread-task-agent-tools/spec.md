# thread-task-agent-tools Specification

## Purpose

TBD - created by archiving change 2026-07-25-thread-tasks. Update Purpose after archive.

## Requirements

### Requirement: Gate task tools behind a scoped MCP capability

The system SHALL expose task tools through a `tasks` MCP capability granted in the per-thread
provider invocation scope. Tool handlers SHALL resolve the calling thread from the invocation scope
rather than from tool arguments.

#### Scenario: Capability granted

- **WHEN** a provider session is issued MCP credentials for a thread that may delegate
- **THEN** its invocation scope includes the `tasks` capability and the task tools are listed

#### Scenario: Capability absent

- **WHEN** a tool call arrives on an invocation scope without the `tasks` capability
- **THEN** the system rejects the call with a capability-unavailable error and creates no thread

#### Scenario: Caller identity comes from the scope

- **WHEN** any task tool is invoked
- **THEN** the parent thread is the invocation scope's thread id and cannot be overridden by a tool
  argument

#### Scenario: Task threads cannot delegate

- **WHEN** the invocation scope's thread has a non-null `parentThreadId`
- **THEN** `task_create` is rejected with a nesting-depth error

### Requirement: Create a task from a provider tool call

The system SHALL expose a `task_create` tool that accepts a title, a prompt, a context spec, and an
optional model selection, dispatches `thread.task.create` for the calling thread, and returns
without waiting for the task to finish.

#### Scenario: Successful creation

- **WHEN** the agent calls `task_create` with a title, a prompt, and `context: "full-thread"`
- **THEN** the system creates the task thread and returns its thread id, title, and status

#### Scenario: Selected message context

- **WHEN** the agent calls `task_create` with `context: "selected-messages"` and a list of parent
  message ids
- **THEN** the tool passes the ids through to the command and the resolved spec is recorded on the
  task

#### Scenario: Missing message ids for selected context

- **WHEN** the agent requests `selected-messages` without message ids
- **THEN** the tool returns a validation error describing the missing argument

#### Scenario: Model override

- **WHEN** the agent supplies a model selection for a ready configured provider instance
- **THEN** the task thread uses that selection instead of the parent's

#### Scenario: Rejected by limits

- **WHEN** the create is rejected for concurrency, lifetime cap, nesting, parent eligibility, or
  provider readiness
- **THEN** the tool returns a structured error naming the reason so the agent can adapt instead of
  retrying blindly

#### Scenario: Call does not block

- **WHEN** `task_create` succeeds
- **THEN** the tool result is returned immediately with status `queued` or `running` and does not
  wait for the task's result

### Requirement: List a thread's tasks from a provider tool call

The system SHALL expose a `task_list` tool that returns the calling thread's tasks with enough state
for the agent to decide whether to wait or proceed.

#### Scenario: Listing tasks

- **WHEN** the agent calls `task_list`
- **THEN** the system returns each task's thread id, title, status, creator, created timestamp, and
  result summary when the task has finished

#### Scenario: No tasks

- **WHEN** the calling thread owns no tasks
- **THEN** the tool returns an empty list rather than an error

#### Scenario: Filtering by status

- **WHEN** the agent calls `task_list` with a `status`
- **THEN** only the calling thread's tasks in that state are returned, and omitting `status` returns
  all of them

#### Scenario: Scope isolation

- **WHEN** the agent calls `task_list`
- **THEN** only tasks owned by the invocation scope's thread are returned

### Requirement: Cancel a task from a provider tool call

The system SHALL expose a `task_cancel` tool that cancels one of the calling thread's tasks.

#### Scenario: Cancelling a running task

- **WHEN** the agent calls `task_cancel` with a running task's thread id
- **THEN** the system dispatches `thread.task.cancel`, the task's turn is interrupted, and the tool
  returns the resulting status

#### Scenario: Cancelling a task owned by another thread

- **WHEN** the supplied thread id is not a task of the invocation scope's thread
- **THEN** the tool returns a not-found error and cancels nothing

#### Scenario: Cancelling an already-settled task

- **WHEN** the supplied task is already `finished`, `failed`, or `cancelled`
- **THEN** the tool succeeds as a no-op and returns the current status

### Requirement: Report task delegation in the agent's own transcript

Task creation and completion driven by an agent SHALL be observable in the parent thread without
requiring the agent to narrate them.

#### Scenario: Agent-created task appears in the parent

- **WHEN** `task_create` succeeds
- **THEN** the parent thread receives a `task.created` activity carrying the task thread id, title,
  creator `agent`, and context kind

#### Scenario: Agent-created task finishes

- **WHEN** an agent-created task's result is delivered
- **THEN** the parent thread receives a `task.finished` activity carrying the task thread id, title,
  outcome, and delivery state
