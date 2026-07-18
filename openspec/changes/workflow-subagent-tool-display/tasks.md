## 1. Contracts

- [ ] 1.1 Add typed task usage schema (`totalTokens`, `toolUses`, `durationMs`) and optional `toolUseId`/`subagentType`/`workflowName`/`prompt`/`skipTranscript`/`outputFile` fields to `Task*Payload` in `packages/contracts/src/providerRuntime.ts`
- [ ] 1.2 Add optional `taskId` to `ToolProgressPayload`
- [ ] 1.3 Update contract tests for the new fields

## 2. Adapter and ingestion

- [ ] 2.1 Map the new SDK fields through `ClaudeAdapter` task/tool-progress emission (drop the `summary: "task:<id>"` encoding)
- [ ] 2.2 Forward the new payload fields through `ProviderRuntimeIngestion` into thread activity payloads
- [ ] 2.3 Update adapter and ingestion tests

## 3. Web derivation

- [ ] 3.1 Preserve `taskId`/`taskType`/usage in `deriveWorkLogEntries`; infer `inProgress` for task started/progress; collapse lifecycle by `taskId` (done in spike — verify against new fields)
- [ ] 3.2 Keep task entries out of neutral-status filtering (done in spike — verify)
- [ ] 3.3 Add derivation for step→worker association (latest active plan step at task start; unmatched → "Other activity")
- [ ] 3.4 Use latest usage snapshot per task (no snapshot summing) for worker and panel totals
- [ ] 3.5 Respect `skipTranscript` (workflow activity card yes, timeline no)

## 4. Workflow activity panel (Option F)

- [ ] 4.1 Build the Option F card as a pinned main-area component: step heading, counter, segmented progress strip, clickable step labels
- [ ] 4.2 Inline worker expansion in the same container; same-step click collapses, other-step click switches
- [ ] 4.3 Worker cards: status badge, cumulative tokens, tool count, duration, last tool
- [ ] 4.4 Collapsed "Progress" disclosure per worker when a progress summary exists; collapsed turn-level "Reasoning" disclosure when displayable reasoning exists
- [ ] 4.5 Bounded compact recent-tools list
- [ ] 4.6 Wire `ChatView` to render the pinned card above the message timeline (PlanSidebar remains unchanged)

## 5. Timeline task cards

- [ ] 5.1 Keep `TaskWorkEntryRow` task cards; add token/duration display from usage
- [ ] 5.2 Omit `skipTranscript` tasks from timeline cards

## 6. Tests and verification

- [ ] 6.1 Unit tests: derivation (association, usage snapshots, skipTranscript), panel rendering, timeline cards
- [ ] 6.2 `npm run typecheck` and `vp test run --project unit` pass
- [ ] 6.3 Run the app with a workflow-heavy thread and verify the panel behavior visually
