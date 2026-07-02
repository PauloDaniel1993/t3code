# Design — handoff-spec-alignment

## Context

`.plans/23-provider-thread-handoff.md` is the feature's authoritative spec. A verified audit found deviations; two (composer-button entry point, collapsed import fold) are accepted product decisions that the plan must absorb, the rest are implementation gaps. High-severity items (DeepSeek timeouts, `requiresNewThreadForModelChange`, `Handoff:` title prefix) were already fixed in the working tree and are prerequisites, not part of this change.

## Goals / Non-Goals

**Goals:**

- Make plan 23 and the implementation agree (amend plan where decided, fix code where not).
- Close the chain-guard, wait-window, and test-coverage gaps.
- Remove the 6× duplication in `apps/server/src/textGeneration/` per AGENTS.md maintainability policy.

**Non-Goals:**

- Building the ThreadActionsMenu (rejected by product decision).
- Expanding imported messages by default (rejected — perf).
- Server-side target-readiness validation (plan explicitly defers it).
- Any DeepSeek protocol changes.

## Decisions

- **Chain guard placement**: in the pure helper `apps/web/src/threadHandoff/handoff.ts` next to the existing eligibility checks, not in the dialog component — keeps the plan's "testable without React" property. Input: the source thread's message list (already available to `countImportableHandoffMessages`); rule: newest imported message index must be followed by ≥1 native message.
- **Factory shape**: `makeJsonTextGeneration` lives in `apps/server/src/textGeneration/TextGenerationShared.ts` (new file; `TextGenerationUtils.ts` already holds sanitizers — keep concerns separate). It accepts a provider-specific `runRaw(prompt, opts) → Effect<string>` plus timeout/parse config, and provides: JSON extraction via existing `extractJsonObject`, schema validation, one `Effect.retry` with a transient-error predicate, and the per-method wrappers (`generateCommitSubject`, ..., `generateHandoffSummary`) so each provider file shrinks to its transport + config. Providers keep their own prompts via existing `TextGenerationPrompts.ts` builders. Alternative (mixin per method) rejected — six near-identical files is the smell being removed.
- **Retry scope**: retry lives in the shared factory so all six providers gain the plan-required "one transient retry for text generation". Compression already retries in `bootstrapContext.ts`; the factory must not double-retry that path — `generateHandoffSummary` accepts a `retries: 0 | 1` override used by the compression caller.
- **Wait window**: change the constant at the single call site (`waitForStartedServerThread(targetThreadRef, 2_000)` in `ChatView.tsx`) to `3_000`; cheaper and spec-true versus amending the plan.
- **Navigation/timeout test**: test the logic seam (`ChatView.logic.ts` helpers / dialog logic) with a fake timer + fake thread-appearance signal rather than a rendered ChatView — consistent with the repo's `.logic.test.ts` convention.

## Risks / Trade-offs

- [Refactoring six live providers at once] → behavior-preserving refactor guarded by existing per-provider tests (`DeepSeekTextGeneration.test.ts`, `TextGeneration.test.ts`, `TextGenerationHandoff.test.ts`); do one provider (DeepSeek) first, verify, then mechanically port the rest.
- [Retry changes latency on failure] → single retry only, existing timeouts unchanged; chat turns remain no-retry.
- [Chain-guard false positives if message `source` is missing on old threads] → role-derived fallback already normalizes `source` in contracts decode; guard reads the normalized field.

## Migration Plan

Pure code + plan-doc change; no data migration. Land as one PR; the plan amendments and code changes must ship together (AGENTS.md requires plan updates in the same change).
