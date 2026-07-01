## ADDED Requirements

### Requirement: Steering into a running turn is accepted

While a turn is running (`phase === "running"`) and the thread has an active turn, the composer SHALL accept a follow-up message (a "steer") submitted via the send action (Enter or the submit handler) and dispatch it to the provider as a continuation of the running turn.

#### Scenario: Steer while running

- **WHEN** a turn is running and the user submits a non-empty composer message
- **THEN** the message is dispatched to the provider
- **AND** the message appears optimistically in the timeline
- **AND** the running turn continues (no new turn boundary is created)

#### Scenario: Empty steer is ignored

- **WHEN** a turn is running and the user submits with no sendable content
- **THEN** no message is dispatched and no busy state is engaged

### Requirement: Consecutive steers are not blocked

The composer's "send busy" lock SHALL clear once the server has recorded a steered message, so that a subsequent steer can be submitted while the same turn is still running. The lock MUST NOT remain engaged for the entire remaining duration of the running turn after a steer.

#### Scenario: Second steer during the same turn

- **WHEN** the user steers once into a running turn and the server records that steered message
- **AND** the turn is still running
- **THEN** the composer becomes ready to send again
- **AND** the user can submit a second steer into the same turn

#### Scenario: Busy state self-clears without a turn change

- **WHEN** a steer is dispatched into a running turn whose `turnId`, `requestedAt`, `startedAt`, and `completedAt` do not change as a result of the steer
- **THEN** the send-busy state SHALL still clear once the steered message is acknowledged (or after a bounded fallback) rather than waiting for the turn to complete

### Requirement: Steer submission gives consistent feedback

The composer SHALL provide consistent, observable feedback for a steer: an accepted steer shows the user's message and re-enables input; a rejected/ignored submission does not silently leave the composer in an inconsistent state.

#### Scenario: Accepted steer feedback

- **WHEN** a steer is accepted
- **THEN** the composer input is cleared and re-enabled for the next message once acknowledged

#### Scenario: Double-submit guard

- **WHEN** the user triggers submit twice in immediate succession (e.g. a repeated Enter) for a single steer
- **THEN** only one message is dispatched
