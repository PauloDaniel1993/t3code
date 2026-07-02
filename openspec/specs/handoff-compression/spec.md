## Purpose

Define model selection, bounded summary generation, and caching behavior for provider handoff
compression.

## Requirements

### Requirement: Select a handoff compression model

The system SHALL add `handoffCompressionModelSelection: ModelSelection | null` to server settings.
The system SHALL treat `null` as automatic model resolution and SHALL keep the existing
`textGenerationModelSelection` behavior for existing auxiliary text-generation tasks.

#### Scenario: Automatic DeepSeek compression model

- **WHEN** handoff compression model selection is automatic and a ready DeepSeek default instance
  is available
- **THEN** the system uses `deepseek-v4-flash` for handoff compression

#### Scenario: Automatic fallback to text generation model

- **WHEN** handoff compression model selection is automatic and no ready DeepSeek default instance
  is available
- **THEN** the system falls back to the existing `textGenerationModelSelection`

#### Scenario: Explicit compression selection unavailable

- **WHEN** an explicit handoff compression model selection references an unavailable provider
  instance or model
- **THEN** the system falls back to automatic resolution and logs a warning without failing handoff

#### Scenario: Settings UI exposes compression model

- **WHEN** the user opens provider or generation settings
- **THEN** the UI shows a `Handoff compression model` row using the provider model picker and
  exposes automatic selection with the resolved model when possible

### Requirement: Generate bounded handoff summaries

The text generation service SHALL provide `generateHandoffSummary` for oversized imported messages
used in bootstrap context. The summarizer SHALL receive bounded input and SHALL produce sanitized
summaries no longer than 4,000 characters.

#### Scenario: Oversized imported message

- **WHEN** an individual imported message cannot fit in the remaining bootstrap context budget
- **THEN** the system generates a handoff summary for that message instead of passing the full text

#### Scenario: Summarizer input is bounded

- **WHEN** a source message is larger than the summarizer input budget
- **THEN** the system sends a deterministic head/tail sample of roughly 80,000 characters rather
  than the unbounded full message

#### Scenario: Summary preserves operational details

- **WHEN** the summarizer processes source message content
- **THEN** the prompt instructs it to preserve file paths, commands, error messages, design
  decisions, constraints, and unresolved tasks

#### Scenario: Summary output is malformed

- **WHEN** the compression provider returns malformed structured output
- **THEN** the system retries once and then falls back to deterministic truncation if the retry
  fails

### Requirement: Cache handoff summaries on target handoff metadata

The system SHALL cache generated handoff summaries in target thread handoff metadata using source
message id, model selection, and source text hash.

#### Scenario: Matching cached summary exists

- **WHEN** the target handoff metadata contains a summary with matching source message id, model
  selection, and source text hash
- **THEN** the system reuses the cached summary for bootstrap context

#### Scenario: Source text hash changes

- **WHEN** the source message text or attachment metadata hash does not match a cached summary
- **THEN** the system ignores the cached summary and generates or falls back to a new summary

#### Scenario: Cache write fails

- **WHEN** summary generation succeeds but writing compression metadata fails
- **THEN** the system logs the failure, continues the handoff send, and may regenerate on a later
  retry

#### Scenario: Compression provider fails

- **WHEN** compression fails after the allowed retry
- **THEN** the system uses deterministic head/tail truncation with a warning line and continues
  building bootstrap context
