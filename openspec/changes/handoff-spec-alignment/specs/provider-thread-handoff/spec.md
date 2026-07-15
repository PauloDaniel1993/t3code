# provider-thread-handoff Specification (delta)

## ADDED Requirements

### Requirement: Web-side handoff chain eligibility guard

The handoff eligibility helper SHALL block handoff when the source thread contains imported messages and has no native (non-imported) message created after the most recent imported block, mirroring the server-side rule.

#### Scenario: Chain blocked without native follow-up

- **WHEN** a source thread's newest messages are all `source: "handoff-import"` with no later native user/assistant message
- **THEN** `handoff.ts` eligibility returns ineligible with a reason explaining a native message is required first

#### Scenario: Chain allowed after native message

- **WHEN** a source thread has at least one native message newer than its last imported message
- **THEN** eligibility does not block on the chain rule

### Requirement: Handoff entry point is the composer control bar

The handoff action SHALL be exposed as a composer control-bar button (icon `GitBranchPlusIcon`, label "Hand off"), with a matching item in the compact composer controls menu. A chat-header ThreadActionsMenu is explicitly not required.

#### Scenario: Button visible with disabled reason

- **WHEN** the source thread is ineligible for handoff
- **THEN** the composer button renders disabled with the eligibility reason as its tooltip/aria description

### Requirement: Imported messages fold collapsed by default

Imported handoff messages SHALL render behind a collapsed "N imported messages" row by default, expandable by the user. Rendering all imported messages expanded is explicitly not required (performance decision, aligned with `.plans/24-timeline-large-thread-perf.md`).

#### Scenario: Collapsed fold on target thread open

- **WHEN** a handoff target thread with imported messages is opened
- **THEN** the timeline shows one collapsed row summarizing the imported run, which expands on click

### Requirement: Dialog waits 3 seconds for the target thread

After command acknowledgement the handoff dialog SHALL wait up to 3,000ms for the target thread shell/detail to appear, navigate to it when it appears, and toast + remain on the source thread on timeout.

#### Scenario: Navigation on target appearance

- **WHEN** the target thread appears within 3,000ms of dispatch acknowledgement
- **THEN** the app navigates to the target thread

#### Scenario: Toast on timeout

- **WHEN** the target thread does not appear within 3,000ms
- **THEN** a toast is shown and the current route stays on the source thread

### Requirement: Text generation uses a shared JSON factory with one transient retry

All provider text-generation implementations SHALL share one factory for JSON-producing generation tasks (commit subject, PR title/description, branch name, thread title, handoff summary). The shared path SHALL retry once on transient failure (network/timeout/malformed output), then surface the error.

#### Scenario: Transient failure retried once

- **WHEN** a text-generation request fails with a transient error and the retry succeeds
- **THEN** the caller receives the successful result and exactly two provider calls were made

#### Scenario: Persistent failure surfaces after one retry

- **WHEN** both the original call and the single retry fail
- **THEN** the typed text-generation error is returned without further retries

### Requirement: Handoff dispatch payload minimality

The `thread.handoff.create` client dispatch payload SHALL contain exactly: `commandId`, `sourceThreadId`, `targetThreadId`, `targetModelSelection`, `createdAt` — and no other keys.

#### Scenario: Exact payload shape asserted

- **WHEN** the web dialog dispatches a handoff
- **THEN** a test asserts the payload's key set equals exactly the allowed set

### Requirement: Server rejects cross-project target references

The decider SHALL reject `thread.handoff.create` when derived state would place the target in a different project than the source (defensive invariant; the command carries no project id).

#### Scenario: Wrong-project rejection covered by test

- **WHEN** decider tests run
- **THEN** an explicit test exercises and asserts the wrong-project rejection path
