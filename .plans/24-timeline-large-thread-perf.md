# Timeline Performance for Large / Handoff Threads

## Goal

Make the chat message timeline render and scroll smoothly for threads with very
large message counts — primarily handoff target threads, which can be created
with up to 2,000 imported messages in a single step (`VISIBLE_HANDOFF_IMPORT_MESSAGE_LIMIT`
in `apps/server/src/orchestration/decider.ts`), but also any long-lived thread.

This is the follow-up ("Option B") to the imported-message collapse shipped in
the handoff slowness fix. Collapse (Option A) hides the imported block by
default, which removes the acute pain. This plan addresses the underlying
behaviour so the timeline stays fast even when a large block is **expanded** or
when a native thread simply grows long.

## Background / Correction

The timeline is **already virtualized**. `MessagesTimeline.tsx` renders rows
through `LegendList` (`@legendapp/list/react`), not a plain `.map()`. So the
slowness is **not** "no virtualization" — it is the cost profile of the existing
virtualized list when fed hundreds of tall, variable-height markdown rows:

1. **Height-estimate mismatch.** `LegendList` is configured with a single fixed
   `estimatedItemSize={90}` (`MessagesTimeline.tsx`). Imported/assistant markdown
   rows are routinely many hundreds of pixels tall. With `initialScrollAtEnd`
   and `maintainVisibleContentPosition`, every off-screen estimate that gets
   corrected to its real (much larger) height forces content-size and
   scroll-offset recomputation — layout thrash that scales with how wrong the
   estimate is and how many rows exist.
2. **No row recycling.** `recycleItems` is not enabled, so each row entering the
   viewport mounts a fresh `ChatMarkdown` (an expensive parse/render) instead of
   reusing an instance.
3. **O(n) derivation per update.** `deriveTimelineEntries` →
   `deriveMessagesTimelineRows` → `computeStableMessagesTimelineRows` each walk
   the full entry array on every input change (streaming delta, working-indicator
   tick, fold toggle). At 600–2,000 entries this is real main-thread work per
   tick during active turns.

Option A mitigates 1–3 for the common case by collapsing the imported run into a
single row, shrinking the live row count to roughly the native message count.
This plan removes the ceiling so expanding a large block, or a genuinely long
native thread, is also smooth.

## Non-Goals

- Re-introducing or replacing the list library. `LegendList` stays.
- Changing the imported-message product model (collapse stays the default; this
  plan is about what happens when content is expanded or threads grow).
- Server-side transcript pruning or pagination of persisted messages (tracked
  separately; see Open Questions).

## Approach

Tackle the three cost sources above, cheapest-first, measuring after each so we
stop when scroll is smooth rather than over-engineering.

### 1. Better height estimation (highest value / lowest risk)

- Replace the single `estimatedItemSize={90}` with a per-`getItemType` estimate.
  `getItemType` already distinguishes `message:user`, `message:assistant`,
  `work`, `turn-fold`, `import-fold`, etc. Give markdown message types a realistic
  larger estimate and the thin fold/work rows a small one. This alone sharply
  reduces correction thrash.
- Investigate `LegendList`'s measured-size cache: confirm whether it persists
  measured heights across data updates within a mounted list, and whether a
  larger/explicit `drawDistance` reduces re-measure churn on fast scroll.
- Acceptance: scrolling up through an expanded 600-message imported block shows
  no visible scroll jump/anchor correction beyond one frame.

### 2. Enable row recycling

- Turn on `recycleItems` and audit row components for recycle-safety: no
  unstable closures, no per-render identity assumptions, correct `keyExtractor`
  (already `item.id`) and `getItemType` separation so recycled nodes only swap
  between same-type items.
- `ChatMarkdown` is the heavy child — verify it memoizes on `text`/props so a
  recycled host doesn't reparse identical content. Add memoization if missing.
- Acceptance: continuous fast scroll over a large thread holds frame rate with
  no flicker or stale content in recycled rows.

### 3. Reduce per-update derivation cost

- Profile `deriveTimelineEntries` + `deriveMessagesTimelineRows` +
  `computeStableMessagesTimelineRows` on a 1,000-entry thread during streaming.
- If hot: memoize the imported/turn-fold derivation so the collapsed imported
  prefix (which never changes once imported) is computed once and reused, and
  only the live tail re-derives on streaming deltas. `computeStableMessagesTimelineRows`
  already preserves row identity; extend the same "unchanged prefix" idea to the
  derivation inputs.
- Acceptance: per-delta main-thread time for derivation on a 1,000-entry thread
  is under a chosen budget (e.g. < 2 ms) on a mid-range machine.

## Files

- `apps/web/src/components/chat/MessagesTimeline.tsx` — `LegendList` props
  (`estimatedItemSize`, `recycleItems`, `drawDistance`), row components,
  `getItemType`.
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` — derivation /
  stable-rows; memoization of the unchanged imported prefix.
- `apps/web/src/components/ChatMarkdown.tsx` — memoization audit.

## Testing

- Unit: extend `MessagesTimeline.logic.test.ts` for any new memoization /
  prefix-reuse logic (identity preserved across updates; correct rows on toggle).
- Manual / perf: with an isolated `--base-dir`, create a handoff target thread
  from a 600+ message source, then:
  - measure time-to-interactive opening the target thread (collapsed),
  - expand the imported block and measure scroll smoothness (Performance panel,
    frame rate, long-task count),
  - send a native turn and confirm streaming does not degrade with the large
    history present.
- Required checks: `vp run typecheck`, `vp check`.

## Rollout / Sequencing

1. Land per-type height estimates (Section 1) — biggest win, smallest risk.
2. Measure. If expanded large blocks are smooth, stop and defer 2–3.
3. Enable recycling (Section 2) if scroll still drops frames.
4. Optimize derivation (Section 3) only if profiling shows it as a bottleneck
   during streaming.

## Open Questions

- Should very large imported blocks remain a single fold, or paginate into
  chunked sub-folds ("messages 1–200", "201–400", …) so even expansion never
  realizes thousands of rows at once? Decide based on Section 1–2 results.
- Is server-side message pagination (load-on-scroll from persistence) warranted
  for extreme threads, or does virtualization of the already-loaded snapshot
  suffice? Out of scope here; revisit if snapshot size itself becomes the limit.
