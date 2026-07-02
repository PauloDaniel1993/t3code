# Tasks — handoff-spec-alignment

## 1. Amend plan 23 (same change as code, per AGENTS.md)

- [ ] 1.1 In `.plans/23-provider-thread-handoff.md` §UI (~L642-645): replace the ThreadActionsMenu/`MoreHorizontalIcon`/`ArrowRightLeftIcon` requirement with the implemented design — composer control-bar button labeled "Hand off" with `GitBranchPlusIcon` (`apps/web/src/components/chat/ChatComposer.tsx:334-355`) plus compact-menu item (`CompactComposerControlsMenu.tsx:90-100`). Note the header menu as a rejected alternative.
- [ ] 1.2 In the same plan §Timeline rendering (~L664): change "Imported messages render expanded by default" to "Imported messages render behind a collapsed `N imported messages` fold by default (performance; see `.plans/24`)".
- [ ] 1.3 Verify plan §UI dialog behavior says "wait up to 3 seconds" (it does) — no plan edit needed for the wait window; the code changes in 3.1.

## 2. Web chain guard

- [ ] 2.1 In `apps/web/src/threadHandoff/handoff.ts`, add a pure helper `hasNativeMessageAfterLastImport(messages): boolean` — find the index of the last message with `source === "handoff-import"`; return true if any later message has a native source (`"user" | "provider"`), or if there are no imported messages.
- [ ] 2.2 Wire it into the existing eligibility function (the one returning disabled reasons around `handoff.ts:44-66`): when false, return ineligible with reason like `Send a message in this thread before handing off again.`
- [ ] 2.3 Tests in `apps/web/src/threadHandoff/handoff.test.ts`: (a) thread ending in imported block → blocked with the chain reason; (b) imported block followed by a native user message → allowed; (c) thread with no imports → unaffected.

## 3. Dialog wait window + missing tests

- [ ] 3.1 In `apps/web/src/components/ChatView.tsx` (~L2474), change `waitForStartedServerThread(targetThreadRef, 2_000)` to `3_000`.
- [ ] 3.2 Add the navigation/timeout test (plan §Web tests "Dialog navigates after target appears and toasts on timeout"). Prefer the logic seam: extract the post-dispatch wait/navigate/toast sequence from `ChatView.tsx` into a testable helper in `ChatView.logic.ts` if not already extractable, then in `ChatView.logic.test.ts` use fake timers to assert (a) target appears at t<3000 → navigate called with target thread id; (b) target never appears → toast called, no navigation.
- [ ] 3.3 Add payload-minimality test: in `packages/client-runtime/src/operations/commands.test.ts` (or the dialog logic test), assert `Object.keys(payload).sort()` equals exactly `["commandId","createdAt","sourceThreadId","targetModelSelection","targetThreadId"]`.

## 4. Shared text-generation factory

- [ ] 4.1 Create `apps/server/src/textGeneration/TextGenerationShared.ts` exporting `makeJsonTextGeneration(config)` where config supplies: provider label, a `runRaw(prompt: string, opts: { timeoutMs: number }) => Effect<string, TextGenerationError>` transport, and default timeout. The factory returns the full `TextGeneration` method set (`generateCommitSubject`, `generatePrTitle`, `generatePrDescription`, `generateBranchName`, `generateThreadTitle`, `generateHandoffSummary`) built from the existing prompt builders in `TextGenerationPrompts.ts`, JSON extraction from `TextGenerationUtils.ts` (`extractJsonObject`), sanitizers (`sanitizeCommitSubject`, `sanitizePrTitle`, `sanitizeThreadTitle`, `sanitizeHandoffSummary`), and **one** `Effect.retry` (Schedule.once) gated on a transient-error predicate (timeout, network, malformed-JSON). `generateHandoffSummary` accepts `retries: 0 | 1` (default 1) so `bootstrapContext.ts`'s own retry path passes 0 to avoid double-retry.
- [ ] 4.2 Port `DeepSeekTextGeneration.ts` onto the factory first (it has the richest tests: `DeepSeekTextGeneration.test.ts`, `TextGenerationHandoff.test.ts`); its file should reduce to settings/env resolution + the HTTP transport (keep the corrected `DEEPSEEK_TEXT_GENERATION_TIMEOUT_MS = 90_000`). Run those tests (WSL/CI if Windows `spawn EFTYPE` blocks).
- [ ] 4.3 Port the remaining five (`ClaudeTextGeneration.ts`, `CodexTextGeneration.ts`, `CursorTextGeneration.ts`, `GrokTextGeneration.ts`, `OpenCodeTextGeneration.ts`) mechanically — each keeps only its transport (CLI/ACP invocation) and passes it to the factory. No behavior change other than the added transient retry.
- [ ] 4.4 Add factory tests in `apps/server/src/textGeneration/TextGenerationShared.test.ts`: transient failure retried exactly once (count calls); second failure surfaces typed error; `retries: 0` makes exactly one call.

## 5. Decider test gap

- [ ] 5.1 In `apps/server/src/orchestration/decider.handoff.test.ts`, add an explicit wrong-project rejection test: construct read-model state where the source thread's project differs from any project reference the command handling derives, and assert `thread.handoff.create` is rejected (see existing rejection tests in the same file for the fixture pattern).

## 6. Gates

- [ ] 6.1 `vp check` passes.
- [ ] 6.2 `vp run typecheck` passes.
- [ ] 6.3 Run the touched server/web test files (`vp test run` per package); on Windows the server suite fails environmentally (`spawn EFTYPE`) — run in WSL/CI.
