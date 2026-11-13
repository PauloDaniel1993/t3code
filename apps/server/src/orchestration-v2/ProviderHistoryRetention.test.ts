import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { createQuestionHistoryProjector } from "../../../../packages/client-runtime/src/state/threadRequests.ts";
import { buildBoundedThreadProjection } from "./threadHistoryPaging.ts";
import { retainProviderHistoryGraph } from "./ProviderHistoryRetention.ts";

const decodeRequest = Schema.decodeUnknownSync(OrchestrationV2RuntimeRequest);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const decodeRun = Schema.decodeUnknownSync(OrchestrationV2Run);
const decodeNode = Schema.decodeSync(OrchestrationV2ExecutionNode);
const decodeSubagent = Schema.decodeSync(OrchestrationV2Subagent);

it.each(["preparing", "queued", "starting", "running", "waiting"])(
  "keeps completed subagents and their ancestors outside the window of a %s run",
  (status) => {
    const now = v2Projection.updatedAt;
    const run = decodeRun({
      id: "live-run",
      threadId: v2Projection.thread.id,
      ordinal: 2,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      providerThreadId: null,
      userMessageId: "prompt",
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    });
    const oldRun = { ...run, id: RunId.make("old-run"), status: "completed" as const };
    const root = decodeNode({
      id: "root",
      threadId: v2Projection.thread.id,
      runId: run.id,
      parentNodeId: null,
      rootNodeId: "root",
      kind: "root_turn",
      status: "completed",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: now,
    });
    const parent = { ...root, id: NodeId.make("parent"), parentNodeId: root.id };
    const task = decodeSubagent({
      id: "task",
      threadId: v2Projection.thread.id,
      runId: run.id,
      parentNodeId: parent.id,
      origin: "app_owned",
      createdBy: "agent",
      driver: "codex",
      providerInstanceId: "codex",
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Review the change",
      title: null,
      model: null,
      status: "completed",
      result: "Done",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    const taskWithoutNode = { ...task, id: NodeId.make("task-without-node") };
    const oldTask = { ...task, id: NodeId.make("old-task"), runId: oldRun.id };
    const taskNode = { ...parent, id: task.id, parentNodeId: parent.id, kind: "subagent" as const };
    const projection = {
      ...v2Projection,
      runs: [oldRun, run],
      nodes: [root, parent, taskNode, { ...taskNode, id: oldTask.id, runId: oldRun.id }],
      subagents: [oldTask, task, taskWithoutNode],
    };

    const retained = retainProviderHistoryGraph(projection, []);
    expect(retained.subagents).toEqual([task, taskWithoutNode]);
    expect(retained.nodes).toEqual([root, parent, taskNode]);

    const settled = retainProviderHistoryGraph(
      { ...projection, runs: [oldRun, { ...run, status: "completed" }] },
      [],
    );
    expect(settled.subagents).toEqual([]);
    expect(settled.nodes).toEqual([]);
  },
);

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
