## 1. Contracts

- [x] 1.1 Add `ThreadTaskStatus`, `ThreadTaskCreatedBy`, `ThreadTaskContextSpec`, `ThreadTaskResult`, `ThreadTaskDelivery`, `ThreadTaskMetadata`, and `ThreadTaskSummary` schemas to `packages/contracts/src/orchestration.ts`
- [x] 1.2 Add `parentThreadId`, `task`, and `taskSummary` to `OrchestrationThread` and `OrchestrationThreadShell` with `null` decoding defaults so historical payloads decode unchanged
- [x] 1.3 Add `OrchestrationMessageSource` (`user | provider | system | task-result`) as an optional key on `OrchestrationMessage` and `ThreadMessageSentPayload`, with role-derived fallback when absent
- [x] 1.4 Add `thread.task.create` and `thread.task.cancel` to the dispatchable client command union, and internal `thread.task.status.set` and `thread.task.finish` commands
- [x] 1.5 Add `thread.task-created`, `thread.task-updated`, and `thread.task-finished` event types and payloads on the thread aggregate
- [x] 1.6 Add task limit constants (`THREAD_TASK_MAX_RUNNING`, `THREAD_TASK_MAX_TOTAL`, `THREAD_TASK_MAX_SELECTED_MESSAGES`, `THREAD_TASK_CONTEXT_MAX_CHARS`, `THREAD_TASK_RESULT_SUMMARY_MAX_CHARS`)
- [x] 1.7 Add `threadTasks` to `ExecutionEnvironmentCapabilities` in `packages/contracts/src/environment.ts` as an optional key
- [x] 1.8 Add contract tests for new schemas, historical decode defaults, message-source fallback, and rejection of malformed task payloads

## 2. Persistence And Projection

- [x] 2.1 Add `ForkMigrations/004_ProjectionThreadTasks.ts` adding `parent_thread_id`, `task_json`, and `task_summary_json` to `projection_threads`, guarded by `PRAGMA table_info`
- [x] 2.2 Add an idempotent `parent_thread_id` index in the same migration and register the entry in `ForkMigrations.ts`
- [x] 2.3 Update `persistence/Layers/ProjectionThreads.ts` writes and reads for the new columns
- [x] 2.4 Update `ProjectionSnapshotQuery.ts` so thread shell and detail snapshots carry `parentThreadId`, `task`, and `taskSummary`
- [x] 2.5 Add a projection query helper that resolves a parent's tasks through the new index
- [x] 2.6 Add migration and projection tests covering pre-existing rows, migration re-run, parent lookup, and replay-identical task state

## 3. Server Task Lifecycle

- [x] 3.1 Add a server task domain module for creation eligibility, nesting-depth checks, cap accounting, model-selection readiness, and deterministic task thread titles
- [x] 3.2 Implement context materialization: full-thread, selected-messages, and none, with non-importable message exclusion, attachment metadata lines, oldest-first trimming, and `contextTruncated`
- [x] 3.3 Implement `thread.task.create` in `decider.ts` — emit `thread.created` for the task thread, `thread.task-created` on the parent, and the task's first turn start
- [x] 3.4 Implement `thread.task.cancel` in `decider.ts` including the no-op path for already-settled tasks
- [x] 3.5 Implement `thread.task.status.set` and `thread.task.finish` internal command handling with exactly-once delivery guarding
- [x] 3.6 Project task events in `projector.ts` into child `task` metadata and parent `taskSummary`, and append `task.created` / `task.finished` parent activities
- [x] 3.7 Implement cascade rules for parent settle, snooze, archive, unarchive, and delete, and for direct archive/delete of a task thread
- [x] 3.8 Add decider and projector tests for creation rejections, caps, nesting, cancel, cascades, and replay stability

## 4. Result Delivery And Parent Wake-Up

- [x] 4.1 Add a task lifecycle reactor that detects an armed task thread settling — no running turn, latest turn `completed` or `error`, no pending approval or user-input request
- [x] 4.2 Build the result payload: outcome, final assistant message id, tail-preserving bounded summary, truncation marker, completion timestamp
- [x] 4.3 Dispatch `thread.task.finish` before the parent wake-up so recording is durable and replay-idempotent
- [x] 4.4 Build the deterministic wake-up wrapper text (task title, original prompt, outcome, summary) and dispatch `thread.turn.start` on the parent with a `task-result` message
- [x] 4.5 Implement delivery skip paths for missing, deleted, and archived parents, and for dispatch failure, including a parent failure activity
- [x] 4.6 Implement pending-delivery retry on server restart without producing a second result recording
- [x] 4.7 Implement explicit re-delivery for an already-finished task
- [ ] 4.8 Add reactor tests for idle detection, approval/input suppression, failed-turn results, cancelled results, each skip reason, restart retry, steer-into-running-parent delivery, and un-settle/un-snooze side effects

## 5. Agent Tool Surface

- [x] 5.1 Extend `McpCapability` with `tasks` and grant it in `McpSessionRegistry` for threads eligible to delegate
- [x] 5.2 Add `mcp/toolkits/tasks/tools.ts` defining `task_create`, `task_list`, and `task_cancel` with input/output schemas and tool annotations
- [x] 5.3 Add `mcp/toolkits/tasks/handlers.ts` resolving the parent from the invocation scope and dispatching the orchestration commands
- [x] 5.4 Register the tasks toolkit in `McpHttpServer.ts` alongside the preview toolkit
- [x] 5.5 Map command rejections to structured tool errors naming the reason (nesting, caps, eligibility, provider readiness, invalid message ids)
- [x] 5.6 Add toolkit tests for capability gating, scope isolation, non-blocking create, list/cancel behavior, and each rejection reason

## 6. Client Runtime

- [x] 6.1 Add `createThreadTask` and `cancelThreadTask` command helpers to `packages/client-runtime/src/operations/commands.ts`
- [x] 6.2 Carry `parentThreadId`, `task`, and `taskSummary` through shell state, the shell reducer, and thread-detail scoping
- [x] 6.3 Add derivation helpers for a parent's task list, running count, and unread-results timestamp
- [x] 6.4 Add client-runtime tests for the command helpers and the shell/detail derivations

## 7. Web Sidebar

- [x] 7.1 Add a grouping transform in `Sidebar.logic.ts` that removes task threads from the top-level list and yields parent-with-tasks groups in the parent's sort position
- [x] 7.2 Add per-parent task-group collapse state to `uiStateStore` with the running/undelivered default-expansion rule
- [x] 7.3 Add the parent row chevron, `N tasks` count chip, and unread-results blue dot with its own visual treatment
- [x] 7.4 Add the indented task row with guide line, status icon (running spinner, done check, returned marker), title, and elapsed time
- [x] 7.5 Add the hover-visible `+ New task` row at the end of each expanded group
- [x] 7.6 Gate every task affordance on the environment's `threadTasks` capability
- [x] 7.7 Add sidebar logic and render tests for grouping, no top-level duplication, archived-parent behavior, collapse persistence, unread-dot clearing, and capability gating

## 8. Web Mini Thread Window

- [x] 8.1 Add the mini thread window component anchored to the clicked row with a caret and a persistent row highlight
- [x] 8.2 Mount the task thread's detail atom while open so status, chips, and mini timeline stream live
- [x] 8.3 Render the status line, `Open thread ↗`, close control, title, and creator/context/model/returned chips
- [x] 8.4 Render the mini timeline: task prompt bubble, latest assistant activity, and the returned-to-parent event line
- [x] 8.5 Add the plain-text steer composer dispatching `thread.turn.start` to the task thread with no navigation
- [x] 8.6 Add the awaiting-approval/input state that directs the user to the full thread, plus the cancel and return-results-again actions
- [x] 8.7 Implement dismissal on Escape, outside click, and group collapse
- [ ] 8.8 Add mini window tests for anatomy, live updates, steer dispatch, dismissal paths, and mobile fallback to full-thread navigation

## 9. Web Timeline And Creation Dialog

- [x] 9.1 Map `task.created` and `task.finished` activities into work-log entries in `session-logic.ts` with task-specific chrome
- [x] 9.2 Render the agent-created and user-created task rows with title, context, and open-thread link
- [x] 9.3 Render the info-blue wake-up row, expandable to reveal the injected result text
- [x] 9.4 Suppress `source: "task-result"` messages from ordinary user-bubble rendering in `MessagesTimeline.logic.ts`
- [x] 9.5 Render the skipped-delivery variant that states the reason instead of claiming the thread resumed
- [x] 9.6 Add the creation dialog with title, prompt, model override, and the Full thread / Selected messages / No context picker
- [x] 9.7 Add the newest-first checkbox message list with selection count, bound enforcement, and preserved input on rejection
- [x] 9.8 Add the `New task…` action to the active thread actions menu
- [ ] 9.9 Add timeline and dialog tests for each row variant, `task-result` suppression, context picker behavior, bounds, and rejection handling

## 10. Verification

- [x] 10.1 Run focused tests for `packages/contracts`, `apps/server` orchestration/persistence/MCP, `packages/client-runtime`, and `apps/web`
- [x] 10.2 Run targeted formatting, lint, and type checks for the changed scope
- [ ] 10.3 Run one integrated web verification pass with the `test-t3-app` skill against an isolated environment: create a task manually, create one via an agent tool call, peek and steer from the mini window, and confirm the parent wakes with an unread blue dot while viewing another thread
