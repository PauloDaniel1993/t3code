## Context

Claude Agent SDK emits enough structured data to build the approved Option F experience, but T3 Code currently discards or weakly encodes part of it.

Available SDK task data:

- `task_started`: `task_id`, `tool_use_id`, `description`, `subagent_type`, `task_type`, `workflow_name`, `prompt`, `skip_transcript`.
- `task_progress`: task/tool-use identity, description, subagent type, cumulative `total_tokens`, `tool_uses`, `duration_ms`, `last_tool_name`, and optional AI-generated progress `summary`.
- `task_notification`: task/tool-use identity, final status, output file, summary, and cumulative usage.
- `tool_progress`: `tool_use_id`, `tool_name`, elapsed seconds, and `task_id` when the tool belongs to a task.

The current canonical task payload retains only a subset of those fields. `tool_progress.task_id` is currently serialized into a free-form summary string, and provider reasoning deltas are not projected into the activity model. The approved UI requires richer canonical metadata and precise semantics for what is displayable.

## Goals / Non-Goals

**Goals:**

- Implement the approved Option F layout as a turn-scoped card shown in one bottom activity surface directly above the composer; select its turn from the timeline's current message cycle and keep a response-local launcher after Close.
- Let users independently close, collapse, or expand every turn's activity surface without changing another turn's state.
- Show step progress and inline worker expansion within the same container.
- Toggle a selected step closed when clicked again; switch worker content when a different step is clicked.
- Show cumulative worker token usage, tool count, duration, last tool, status, and output/result summary when present.
- Show only provider-supplied, user-displayable progress or reasoning summaries, collapsed by default.
- Preserve enough task metadata to support workflows and subagents without parsing display strings.
- Keep compact tool rows and distinct task cards in the transcript.

**Non-Goals:**

- Do not expose hidden/raw chain-of-thought. The UI only displays summaries or reasoning text explicitly delivered by the provider runtime.
- Do not invent token counts, tool counts, durations, reasoning, or task-to-step relationships when metadata is unavailable.
- Do not require a separate right-panel surface in the first iteration; current and historical activity share one bottom surface in the main conversation area.
- Do not recursively render arbitrary nested subagent hierarchies in the first iteration.

## Decisions

1. **Extend canonical task payloads instead of parsing raw provider messages in the web app.**
   - Add a canonical task-usage schema with `totalTokens`, `toolUses`, and `durationMs`.
   - Preserve optional `toolUseId`, `subagentType`, `workflowName`, `prompt`, `skipTranscript`, and `outputFile` fields.
   - Add optional `taskId` to `ToolProgressPayload`; stop using `summary: "task:<id>"` as correlation metadata.
   - Rationale: provider-specific parsing stays in adapters, while web presentation consumes stable canonical data.

2. **Treat `task.progress.summary` as a progress summary, not chain-of-thought.**
   - The UI label is “Progress” or “Progress summary.”
   - If the provider emits displayable `reasoning_text` for the primary turn, it may be projected as a separate collapsed “Reasoning” section at the workflow/turn level.
   - Rationale: this accurately represents SDK semantics and avoids promising unavailable subagent reasoning.

3. **Correlate tasks to steps by lifecycle sequence.**
   - On `task.started`, assign the task to the plan step that is `inProgress` in the latest `turn.plan.updated` state at or before the task event sequence/time.
   - Persist this derived association in the client model for the lifetime of the derived timeline; recomputation from the same ordered activities must be deterministic.
   - If no step is active, assign the task to an “Other activity” group rather than guessing.
   - Rationale: no explicit step ID exists in current provider events.

4. **Aggregate cumulative usage without double-counting progress snapshots.**
   - Task progress/notification usage values are cumulative. For each worker, keep the latest valid usage snapshot, not the sum of all snapshots.
   - Panel total tokens/tool uses/duration derive from the latest snapshot of each unique task.
   - Rationale: summing progress snapshots would inflate totals.

5. **Use one expandable phase container per turn.**
   - The progress strip and worker list share one rounded container.
   - `selectedStepId === clickedStepId` clears selection; otherwise selection switches.
   - Step selection remains local to the card instance and cannot leak to another turn.

6. **Retain activity by exchange and select the bottom surface from scroll context.**
   - Derive one workflow activity model for every turn with meaningful persisted activity.
   - Render one bottom-anchored card directly above the composer for the message cycle selected by the timeline.
   - While the timeline is at the live end, prefer the running turn; manual scrolling selects historical turns in either direction without a close/reopen step.
   - Keep only the compact reopen launcher beside a terminal assistant response when that turn's bottom surface is closed.
   - Hide the bottom surface when the selected cycle has no meaningful activity.
   - Historical cards reconstruct from persisted thread activity after reload or reconnect.
   - Rationale: users need to revisit and compare multiple subagent/workflow runs in a single thread.

7. **Model card visibility as three independent states.**
   - `expanded` shows the full workflow details.
   - `collapsed` keeps the compact summary card visible.
   - `closed` removes the summary container but retains a small, accessible Activity launcher for that exchange; closing never deletes history.
   - Store historical view state in a `turnId`-keyed map owned above virtualized rows so unmounting a row does not reset another card or create accordion behavior.
   - Every turn defaults collapsed when no explicit session state exists.

8. **Respect transcript visibility metadata.**
   - `skipTranscript` tasks remain available in the workflow activity card's worker model but are omitted from inline transcript task cards.
   - Rationale: this matches the SDK’s ambient/housekeeping task semantics.

## Risks / Trade-offs

- **[Risk]** Lifecycle-based task-to-step association can be ambiguous when multiple steps are marked active or plan updates lag task starts.  
  **Mitigation:** choose the first active step in plan order and place unmatched tasks in “Other activity”; never silently assign to a pending step.
- **[Risk]** Usage is optional and provider-specific.  
  **Mitigation:** make every metric optional and omit separators/labels for absent values.
- **[Risk]** Reasoning deltas may be absent, empty, or provider-filtered.  
  **Mitigation:** render the disclosure only when non-empty displayable content exists; use task progress summaries as progress feedback, not as raw reasoning.
- **[Risk]** The bottom card may cover conversation content or collide with the composer and scroll controls.
  **Mitigation:** measure the card, include it with the composer in the timeline's bottom inset, place scroll-to-end above both surfaces, and bound expanded content with internal scrolling.
- **[Risk]** Several expanded historical cards can increase virtualized row heights and rendering work.
  **Mitigation:** keep detail content unmounted in collapsed/closed states, bound worker/tool regions, and keep independent view state above the virtualized rows.

## Migration Plan

1. Extend contracts additively and update adapter/ingestion mapping.
2. Add pure client derivation for workflow steps, worker association, cumulative usage, and compact tools.
3. Add the Option F component as a bottom-anchored card above the composer in the main conversation area.
4. Add focused tests and browser verification.

Rollback is limited to removing the new panel and leaving additive canonical fields unused.

## Open Questions

- Future provider/runtime versions may add an explicit phase/step ID; if so, prefer it over lifecycle-based correlation while retaining the fallback.
