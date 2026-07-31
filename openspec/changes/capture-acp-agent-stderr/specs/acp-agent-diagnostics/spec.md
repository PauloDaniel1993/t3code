## ADDED Requirements

### Requirement: Every ACP agent's stderr is consumed for the life of its session

The ACP session runtime SHALL consume the agent child process's stderr from the moment the runtime
is built until its scope closes. Consumption SHALL NOT be conditional on the provider, and the
stderr pipe SHALL NOT be left unread.

#### Scenario: Agent writes to stderr during a session

- **WHEN** an ACP agent writes diagnostic output to stderr while a session is live
- **THEN** the runtime consumes it rather than leaving the pipe unread

#### Scenario: Agent writes nothing to stderr

- **WHEN** an ACP agent produces no stderr output
- **THEN** session behavior is unchanged and no diagnostic context is attached to anything

#### Scenario: Session scope closes

- **WHEN** the session runtime's scope closes
- **THEN** the stderr reader is stopped and does not outlive the session

### Requirement: Retained stderr is bounded and keeps the most recent output

The runtime SHALL retain a bounded window of the most recent stderr per session. When the window is
exceeded, the oldest output SHALL be dropped. Retention SHALL NOT grow without bound for a
long-running or verbose agent.

#### Scenario: Agent exceeds the retention window

- **WHEN** an agent writes more stderr than the retention window holds
- **THEN** the oldest output is dropped and the most recent output is retained

#### Scenario: Long-running verbose session

- **WHEN** an agent logs continuously for the life of a long session
- **THEN** retained stderr stays within its bound

### Requirement: Agent diagnostics are attributed to failures

Adapter errors arising from spawning, starting, or prompting an ACP session SHALL carry the recent
stderr window as additional context. The existing error types and messages SHALL be preserved, so
callers that match on error tags are unaffected.

#### Scenario: Agent fails to spawn

- **WHEN** the agent process fails to start and writes an explanation to stderr
- **THEN** the resulting adapter error carries that output as context

#### Scenario: Session startup fails

- **WHEN** initialization, authentication, or session setup fails
- **THEN** the resulting adapter error carries the recent stderr window

#### Scenario: A turn fails

- **WHEN** a prompt fails and the agent wrote a reason to stderr
- **THEN** the failure surfaced for that turn carries that reason

#### Scenario: Failure with no stderr output

- **WHEN** a failure occurs and the agent wrote nothing to stderr
- **THEN** the error keeps its existing type and message with no diagnostic context attached

### Requirement: Agent stderr is recorded in the native event log

Captured stderr SHALL be recorded in the native event log alongside JSON-RPC traffic, identified as
process diagnostics rather than protocol messages, so a session transcript shows what the agent
reported.

#### Scenario: Native event logging is enabled

- **WHEN** an agent writes to stderr while native event logging is enabled
- **THEN** the output appears in the native event log distinguishable from JSON-RPC traffic

#### Scenario: Native event logging is disabled

- **WHEN** native event logging is not configured
- **THEN** stderr is still consumed and still available for error attribution

### Requirement: Captured stderr is redacted before it is retained or surfaced

Captured stderr SHALL be redacted for credential-shaped content before it is written to the native
event log, attached to an error, or otherwise persisted. Where redaction cannot be guaranteed, the
retention SHALL be documented as sensitive.

#### Scenario: Agent writes a token-shaped value to stderr

- **WHEN** an agent's stderr contains a value matching a credential pattern
- **THEN** the retained and logged output has that value redacted

#### Scenario: Device-code login output

- **WHEN** an agent's authentication flow writes exchange details to stderr
- **THEN** those details are redacted before being persisted to the native event log

### Requirement: Kimi's log-file failure scraper becomes a fallback behind stderr

The Kimi driver SHALL prefer a failure message recovered from captured stderr, and SHALL fall back
to its session log-file scraper only when stderr yields none. The source of a recovered message
SHALL be recorded so the scraper's continued necessity can be evaluated.

#### Scenario: Stderr carries the turn failure

- **WHEN** a Kimi turn fails and its stderr contains the failure reason
- **THEN** the message shown to the user comes from stderr and the log file is not required

#### Scenario: Only the log file carries the turn failure

- **WHEN** a Kimi turn fails, stderr yields no message, and the session log file does
- **THEN** the log-file message is used and the fallback is recorded as the source

#### Scenario: Neither source yields a message

- **WHEN** a Kimi turn fails and neither stderr nor the log file yields a message
- **THEN** the existing generic failure message is used
