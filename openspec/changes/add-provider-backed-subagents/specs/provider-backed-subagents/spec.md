## ADDED Requirements

### Requirement: Subagent feature gating

The system SHALL expose provider-backed Subagents only when the server Subagents feature flag is enabled.

#### Scenario: Provider tools hidden while disabled

- **WHEN** Subagents are disabled in server settings and a provider session receives MCP credentials
- **THEN** the MCP credential MUST NOT include the `subagents` capability

#### Scenario: UI launch disabled while feature disabled

- **WHEN** Subagents are disabled in server settings and the user views an eligible thread
- **THEN** the UI MUST NOT allow launching a subagent from that thread

### Requirement: Durable child thread lifecycle

The system SHALL represent each launched subagent as a durable child thread in the same project as the parent thread.

#### Scenario: Successful launch creates child thread

- **WHEN** an eligible parent thread launches a subagent with an accepted effective policy
- **THEN** the system MUST create a child thread with parent thread id, parent turn id when available, subagent run id, target model selection, status, and optional profile id metadata

#### Scenario: Child thread uses normal provider execution

- **WHEN** a child thread is launched
- **THEN** the child MUST use normal thread message, turn-start, provider session, provider runtime event, checkpoint, and projection behavior

#### Scenario: Launch is replay stable

- **WHEN** the server replays orchestration events after restart
- **THEN** parent/child linkage, child status, and child result metadata MUST be reconstructed without in-memory launch state

### Requirement: Async model-facing Subagent tools

The system SHALL expose async Subagent MCP tools to eligible tool-capable parent provider sessions.

#### Scenario: Launch returns receipt

- **WHEN** a parent model calls `subagent_launch`
- **THEN** the tool MUST return a launch receipt containing parent thread id, child thread id or pending approval state, run id, effective profile/model, initial status, and navigation metadata

#### Scenario: Status returns current state

- **WHEN** a parent model calls `subagent_status` for a known child run
- **THEN** the tool MUST return the current run status, target model/profile, timestamps, and failure/cancel/timeout detail when present

#### Scenario: Read returns bounded result

- **WHEN** a parent model calls `subagent_read` for a completed, failed, cancelled, or timed-out child run
- **THEN** the tool MUST return status, child thread id/title, bounded summary or diagnostics, bounded key excerpts when available, and metadata linking to the child thread

#### Scenario: Cancel interrupts child

- **WHEN** a parent model calls `subagent_cancel` for a running child run
- **THEN** the system MUST request interruption of that child thread without interrupting the parent turn

### Requirement: Subagent launch eligibility

The system SHALL validate launch eligibility on the server before creating or starting child work.

#### Scenario: Child cannot launch nested child

- **WHEN** a thread that already has a parent thread id attempts to call `subagent_launch`
- **THEN** the system MUST reject the launch without creating another child thread

#### Scenario: Missing or unready target rejected

- **WHEN** a launch resolves to a missing, disabled, unknown, or not-ready provider instance
- **THEN** the system MUST reject the launch and return a structured reason

#### Scenario: Target allowlist enforced

- **WHEN** server settings restrict allowed subagent targets and a launch requests a provider instance outside that allowlist
- **THEN** the system MUST reject the launch and return a structured reason

### Requirement: Subagent context construction

The system SHALL build child prompts from explicit task input, profile instructions, parent metadata, and bounded parent context.

#### Scenario: Child receives bounded parent context

- **WHEN** a subagent is launched from a parent thread with existing messages
- **THEN** the child user message MUST include the requested task, effective profile instructions, parent thread metadata, and a bounded summary of relevant parent context

#### Scenario: Full parent transcript not imported

- **WHEN** a child thread is launched
- **THEN** the system MUST NOT copy the full parent transcript into the child as visible imported messages

#### Scenario: Summary model fallback

- **WHEN** `subagents.summaryModelSelection` is null
- **THEN** the system MUST resolve parent-context and child-result summaries through the existing text-generation model selection fallback

### Requirement: Subagent profiles and defaults

The system SHALL support settings-backed Subagent profiles and ad hoc launch overrides.

#### Scenario: Profile resolves launch defaults

- **WHEN** a launch references an enabled profile
- **THEN** the system MUST use the profile model selection, instructions, runtime default, timeout, and result summary budget unless an allowed launch override is supplied

#### Scenario: Disabled profile rejected

- **WHEN** a launch references a disabled or missing profile
- **THEN** the system MUST reject the launch and return a structured reason

#### Scenario: Ad hoc launch uses server defaults

- **WHEN** a launch does not reference a profile and omits a target model selection
- **THEN** the system MUST use `subagents.defaultModelSelection` when set and otherwise reject the launch as missing a target

### Requirement: Runtime policy and approvals

The system SHALL default subagents to read-only runtime and require policy approval for risky launches.

#### Scenario: Read-only launch auto-starts within limits

- **WHEN** a launch requests the default read-only runtime, passes all limits, and requires no policy approval
- **THEN** the system MUST create and start the child run without prompting the user

#### Scenario: Write-capable launch requires approval

- **WHEN** a launch requests write-capable runtime or another policy-restricted behavior
- **THEN** the system MUST create a parent-thread approval request and MUST NOT start provider work until the launch is accepted

#### Scenario: Declined launch does not start child provider work

- **WHEN** the user declines a pending subagent launch approval
- **THEN** the system MUST mark the run rejected or cancelled and MUST NOT start a child provider turn

### Requirement: Concurrency and timeout enforcement

The system SHALL enforce bounded concurrency and server-side timeouts for subagent runs.

#### Scenario: Per-parent concurrency limit enforced

- **WHEN** a parent turn has reached `subagents.maxConcurrentPerParentTurn`
- **THEN** additional launch attempts from that parent turn MUST be rejected or queued according to server policy without exceeding the limit

#### Scenario: Global concurrency limit enforced

- **WHEN** the environment has reached `subagents.maxConcurrentGlobal`
- **THEN** additional launch attempts MUST be rejected or queued according to server policy without exceeding the limit

#### Scenario: Timeout marks child timed out

- **WHEN** a child run exceeds its effective timeout
- **THEN** the system MUST interrupt the child thread when possible, mark the run `timed_out`, preserve partial transcript data, and append parent activity

### Requirement: Cancellation behavior

The system SHALL support explicit child cancellation and configurable parent-interrupt cascade.

#### Scenario: Child-only cancellation

- **WHEN** the user or parent model cancels a running child run directly
- **THEN** the system MUST interrupt that child thread and MUST NOT interrupt the parent thread

#### Scenario: Parent interrupt cascade enabled

- **WHEN** a parent thread is interrupted and effective subagent policy has `cancelChildrenOnParentInterrupt` enabled
- **THEN** the system MUST request interruption of running child runs associated with that parent turn

#### Scenario: Parent interrupt cascade disabled

- **WHEN** a parent thread is interrupted and effective subagent policy has `cancelChildrenOnParentInterrupt` disabled
- **THEN** running child runs MUST continue unless explicitly cancelled or timed out

### Requirement: Failure and result materialization

The system SHALL preserve failed, cancelled, and timed-out child run state and make bounded diagnostics available.

#### Scenario: Provider failure recorded

- **WHEN** a child provider turn fails
- **THEN** the system MUST mark the child run `failed`, preserve partial transcript data, append parent activity, and make diagnostics available through `subagent_read`

#### Scenario: Completed child summarized

- **WHEN** a child run completes successfully
- **THEN** the system MUST materialize a bounded result summary, mark the run `completed`, and make the summary available through UI and `subagent_read`

#### Scenario: Summary failure falls back to deterministic excerpt

- **WHEN** result summary generation fails
- **THEN** the system MUST retain completion status and provide a deterministic bounded fallback excerpt or diagnostic instead of failing the child run

### Requirement: Parent thread visibility

The system SHALL show subagent lifecycle in the parent thread without mutating provider-native parent messages.

#### Scenario: Parent timeline shows compact activity

- **WHEN** a subagent is launched, changes status, completes, fails, is cancelled, or times out
- **THEN** the parent thread timeline MUST show compact activity rows with status and child-thread links

#### Scenario: Parent transcript remains provider-native

- **WHEN** child results become available
- **THEN** the system MUST NOT insert child output as parent assistant or user messages

### Requirement: Sidebar and child management UI

The system SHALL expose child threads through sidebar hierarchy and parent-thread management UI.

#### Scenario: Sidebar nests child thread

- **WHEN** a parent thread has child subagent threads
- **THEN** the sidebar MUST be able to render those children under the parent using shell projection data

#### Scenario: Parent panel manages children

- **WHEN** the user views a parent thread with child runs
- **THEN** the UI MUST show child status, provider/model, profile when present, open-thread action, cancel action when running, and summary/read action when available

### Requirement: Persistence compatibility

The system SHALL persist subagent metadata through additive, decode-safe projection changes.

#### Scenario: Existing thread decodes without subagent fields

- **WHEN** an existing thread projection row has no subagent fields
- **THEN** the system MUST decode it with null parent/child metadata and no child status

#### Scenario: Child lookup uses indexed projection data

- **WHEN** the UI requests children for a parent thread
- **THEN** the system MUST support lookup through persisted parent linkage without hydrating every thread detail

### Requirement: Observability

The system SHALL record structured observability for subagent lifecycle and load behavior.

#### Scenario: Launch metrics recorded

- **WHEN** a subagent launch is accepted, rejected, queued, or approval-gated
- **THEN** the system MUST record structured logs and metrics with status, provider instance, model, profile when present, and reason labels when applicable

#### Scenario: Completion metrics recorded

- **WHEN** a child run completes, fails, is cancelled, or times out
- **THEN** the system MUST record duration, terminal status, provider instance, model, profile when present, and failure/timeout labels when applicable
