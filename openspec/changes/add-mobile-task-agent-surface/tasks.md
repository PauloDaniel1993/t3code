## Delivery status

This change is being delivered in three PRs. The evaluated leaf graph was too large for one
reviewable diff — roughly twenty leaves spanning the v2 list, the legacy list, HomeScreen, the
iPad sidebar, the thread detail screen, the feed, the composer, and a new unread-persistence
layer.

- **PR 1 — foundation (this PR).** The shared rollup rules and the entire pure mobile logic
  layer. No UI, no React components. Sections 1, 2, 6.1, 6.3 and the logic-level parts of 7.
- **PR 2 — UI surfaces.** Sections 3, 4, 5, the unread lifecycle, and 6.2 on a device.
- **PR 3 — remainder**, if PR 2 does not absorb it.

Scope decisions taken during PR 1, recorded here so they are not rediscovered as surprises:

- **Legacy list is out of scope.** Mobile can opt out of the v2 thread list, and the legacy
  `ThreadListRow` remains live in Home and the iPad sidebar. This change targets
  `thread-list-v2-items.tsx` only, so **the surface is absent in legacy-list mode**.
- **React Native component-test infrastructure does not exist** — `apps/mobile` has 99 vitest
  tests and zero `.test.tsx`, with no `@testing-library/react-native` and no
  `react-test-renderer`. PR 1 follows the repository's established pure-logic pattern, which is
  also what Requirement 2 asks for ("verifiable without rendering a component"). Adding a
  component-test harness is an open follow-up, not a silent omission.

## 1. Share the Rollup Rules

- [x] 1.1 Read `apps/web/src/components/SidebarNativeAgents.logic.ts` and `SidebarNativeAgentGroups.logic.ts` with their tests, and list every exported symbol web depends on, so the move is a known surface rather than a guess.
- [x] 1.2 Choose the shared home and say why in one line. `packages/client-runtime` is the candidate both apps already import; it holds state and operations today, so the rules need their own named module rather than an append to an existing one.
  - Chosen: `packages/client-runtime/src/state/native-agents/`, exported as
    `@t3tools/client-runtime/state/native-agents`. `state/threadTasks.ts` already holds
    thread-task presentation rules, so this follows precedent rather than inventing a sibling tree.
- [x] 1.3 Move the pure grouping and counting logic — `groupNativeAgentsByTurn` and the `runningCount` / `finishedCount` / `failedCount` / `latestAt` / `isLatest` derivation — into that module, unchanged.
  - One deviation from a verbatim move: `formatElapsedSince` now takes milliseconds directly
    instead of round-tripping through `new Date().toISOString()`, because `client-runtime` bans
    `new Date(`. The call site guards `Number.isFinite` first, so the round-trip was exact
    identity for every reachable input. Both reviewers verified the equivalence independently.
- [x] 1.4 Move the existing tests with the code. They must pass **without edits**; a test that needs changing to go green means behaviour changed, and that is a defect, not a test fix.
  - Verified by diffing both files against `dev`: exactly one import-specifier line differs in
    each, every assertion and fixture byte-identical. Re-verified after the pre-commit formatter ran.
- [x] 1.5 Repoint web's imports and confirm the desktop sidebar renders identically — same groups, same labels, same counts, same expand/collapse behaviour.
  - Confirmed in a browser against a live instance with seeded tasks: chip label `"2 tasks"` /
    `"1 task"` with correct plural agreement, `aria-expanded` toggling true/false, task rows
    2 → 0 → 2 on collapse/expand. The chip label is produced by `formatTaskGroupChipLabel`, one
    of the moved functions, so this is the relocated code executing in the real sidebar.
- [~] 1.6 Run the full web test suite. Any failure here is a regression in a shipped surface and blocks the rest of this change.
  - 2074 pass. **3 failures are pre-existing and unrelated** — `src/cloud/connectCliAuth.test.ts`
    (2, Clerk env config leakage) and `src/appearance/appearanceCss.test.ts` (1, settings markup).
    Neither test, nor anything in its import closure, appears in this change set. Web typecheck
    exits 0 and the production build succeeds.

## 2. Mobile Data Access and Theme

- [ ] 2.1 Confirm at runtime that `EnvironmentThreadShell` on mobile actually carries `nativeAgents`, `task`, `taskSummary`, and `parentThreadId` — the contract says it does; verify it against a real payload before building on it.
  - **Still open.** The contract declares it and both reviewers confirmed the type flows through
    to `apps/mobile`, but no real payload carrying `nativeAgents` was observed at runtime. The
    browser pass surfaced task groups, not native agents, because seeding those needs a real
    provider turn. Verify this before or during PR 2.
- [x] 2.2 Add mobile-side selectors that read those fields and apply the shared rules from section 1. No new subscription, no new RPC, no duplicated counting.
  - `taskAgentModel.ts`. Counts come from `groupNativeAgentsByTurn`; a test asserts parity with
    the shared function for every running/finished/failed count.
- [x] 2.3 Handle the bounded window honestly: `nativeAgents` carries the latest turn's set plus anything still running. Decide what the surface says when a thread has older agents that are no longer in the payload, and make sure nothing implies a full history.
  - The projection ships `NATIVE_AGENT_WINDOW` carrying an explicit "not full agent history"
    disclaimer, and uses the desktop's existing "Latest turn" / "Earlier turn" wording rather
    than inventing turn ordinals. No lifetime total is presented.
- [x] 2.4 Port `experiments/mobile-tasks-mockups-v2/CONTRAST.md`'s tokens to a typed JS theme object covering both themes, since React Native has no CSS custom properties.
  - `taskAgentTheme.ts`, every value commented with its source and documented ratio. Lowest
    selected token is light `coral` at 4.69:1.
- [x] 2.5 Add a contrast assertion helper that evaluates **effective** colour, including any ancestor `opacity`, so the 2.66:1 defect class cannot recur silently.
  - `taskAgentContrast.ts`. Two entry points model two different physical situations:
    `effectiveContrast` for text over a single opaque surface outside the opacity layer, and
    `effectiveOpacitySubtreeContrast` for a subtree carrying its own background under ancestor
    opacity. The second was added after review found the first produced a **false pass** —
    white on a black card at `opacity: 0.5` over white renders at 3.98:1 but measured 5.28:1.
    Regression tests lock both historical defects and the distinction between the two models.

## 3. Thread List Entry

Deferred to PR 2.

- [ ] 3.1 Nest task rows under their parent in `features/threads/thread-list-v2-items.tsx`, following the anatomy in `experiments/mobile-tasks-mockups-v2/flow-1-list/`.
- [ ] 3.2 Add the disclosure chip carrying the rollup, and the guide-line sub-rows beneath an expanded thread.
- [ ] 3.3 Present the per-turn agent rollup on the turn row.
- [ ] 3.4 Surface the unread-result indication on the parent thread, so it is visible without expanding.
- [ ] 3.5 **Regression gate:** a thread that owns no tasks and no agents renders exactly as it does today. This list already works and users rely on it.
  - The projection already enforces the model half: a thread owning neither projects to
    `kind: "plain-thread"` with no `rollup` key, so an ordinary thread cannot structurally
    acquire a rollup. The render half is PR 2's.

## 4. Peek

Deferred to PR 2.

- [ ] 4.1 Build the peek presentation from `experiments/mobile-tasks-mockups-v2/flow-2-peek/`.
- [ ] 4.2 Use identical row anatomy for tasks and for agents — an agent must not get a degraded or structurally different treatment.
- [ ] 4.3 Render the composer as unavailable **with the reason in words** wherever the subject cannot be steered, including every provider-native in-session agent.
  - The reasons already exist in `taskAgentNavigation.ts` and are carried on every projected
    row; PR 2 renders them.
- [ ] 4.4 Provide the route from an agent to where it ran in the transcript, or state plainly why it is unavailable if the lookup cannot be supported yet.
  - **Resolved as unavailable-with-reason.** `ThreadNativeAgent` carries `taskId` and `turnId`
    but no transcript message or card identifier, and the contract states these agents have no
    transcript. Modelled as a discriminated result that must carry a non-empty reason; routing
    to the owning task instead was rejected as overclaiming.

## 5. Full Task View

Deferred to PR 2.

- [ ] 5.1 Build the full task view from `experiments/mobile-tasks-mockups-v2/flow-3-task/` — the task's identity, its turns, the agents inside a turn with their outcomes, and a composer.
- [ ] 5.2 Ensure the route resolves to the task that was tapped, never to a default. This exact defect appeared in the mockups: three forward hops silently dropped their payload and always rendered the default.
  - Made unconstructible at the type level: task destinations require branded ids with no
    optional or defaulted identity fields. A test proves resolving task B never yields task A.
- [ ] 5.3 Ensure no dead affordances — every control either acts or states why it cannot.

## 6. Settle the Gesture

- [x] 6.1 Build both mappings for the task-row tap — peek and push — behind a switch, since this is a feel question and the mockups deliberately left it open.
  - `resolveTaskRowTapDestination` takes **no context argument**, so it is structurally
    impossible for the same gesture to peek in one place and push in another.
- [ ] 6.2 Decide one, apply it everywhere a task row appears, and record the decision and its reasoning.
  - **Provisional, not settled.** Default is `peek`, per the mockups. PR 1 ships no UI, so
    deciding a feel question here would be guessing. Settle it on a device in PR 2.
- [x] 6.3 Keep the losing destination reachable through a different, discoverable affordance.
  - Every task row projects an `alternative-affordance` labelled "Open thread" (or "Peek at
    task" under the inverse mapping), tested to exist for every row.

## 7. Verification

- [~] 7.1 Write a component test per state in `experiments/mobile-tasks-mockups-v2/state-matrix/` — queued, exactly one agent, zero failures, all failed, cancelled mid-flight, returned-but-unread, and the native agent — asserting the honesty rule each state exists to prove, not the pixels.
  - All seven states are covered as **pure view-model tests** rather than component tests, since
    no RN component-test harness exists (see Delivery status). Each case asserts its honesty
    rule and every case additionally walks the whole projection asserting no `"0 of 0"` string.
- [x] 7.2 Assert no rollup renders "0 of 0", no count of one is pluralised, and no failure styling appears where nothing has failed.
  - Enforced by the type, not only asserted: the outcome rollup is a discriminated union where
    `success-only` has no `failedCount` field, `failure-only` has no `finishedCount`, and
    `not-started` carries no counters. Displayed counts are branded positive integers.
- [x] 7.3 Assert every failed agent carries a reason, and that reasons behind a rollup are reachable.
  - A failed agent cannot reach the projection without a reason; the fallback covers empty or
    missing provider text. `FailedCounter.failures` is a non-empty tuple, so a failure count
    with no reachable reasons is unrepresentable.
- [x] 7.4 Assert every unavailable control carries its reason in words.
- [~] 7.5 Measure contrast on the built surface in both themes, against effective composited colour rather than token values — specifically including the stated-reason text, which is the only thing distinguishing an explained control from a broken one.
  - The helper and the token table are verified in both themes, with the stated-reason role
    asserted explicitly by name. **Measuring the built surface is PR 2's** — the unit runner
    cannot prove that the real React Native tree carries no unintended ancestor opacity.
- [ ] 7.6 Run the surface on a real device or simulator in both themes and confirm each of the seven states renders as designed.
  - Deferred to PR 2; PR 1 renders nothing. Note `apps/mobile` has no web target
    (`react-native-web` is not installed), so this needs a simulator or device.
- [x] 7.7 Confirm the desktop sidebar is unchanged from before section 1, by test and by inspection.
  - By test: the moved tests pass unedited. By inspection: browser-verified, see 1.5.
- [x] 7.8 Record which of v1's data gaps remain open — cross-level rollup, turn identity beyond the latest turn, push-notification parity, agent-to-transcript lookup — so shipping this surface does not read as having resolved them.
  - **All four remain open and are untouched by this change.** Cross-level rollup across a
    task's own children is not attempted. Turn identity beyond the latest turn is not available;
    turn ids stay opaque and no ordinals are invented. Push-notification parity is not
    addressed. Agent-to-transcript lookup does not exist and is surfaced as unavailable with a
    reason rather than approximated (see 4.4). Each needs a contract answer this change does
    not have.
- [x] 7.9 Record that the tasks/agents reference image still never arrived and that the visual language remains unverified against it, rather than letting a shipped surface imply the question was settled.
  - **The reference image never existed.** `experiments/mobile-tasks-mockups-v2/` is the
    reference of record, and the visual language is an accepted interpretation, not a verified
    match. No alignment is claimed anywhere in this change, and none should be inferred from
    it shipping.
