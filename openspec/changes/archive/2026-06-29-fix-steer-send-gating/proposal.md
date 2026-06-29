## Why

Steering (sending a follow-up message while the model is still running) feels unreliable: sometimes a message goes through, sometimes pressing Enter silently does nothing. The root cause is that the composer's "send busy" lock never clears for a steer, because a steer continues the **same** turn and the lock only releases when it detects a **new/changed** turn. After one steer, the user is locked out of steering again until the turn finishes — with no visible feedback explaining why.

## What Changes

- Fix the local-dispatch acknowledgement model so a steer (a send while `phase === "running"` into an already-active turn) is recognized as acknowledged by a signal that actually changes on a steer, instead of `latestTurnChanged` (which never changes for a continued turn).
- Allow consecutive steers: `isSendBusy` must clear after the server records the steered message rather than staying stuck for the remainder of the running turn.
- Add a short-lived, self-clearing busy/optimistic state for steers so the UI gives consistent feedback (the steered message appears; the composer re-enables) without permanently blocking input.
- Keep the existing synchronous double-submit guard (`sendInFlightRef`) so a single Enter still can't double-fire.

## Capabilities

### New Capabilities

- `composer-steering`: Sending follow-up messages into a running turn ("steering") — when a steer is accepted, how the composer's busy/enabled state is derived, and the guarantee that consecutive steers are not blocked.

### Modified Capabilities

<!-- None: there is no existing spec for composer send/steer behavior yet. -->

## Impact

- `apps/web/src/components/ChatView.logic.ts` — `hasServerAcknowledgedLocalDispatch`, `createLocalDispatchSnapshot`, `LocalDispatchSnapshot` (acknowledgement heuristic).
- `apps/web/src/components/ChatView.tsx` — `onSend` gating (`isSendBusy` / `sendInFlightRef`), `beginLocalDispatch`, `isSendBusy` derivation.
- `apps/web/src/components/ChatView.logic.test.ts` — new cases for the steer acknowledgement path.
- No server/protocol changes expected; server already treats a mid-turn `sendTurn` as a steer (`apps/server/src/provider/Layers/ClaudeAdapter.ts`) and preserves turn fields in the projector (`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`).
