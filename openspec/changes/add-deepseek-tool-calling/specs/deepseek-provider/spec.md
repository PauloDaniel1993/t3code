## ADDED Requirements

### Requirement: Execute DeepSeek tool calls through T3-owned tools

The DeepSeek provider SHALL expose eligible T3 Code tools to DeepSeek through the
OpenAI-compatible Chat Completions tool-call shape when the selected provider instance, model, and
MCP capability scope support tools.

#### Scenario: Tool definitions are sent to DeepSeek

- **WHEN** a DeepSeek session has an eligible provider-scoped MCP credential and the selected model
  supports tool calls
- **THEN** the DeepSeek request includes tool definitions derived from eligible T3 Code tool metadata
- **AND** the request does not include tools outside the credential's capabilities

#### Scenario: No tools are advertised without capability

- **WHEN** a DeepSeek session lacks provider-scoped MCP credentials or the selected model does not
  support tool calls
- **THEN** the DeepSeek request does not include tool definitions
- **AND** tool-dependent behavior remains unsupported through a typed provider error

### Requirement: DeepSeek tool calls complete as one bounded turn

The DeepSeek adapter SHALL execute model-requested tool calls in bounded rounds, append tool result
messages to the local transcript, and continue the DeepSeek completion loop until the model returns
a final assistant message or the configured tool-call limit is reached.

#### Scenario: Successful tool call round

- **WHEN** DeepSeek returns an assistant message containing valid tool calls
- **THEN** the adapter executes each authorized tool call
- **AND** appends one tool result message per tool call to the model transcript
- **AND** sends the updated transcript back to DeepSeek before completing the turn

#### Scenario: Tool call loop limit is reached

- **WHEN** DeepSeek continues requesting tool calls after the configured maximum number of
  tool-call rounds
- **THEN** the adapter fails the turn with a provider-visible runtime error
- **AND** the adapter does not persist the partial tool-call transcript into the resume cursor

#### Scenario: Malformed tool call is rejected

- **WHEN** DeepSeek returns a tool call with an unknown tool name, invalid JSON arguments, or
  arguments that fail the tool schema
- **THEN** the adapter returns a typed provider runtime error naming the malformed tool call
- **AND** the adapter does not execute any unauthorized or invalid tool action

### Requirement: DeepSeek tool transcripts are resumable

The DeepSeek adapter SHALL persist successful tool-call transcripts in its versioned resume cursor
and SHALL preserve the existing rule that failed or interrupted turns do not update the cursor.

#### Scenario: Successful tool transcript persists

- **WHEN** a DeepSeek turn executes one or more tool calls and then completes with a final assistant
  response
- **THEN** the resume cursor contains the user message, assistant tool-call message, tool result
  messages, and final assistant message in model-visible order

#### Scenario: Interrupted tool turn is not persisted

- **WHEN** the user interrupts a DeepSeek turn while a tool-call round or follow-up completion is in
  progress
- **THEN** the adapter emits an interrupted turn completion
- **AND** the resume cursor remains at the last successfully completed turn

## MODIFIED Requirements

### Requirement: Limit unsupported DeepSeek capabilities

The DeepSeek provider SHALL NOT claim support for provider-native file edits, provider-native
approvals, or provider-native user-input request events. DeepSeek tool support SHALL be limited to
eligible T3 Code tools exposed through the provider-scoped capability path, and unavailable or
unauthorized tool capabilities SHALL fail through typed unsupported responses.

#### Scenario: Provider-native file edit requested

- **WHEN** a DeepSeek turn would require provider-native file edits outside an authorized T3 Code
  tool call
- **THEN** the provider reports the capability as unsupported instead of emitting partial file-edit
  behavior

#### Scenario: Provider-native approval or user input requested

- **WHEN** a DeepSeek session would require provider-native approval or user-input events outside an
  authorized T3 Code tool call
- **THEN** the provider does not emit provider-native approval or user-input events and reports
  unsupported behavior through the provider capability path

#### Scenario: Unauthorized tool capability requested

- **WHEN** DeepSeek requests a tool that is not present in the session's provider-scoped capability
  set
- **THEN** the adapter rejects the tool call with a provider-visible error
- **AND** the adapter does not execute the unauthorized tool
