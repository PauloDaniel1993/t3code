## ADDED Requirements

### Requirement: Structured user input supports ten-question batches

The system SHALL support a single structured user-input prompt containing between one and ten questions inclusive.

#### Scenario: Ten-question prompt is accepted

- **WHEN** an agent or provider requests structured user input with ten valid questions
- **THEN** the system records one pending user-input request containing all ten questions in the original order
- **AND** no question is dropped, merged, or split into a separate pending request

#### Scenario: Empty prompt is rejected

- **WHEN** an agent or provider requests structured user input with zero valid questions
- **THEN** the system rejects the request without creating a pending user-input request

### Requirement: User input batch limit is advertised to agents

The system SHALL advertise ten as the maximum number of questions for one `request_user_input` prompt wherever agent-facing tool metadata or developer instructions describe the tool.

#### Scenario: Agent sees ten-question maximum

- **WHEN** an agent receives the `request_user_input` tool definition or related usage instructions
- **THEN** the definition or instructions state that one prompt may include up to ten questions

### Requirement: T3 MCP user-input supersedes provider-native question tools

When the `t3-code` MCP `request_user_input` tool is attached to a provider session, the system SHALL reject provider-native structured question tools instead of opening the T3 pending-input UI through those native fallback paths.

#### Scenario: Provider-native question tool is rejected while T3 MCP is available

- **GIVEN** a provider session has the `t3-code` MCP `request_user_input` tool attached
- **WHEN** the provider attempts to use a provider-native structured question tool
- **THEN** the provider-native request is rejected with a provider-visible message directing the provider to the T3 MCP `request_user_input` tool
- **AND** the system does not create a pending user-input request from the provider-native fallback path

### Requirement: Over-limit batches fail predictably

The system MUST NOT silently truncate structured user-input prompts that contain more than ten questions.

#### Scenario: Eleven-question prompt is rejected

- **WHEN** an agent or provider requests structured user input with eleven valid questions
- **THEN** the system rejects the request or returns a provider-visible error that names the ten-question maximum
- **AND** the system does not create a partial pending user-input request

### Requirement: Ten-question answers resolve as one request

The system SHALL collect and submit answers for every question in a ten-question prompt through the existing `user-input.resolved` answer map.

#### Scenario: Ten answers are submitted

- **WHEN** the user answers all ten questions in a pending user-input request
- **THEN** the resolved answer payload contains one answer entry for each original question id
- **AND** the provider receives the resolved answers for the original request id

#### Scenario: Incomplete ten-question prompt cannot be submitted

- **WHEN** a pending user-input request has ten questions and at least one question remains unanswered
- **THEN** the client keeps the request incomplete and does not submit a resolved answer payload

### Requirement: Clients present ten-question prompts without layout loss

The web and mobile clients SHALL render ten-question pending-input prompts without clipping controls, losing answer state, or preventing navigation through the full prompt.

#### Scenario: Web progresses through ten questions

- **WHEN** the web composer receives a pending user-input request with ten questions
- **THEN** it shows the active question with a progress indicator for the ten-question total
- **AND** the user can advance from the first through the tenth question while preserving previous answers

#### Scenario: Mobile renders ten questions

- **WHEN** the mobile thread view receives a pending user-input request with ten questions
- **THEN** it renders all ten questions and their answer controls in the pending-input card or surrounding scroll view
