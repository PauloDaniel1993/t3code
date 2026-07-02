# Handoff Spec Alignment

## Why

The provider thread handoff feature (commits `917b2f95`, `b1a54bc2`) deviates from its authoritative plan (`.plans/23-provider-thread-handoff.md`) in several verified ways: the UI entry point and import-fold rendering differ (both now accepted as intentional — the plan must be amended), the web-side handoff-chain eligibility guard is missing, one plan-mandated test is absent, the dialog wait window is 2s instead of 3s, and `generateHandoffSummary`/JSON-runner wrappers are copy-pasted across six text-generation providers without the plan-required transient retry.

## What Changes

- Amend `.plans/23-provider-thread-handoff.md` to document the composer-bar "Hand off" button (instead of ThreadActionsMenu) and collapsed-by-default imported-message fold as the accepted design.
- Bump the handoff dialog target-thread wait from 2,000ms to 3,000ms per plan.
- Add the web-side handoff-chain guard: source thread must have at least one native (non-imported) message after its most recent imported block.
- Add the missing web test: dialog navigates when the target thread appears and toasts on timeout.
- Extract a shared `makeJsonTextGeneration` factory consolidating the six duplicated per-provider JSON text-generation wrappers, adding one transient retry for text-generation tasks in the shared path.
- Add a strict dispatch-payload minimality test (exactly 4 fields) and an explicit "wrong project" decider rejection test.

## Capabilities

### New Capabilities

<!-- none — all changes align existing behavior to the existing capability -->

### Modified Capabilities

- `provider-thread-handoff`: chain-handoff eligibility enforced client-side; dialog wait window 3s; entry point and import rendering documented as composer button + collapsed fold. (Delta spec created here; the feature predates OpenSpec main-spec sync, so this delta also records the affected requirements.)

## Impact

- `apps/web/src/threadHandoff/handoff.ts` + `handoff.test.ts` (chain guard).
- `apps/web/src/components/ChatView.tsx` (wait window), `ChatView.logic.test.ts` / `ThreadHandoffDialog.logic.test.ts` (navigation/timeout test, payload test).
- `apps/server/src/textGeneration/*TextGeneration.ts` (6 files) — refactor onto a shared factory; behavior-preserving except the added retry.
- `apps/server/src/orchestration/decider.handoff.test.ts` (wrong-project test).
- `.plans/23-provider-thread-handoff.md` (amendments).
