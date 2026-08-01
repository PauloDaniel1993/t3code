## Delivery status — closed 2026-08-02

This change was delivered in two PRs, both merged to `dev`. The evaluated leaf graph was too
large for one reviewable diff — roughly twenty leaves spanning the v2 list, the legacy list,
HomeScreen, the iPad sidebar, the thread detail screen, the feed, the composer, and a new
unread-persistence layer.

- **PR 1 — foundation (#40, merged).** The shared rollup rules and the entire pure mobile logic
  layer. No UI, no React components. Sections 1, 2, 6.1, 6.3 and the logic-level parts of 7.
- **PR 2 — UI surfaces (#41, merged).** Sections 3, 4, 5, the unread lifecycle, and 6.2.
  14 commits, 32 files, +6444/−110. Two independent reviews, no blockers, ten findings, eight
  fixed. Mobile suite 740 passing, up from 681.
- **PR 3 — not required.** PR 2 absorbed the remaining sections. A third PR was scoped only as a
  device-verification pass; the owner closed the change without it (see Waived below).

### Waived at closure — accepted risk, not verification

The owner closed this change on 2026-08-02 without the device pass. These items are **not
verified**, and are recorded as accepted rather than marked done, so nothing here reads as a
confirmation that did not happen:

- **7.6 — the seven-state device matrix was never run.** The delivery host had no Expo web
  target (`react-native-web` absent), no Android emulator binary, system image or AVD, and Expo
  Go is unsupported because of native modules. Layout, dynamic nested height, scroll anchoring,
  keyboard insets, and tap-versus-swipe arbitration have not been seen on a real device.
- **2.1 — `nativeAgents` has never been observed in a runtime payload.** It is derived
  server-side from real provider events and the public dispatch endpoint accepts no injection
  path, so agent rows cannot be seeded without a real provider turn. The contract declares the
  field and the type flows through to `apps/mobile`, but that is a reading, not an observation.
- **6.2 — the gesture was settled by shipping the default, not by feel.** Tap resolves to the
  peek sheet everywhere. That is a real decision and it is applied consistently, but the
  device comparison the spec envisaged did not happen.
- **7.5 — contrast was measured on the composed token stack, not sampled on a rendered device.**

The surface ships behind `threadTasksEnabled`, a device-local beta flag defaulting to **off**,
which is what makes closing on unverified layout a reasonable risk rather than an unreasonable
one.

Scope decisions taken during delivery, recorded so they are not rediscovered as surprises:

- **Legacy list is out of scope.** Mobile can opt out of the v2 thread list, and the legacy
  `ThreadListRow` remains live in Home and the iPad sidebar. This change targets
  `thread-list-v2-items.tsx` only, so **the surface is absent in legacy-list mode**.
- **React Native component-test infrastructure does not exist** — `apps/mobile` had 99 vitest
  tests and zero `.test.tsx`, with no `@testing-library/react-native` and no
  `react-test-renderer`. Both PRs follow the repository's established pure-logic pattern, which
  is also what Requirement 2 asks for ("verifiable without rendering a component"). Adding a
  component-test harness is an open follow-up, not a silent omission.
- **The spec carries 26 scenarios across 10 requirements**, not the 24 an early brief claimed.
  Corrected during PR 2 by counting.

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

- [~] 2.1 Confirm at runtime that `EnvironmentThreadShell` on mobile actually carries `nativeAgents`, `task`, `taskSummary`, and `parentThreadId` — the contract says it does; verify it against a real payload before building on it.
  - **Never observed. Waived at closure** — see Waived above. `task`, `taskSummary` and
    `parentThreadId` were seen indirectly via the desktop sidebar rendering seeded task groups
    from the same shell payload. `nativeAgents` was not: it is derived server-side from real
    provider events and the public dispatch endpoint accepts no injection path, so agent rows
    cannot be seeded without a real provider turn. The contract declares the field and both
    reviewers confirmed the type reaches `apps/mobile` — but that is a reading of the contract,
    not an observation of a payload, and the whole agent surface rests on it.
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

Delivered in PR 2 (#41). Not verified on a device — see Waived above.

- [x] 3.1 Nest task rows under their parent in `features/threads/thread-list-v2-items.tsx`, following the anatomy in `experiments/mobile-tasks-mockups-v2/flow-1-list/`.
- [x] 3.2 Add the disclosure chip carrying the rollup, and the guide-line sub-rows beneath an expanded thread.
- [x] 3.3 Present the per-turn agent rollup on the turn row.
  - A review finding corrected the collapsed state, which had implied thread-wide agent totals
    rather than the bounded latest-turn window.
- [x] 3.4 Surface the unread-result indication on the parent thread, so it is visible without expanding.
  - Both reviewers independently caught a parent marker that cleared while a sibling task was
    still unread. Fixed, with a regression test confirmed non-vacuous — it fails against the
    old aggregation and passes against the new.
- [x] 3.5 **Regression gate:** a thread that owns no tasks and no agents renders exactly as it does today. This list already works and users rely on it.
  - Structural on both halves. The projection gives a thread owning neither `kind:
"plain-thread"` with no `rollup` key. The view binds the existing v2 row tree to a variable
    and early-returns it whenever there is no rollup, so an ordinary thread renders the _same_
    tree rather than an equivalent-looking one. `ThreadRouteScreen` keeps ordinary threads inert
    — no task-shell subscription, no projection build.

## 4. Peek

Delivered in PR 2 (#41). Not verified on a device — see Waived above.

- [x] 4.1 Build the peek presentation from `experiments/mobile-tasks-mockups-v2/flow-2-peek/`.
  - `TaskAgentPeekSheet.tsx` plus `TaskPeekRouteScreen.tsx`.
- [x] 4.2 Use identical row anatomy for tasks and for agents — an agent must not get a degraded or structurally different treatment.
- [x] 4.3 Render the composer as unavailable **with the reason in words** wherever the subject cannot be steered, including every provider-native in-session agent.
  - Opaque tokens, no ancestor opacity over the text. Measures 4.66:1 dark / 5.28:1 light.
- [x] 4.4 Provide the route from an agent to where it ran in the transcript, or state plainly why it is unavailable if the lookup cannot be supported yet.
  - **Resolved as unavailable-with-reason, a deliberate deviation from normative text.**
    Requirement 3 says the peek "SHALL offer a route to the agent's place in the transcript".
    `ThreadNativeAgent` carries `taskId` and `turnId` but no transcript message or card
    identifier, and the contract states these agents have no transcript, so the route cannot
    exist. Routing to the owning task instead was rejected as overclaiming. Recorded rather
    than hidden.

## 5. Full Task View

Delivered in PR 2 (#41). Not verified on a device — see Waived above.

- [x] 5.1 Build the full task view from `experiments/mobile-tasks-mockups-v2/flow-3-task/` — the task's identity, its turns, the agents inside a turn with their outcomes, and a composer.
  - `TaskAgentTaskSurface.tsx` with its `.logic.ts` sibling.
- [x] 5.2 Ensure the route resolves to the task that was tapped, never to a default. This exact defect appeared in the mockups: three forward hops silently dropped their payload and always rendered the default.
  - Unconstructible at the type level: destinations require branded ids with no optional or
    defaulted identity fields. `TaskPeek` and `TaskAgentPeek` are separate routes so a dropped
    `agentId` cannot silently degrade into the owning task; a stale or incomplete identity
    resolves to nothing rather than to a default.
- [x] 5.3 Ensure no dead affordances — every control either acts or states why it cannot.
  - One known exception, accepted deliberately: a failed or cancelled task's reason text says
    "retry it", but no retry control exists. Implementing retry means issuing orchestration
    turns from mobile, which `design.md` lists as a non-goal. The wording, not the control, is
    the residue — worth revisiting when retry lands.

## 6. Settle the Gesture

- [x] 6.1 Build both mappings for the task-row tap — peek and push — behind a switch, since this is a feel question and the mockups deliberately left it open.
  - `resolveTaskRowTapDestination` takes **no context argument**, so it is structurally
    impossible for the same gesture to peek in one place and push in another.
- [x] 6.2 Decide one, apply it everywhere a task row appears, and record the decision and its reasoning.
  - **Decision: tap opens the peek sheet.** Applied everywhere by construction —
    `resolveTaskRowTapDestination` takes no context argument, so one switch changes it
    globally and no call site can diverge. The explicit "Open thread" affordance pushes the
    full task route.
  - **Reasoning, stated honestly:** this is the mockups' default, shipped as-is. The spec
    envisaged trying both on a device and choosing by feel; no device was available, so the
    default was accepted rather than compared. Revisit if the sheet feels wrong in use — the
    switch makes that a one-line change.
- [x] 6.3 Keep the losing destination reachable through a different, discoverable affordance.
  - Every task row projects an `alternative-affordance` labelled "Open thread" (or "Peek at
    task" under the inverse mapping), tested to exist for every row.

## 7. Verification

- [~] 7.1 Write a component test per state in `experiments/mobile-tasks-mockups-v2/state-matrix/` — queued, exactly one agent, zero failures, all failed, cancelled mid-flight, returned-but-unread, and the native agent — asserting the honesty rule each state exists to prove, not the pixels.
  - All seven states are covered as **pure view-model tests** rather than component tests, since
    no RN component-test harness exists (see Delivery status). Each case asserts its honesty
    rule and every case additionally walks the whole projection asserting no `"0 of 0"` string.
  - PR 2 added view-model tests for the rendering decisions on top of PR 1's projection tests.
    Mobile suite: **740 passing**, up from 681 on `dev`. The 5 failures in
    `src/lib/threadActivity.test.ts` are pre-existing on untouched `dev` and unrelated.
    `tsc --noEmit` exit 0; `threadListV2`'s 19 tests unchanged.
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
  - Measured on the composed token stack: the unavailable-composer explanation is 4.66:1 dark
    and 5.28:1 light, and no ancestor `opacity` sits over any text on the new surface, which is
    what makes the token figure the effective figure. **Not sampled on a rendered device**, so
    an unintended opacity introduced by a parent at runtime would not have been caught.
  - One known pre-existing exception: the iPad sidebar applies an ancestor opacity fade over all
    its content. That is on `dev` already and affects every sidebar surface, not just this one.
- [~] 7.6 Run the surface on a real device or simulator in both themes and confirm each of the seven states renders as designed.
  - **Never run. Waived at closure** — see Waived above. No Expo web target, no Android
    emulator or AVD, Expo Go unsupported due to native modules. This is the single largest
    unverified area in the change: nothing has been seen rendering. The `threadTasksEnabled`
    flag defaults off, which bounds the exposure.
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
