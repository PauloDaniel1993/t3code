## ADDED Requirements

### Requirement: Configure Kimi as a first-class subscription provider

The system SHALL register a built-in `kimi` driver backed by the current Kimi Code CLI, SHALL keep the default Kimi instance disabled until the user enables it, and SHALL support multiple independently configured Kimi instances. Kimi settings SHALL include an executable path defaulting to `kimi`, an optional Kimi Code home path, and custom model fallbacks. The provider SHALL use Kimi Code membership authentication rather than requiring a Moonshot or Kimi Platform API key.

#### Scenario: Decode settings without Kimi configuration

- **WHEN** server settings created before the Kimi driver are decoded
- **THEN** decoding succeeds with a disabled default Kimi configuration and leaves all existing provider settings and explicit provider instances unchanged

#### Scenario: Add a Kimi instance

- **WHEN** a user adds and enables a Kimi provider instance
- **THEN** the instance is registered under driver kind `kimi` and its identity, settings, environment, status, models, and sessions remain scoped to that provider instance

#### Scenario: Select a ready Kimi provider

- **WHEN** an enabled Kimi instance and model are ready
- **THEN** Kimi appears in the normal provider/model picker, text-generation model selection, and provider handoff target selection

### Requirement: Use upstream-owned Kimi Code subscription authentication

The system SHALL use the Kimi Code CLI's existing OAuth-managed membership credentials. T3 Code MUST NOT request, persist, copy, return, or log Kimi OAuth access or refresh tokens, and a readiness probe MUST NOT initiate an interactive login or consume a model request.

#### Scenario: Authenticated subscription is ready

- **WHEN** `kimi acp` initializes successfully and ACP authentication method `login` accepts the CLI's stored credentials
- **THEN** the provider reports authenticated readiness without importing the credentials into T3 Code

#### Scenario: Kimi CLI is not installed

- **WHEN** the configured Kimi executable cannot be resolved or launched
- **THEN** the provider reports an unavailable installation state with actionable Kimi Code CLI installation guidance

#### Scenario: Kimi CLI is signed out

- **WHEN** ACP authentication reports that credentials are required
- **THEN** the provider reports an unauthenticated state, instructs the user to run `kimi login` for the same Kimi Code home, and does not start a provider session

#### Scenario: Kimi ACP is unavailable

- **WHEN** the executable is installed but does not support the required ACP handshake or capabilities
- **THEN** the provider reports an actionable incompatible-runtime state distinct from missing installation and missing authentication

### Requirement: Isolate configurable Kimi Code homes

The system SHALL map a non-empty Kimi home setting to `KIMI_CODE_HOME` for every probe, ACP session, and auxiliary generation process belonging to that instance. A blank setting SHALL preserve the Kimi CLI default. Instances with different Kimi Code homes SHALL NOT share Kimi-managed credentials, configuration, sessions, logs, or update state through T3 Code.

#### Scenario: Use a custom Kimi Code home

- **WHEN** a Kimi instance is configured with a custom home path
- **THEN** every Kimi child process for that instance receives the same resolved `KIMI_CODE_HOME`

#### Scenario: Separate subscription accounts

- **WHEN** two Kimi instances use different Kimi Code home paths
- **THEN** authentication and native session state from one instance are not used to make the other instance ready or resumable

#### Scenario: Share the default Kimi Code home deliberately

- **WHEN** multiple Kimi instances use the same blank or explicit Kimi Code home
- **THEN** the UI does not claim credential isolation between those instances and each instance remains a distinct T3 routing identity

### Requirement: Drive Kimi sessions through negotiated ACP capabilities

The Kimi adapter SHALL launch the documented `kimi acp` entry point, initialize ACP, validate authentication with method `login`, and create or resume native sessions for the requested working directory. It SHALL negotiate capabilities rather than assuming support from a version string alone and SHALL convert protocol failures into typed provider errors.

#### Scenario: Start a new Kimi session

- **WHEN** T3 Code starts a thread without a Kimi resume cursor
- **THEN** the adapter initializes and authenticates ACP, creates a native session for the thread working directory, and emits canonical session-started, thread-started, and ready events

#### Scenario: Resume a Kimi session

- **WHEN** T3 Code starts a thread with a valid Kimi resume cursor
- **THEN** the adapter resumes the referenced native session without replaying duplicate history already owned by T3 Code

#### Scenario: Reject an invalid resume cursor

- **WHEN** a Kimi resume cursor has an unsupported version, invalid native session identifier, or belongs to an incompatible provider instance
- **THEN** session start fails with a typed validation error and does not silently create or attach to another native session

#### Scenario: Stop a Kimi session

- **WHEN** a Kimi session is stopped or its provider scope closes
- **THEN** the adapter cancels in-flight work, resolves pending approval and user-input requests safely, terminates the ACP subprocess, and releases local resources even though upstream ACP does not implement `session/close`

### Requirement: Preserve Kimi model and mode semantics

The provider SHALL derive account-available model, thinking, and mode choices from Kimi ACP configuration options when available, preserve provider-reported identifiers and labels, and merge configured custom models only as explicit fallbacks or additions. A requested model or option MUST be applied through ACP before the prompt and MUST NOT silently fall back to a different selection.

#### Scenario: Discover subscription model options

- **WHEN** Kimi reports model and thinking options for an authenticated session
- **THEN** T3 Code exposes those options on the bound Kimi instance without claiming access to models that Kimi did not report for the account

#### Scenario: Apply a selected model

- **WHEN** a turn specifies a Kimi model and option selections supported by the session
- **THEN** the adapter applies the corresponding ACP configuration options before sending the prompt and reports the effective selection in canonical state

#### Scenario: Requested model is unavailable

- **WHEN** the requested Kimi model or option is not present in the current ACP configuration options
- **THEN** the turn fails with an actionable provider validation error instead of silently using Kimi's default

#### Scenario: Map interaction mode

- **WHEN** the requested T3 interaction or runtime mode has a compatible mode or permission option advertised by Kimi
- **THEN** the adapter selects that upstream option and otherwise leaves the upstream mode unchanged without fabricating support

### Requirement: Map Kimi turns, tools, permissions, and user input canonically

The adapter SHALL map Kimi ACP assistant chunks, plans, tool lifecycle updates, permission requests, and question elicitation into canonical provider runtime events. It SHALL preserve one logical active T3 turn while steering is supported, reject unsafe concurrent sends otherwise, and return to ready state after completed, failed, cancelled, or interrupted work. Kimi SHALL remain able to use subagents. When the current response depends on delegated results, the provider interaction SHALL keep those subagents in the active ACP prompt, may run independent subagents concurrently, and SHALL synthesize their results before ending the turn. T3 Code MUST NOT represent detached background work as durably supervised when Kimi ACP has not published its lifecycle.

#### Scenario: Stream a successful turn

- **WHEN** Kimi streams assistant content and tool updates for a prompt
- **THEN** T3 Code emits one turn-started event, ordered content and tool events, one terminal turn-completed event, and a ready session state

#### Scenario: Request tool approval

- **WHEN** Kimi requests permission for a tool action in approval-required mode
- **THEN** T3 Code emits a canonical approval request, sends the user's selected upstream-compatible outcome, and records the resolved request without auto-approving it

#### Scenario: Request structured user input

- **WHEN** Kimi uses the ACP permission channel to elicit one or more answers
- **THEN** T3 Code emits a canonical user-input request and maps the submitted answers back to the pending ACP request rather than treating it as a binary tool approval

#### Scenario: Interrupt an active turn

- **WHEN** the user interrupts a running Kimi turn
- **THEN** the adapter sends ACP cancellation, settles pending interaction requests, emits interrupted completion exactly once, and keeps the last successfully resumable native session cursor

#### Scenario: Ignore an unknown non-critical update

- **WHEN** Kimi emits an unrecognized ACP update that is not required to preserve session correctness
- **THEN** the adapter records a redacted diagnostic and continues processing without crashing the provider event stream

#### Scenario: Delegate required work to subagents

- **WHEN** Kimi delegates independent investigations whose results are required to answer the current user request
- **THEN** it may run the subagents concurrently but keeps them in foreground mode, receives their results inside the active ACP prompt, and returns a synthesized user-facing response before the turn completes

#### Scenario: Render a Kimi subagent invocation

- **WHEN** Kimi ACP emits an `Agent` tool invocation with subagent input
- **THEN** T3 Code renders it as a canonical collaboration-agent tool activity with a concise description rather than a generic tool card containing the full delegated prompt

#### Scenario: Encounter an existing detached completion

- **WHEN** a resumed Kimi native session already contains completed background-agent notifications or results that were not surfaced through ACP
- **THEN** the next prompt directs Kimi to synthesize those pending results before performing unrelated status work, without claiming T3 observed an authoritative background-task lifecycle

### Requirement: Deliver only negotiated attachments and MCP transports

The Kimi provider SHALL map prompt attachments and MCP servers only through capabilities negotiated with the running ACP agent. It SHALL support text and images when advertised, MUST NOT infer audio, video, binary-resource, or MCP transport support from Kimi's non-ACP clients, and SHALL reject unsupported inputs before sending a partial prompt.

#### Scenario: Send an image attachment

- **WHEN** Kimi advertises ACP image prompt support and the user attaches a supported image
- **THEN** the adapter sends a base64 image content block with its MIME type and preserves any accompanying text

#### Scenario: Send a text resource

- **WHEN** Kimi advertises embedded-resource support and the user attaches a text resource supported by T3 Code
- **THEN** the adapter sends a text resource or resource link without exposing unrelated local file contents

#### Scenario: Reject an unsupported attachment

- **WHEN** a prompt contains an audio, video, or binary attachment not advertised by the active Kimi ACP capabilities
- **THEN** the send fails with an actionable validation error before any partial prompt is dispatched

#### Scenario: Forward MCP configuration

- **WHEN** a Kimi session is created with MCP servers
- **THEN** T3 Code forwards only transports supported by both T3 Code and the negotiated Kimi ACP runtime and reports omitted transports without leaking MCP credentials

### Requirement: Provide Kimi-backed auxiliary text generation

The Kimi driver SHALL provide structured auxiliary text generation for features such as thread titles, branch names, commit or change-request text, and handoff summaries by using the same authenticated ACP runtime and shared structured-generation safeguards as other provider drivers. Auxiliary generation SHALL use a session isolated from user conversation context and SHALL enforce cancellation, timeout, output validation, and secret-safe logging.

#### Scenario: Generate valid structured text

- **WHEN** a caller requests structured text from a ready Kimi model
- **THEN** the provider returns locally validated structured output without adding the auxiliary prompt or response to a user-visible T3 thread

#### Scenario: Auxiliary generation fails

- **WHEN** Kimi times out, is interrupted, returns malformed structured output, or loses authentication during generation
- **THEN** the operation fails with a typed text-generation error and releases the scoped ACP process and pending requests

#### Scenario: Hand off to Kimi

- **WHEN** a ready Kimi instance and model are selected as a handoff target
- **THEN** handoff compression may use Kimi text generation, while the target thread starts a fresh Kimi native session and never receives the source provider's native resume cursor

### Requirement: Report and maintain the supported Kimi Code CLI safely

The provider SHALL report the installed Kimi Code CLI version, publish update advisories without blocking an otherwise compatible runtime, and expose only documented update actions supported by the detected installation. T3-managed Kimi child processes SHALL disable upstream background self-update so an executable does not change during an active provider session.

#### Scenario: Probe the installed version

- **WHEN** the configured executable responds to `kimi --version`
- **THEN** the provider snapshot includes the parsed version and still uses ACP capability negotiation to determine compatibility

#### Scenario: Update information is unavailable

- **WHEN** the latest-version check fails but the installed CLI passes the required ACP handshake
- **THEN** Kimi remains ready and the snapshot reports only a non-blocking update warning

#### Scenario: Run an explicit update

- **WHEN** the user invokes a supported Kimi update action
- **THEN** provider maintenance serializes the documented update command, does not mutate active sessions concurrently, refreshes status afterward, and falls back to manual guidance for unsupported installation sources or platforms

### Requirement: Present Kimi consistently across client surfaces

The web client SHALL register Kimi presentation metadata and a provider icon, render its schema-driven instance settings and status, and distinguish disabled, missing, unauthenticated, incompatible, updating, and ready states. The mobile client SHALL render Kimi with its own provider identity and model labels rather than an unrelated provider fallback. Existing providers and unknown driver kinds SHALL continue to render and route as before.

#### Scenario: Configure Kimi in provider settings

- **WHEN** the user opens provider settings or the add-provider-instance dialog
- **THEN** Kimi is available as a driver choice with fields for its supported executable, home, environment, identity, and enabled state

#### Scenario: Explain why Kimi is unavailable

- **WHEN** a Kimi instance is not ready
- **THEN** its card and model-picker state show the specific actionable installation, login, compatibility, or update reason without exposing credentials or raw ACP payloads

#### Scenario: Render a Kimi thread on mobile

- **WHEN** the mobile client receives a thread or model snapshot for driver `kimi`
- **THEN** it shows Kimi-specific provider identity and model presentation while preserving generic provider-instance routing

#### Scenario: Preserve existing provider behavior

- **WHEN** the client receives settings or snapshots that contain no Kimi instance or contain an unknown provider driver
- **THEN** existing provider ordering, selection, icons, settings round-tripping, and unknown-driver fallback behavior remain compatible
