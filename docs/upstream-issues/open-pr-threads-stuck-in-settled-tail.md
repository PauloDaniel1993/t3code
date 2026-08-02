# Open-PR threads can remain stuck in the Settled tail

Summary: An open pull-request thread can be classified as settled before its row mounts, so the row never gets a chance to report that the PR is open.

Impact: A thread waiting for review can disappear from the active list and remain hidden behind the Settled shelf’s paging or collapsed state. Reopening a PR while its row is not rendered can leave the same thread settled with stale or missing PR state.

## Minimal reproduction

1. Use the v2 thread sidebar with a server that supports thread settlement and a repository whose branch has a pull request.
2. Prepare at least 11 otherwise-eligible settled threads in one scope. Make the target thread older than the other ten and quiet past the configured inactivity window, but leave an actual PR open on its branch. Do not give the target an explicit settled override.
3. Open the sidebar with the Settled shelf expanded, but do not click **Show more**. The target is sorted after the first ten settled rows.
4. Observe that the target is not in Active and is not among the ten rendered Settled rows. It appears only after paging the tail or otherwise navigating it into view; once its row mounts, its PR state can finally be discovered.
5. For the reopen variant, let a rendered PR row report `closed` or `merged`, then page it out or collapse the Settled shelf and reopen the PR externally. Refresh the repository state. The unrendered row cannot report the new `open` state.

## Causal chain

1. PR state is discovered by the row. The row resolves a PR state and reports it to its parent from an effect: `apps/web/src/components/SidebarV2.tsx:550` — `onChangeRequestState(threadKey, prState);`.

2. The parent stores those reports in a map that starts empty: `apps/web/src/components/SidebarV2.tsx:1357-1359` — `const [changeRequestStateByKey, setChangeRequestStateByKey] = useState<...>(() => new Map());`.

3. The parent partitions threads before rendering rows, and reads that same map during classification: `apps/web/src/components/SidebarV2.tsx:1592` — `const changeRequestState = changeRequestStateByKey.get(threadKey) ?? null;`; it then passes the value to `effectiveSettled`: `apps/web/src/components/SidebarV2.tsx:1600` — `effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })`.

4. The shared predicate has the intended open-PR behavior only when the state is supplied: `packages/client-runtime/src/state/threadSettled.ts:264-268` — `if (options.changeRequestState === "open") return false;`. With a missing state, it falls through to the inactivity test: `packages/client-runtime/src/state/threadSettled.ts:271-280` — `return (Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoSettleAfterDays * DAY_MS);`.

5. Only a bounded settled tail is materialized. The initial count is ten: `apps/web/src/components/SidebarV2.tsx:168` — `const SETTLED_TAIL_INITIAL_COUNT = 10;`; the visible slice is taken before rows are created: `apps/web/src/components/SidebarV2.tsx:1677` — `useState(SETTLED_TAIL_INITIAL_COUNT);` and `apps/web/src/components/SidebarV2.tsx:1685-1687` — `const visible = settledThreads.slice(0, settledVisibleCount);`.

6. The rendered list consumes only that visible tail: `apps/web/src/components/SidebarV2.tsx:2986-2988` — `for (const thread of renderedSettledThreads) { items.push(renderThreadRow(thread, "settled")); }`. A collapsed shelf renders no settled rows except the routed thread: `apps/web/src/components/SidebarV2.tsx:1709-1715` — `if (routeThreadKey === null) return [];`.

7. Therefore, a target beyond the first ten—or any settled row hidden by collapse—does not mount, so its row effect cannot populate the map. For a row that was previously mounted, the reporting effect has no cleanup callback: `apps/web/src/components/SidebarV2.tsx:549-551` — `useEffect(() => { onChangeRequestState(threadKey, prState); }, [...])`; the handler removes an entry only when it receives `null`: `apps/web/src/components/SidebarV2.tsx:1365-1368` — `if (state === null) { next.delete(threadKey); }`. A never-mounted target remains `null`; a previously rendered row can retain its last `closed`/`merged` value after unmount.

8. Mobile follows the same dependency direction. The shared mobile partition accepts per-row PR state and applies it before the inactivity decision: `apps/mobile/src/features/threads/threadListV2.ts:319-320` — `Per-row PR state reported up by visible rows`; `apps/mobile/src/features/threads/threadListV2.ts:379-380` — `input.changeRequestStateByKey?.get(\`${thread.environmentId}:${thread.id}\`) ?? null;`; and `apps/mobile/src/features/threads/threadListV2.ts:395-402`—`effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })`followed by`active.push(thread)` otherwise.

9. The mobile row supplies that state only when it is rendered: `apps/mobile/src/features/threads/thread-list-v2-items.tsx:375-380` — `const pr = useThreadPr(...); ... onChangeRequestState?.(threadKey, prState);`. The hook itself queries VCS state for the row: `apps/mobile/src/state/use-thread-pr.ts:19-30` — `useEnvironmentQuery(... vcsEnvironment.status({ environmentId: thread.environmentId, input: { cwd } }))`; its documentation explicitly describes the visibility dependency: `apps/mobile/src/state/use-thread-pr.ts:13-17` — `virtualization means only visible rows subscribe at all`.

10. Mobile also limits the settled rows and can hide them on a collapsed shelf: `apps/mobile/src/features/threads/threadListV2.ts:101` — `export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;`; `apps/mobile/src/features/threads/threadListV2.ts:422-424` — `const pagedSettled = orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;`; and `apps/mobile/src/features/threads/threadListV2.ts:430-434` — `input.settledShelfExpanded !== false ? pagedSettled : pagedSettled.filter(...)`. Both mobile callers pass the row-state map, page limit, and shelf state into this builder: `apps/mobile/src/features/home/HomeScreen.tsx:591-604` and `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx:495-509`.

## Observed behaviour

An old target with an open PR is classified as settled while its PR state is unavailable, then remains outside the materialized settled tail. A previously rendered target can remain settled after its PR is reopened while the row is paged out or the shelf is collapsed.

## Expected behaviour

With no explicit user-settle override and no active blocker, an open PR should prevent automatic inactivity settlement, including after a reopen, regardless of whether the row is currently visible. The `effectiveSettled` guard already expresses that rule when it receives `"open"`.

## Suggested fix direction

Make change-request state available at the thread-shell/read-model or other parent classification boundary, rather than discovering it only in rendered rows. The classification input should be updated when a PR opens, closes, merges, or reopens even if the corresponding row is outside the settled page or the shelf is collapsed. Keep the explicit user-settle override semantics intact.

## Verification

Verified against `origin/main` resolved to `e60821f0e0d82a5d671ca3b94719c49d333921c8`. The open-PR guard is present at `packages/client-runtime/src/state/threadSettled.ts:268` and was introduced by commit `491219bf1f4db7144b747fe02af0cbc075668b12`. The additional mobile settled-shelf unmount path is present in `apps/mobile/src/features/threads/threadListV2.ts:430-434` and was introduced by commit `916cff733cd00c85fe0419df5bcb9372a6384746`.
