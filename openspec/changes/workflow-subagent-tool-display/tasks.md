## 1. Contracts

- [x] 1.1 Add typed task usage schema (`totalTokens`, `toolUses`, `durationMs`) and optional `toolUseId`/`subagentType`/`workflowName`/`prompt`/`skipTranscript`/`outputFile` fields to `Task*Payload` in `packages/contracts/src/providerRuntime.ts`
- [x] 1.2 Add optional `taskId` to `ToolProgressPayload`
- [x] 1.3 Update contract tests for the new fields

## 2. Adapter and ingestion

- [x] 2.1 Map the new SDK fields through `ClaudeAdapter` task/tool-progress emission (drop the `summary: "task:<id>"` encoding)
- [x] 2.2 Forward the new payload fields through `ProviderRuntimeIngestion` into thread activity payloads
- [x] 2.3 Update adapter and ingestion tests

## 3. Web derivation

- [x] 3.1 Preserve `taskId`/`taskType`/usage in `deriveWorkLogEntries`; infer `inProgress` for task started/progress; collapse lifecycle by `taskId` (done in spike — verify against new fields)
- [x] 3.2 Keep task entries out of neutral-status filtering (done in spike — verify)
- [x] 3.3 Add derivation for step→worker association (latest active plan step at task start; unmatched → "Other activity")
- [x] 3.4 Use latest usage snapshot per task (no snapshot summing) for worker and panel totals
- [x] 3.5 Respect `skipTranscript` (workflow activity card yes, timeline no)
- [x] 3.6 Derive a stable turn-keyed collection of every meaningful workflow activity model for historical timeline rendering

## 4. Turn-scoped workflow activity cards (Option F)

- [x] 4.1 Build the reusable Option F card: step heading, counter, segmented progress strip, clickable step labels
- [x] 4.2 Inline worker expansion in the same container; same-step click collapses, other-step click switches
- [x] 4.3 Worker cards: status badge, cumulative tokens, tool count, duration, last tool
- [x] 4.4 Collapsed "Progress" disclosure per worker when a progress summary exists; collapsed turn-level "Reasoning" disclosure when displayable reasoning exists
- [x] 4.5 Bounded compact recent-tools list
- [x] 4.6 Wire `ChatView` to anchor one activity card above the composer and follow the timeline's current message cycle (PlanSidebar remains unchanged)
- [x] 4.7 Retain response-local launchers for closed settled activity and switch the bottom surface automatically while scrolling
- [x] 4.8 Add independent `closed` / `collapsed` / `expanded` state per turn, retaining an accessible launcher after Close and allowing multiple expanded cards

## 5. Timeline task cards

- [x] 5.1 Keep `TaskWorkEntryRow` task cards; add token/duration display from usage
- [x] 5.2 Omit `skipTranscript` tasks from timeline cards

## 6. Tests and verification

- [x] 6.1 Unit tests: derivation (association, usage snapshots, skipTranscript, historical turn collection), tri-state panel rendering, independent timeline cards
- [x] 6.2 Affected `vp test run` suites, `vp check`, and `vp run typecheck` pass
- [x] 6.3 Run the app with a workflow-heavy thread and verify the panel behavior visually
