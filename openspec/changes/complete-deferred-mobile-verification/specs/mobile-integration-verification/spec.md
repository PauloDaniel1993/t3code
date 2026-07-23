## ADDED Requirements

### Requirement: Run mobile verification on an isolated representative device

The verification SHALL use one viable iOS Simulator or Android Emulator with the
`com.t3tools.t3code.dev` development client, a Metro bundle from the current worktree, and a
disposable T3 server base directory. The client MUST connect using a fresh single-use pairing
credential and MUST display a seeded project from that disposable environment before feature
scenarios begin.

#### Scenario: A compatible iOS Simulator is available

- **WHEN** verification runs on a macOS host with Xcode and a compatible T3 Code development client
- **THEN** the verifier uses one iOS Simulator, the `t3code-dev` scheme, the current worktree's Metro
  bundle, and the simulator-specific loopback server origin

#### Scenario: Android is the viable representative platform

- **WHEN** iOS is unavailable and an Android SDK, running emulator, and compatible T3 Code
  development client are available
- **THEN** the verifier uses that emulator, configures only test-owned reverse-port rules, loads the
  current worktree's `t3code-dev` Metro URL, and uses `10.0.2.2` for the server origin

#### Scenario: No representative device is viable

- **WHEN** the host lacks a usable SDK, simulator or emulator, or compatible development client
- **THEN** verification remains incomplete and records the missing prerequisite without marking any
  originating integration task complete

### Requirement: Verify bounded history and live activity behavior on mobile

The verification SHALL exercise a thread whose activity count exceeds the initial mobile history
window. It MUST prove that older pages prepend without gaps or duplicates, live activity remains at
the tail while a page is loading, a failed page can be retried, and stable activity upserts do not
reorder the visible timeline or leave terminal work rendered as running.

#### Scenario: Load an older activity page

- **WHEN** the paired mobile client opens a seeded thread with more activity than the initial window
  and requests older activity
- **THEN** older rows appear before the existing window in deterministic order with no missing or
  duplicated activity identities

#### Scenario: Live activity arrives while history is loading

- **WHEN** a canonical live activity or stable activity upsert arrives while an older page request
  is pending
- **THEN** the historical page merges at the beginning, the live activity remains at the end, and
  terminal status cannot be replaced by a stale non-terminal update

#### Scenario: Retry a failed older-page request

- **WHEN** the first older-page request fails and the user activates the mobile retry control
- **THEN** the client waits for the fresh request, merges a successful response, and does not
  immediately redisplay the cached failure

### Requirement: Verify interrupted-turn recovery on mobile

The verification SHALL observe mobile state across a controlled backend interruption while a turn
is active. After restart, the first synchronized snapshot MUST show the stale turn as interrupted
or visibly failed, MUST NOT show the thread as indefinitely working, and MUST permit a subsequent
turn after the environment reconnects.

#### Scenario: Backend restarts during active provider work

- **WHEN** the disposable server is stopped after a turn starts and is then restarted against the
  same base directory
- **THEN** the mobile client reconnects to a snapshot that settles the prior work as interrupted,
  clears the active-turn presentation, and enables a subsequent send

#### Scenario: Recovery preserves resumable provider state

- **WHEN** the interrupted thread has a valid provider resume cursor and the user sends a follow-up
  after reconnection
- **THEN** the provider resumes or re-establishes the supported session without duplicating the
  interrupted user request or its visible history

### Requirement: Verify the Kimi mobile experience end to end

The verification SHALL use an enabled, authenticated Kimi instance and the synthetic
`kimi-default` model on mobile. It MUST cover Kimi-specific identity, model selection, streamed
thread rendering, a controlled approval request, interruption, and a successful follow-up using
preserved resume state.

#### Scenario: Select Kimi on mobile

- **WHEN** the paired mobile client opens model selection for a ready Kimi instance
- **THEN** it displays Kimi-specific identity and `kimi-default`, routes the selection to the Kimi
  provider instance, and does not use an unrelated provider fallback

#### Scenario: Complete a streamed Kimi turn

- **WHEN** the user sends a deterministic prompt through `kimi-default`
- **THEN** assistant output streams into the thread, the turn reaches one terminal state, and the
  composer returns to a sendable state

#### Scenario: Resolve a Kimi tool approval

- **WHEN** a controlled prompt in approval-required mode causes Kimi to request a harmless local
  tool action
- **THEN** mobile presents the approval using Kimi identity, submits the selected outcome, removes
  the pending request, and renders the resulting terminal tool state

#### Scenario: Interrupt and resume Kimi

- **WHEN** the user interrupts an active Kimi turn and sends a follow-up after the provider returns
  to ready state
- **THEN** the interrupted turn settles exactly once and the follow-up completes through the
  preserved Kimi session without duplicating prior content

### Requirement: Preserve secret-safe evidence and explicit debt closure

The verifier SHALL record the platform, OS/runtime version, device identifier, development-client
identity, Metro and server origins without credentials, scenario outcomes, focused commands, and
artifact locations. Screenshots and logs MUST exclude pairing tokens, OAuth state, credentials,
prompt payload dumps, and raw provider protocol payloads. Test-owned processes, reverse-port rules,
pairings, and disposable state MUST be removed or explicitly retained with a documented reason.

#### Scenario: All required scenarios pass

- **WHEN** every requirement in this change has passing representative-device evidence
- **THEN** the verifier marks the mobile verification tasks in both originating OpenSpec changes
  complete and records links to the evidence

#### Scenario: A scenario fails or cannot run

- **WHEN** any required scenario fails or a prerequisite is unavailable
- **THEN** the originating tasks remain incomplete and the evidence records the exact blocker or
  failure without claiming successful verification

#### Scenario: Verification finishes

- **WHEN** the representative-device pass ends
- **THEN** all processes, port mappings, credentials, and disposable files owned by the pass are
  cleaned up, except evidence deliberately retained in a secret-safe location
