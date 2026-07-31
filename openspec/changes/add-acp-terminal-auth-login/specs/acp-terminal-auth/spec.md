## ADDED Requirements

### Requirement: Advertised terminal auth methods are captured during the readiness probe

The ACP readiness probe SHALL retain the `authMethods` returned by `initialize`, including any
`_meta["terminal-auth"]` descriptor, and SHALL expose the available terminal auth method on the
provider snapshot. A provider that advertises no terminal auth method SHALL report none.

#### Scenario: Agent advertises a terminal auth method

- **WHEN** the readiness probe receives an auth method of type `terminal` carrying a
  `terminal-auth` descriptor with a command
- **THEN** the provider snapshot reports that method with its label and resolved command

#### Scenario: Agent advertises no terminal auth method

- **WHEN** the readiness probe receives auth methods that contain no terminal descriptor
- **THEN** the provider snapshot reports no terminal auth method and the card keeps its manual
  instructions

#### Scenario: Descriptor is malformed

- **WHEN** a terminal descriptor is present but has no usable command
- **THEN** the provider snapshot reports no terminal auth method rather than a partial one

### Requirement: An unauthenticated provider offers a supervised login action

T3 Code SHALL offer a login action for a provider instance that is installed, reports an
unauthenticated state, and advertises a terminal auth method. The action SHALL show the resolved
command before running it and SHALL require an explicit user action to start. T3 Code SHALL run only
the command the agent advertised.

#### Scenario: Installed but unauthenticated provider

- **WHEN** a provider instance is installed, unauthenticated, and advertises a terminal auth method
- **THEN** the card offers a login action showing the command that will run

#### Scenario: Already authenticated provider

- **WHEN** a provider instance reports an authenticated state
- **THEN** no login action is offered

#### Scenario: Provider is not installed

- **WHEN** the provider CLI is missing or fails its version probe
- **THEN** no login action is offered and the card keeps its installation guidance

#### Scenario: User does not start the login

- **WHEN** the login action is offered but not activated
- **THEN** no process is spawned

### Requirement: Login runs in the provider instance's environment

The login command SHALL run with the provider instance's resolved process environment — the same one
used to spawn its ACP session, including any configured agent home — overlaid with the descriptor's
own environment entries. The command SHALL run in an interactive terminal surface with no execution
timeout.

#### Scenario: Instance uses a custom agent home

- **WHEN** a provider instance is configured with a custom home and the user starts its login
- **THEN** the login command runs with that home set, so the credential lands in the home the
  instance uses

#### Scenario: Descriptor sets its own environment entry

- **WHEN** the terminal descriptor declares an environment entry that also exists in the instance
  environment
- **THEN** the descriptor's value is used

#### Scenario: User takes several minutes to complete a device-code flow

- **WHEN** the login process stays alive while the user completes an external browser step
- **THEN** T3 Code does not terminate it

### Requirement: Provider readiness is re-probed when the login process exits

When the login process exits, T3 Code SHALL re-run the provider readiness check once and publish
the resulting snapshot, without requiring a manual refresh.

#### Scenario: Login succeeds

- **WHEN** the login process exits and the agent now reports an authenticated state
- **THEN** the provider card shows the authenticated state without a manual refresh

#### Scenario: Login is abandoned or fails

- **WHEN** the login process exits without authenticating
- **THEN** the provider card returns to its unauthenticated state and the login action stays
  available

### Requirement: T3 Code does not handle the resulting credentials

T3 Code SHALL NOT read, store, forward, log, or display any token, code, or credential produced by
the login flow. Credential ownership SHALL remain entirely with the provider CLI.

#### Scenario: Login flow prints a device code

- **WHEN** the login process prints a device code or token to its terminal
- **THEN** T3 Code renders the terminal output without capturing the value into provider state,
  settings, or logs
