import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2RuntimeRequest, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { createQuestionHistoryProjector } from "../../../../packages/client-runtime/src/state/threadRequests.ts";
import { buildBoundedThreadProjection } from "./threadHistoryPaging.ts";

const decodeRequest = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);

it("keeps a visible question's saved answer without its historical node, and prunes both off page", () => {
  const now = v2Projection.updatedAt;
  const request = decodeRequest({
    id: "async-question",
    nodeId: "absent-node",
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "resolved",
    responseCapability: { type: "message" },
    createdAt: now,
    resolvedAt: now,
    answers: { next: "continue" },
  });
  const item = decodeItem({
    id: "question-item",
    threadId: v2Projection.thread.id,
    runId: null,
    nodeId: request.nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_input_request",
    requestId: request.id,
    responseMode: "message",
    questions: [
      {
        id: "next",
        header: "Next",
        question: "What next?",
        required: true,
        allowCustomAnswer: false,
        options: [{ label: "Continue", value: "continue", description: "Resume" }],
      },
    ],
  });
  const row = {
    item,
    position: 0,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
  };
  const projection = {
    ...v2Projection,
    nodes: [],
    runtimeRequests: [request],
    turnItems: [item],
    visibleTurnItems: [row],
  };
  const bounded = buildBoundedThreadProjection({ projection, snapshotSequence: 1 });
  const question = createQuestionHistoryProjector()(bounded.projection)[0]?.item;
  if (question?.type !== "user_input_request") throw new Error("Expected visible question");
  expect(question.questionAnswer?.answers).toEqual({ next: "continue" });
  expect(bounded.projection.runtimeRequests).toEqual([request]);
  const pruned = buildBoundedThreadProjection({
    projection: { ...projection, visibleTurnItems: [] },
    snapshotSequence: 1,
  });
  expect(pruned.projection.turnItems).toEqual([]);
  expect(pruned.projection.runtimeRequests).toEqual([]);
});
