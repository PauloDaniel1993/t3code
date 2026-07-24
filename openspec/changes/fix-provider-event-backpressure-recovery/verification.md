# Verification Record

All Vite+ test commands exclude `.claude/**` because local Claude worktrees contain duplicate
package copies that are not part of this change.

## 8.1 Focused tests

Completed on 2026-07-23: 184 focused assertions passed across contracts, ACP normalization and
coalescing, provider ingestion, orchestration, persistence/migrations, startup recovery, maintenance
CLI behavior, and client runtime.

```text
vp test run packages/contracts/src/orchestration.test.ts packages/contracts/src/orchestrationFlowControl.test.ts packages/contracts/src/maintenance.test.ts packages/client-runtime/src/state/activityHistory.test.ts packages/client-runtime/src/state/threadReducer.test.ts --exclude '.claude/**'
vp test run apps/server/src/provider/acp/AcpToolActivityNormalizer.test.ts --exclude '.claude/**'
vp test run apps/server/src/provider/acp/AcpToolProgressCoalescer.test.ts --exclude '.claude/**'
vp test run apps/server/src/orchestration/ProviderEventFlowControl.test.ts --exclude '.claude/**'
vp test run apps/server/src/orchestration/ProviderIngestionScheduler.test.ts --exclude '.claude/**'
vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.approval.test.ts --exclude '.claude/**'
vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t 'preserves completed tool metadata|projects canonical tool progress|preserves canonical tool identity|projects Kimi and Codex terminals fairly' --exclude '.claude/**'
vp test run apps/server/src/orchestration/projector.test.ts apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts --exclude '.claude/**'
vp test run apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts -t 'upserts stable tool activities' --exclude '.claude/**'
vp test run apps/server/src/orchestration/Layers/OrchestrationReactor.test.ts --exclude '.claude/**'
vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts -t 'awaits a provider turn id when replaying a durable pending request' --exclude '.claude/**'
vp test run apps/server/src/persistence/Layers/DatabaseCompactionJournal.test.ts apps/server/src/persistence/Layers/DatabaseCompactionEstimator.test.ts apps/server/src/persistence/Layers/DatabaseLogicalCompactor.test.ts apps/server/src/persistence/Layers/DatabaseLogicalCompaction.test.ts apps/server/src/persistence/Layers/DatabaseMaintenanceRuntime.test.ts apps/server/src/persistence/DatabasePhysicalMaintenance.test.ts apps/server/src/persistence/Layers/StartupRecoveryQueries.test.ts apps/server/src/provider/Layers/ProviderSessionStartupRecovery.test.ts --exclude '.claude/**'
vp test run apps/server/src/serverRuntimeStartup.test.ts --exclude '.claude/**'
vp test run apps/server/src/bin.test.ts -t 'database maintenance|refuses maintenance|routes project commands through a running server' --exclude '.claude/**'
```

Migration 33 is exercised by the startup-recovery repository/service tests. Migration 34 is exercised
by the journal, estimator, logical-compaction, physical-maintenance, and startup-runtime tests.

## 8.2 Static checks

Completed on 2026-07-23:

- `vp fmt --check` passed across the affected server, contracts, client-runtime, web, mobile, and
  OpenSpec paths (478 files considered).
- `vp lint ... --report-unused-disable-directives` passed across the same affected source paths.
- Package-scoped type checks passed for `@t3tools/contracts`, `@t3tools/client-runtime`,
  `@t3tools/web`, `t3`, and `@t3tools/mobile`.
- `git diff --check` passed.

## 8.3 High-volume and large-snapshot regression

Completed on 2026-07-23 against isolated in-memory SQLite test databases:

- 50,000 ACP progress updates produced at most 52 canonical events and retained the terminal state.
- 50,000 scheduler updates collapsed to the latest Kimi progress plus the Codex terminal, with
  49,999 replacements coalesced.
- A 10,000-update Kimi flood concurrent with a Codex completion drained within the 10-second bound;
  both terminals projected, the Kimi tool occupied one stable row, and its final payload remained
  within the 64 KiB terminal limit.
- A 20,005-row activity history returned exactly the configured 200-row initial window, preserved
  the older-history cursor, and serialized below 300,000 bytes.

```text
vp test run apps/server/src/provider/acp/AcpToolProgressCoalescer.test.ts -t 'fifty-thousand-update flood' --exclude '.claude/**'
vp test run apps/server/src/orchestration/ProviderIngestionScheduler.test.ts -t 'Kimi-style progress flood' --exclude '.claude/**'
vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts -t 'projects Kimi and Codex terminals fairly' --exclude '.claude/**'
vp test run apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts -t 'bounds initial activity snapshots' --exclude '.claude/**'
```

## 8.4 Current-incident-shaped 1 GB-class compaction

Completed on 2026-07-23 with the opt-in regression against an isolated temporary SQLite database:

- Source size: 1,114,243,072 bytes.
- Compact candidate / installed size: 1,220,608 bytes.
- Physical reduction: approximately 99.89%.
- Logical event/projection bytes reclaimed before `VACUUM INTO`: 37,669,549 bytes.
- Full event replay and the compacted stable projection produced the same terminal Kimi tool
  identity and payload.
- SQLite and T3 application invariants matched before atomic replacement; the installed candidate
  was re-opened and checked before the rollback was released.

```text
$env:T3_RUN_INCIDENT_COMPACTION='1'; vp test run apps/server/src/persistence/DatabaseIncidentCompaction.test.ts --exclude '.claude/**' --reporter=verbose
```

## 8.5 Integrated web verification

Completed on 2026-07-23 with the `test-t3-app` workflow against one isolated base directory,
temporary Git workspace, and disposable Kimi ACP mock. The T3 collaborative preview was unavailable
with an explicit authentication transport error, so the workflow used the skill's local Playwright
fallback.

- Provider refresh recognized the configured Kimi subscription provider as authenticated at
  v0.29.0, and the model picker exposed `Kimi default`.
- A real Kimi-backed turn exercised pending, in-progress, and terminal ACP tool updates. The web
  timeline retained one stable `Ran command` tool card and the terminal assistant response
  `hello from mock`.
- A valid 208-row disposable activity fixture loaded as the bounded 200-row initial window with a
  `Load older activity` control. Loading the older page removed the control and increased the
  collapsed work-log count from 196 to 204 previous entries.
- A deliberately crashed live Kimi turn remained `running` in durable state. On restart, startup
  recovery reported one reconciled session and one interrupted turn, and the web timeline rendered
  `Provider work was interrupted because its live session was not present after server restart.`
- Offline maintenance first refused compaction with both `provider-work-active` and
  `turn-work-active`. After startup recovery cleared those blockers, logical compaction completed,
  physical reclamation moved to `awaiting-restart`, and the next startup installed the validated
  compact database (442,368 bytes to 434,176 bytes) before serving the preserved thread.

Screenshots:

- `output/playwright/kimi-integrated-terminal-tool.png`
- `output/playwright/kimi-bounded-history-loaded.png`
- `output/playwright/kimi-recovered-interrupted-state.png`

## 8.6 Integrated mobile verification

Attempted on 2026-07-23 with the `test-t3-mobile` workflow, but the current Windows host has no
Android SDK, `adb`, Android emulator binary, or running emulator. iOS Simulator tooling is not
available on Windows. The skill explicitly requires reporting the missing prerequisite instead of
substituting a browser viewport or claiming verification, so task 8.6 remains unchecked.
