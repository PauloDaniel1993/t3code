## ADDED Requirements

### Requirement: Configure DeepSeek as a first-class provider

The system SHALL provide a built-in `deepseek` provider with models `deepseek-v4-pro` and
`deepseek-v4-flash`. The provider SHALL appear in normal provider selection and handoff target
selection when enabled and ready.

#### Scenario: DeepSeek settings defaults

- **WHEN** provider settings are decoded without DeepSeek settings
- **THEN** the system initializes DeepSeek as disabled with default models and no custom models

#### Scenario: DeepSeek readiness

- **WHEN** DeepSeek is enabled and has an API key, base URL, context limit, and at least one model
- **THEN** the provider instance is ready for chat, text generation, and handoff target selection

#### Scenario: DeepSeek missing configuration

- **WHEN** DeepSeek is enabled but missing API key or base URL
- **THEN** the provider instance is not ready and the UI can show an actionable disabled reason

#### Scenario: DeepSeek model defaults

- **WHEN** a DeepSeek provider instance has no sticky model override
- **THEN** normal chat defaults to `deepseek-v4-pro` and automatic handoff compression can default
  to `deepseek-v4-flash`

### Requirement: Use an OpenAI-compatible DeepSeek API client

The system SHALL call DeepSeek through an Effect `HttpClient` based API layer using the
OpenAI-compatible Chat Completions shape. The system MUST NOT log DeepSeek API keys, full request
bodies, full prompts, full completions, or generated summaries.

#### Scenario: Normalizing base URL

- **WHEN** the configured DeepSeek base URL does not end in `/chat/completions`
- **THEN** the API layer appends `/chat/completions` after trimming trailing slashes

#### Scenario: Base URL already points at chat completions

- **WHEN** the configured DeepSeek base URL already ends in `/chat/completions`
- **THEN** the API layer uses the configured URL as-is

#### Scenario: Streaming chat response

- **WHEN** the chat adapter sends a streaming request
- **THEN** the API layer parses SSE `data:` lines, ignores comments and keepalives, reads assistant
  text from `choices[].delta.content`, and stops at `[DONE]`

#### Scenario: Non-streaming text generation

- **WHEN** text generation sends a DeepSeek request
- **THEN** the API layer uses a non-streaming request and validates the structured result locally

#### Scenario: API timeout

- **WHEN** a DeepSeek chat request runs longer than 10 minutes or a text generation request runs
  longer than 90 seconds
- **THEN** the system fails the request with a provider runtime error

### Requirement: Run DeepSeek chat sessions locally

The DeepSeek adapter SHALL create local sessions without a startup API probe and SHALL persist a
versioned local cursor only after successful completed sends.

#### Scenario: Starting a DeepSeek session

- **WHEN** the provider service starts a DeepSeek session
- **THEN** the adapter creates local session state, emits session started and ready state events,
  and does not call the remote API

#### Scenario: Sending a successful DeepSeek turn

- **WHEN** DeepSeek streams a complete assistant response
- **THEN** the adapter emits running, turn started, content delta, item completed, turn completed,
  and ready state events, and stores the successful user and assistant exchange in the resume cursor

#### Scenario: DeepSeek send fails

- **WHEN** a DeepSeek stream fails before a complete assistant message
- **THEN** the adapter emits a runtime error and failed turn completion and does not update the
  resume cursor

#### Scenario: DeepSeek send is interrupted

- **WHEN** the user interrupts an in-flight DeepSeek turn
- **THEN** the adapter aborts the stream, emits interrupted completion, and does not update the
  resume cursor

#### Scenario: DeepSeek cursor is corrupt

- **WHEN** the provider service resumes a DeepSeek session with a corrupt cursor
- **THEN** `startSession` fails with a clear provider runtime error

#### Scenario: DeepSeek receives concurrent sends

- **WHEN** a DeepSeek session already has an in-flight send
- **THEN** the adapter rejects another send for that session

### Requirement: Limit unsupported DeepSeek capabilities

The DeepSeek v1 provider SHALL NOT claim support for tools, file edits, approvals, or user-input
requests. Unsupported capabilities SHALL fail through typed unsupported responses.

#### Scenario: Tool or file edit requested

- **WHEN** a DeepSeek turn would require provider-native tools or file edits
- **THEN** the provider reports the capability as unsupported instead of emitting partial file-edit
  behavior

#### Scenario: Approval or user input requested

- **WHEN** a DeepSeek session would require approval or user-input events
- **THEN** the provider does not emit approval or user-input events and reports unsupported
  behavior through the provider capability path
