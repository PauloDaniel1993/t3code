## 1. Reproduce and lock in the bug

- [x] 1.1 Add a failing unit test in `ChatView.logic.test.ts` for `hasServerAcknowledgedLocalDispatch`: a steer dispatch into a running turn whose `turnId`/`requestedAt`/`startedAt` are unchanged and `completedAt` is still `null` currently returns `false` (never acknowledged) — assert the desired behavior (acknowledged once the steered message lands).
- [x] 1.2 Manually confirm the repro: start a turn, steer once, then attempt a second steer while still running, and observe the second submit is silently dropped.

## 2. Model a steer in the dispatch snapshot

- [x] 2.1 Extend `LocalDispatchSnapshot` (`ChatView.logic.ts`) with the fields needed to recognize a steer and detect its acknowledgement: a `wasSteer` flag plus a baseline (e.g. latest user message id/count and/or `session.updatedAt`) captured at dispatch time.
- [x] 2.2 Update `createLocalDispatchSnapshot` to populate the new fields, computing `wasSteer` from `phase === "running"` with an active turn whose `turnId` matches the latest turn.
- [x] 2.3 Thread any newly required inputs (latest user message id/count) into `createLocalDispatchSnapshot`/`beginLocalDispatch` callers in `ChatView.tsx`.

## 3. Fix the acknowledgement logic

- [x] 3.1 In `hasServerAcknowledgedLocalDispatch`, add a steer branch: when `wasSteer`, return acknowledged once the steered message is server-recorded (user message id/count advanced past the baseline) or `session.updatedAt` advanced — instead of requiring `latestTurnChanged`.
- [x] 3.2 Add a bounded fallback so the busy lock can never wedge (clear `localDispatch` after a conservative timeout even if no signal is observed).
- [x] 3.3 Verify the existing turn-start path (`!wasSteer`) is unchanged and still acknowledges on `latestTurnChanged`.

## 4. Composer gating

- [x] 4.1 Confirm `onSend` (`ChatView.tsx`) still proceeds for steers once `isSendBusy` clears, and that `sendInFlightRef` remains the synchronous double-submit guard.
- [x] 4.2 Ensure `isSendBusy`/`isPreparingWorktree` derivation reflects the cleared steer dispatch so the composer re-enables between consecutive steers.

## 5. Tests and verification

- [x] 5.1 Make the test from 1.1 pass; add cases for: consecutive steers, empty-content steer ignored, double-submit guard, and the fallback-timeout clear.
- [x] 5.2 Add/adjust tests ensuring the normal first-message turn-start acknowledgement is unaffected.
- [x] 5.3 Run the web test suite and typecheck/lint for the touched files.
- [x] 5.4 Manual verification: start a turn and steer 2–3 times in quick succession into the same running turn — each message dispatches and the composer re-enables between them.
