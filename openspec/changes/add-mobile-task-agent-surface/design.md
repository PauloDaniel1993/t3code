## Context

Three facts, each verified against the tree rather than assumed, set the shape of this change.

**The data already arrives.** `ThreadTaskThreadFields` (`packages/contracts/src/orchestration.ts:683`) defines `parentThreadId`, `task`, `taskSummary`, and `nativeAgents`. It is spread into `OrchestrationThreadShell` at line 758, which is the element type of `OrchestrationShellSnapshot.threads` and of the shell stream events. `packages/client-runtime/src/state/models.ts` declares `EnvironmentThreadShell extends OrchestrationThreadShell` and `scopeThreadShell` spreads the whole object through. `apps/mobile` imports `@t3tools/client-runtime/state/shell` 33 times and already types its list rows as `EnvironmentThreadShell`. So every mobile client is receiving `nativeAgents` today and discarding it at the render boundary. There is nothing to add to the wire.

**The rules already exist, in the wrong place.** `apps/web/src/components/SidebarNativeAgents.logic.ts` groups agents by turn and derives `runningCount`, `finishedCount`, `failedCount`, `latestAt`, and `isLatest`; `SidebarNativeAgentGroups.logic.ts` sits beside it. Both are pure, both have test files, and the first opens by stating it is "kept separate from the components so the rules — how groups are labelled, which ones open, what a row says — are testable without rendering." They were written to be portable and then filed under `apps/web/src/components/`.

**The design is settled and measured.** `experiments/mobile-tasks-mockups-v2/` carries the converged flow, a state matrix rendering seven lifecycle states, `CONVENTIONS.md` for the anatomy and honesty rules, `CONTRAST.md` with WCAG ratios computed from literal token values, and `HANDOFF.md`. Its `mobile-task-agent-surface` spec was deliberately written about the design rather than the HTML so it transfers here unchanged.

What does not exist is any mobile code that reads, groups, or renders this — and one open question the mockups refused to answer: whether a task-row tap peeks or navigates.

## Goals / Non-Goals

**Goals:**

- Make a phone user able to see that a thread owns tasks, what those tasks are doing, which agents ran, and why any of them failed.
- Share the rollup rules between the two clients so desktop and mobile cannot report different counts for the same thread.
- Implement the honesty requirements as testable behaviour, not as visual polish.
- Settle sheet-versus-push, because shipped code cannot hold both.
- Leave web rendering byte-for-byte identical.

**Non-Goals:**

- Any change to `packages/contracts`, `apps/server`, or persistence. The projection pipeline already populates this data and its backfill migration already shipped.
- Reworking the desktop sidebar. Its logic moves; its behaviour does not.
- Resolving v1's remaining data gaps — cross-level rollup across a task's own children, turn identity beyond the latest turn, push-notification parity, and agent-to-transcript deep linking. Each needs a contract answer this change does not have.
- Closing the reference-alignment question. The tasks/agents reference image still does not exist; the mockups are the reference of record, and that is recorded rather than hidden.
- Feature parity with the web sidebar's task creation flows. This change surfaces what exists; `NewTaskDraftScreen` already covers creation.

## Decisions

### 1. Read the existing payload; add nothing to the wire

The first instinct on seeing zero `nativeAgent` references in `apps/mobile` is that the data is missing and the client needs a new subscription. It is not, and it does not — the field is on the shell payload every client already streams. Adding a subscription would duplicate data the snapshot already carries and create a second source of truth for the same field.

The consequence worth naming: because `nativeAgents` is bounded server-side to "the latest turn's set plus anything still running" (per its own contract comment), mobile inherits that bound. The surface can show the live picture and cannot show history. Any design that implies a full agent history is drawing something the payload does not contain.

### 2. Move the rollup rules to a shared home, and let the tests prove nothing changed

The pure logic moves out of `apps/web/src/components/`. `packages/client-runtime` is the candidate both apps already depend on — mobile imports it heavily, and web consumes the same state — though it currently holds state and operations rather than presentation rules, so the move needs a deliberate module rather than a dumping ground.

The existing `SidebarNativeAgentGroups.logic.test.ts` and its siblings move with the code and must pass unchanged. That is the entire safety argument for the extraction: if the tests still pass against the relocated module and web's imports repoint, web's behaviour is intact by construction.

Rejected: copying the logic into mobile. Two copies of a counting rule diverge, and the failure mode is the worst kind — two surfaces confidently reporting different numbers for the same thread, with no error anywhere.

### 3. Treat the state matrix as the test matrix

`experiments/mobile-tasks-mockups-v2/state-matrix/` renders seven states, each chosen because it is where a specific defect appears: queued (no ratio to show), exactly one agent (pluralisation), zero failures (false-positive failure styling), all failed (implying partial success), cancelled mid-flight (conflating cancellation with failure), returned-but-unread (losing the result), and the native agent (an unexplained disabled control).

Those become the test cases directly. A component test per state, asserting the honesty rule rather than the pixels, gives coverage that survives restyling — which matters because the visual language is explicitly unverified against a reference and may yet change.

### 4. Port the tokens rather than re-deriving them

React Native has no CSS custom properties. `CONTRAST.md`'s values become a typed theme object with both themes, so the measured ratios stay traceable to something checkable instead of being re-picked by eye during implementation.

### 5. Verify contrast as composited, not as configured

Two of the three real contrast defects in the mockup round were invisible to the token table. A `.sh-composer.disabled { opacity: 0.65 }` multiplier dropped the mandatory "why this is unavailable" sentence to **2.66:1** while its token measured 4.69:1 — the token was fine and the rendered text was not. An avatar background of `hsl(var(--h) 65% 38%)` with white text measures 7.22:1 at hue 215 and **2.78:1** at hue 60.

React Native reproduces the first exactly: `opacity` on a `View` composites its whole subtree. So the requirement is written against the effective colour, and the disabled-composer case is called out specifically, because that text is the only thing distinguishing an explained control from a broken one.

### 6. Settle sheet-versus-push during implementation, not before

The mockups left this open deliberately and correctly — it is a feel question, and the honest way to answer it is with both built. The constraint the spec imposes is not which one wins but that only one does, everywhere, and that whichever loses stays reachable by a different affordance. Deciding it on paper first would be guessing; deciding it per-context would reproduce exactly the inconsistency v1 warned about.

## Risks / Trade-offs

- **The extraction changes web behaviour subtly** → The moved tests are the guard. If a test needs editing to pass after the move, that is the signal that behaviour changed, and it must be treated as a defect rather than a test fix.
- **`packages/client-runtime` becomes a grab bag** → It currently holds state and operations, not presentation rules. Put the rules in their own module with an explicit name rather than appending to an existing one, or the next person has nowhere obvious to look.
- **The bounded `nativeAgents` window disappoints** → It carries the latest turn plus anything running. A user expecting to scroll back through every agent a long thread ever spawned will not find them, and the surface should not imply otherwise.
- **The visual language is still unverified** → The reference image never arrived. Building against the mockups is the best available option, and the risk is that a later reference invalidates the styling. Structure — nesting, states, counts, reasons — survives a restyle; that is where the tests should sit.
- **Nesting rows changes a list that already works** → `thread-list-v2-items.tsx` renders a list users rely on. Threads owning no tasks must render exactly as they do today, which is both a requirement above and the regression to watch.
- **Contrast regressions reappear at implementation time** → Ratios were measured for the mockup's colours on the web. Any RN-specific adjustment re-opens the question, and "the token passes" is not evidence, as this round demonstrated twice.
