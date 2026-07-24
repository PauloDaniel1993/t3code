## Why

The Kimi provider and bounded activity-history changes have focused mobile tests but still lack the
required representative simulator or emulator pass because the current Windows host has no Android
SDK, `adb`, or attached emulator. Recording that gap as explicit technical debt prevents the two
deferred checks from being mistaken for completed release evidence.

## What Changes

- Establish a repeatable, disposable mobile integration-verification procedure for one viable iOS
  Simulator or Android Emulator.
- Verify bounded history, live activity merging, and interrupted-turn recovery on the mobile thread
  surface.
- Verify Kimi identity, model selection, streamed rendering, approval handling, and session resume
  with an authenticated Kimi CLI environment.
- Capture secret-safe evidence, record the tested device/runtime versions, and clean up all
  test-owned processes, pairing credentials, reverse-port rules, and disposable state.
- Close the deferred verification items in the originating OpenSpec changes only after the
  corresponding scenarios pass.

## Capabilities

### New Capabilities

- `mobile-integration-verification`: Defines the representative-device setup, required mobile
  scenarios, evidence, failure handling, and completion criteria for the deferred verification.

### Modified Capabilities

None.

## Impact

- OpenSpec verification state for `add-kimi-subscription-provider` and
  `fix-provider-event-backpressure-recovery`.
- Mobile development tooling: Expo development client, Metro, Android SDK/emulator or Xcode/iOS
  Simulator, and T3 Code pairing.
- Disposable local T3 server state and an authenticated Kimi CLI test home.
- No production contracts, runtime behavior, or persisted user data change as part of this debt
  item.
