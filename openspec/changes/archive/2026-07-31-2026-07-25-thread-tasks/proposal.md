## Why

A T3 Code thread is a single linear conversation. When the agent needs to split work — audit three
subsystems, inventory two clients, compare against a reference — it either serializes the work into
one context or the user hand-creates unrelated threads and manually copies results back. Neither
keeps the parent conversation as the place where the work converges.

Thread tasks make delegation first-class: a task is a real thread owned by a parent thread. The
parent's agent (or the user) creates it with a chosen slice of context, it runs with its own
provider session, and when it finishes t3code injects its result into the parent and resumes the
parent thread — even if the user is looking somewhere else. The approved UX mockup in
`experiments/thread-tasks-mockups/` is the reference for the visible surface.

## What Changes

- Add `parentThreadId` and per-thread task metadata to the orchestration thread model so a thread
  can own child task threads, with a parent-side rollup for sidebar counts and unread results.
- Add a `thread.task.create` / `thread.task.cancel` command pair and `thread.task-created`,
  `thread.task-updated`, `thread.task-finished` events on the parent thread aggregate.
- Add a task context spec — full thread, selected message ids, or none — rendered deterministically
  into the task thread's first user message with a bounded budget.
- Add automatic result delivery: when a task thread goes idle after doing work, the server records
  the result and wakes the parent by dispatching a turn start carrying a `task-result` message,
  which reuses existing session resume for idle or stopped parent sessions.
- Add a `tasks` MCP capability with `task_create`, `task_list`, and `task_cancel` tools so a
  tool-capable parent provider can delegate without a bespoke protocol method.
- Add nested sidebar rendering: disclosure chevron, `N tasks` count chip, unread-results blue dot,
  indented task rows with live status and elapsed time, and a hover-visible `+ New task` row.
- Add the mini thread window — a floating card anchored to a task row with status, chips, a live
  mini timeline, a plain-text steer composer, and `Open thread ↗`.
- Add parent-timeline lifecycle rows for task created and task finished, and hide the injected
  `task-result` message behind the finished row.
- Add cascade rules: settling or snoozing a parent leaves tasks running and delivery wakes the
  parent; archiving cancels running tasks and skips delivery; deleting cascades to task threads.
- Add an additive fork migration and a `threadTasks` environment capability flag for version skew.

## Capabilities

### New Capabilities

- `thread-tasks`: Defines parent/child thread linkage, task status and result payloads, the context
  spec, creation and cancellation commands, result delivery and parent wake-up, cascade behavior on
  settle/snooze/archive/delete, projection storage, and replay stability.
- `thread-task-agent-tools`: Defines the provider-callable MCP surface — capability gating, the
  `task_create` / `task_list` / `task_cancel` tools, their inputs and outputs, and the limits that
  bound delegation.
- `thread-task-ui`: Defines the web surface — nested sidebar rows and their indicators, the mini
  thread window, timeline lifecycle rows, manual creation entry points, and the context picker.

### Modified Capabilities

No existing OpenSpec capabilities are modified. `composer-steering` behavior is reused unchanged by
the mini-window steer composer.

## Impact

- Affected contracts:
  - `packages/contracts/src/orchestration.ts`
  - `packages/contracts/src/environment.ts`
- Affected client runtime:
  - `packages/client-runtime/src/operations/commands.ts`
  - `packages/client-runtime/src/state/shell.ts`, `shellReducer.ts`, `threadDetail.ts`
- Affected server systems:
  - orchestration commands, events, decider, and projector
  - `ProviderCommandReactor` result delivery and parent turn start
  - a new task lifecycle reactor watching task-thread turn completion
  - MCP invocation capabilities, session registry, and a new `tasks` toolkit
  - projection persistence and snapshot query
- Affected web systems:
  - `apps/web/src/components/SidebarV2.tsx` and `Sidebar.logic.ts`
  - a new mini thread window component and its anchoring/dismissal logic
  - `apps/web/src/components/chat/MessagesTimeline.tsx` and `MessagesTimeline.logic.ts`
  - `apps/web/src/session-logic.ts` activity-to-work-log mapping
  - `apps/web/src/uiStateStore.ts` for task-group collapse state
- Affected persistence:
  - additive fork migration `004_ProjectionThreadTasks` for `parent_thread_id`, `task_json`,
    `task_summary_json`, and a parent lookup index on `projection_threads`
- Required verification:
  - focused contract, server, and web tests for the changed behavior
  - integrated web verification with the `test-t3-app` skill against an isolated environment
