## 1. Share the Rollup Rules

- [ ] 1.1 Read `apps/web/src/components/SidebarNativeAgents.logic.ts` and `SidebarNativeAgentGroups.logic.ts` with their tests, and list every exported symbol web depends on, so the move is a known surface rather than a guess.
- [ ] 1.2 Choose the shared home and say why in one line. `packages/client-runtime` is the candidate both apps already import; it holds state and operations today, so the rules need their own named module rather than an append to an existing one.
- [ ] 1.3 Move the pure grouping and counting logic — `groupNativeAgentsByTurn` and the `runningCount` / `finishedCount` / `failedCount` / `latestAt` / `isLatest` derivation — into that module, unchanged.
- [ ] 1.4 Move the existing tests with the code. They must pass **without edits**; a test that needs changing to go green means behaviour changed, and that is a defect, not a test fix.
- [ ] 1.5 Repoint web's imports and confirm the desktop sidebar renders identically — same groups, same labels, same counts, same expand/collapse behaviour.
- [ ] 1.6 Run the full web test suite. Any failure here is a regression in a shipped surface and blocks the rest of this change.

## 2. Mobile Data Access and Theme

- [ ] 2.1 Confirm at runtime that `EnvironmentThreadShell` on mobile actually carries `nativeAgents`, `task`, `taskSummary`, and `parentThreadId` — the contract says it does; verify it against a real payload before building on it.
- [ ] 2.2 Add mobile-side selectors that read those fields and apply the shared rules from section 1. No new subscription, no new RPC, no duplicated counting.
- [ ] 2.3 Handle the bounded window honestly: `nativeAgents` carries the latest turn's set plus anything still running. Decide what the surface says when a thread has older agents that are no longer in the payload, and make sure nothing implies a full history.
- [ ] 2.4 Port `experiments/mobile-tasks-mockups-v2/CONTRAST.md`'s tokens to a typed JS theme object covering both themes, since React Native has no CSS custom properties.
- [ ] 2.5 Add a contrast assertion helper that evaluates **effective** colour, including any ancestor `opacity`, so the 2.66:1 defect class cannot recur silently.

## 3. Thread List Entry

- [ ] 3.1 Nest task rows under their parent in `features/threads/thread-list-v2-items.tsx`, following the anatomy in `experiments/mobile-tasks-mockups-v2/flow-1-list/`.
- [ ] 3.2 Add the disclosure chip carrying the rollup, and the guide-line sub-rows beneath an expanded thread.
- [ ] 3.3 Present the per-turn agent rollup on the turn row.
- [ ] 3.4 Surface the unread-result indication on the parent thread, so it is visible without expanding.
- [ ] 3.5 **Regression gate:** a thread that owns no tasks and no agents renders exactly as it does today. This list already works and users rely on it.

## 4. Peek

- [ ] 4.1 Build the peek presentation from `experiments/mobile-tasks-mockups-v2/flow-2-peek/`.
- [ ] 4.2 Use identical row anatomy for tasks and for agents — an agent must not get a degraded or structurally different treatment.
- [ ] 4.3 Render the composer as unavailable **with the reason in words** wherever the subject cannot be steered, including every provider-native in-session agent.
- [ ] 4.4 Provide the route from an agent to where it ran in the transcript, or state plainly why it is unavailable if the lookup cannot be supported yet.

## 5. Full Task View

- [ ] 5.1 Build the full task view from `experiments/mobile-tasks-mockups-v2/flow-3-task/` — the task's identity, its turns, the agents inside a turn with their outcomes, and a composer.
- [ ] 5.2 Ensure the route resolves to the task that was tapped, never to a default. This exact defect appeared in the mockups: three forward hops silently dropped their payload and always rendered the default.
- [ ] 5.3 Ensure no dead affordances — every control either acts or states why it cannot.

## 6. Settle the Gesture

- [ ] 6.1 Build both mappings for the task-row tap — peek and push — behind a switch, since this is a feel question and the mockups deliberately left it open.
- [ ] 6.2 Decide one, apply it everywhere a task row appears, and record the decision and its reasoning.
- [ ] 6.3 Keep the losing destination reachable through a different, discoverable affordance.

## 7. Verification

- [ ] 7.1 Write a component test per state in `experiments/mobile-tasks-mockups-v2/state-matrix/` — queued, exactly one agent, zero failures, all failed, cancelled mid-flight, returned-but-unread, and the native agent — asserting the honesty rule each state exists to prove, not the pixels.
- [ ] 7.2 Assert no rollup renders "0 of 0", no count of one is pluralised, and no failure styling appears where nothing has failed.
- [ ] 7.3 Assert every failed agent carries a reason, and that reasons behind a rollup are reachable.
- [ ] 7.4 Assert every unavailable control carries its reason in words.
- [ ] 7.5 Measure contrast on the built surface in both themes, against effective composited colour rather than token values — specifically including the stated-reason text, which is the only thing distinguishing an explained control from a broken one.
- [ ] 7.6 Run the surface on a real device or simulator in both themes and confirm each of the seven states renders as designed.
- [ ] 7.7 Confirm the desktop sidebar is unchanged from before section 1, by test and by inspection.
- [ ] 7.8 Record which of v1's data gaps remain open — cross-level rollup, turn identity beyond the latest turn, push-notification parity, agent-to-transcript lookup — so shipping this surface does not read as having resolved them.
- [ ] 7.9 Record that the tasks/agents reference image still never arrived and that the visual language remains unverified against it, rather than letting a shipped surface imply the question was settled.
