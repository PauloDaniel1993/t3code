## ADDED Requirements

### Requirement: Canonical task payloads preserve SDK metadata

The canonical `task.started`, `task.progress`, and `task.completed` payloads SHALL preserve, when present in the provider message: `taskId`, `toolUseId`, `taskType`, `subagentType`, `workflowName`, `prompt`, `skipTranscript`, `outputFile`, and structured usage (`totalTokens`, `toolUses`, `durationMs`).

#### Scenario: Claude task_started message arrives

- **WHEN** the Claude adapter receives a `task_started` system message with `subagent_type` and `workflow_name`
- **THEN** the emitted canonical `task.started` payload carries those values in typed fields

#### Scenario: Claude task_progress message arrives with usage

- **WHEN** a `task_progress` message includes `usage.total_tokens`, `usage.tool_uses`, and `usage.duration_ms`
- **THEN** the canonical `task.progress` payload carries a typed usage object with those values

### Requirement: Tool progress carries typed task correlation

The canonical `tool.progress` payload SHALL carry an optional typed `taskId` field when the provider message includes one; correlation SHALL NOT be encoded in the free-form `summary` field.

#### Scenario: A tool runs inside a task

- **WHEN** a `tool_progress` message includes a `task_id`
- **THEN** the canonical `tool.progress` payload includes `taskId` as a typed field

### Requirement: Work-log derivation preserves task identity and status

Web work-log derivation SHALL preserve `taskId`, `taskType`, and usage metadata from task activity payloads, and SHALL infer an `inProgress` lifecycle status for `task.started` and `task.progress` entries lacking explicit status.

#### Scenario: Task lifecycle events for one task

- **WHEN** `task.started`, `task.progress`, and `task.completed` activities arrive for the same `taskId`
- **THEN** the derived entries collapse into one entry carrying that `taskId` and the final lifecycle status ("completed", "failed", or "stopped")

### Requirement: Task entries render as task cards

Work entries with a `taskId` SHALL render as distinct task/subagent cards (status badge, task styling) rather than generic tool rows, in both the timeline and the pinned workflow activity card.

#### Scenario: Task entry reaches the UI

- **WHEN** a work entry has `taskId` set
- **THEN** it renders with task-card styling and a lifecycle status badge

### Requirement: Task entries are not filtered as neutral

Neutral-status filtering SHALL NOT hide task entries solely because their tone is "info" or "thinking" or their status is `inProgress`.

#### Scenario: In-progress task entry with info tone

- **WHEN** `deriveWorkLogEntries` processes a `task.progress` activity with tone "info"
- **THEN** the resulting entry is visible (not classified as neutral/empty)
