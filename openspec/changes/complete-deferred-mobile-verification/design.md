## Context

Two implementation changes are code-complete but retain one unchecked mobile integration task each:

- `fix-provider-event-backpressure-recovery` task 8.6 covers bounded history, live activity merging,
  and recovered interrupted state.
- `add-kimi-subscription-provider` task 9.6 covers Kimi identity, model selection, streamed thread
  rendering, approval, and resume.

Focused mobile tests and type checks pass, but the current Windows host has neither an Android SDK
nor `adb` or an attached emulator. A real Kimi web turn and restart recovery were verified, but that
does not substitute for the mobile rendering and interaction obligations. The future pass must use
disposable server state and must not expose membership-owned Kimi OAuth state or pairing tokens.

## Goals / Non-Goals

**Goals:**

- Produce reproducible representative-device evidence for both deferred mobile tasks.
- Exercise deterministic history and recovery fixtures independently from provider variability.
- Exercise a real authenticated Kimi mobile session for identity, streaming, approval, interrupt,
  and resume.
- Keep the pass isolated, secret-safe, and easy to clean up.
- Make debt closure mechanical: both originating tasks are checked only after all required
  scenarios pass.

**Non-Goals:**

- Supporting every phone, tablet, operating-system version, or both mobile platforms.
- Rebuilding native projects when the current changes remain JavaScript or TypeScript only and a
  compatible development client is installed.
- Changing production mobile, provider, history, or recovery behavior as part of this verification
  debt item.
- Treating focused unit tests, web verification, or a disconnected mobile render as equivalent to a
  paired representative-device pass.

## Decisions

### Use one viable representative platform

Prefer one iOS Simulator on a compatible macOS host; otherwise use one Android Emulator with the
Android SDK. The behavioral changes are cross-platform React Native code, so one representative
runtime provides the required integration signal without multiplying setup cost.

Alternative considered: require both iOS and Android. This was rejected because the debt concerns
shared mobile state and presentation rather than platform-specific native code.

### Reuse a compatible development client

Start Metro from the current worktree with development identity `com.t3tools.t3code.dev` and scheme
`t3code-dev`. Reuse an installed compatible client because the reviewed changes do not alter native
dependencies, entitlements, config plugins, or generated native projects. Rebuild only if the
available client is incompatible.

Alternative considered: always perform an Expo prebuild and native rebuild. This was rejected
because it adds destructive generated-project churn and tests more than the changed surface.

### Separate deterministic state scenarios from the real Kimi scenario

Seed bounded history, live-upsert ordering, retry, and stale-running recovery in a disposable
environment using the existing integration fixture patterns. Then use an authenticated Kimi CLI
home for provider-specific interaction. This keeps pagination and recovery assertions repeatable
while still proving the real provider boundary.

Alternative considered: generate every state through a live Kimi conversation. This was rejected
because provider timing and tool choice cannot reliably produce page boundaries, request failures,
or a controlled crash at the required moment.

### Use a controlled restart for recovery

After confirming that a provider turn is active, stop only the disposable backend, restart it
against the same base directory, and wait for mobile reconnection. Assert that the old turn becomes
interrupted and the composer becomes usable before sending the resume follow-up. Do not kill shared
servers or mutate shared `~/.t3` state.

Alternative considered: directly rewrite the running projection while the server is open. This was
rejected because it bypasses the startup readiness and recovery path being verified.

### Store a concise verification record

Execution will add `verification.md` to this change directory with the tested platform and versions,
commands, scenario results, and secret-safe artifact paths. Screenshots may live in an ignored
verification output directory; credentials and raw provider payloads must never be captured.

Alternative considered: rely only on terminal history. This was rejected because the original debt
would become unauditable after the local session ends.

### Close originating tasks only after the complete pass

Tasks 8.6 and 9.6 remain unchecked until all scenarios relevant to each task pass. A partial pass
can be recorded but cannot be converted into a successful checkmark. When both pass, update their
task files and cite this change's verification record.

## Risks / Trade-offs

- **A compatible dev client is unavailable** → Record the prerequisite; build one only when the
  executing user authorizes the native build.
- **Kimi authentication or service availability changes** → Preserve deterministic non-provider
  results, leave Kimi debt open, and record the actionable provider blocker without inspecting
  credential files.
- **A tool-approval prompt does not trigger the intended tool** → Use a controlled harmless command
  in a disposable Git workspace and retry with a fresh turn; do not approve destructive actions.
- **Restart timing misses the active-turn window** → Confirm the visible working state before
  stopping the backend and repeat only in disposable state.
- **Screenshots expose a pairing token or account data** → Navigate away from pairing before
  capture, mask unnecessary account identity, and inspect retained artifacts before recording them.
- **One representative platform misses a platform-specific regression** → This debt closes only the
  shared cross-platform obligation; future platform-specific changes still require their affected
  platform.

## Migration Plan

1. Provision a compatible development client and one simulator or emulator on a viable host.
2. Create a disposable T3 base directory and seed the deterministic project/thread fixtures.
3. Start the isolated backend and current-worktree Metro server, then pair the selected device with
   a fresh credential.
4. Run bounded-history, live-merge, retry, and interrupted-recovery scenarios.
5. Enable an authenticated Kimi instance and run identity, model, streaming, approval, interrupt,
   and resume scenarios.
6. Record results in `verification.md`, inspect evidence for secrets, and clean up test-owned state.
7. If every scenario passes, check the two originating mobile tasks and validate all three OpenSpec
   changes. If any scenario does not pass, leave its originating task unchecked.

Rollback consists of removing test-owned state and leaving the originating tasks unchecked; this
change introduces no production migration.

## Open Questions

- Which viable host and representative device will be used when the debt is scheduled?
- Is a compatible `com.t3tools.t3code.dev` client already installed there, or will a one-time native
  development build be required?
