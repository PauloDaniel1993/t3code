## Why

Tasks and their provider-native in-session agents are invisible on mobile. The web sidebar has surfaced them since `thread-task-ui` shipped — nested task rows, per-turn agent groups, a peek window, steering — while `apps/mobile` renders a thread list that shows none of it. A user who starts a task from their phone can see the parent thread working and cannot see what is working, whether anything failed, or why.

The design work is already done and the data is already there. `experiments/mobile-tasks-mockups-v2/` settled the flow, rendered every lifecycle state, and wrote the honesty rules down as a spec. Separately — and this is the fact that makes the change small — `nativeAgents` already rides on the thread payload mobile subscribes to. Nothing is missing from the wire; nothing reads it.

## What Changes

- **Read what mobile already receives.** `ThreadTaskThreadFields` (`packages/contracts/src/orchestration.ts:683`) puts `nativeAgents`, `task`, `taskSummary`, and `parentThreadId` on `OrchestrationThreadShell`, which is what `OrchestrationShellSnapshot.threads` carries and what `EnvironmentThreadShell` extends. `apps/mobile` imports that type 33 times and already types its list rows with it. **No contract change, no server change, no new subscription.**
- **Lift the rollup rules into shared code.** `apps/web/src/components/SidebarNativeAgents.logic.ts` and `SidebarNativeAgentGroups.logic.ts` already group agents by turn and compute `runningCount` / `finishedCount` / `failedCount` as pure functions — their own header says they are "kept separate from the components so the rules are testable without rendering." Move them somewhere both apps consume so the two surfaces cannot drift, with **no behaviour change on web**.
- **Build the converged mobile flow** from `experiments/mobile-tasks-mockups-v2/`: thread-list entry with the disclosure chip and guide-line sub-rows, a bottom-sheet peek, and the full task view that "Open thread" lands on.
- **Satisfy the honesty requirements** already written in `mobile-task-agent-surface`: every lifecycle state has a rendering; a control that cannot be used states why in words; counts read correctly at zero, one, and all-failed; every failure carries a reason; text meets 4.5:1 in both themes.
- **Settle sheet-versus-push**, which the mockups deliberately left open (v1 `README.md:158-161`). It cannot stay open in shipped code — a task row tap must be one gesture.
- **Port the theme tokens to a JS theme object.** React Native has no CSS custom properties, so `CONTRAST.md`'s measured values need a typed home rather than a re-derivation.

## Capabilities

### New Capabilities

- `mobile-task-agent-ui`: How the mobile client surfaces tasks and in-session agents — nesting tasks under their parent in the thread list, rolling up counts per turn, peeking at a task or agent, the full task view, steering and its refusal, unread results, and the navigation gesture that connects them. The mobile analogue of `thread-task-ui`.

### Modified Capabilities

None. `mobile-task-agent-surface` states the design contract this change implements, and its requirements are unchanged — they were written to be implementation-agnostic precisely so they would survive into React Native. `thread-task-ui` describes the desktop sidebar and is untouched.

## Impact

- **`apps/mobile`** — a new feature area for the task/agent surface, plus changes to `features/threads/thread-list-v2-items.tsx` to nest task rows and render the disclosure chip. This is the bulk of the work.
- **Shared location for the rollup logic** — the pure grouping and counting functions move out of `apps/web/src/components/`. Exact home to be settled in design; `packages/client-runtime` is the candidate both apps already depend on, though it currently holds state rather than presentation rules.
- **`apps/web`** — imports repoint at the shared module. Behaviour must not change, and the existing `SidebarNativeAgentGroups.logic.test.ts` and `SidebarNativeAgents.logic.ts` tests are the proof.
- **No changes to** `packages/contracts`, `apps/server`, or the persistence layer. The projection pipeline (`apps/server/src/orchestration/nativeAgents.ts`) and its backfill migration already populate this data.
- **Accessibility is a hard acceptance criterion, not a polish pass.** The mockup round produced two contrast defects that token tables could not see — a `0.65` opacity multiplier that dropped a mandatory explanation to 2.66:1, and an `hsl()` avatar hue that passes at 215 and fails at 60. React Native `View` opacity reproduces the first exactly.
- **Inherited from the mockups, unresolved:** the tasks/agents reference image never arrived, so the visual language is an interpretation rather than a match. `experiments/mobile-tasks-mockups-v2/HANDOFF.md` records this. Implementation proceeds on the mockups as the reference of record.
- **Depends on** `revise-mobile-task-mockups` being archived, so `mobile-task-agent-surface` lands in `openspec/specs/` and can be referenced rather than duplicated.
