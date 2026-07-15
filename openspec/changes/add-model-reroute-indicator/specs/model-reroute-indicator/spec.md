## ADDED Requirements

### Requirement: Detect explicit safety-refusal fallback

The Claude provider adapter SHALL detect the Claude Agent SDK's `model_refusal_fallback` system message and SHALL emit a `model.rerouted` provider-runtime event carrying the original model, the fallback model, reason `refusal`, and the refusal category and explanation when the SDK provides them.

#### Scenario: Fallback system message received during a turn

- **WHEN** the SDK stream delivers a system message with subtype `model_refusal_fallback` (original model `claude-fable-5`, fallback model `claude-opus-4-8`)
- **THEN** the adapter emits exactly one `model.rerouted` event for the turn with `fromModel: claude-fable-5`, `toModel: claude-opus-4-8`, `reason: refusal`, and any provided category/explanation

### Requirement: Detect sticky session model swap on subsequent turns

Because the SDK's refusal fallback swap persists for the session without further fallback messages, the adapter SHALL compare the serving model reported on top-level assistant messages against the requested model on every turn, and SHALL emit a `model.rerouted` event with reason `session-model-swap` when they differ. The comparison MUST tolerate requested-model slugs (including a `[1m]` context suffix) against fully versioned served-model ids by comparing on the stripped slug prefix. At most one such event SHALL be emitted per turn.

#### Scenario: Later turn in a session that already swapped

- **WHEN** a turn requests `claude-fable-5` and the first top-level assistant message reports a serving model of the `claude-opus-4-8` family, with no fallback system message in that turn
- **THEN** the adapter emits exactly one `model.rerouted` event with `reason: session-model-swap`

#### Scenario: Requested slug with context suffix matches served versioned id

- **WHEN** the requested model is `claude-fable-5[1m]` and the assistant message reports a serving model whose id begins with `claude-fable-5`
- **THEN** no `model.rerouted` event is emitted

### Requirement: Subagent model usage does not trigger detection

Assistant messages nested under a tool or subagent (non-null `parent_tool_use_id`) SHALL be excluded from serving-model comparison, and aggregate per-model usage totals MUST NOT be used as a reroute signal.

#### Scenario: Subagent runs on a different model

- **WHEN** a turn requested on `claude-fable-5` spawns a subagent whose assistant messages report a different model, while all top-level assistant messages report `claude-fable-5`
- **THEN** no `model.rerouted` event is emitted and no message is badged

### Requirement: Reroute is persisted on exactly one assistant message per turn

The orchestration layer SHALL attach the reroute payload (`fromModel`, `toModel`, `reason`, optional `category`/`explanation`) to exactly one assistant message of the affected turn, persist it in message storage, and preserve it across subsequent streaming upserts of the same message. The stored value SHALL be included in thread snapshots so it survives client reloads. Messages created before this capability exists SHALL remain valid with no reroute value.

#### Scenario: Reroute survives reload

- **WHEN** a rerouted turn completes and the user reloads the thread
- **THEN** the same single assistant message still carries the reroute information

#### Scenario: Streaming upsert after attachment

- **WHEN** a message that already carries reroute information receives a later streaming update without it
- **THEN** the stored reroute information is preserved unchanged

#### Scenario: Historical message without reroute data

- **WHEN** a thread containing messages persisted before this capability is loaded
- **THEN** those messages decode successfully and display no reroute indicator

### Requirement: Rerouted messages display a persistent indicator

The web chat timeline SHALL render a badge on the assistant message carrying reroute information, labeled with the human-readable name of the serving model (falling back to the raw model id for unknown models), and SHALL expose the origin model and any refusal category/explanation via a tooltip.

#### Scenario: Badge on rerouted message

- **WHEN** an assistant message with reroute information `{fromModel: claude-fable-5, toModel: claude-opus-4-8}` is rendered
- **THEN** the message shows a badge reading "Rerouted to Opus 4.8" whose tooltip identifies the requested model and, when present, the refusal category and explanation

#### Scenario: Unrerouted message shows nothing

- **WHEN** an assistant message without reroute information is rendered
- **THEN** no reroute badge is shown
