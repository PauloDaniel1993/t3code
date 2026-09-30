import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { ProviderInstanceId } from "./index.ts";
import { OrchestrationV2ThreadShell } from "./orchestrationV2.ts";
const now = DateTime.makeUnsafe("2026-09-30T00:00:00Z");
const historicalShell = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-1",
  projectId: "project-1",
  title: "Thread",
  providerInstanceId: "claudeAgent",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: "thread-1",
  },
  forkedFrom: null,
  activeProviderThreadId: "provider-thread-1",
  latestRunId: "run-1",
  activeRunId: null,
  status: "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
};
it("reads old shells and optional task watermarks; an older client ignores the new field", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadShell);
  expect(decode(historicalShell)).not.toHaveProperty("latestTaskDeliveredAt");
  expect(
    decode({ ...historicalShell, latestTaskDeliveredAt: null }).latestTaskDeliveredAt,
  ).toBeNull();
  expect(
    decode({ ...historicalShell, latestTaskDeliveredAt: "2026-09-30T00:00:00.000Z" })
      .latestTaskDeliveredAt,
  ).toBe("2026-09-30T00:00:00.000Z");
  const { latestTaskDeliveredAt: _field, ...legacyFields } = OrchestrationV2ThreadShell.fields;
  const oldClient = Schema.Struct(legacyFields);
  expect(
    Schema.decodeUnknownSync(oldClient)({
      ...historicalShell,
      latestTaskDeliveredAt: "2026-09-30T00:00:00.000Z",
    }),
  ).not.toHaveProperty("latestTaskDeliveredAt");
});
