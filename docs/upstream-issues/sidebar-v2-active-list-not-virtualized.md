# Web Sidebar v2 renders every active thread at once

Summary: The web Sidebar v2 builds every active thread as a full card in one plain `<ul>` instead of using viewport virtualization.

Impact: DOM nodes, row-local hooks, VCS queries, terminal-session subscriptions, and layout/animation work grow with the total active-thread count. Workloads with many open PR threads are especially likely to keep a large active list because an open PR blocks automatic inactivity settlement.

## Minimal reproduction

1. Use the web Sidebar v2 with a project that supports thread settlement.
2. Create or import a large number of active threads; keeping an open PR on each target makes them remain active once their PR state is known.
3. Open the sidebar and scroll through the list. Inspect the DOM or React component tree while comparing the number of mounted `SidebarV2Row` instances with the total active-thread count.
4. Observe that off-screen active rows remain mounted and that list updates are applied to the same full `<ul>`.

## Causal chain

1. The sidebar first walks the entire visible shell collection and partitions it into active, snoozed, and settled arrays: `apps/web/src/components/SidebarV2.tsx:1573-1582` — `const visible = threads.filter(...)` followed by `for (const thread of visible)`; a thread that does not satisfy settled classification is pushed to active at `apps/web/src/components/SidebarV2.tsx:1598-1605` — `} else { active.push(thread); }`.

2. The active rows share one plain unordered list, and the list is registered with AutoAnimate: `apps/web/src/components/SidebarV2.tsx:2560` — `autoAnimate(node, { duration: 150, easing: "ease-out" });`; `apps/web/src/components/SidebarV2.tsx:2827` — `<ul ref={attachListAutoAnimateRef} role="list" className="flex flex-col gap-px">`.

3. The render path maps every active thread into that list: `apps/web/src/components/SidebarV2.tsx:2913-2915` — `const items: ReactNode[] = activeThreads.map((thread) => renderThreadRow(thread, "active"));`. The row factory explicitly selects the full card variant for active rows: `apps/web/src/components/SidebarV2.tsx:2836-2843` — `every other thread is a full card` and `const isCard = section === "active"`.

4. Each mounted card owns row-specific work. The row subscribes to running terminal IDs at `apps/web/src/components/SidebarV2.tsx:452-455` — `useThreadRunningTerminalIds({ environmentId: thread.environmentId, threadId: thread.id })`; it also starts a VCS status query at `apps/web/src/components/SidebarV2.tsx:525-532` — `useEnvironmentQuery(... vcsEnvironment.status({ environmentId: thread.environmentId, input: { cwd: gitCwd } }))`.

5. This combines with the open-PR settlement rule: `packages/client-runtime/src/state/threadSettled.ts:264-268` — `if (options.changeRequestState === "open") return false;`. Once the row has reported an open PR, that thread stays in `activeThreads` regardless of inactivity, so the unbounded active-card path can accumulate over time.

## Observed behaviour

The browser mounts one full `SidebarV2Row` for every active thread, including rows outside the visible viewport. The single list also receives whole-list AutoAnimate behavior, so the amount of mounted work and list-update work scales with the active-thread count.

## Expected behaviour

The sidebar should keep the same ordering, selection, accessibility, and row actions while mounting only a bounded viewport window (plus a small overscan) for large active lists. An off-screen active thread should not require a mounted card merely to remain in the list model.

## Suggested fix direction

Move the active-card section to a viewport-aware virtualized list, or introduce an equivalent virtualization layer that can coexist with the settled/snoozed shelf headers and row actions. Rework the animation boundary as needed instead of attaching whole-list AutoAnimate to an unbounded DOM list. This should be treated separately from Issue A: virtualization bounds mounted work, while PR state used for classification must not depend on a row having mounted.

Mobile is not affected by this specific web rendering path: the v2 Home list uses `FlatList` at `apps/mobile/src/features/home/HomeScreen.tsx:1051-1053`, and the navigation sidebar uses `LegendList` at `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx:1160-1168` with `recycleItems` at `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx:1183-1185`.

## Verification

Verified against `origin/main` resolved to `e60821f0e0d82a5d671ca3b94719c49d333921c8`.
