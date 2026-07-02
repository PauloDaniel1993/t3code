## Context

In `apps/web`, the composer's send button becomes a Stop button while a turn is running, so "steering" (sending a follow-up into a running turn) happens via the Enter key: `onComposerCommandKey` → `submitComposer` → `onSend` (`ChatComposer.tsx`, `ChatView.tsx`). `onSend` does **not** gate on `phase === "running"` — steering is intended — but it early-returns when `isSendBusy || sendInFlightRef.current` is true.

`isSendBusy` is derived from a "local dispatch" optimistic bridge that spans the gap between the user pressing send and the server acknowledging the work:

- `beginLocalDispatch()` snapshots the current turn (`createLocalDispatchSnapshot`) and sets `localDispatch`.
- `isSendBusy = activeLocalDispatch !== null`, where `activeLocalDispatch = serverAcknowledgedLocalDispatch ? null : localDispatch`.
- `hasServerAcknowledgedLocalDispatch` (`ChatView.logic.ts`) decides when the dispatch is acknowledged. In `phase === "running"` it returns acknowledged **only when `latestTurnChanged`** — i.e. the turn's `turnId` / `requestedAt` / `startedAt` / `completedAt` differ from the snapshot.

**The bug:** a steer continues the _same_ turn. The projector preserves turn fields on a continued turn (`ProjectionPipeline.ts:1245`: `requestedAt: existingTurn.value.requestedAt ?? …`, same `turnId`, `completedAt` stays `null`). So after a steer, `latestTurnChanged` is permanently false for the rest of the turn, `hasServerAcknowledgedLocalDispatch` never returns true, `isSendBusy` stays stuck true, and `onSend` early-returns on every subsequent steer until the turn finally completes. The first steer (when the lock happened to be clear) succeeds; the next is silently dropped — hence "sometimes it lets me, sometimes not."

Constraints: no server/protocol change is needed — the server already models a mid-turn `sendTurn` as a steer. The fix is in the web client's dispatch-acknowledgement state model.

## Goals / Non-Goals

**Goals:**

- A steer's busy lock clears as soon as the server records the steered message, not when the turn ends.
- Consecutive steers into the same running turn are allowed.
- Preserve the synchronous double-submit guard (`sendInFlightRef`) and keep optimistic feedback.
- Add regression tests around the acknowledgement logic.

**Non-Goals:**

- Changing server steer semantics or the projector.
- Redesigning the composer primary-action button (Stop-while-running stays).
- Changing how the _first_ message of a turn is acknowledged.

## Decisions

### Decision: Distinguish a "steer" dispatch from a "turn-starting" dispatch

Record on the dispatch snapshot whether it was a steer — i.e. at `beginLocalDispatch` time `phase === "running"` and there is an active turn whose `turnId` matches the latest turn. Acknowledgement then uses a steer-appropriate signal instead of `latestTurnChanged`.

Rationale: the existing `latestTurnChanged` heuristic is correct for _starting_ a turn (turn id/timestamps genuinely change) but structurally wrong for a continuation. Tagging the snapshot keeps the good path untouched and isolates the new behavior.

Alternatives considered:

- **Skip `beginLocalDispatch` entirely for steers** (rely only on `sendInFlightRef`). Simpler, and arguably steers don't need the "Sending…" affordance. Rejected as the primary approach because it drops optimistic feedback and the reserved-message anchoring that `localDispatch` participates in; kept as a fallback if tagging proves noisy.
- **Time-boxed clear only** (clear `localDispatch` after N ms regardless). Band-aid that races with slow servers; used only as a bounded _fallback_, not the primary signal.

### Decision: Acknowledge a steer on the steered message landing, with a bounded fallback

For a steer-tagged dispatch, treat it as acknowledged when any of:

- the thread's user-visible message count / latest user message advances past the snapshot (the steered message is now server-recorded), or
- `session.updatedAt` advances past the snapshot, or
- a bounded fallback timeout elapses (safety net so the lock can never wedge).

Rationale: these signals actually move when a steer is processed, unlike the turn identity fields. The fallback guarantees the composer can never get permanently stuck even if a signal is missed.

Alternatives considered: keying off `latestTurn.completedAt` (current behavior) — rejected, that only moves when the whole turn ends, which is exactly the bug.

### Decision: Keep `sendInFlightRef` as the only synchronous re-entrancy guard

`isSendBusy` should not be the double-submit guard for steers; `sendInFlightRef` (set true at dispatch, reset in the send `finally`) already prevents a single Enter from double-firing. This lets `isSendBusy` be purely about optimistic UI feedback.

## Risks / Trade-offs

- [Message-count signal misfires if background/assistant messages also bump the counter] → Compare against a steer-specific baseline (snapshot the user message count / latest user message id at dispatch) and/or gate on `session.updatedAt`; cover with tests.
- [Fallback timeout too short on slow connections shows a flicker of re-enabled input before ack] → Choose a conservative timeout; the message-landing signal should normally win the race.
- [Allowing rapid consecutive steers could let users flood the agent loop] → Acceptable; the server already queues steers into the live loop, and `sendInFlightRef` prevents true double-fire. Revisit only if abuse is observed.
- [Regression in the normal turn-start path] → The steer branch is additive and gated on the steer tag; existing `latestTurnChanged` path is unchanged and retains its tests.

## Migration Plan

Pure client state-logic change; no data migration. Ship behind normal release. Rollback is reverting the `ChatView.logic.ts` / `ChatView.tsx` changes. Manual verification: start a turn, steer twice in quick succession into the same running turn, confirm both messages dispatch and the composer re-enables between them.

## Open Questions

- Preferred acknowledgement signal: user-message-count delta vs `session.updatedAt` vs both? (Lean: snapshot latest user message id + count, ack when it advances; `session.updatedAt` as secondary.)
- Fallback timeout value (e.g. ~1.5–3s) — pick to comfortably exceed typical round-trip without a noticeable flicker.
- Should the "Sending…" affordance even show for steers, or should steers be visually instantaneous? (Affects whether we keep `localDispatch` for steers or take the lighter fallback approach.)
