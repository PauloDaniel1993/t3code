## Why

T3 Code currently flattens tool calls, subagent tasks, workflow progress, and provider-supplied reasoning/progress summaries into a sparse work log. This makes long-running Claude workflows difficult to understand: users cannot quickly see the active step, its workers, cumulative token usage, or the latest progress feedback without expanding unrelated transcript entries.

## What Changes

- Add a T3-native workflow activity view based on the approved **Option F** design:
  - A compact step progress panel with completed, active, and pending segments.
  - Clicking a step expands the **same panel** to show that step’s workers; clicking the open step again collapses it.
  - Worker cards show lifecycle status, cumulative token total, tool count, elapsed time, last tool, and the latest displayable progress summary when supplied.
  - Provider-supplied reasoning summaries are collapsed by default and expand only on user action.
  - Recent tool calls remain compact rows below the worker cards.
- Preserve the Claude Agent SDK task metadata needed by the UI: task/tool-use identity, task/subagent/workflow type, workflow name, transcript visibility, output file, structured usage, and last tool.
- Add typed task correlation to tool-progress events instead of encoding the task ID in free-form summary text.
- Deterministically associate tasks with the plan step that was active when each task started; tasks without an active step remain in an unassigned activity group.
- Render task lifecycle entries as distinct task cards while retaining the existing compact tool-call treatment.

## Capabilities

### New Capabilities

- `workflow-activity-panel`: Interactive Option F panel for step progress, inline worker expansion, worker metrics, tool rows, and collapsed progress/reasoning summaries.
- `task-lifecycle-rendering`: Canonical preservation and presentation of task identity, workflow metadata, usage, status, progress summaries, and task-linked tool progress.

### Modified Capabilities

- (none)

## Impact

- Provider/runtime contract changes in `packages/contracts/src/providerRuntime.ts`.
- Claude event mapping changes in `apps/server/src/provider/Layers/ClaudeAdapter.ts` and orchestration ingestion.
- Web derivation changes in `apps/web/src/session-logic.ts` or a dedicated workflow-activity model.
- Side-panel UI changes in `ActivitySidebar.tsx`, `PlanSidebar.tsx`, and `ChatView.tsx`.
- Timeline task-card updates in `MessagesTimeline.tsx`.
- Contract, adapter, ingestion, derivation, rendering, interaction, and browser tests.
