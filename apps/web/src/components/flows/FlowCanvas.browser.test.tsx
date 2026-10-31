import { expect, it } from "vite-plus/test";
import { ReactFlowProvider } from "@xyflow/react";
import {
  FlowId,
  FlowRunId,
  FlowStepRunId,
  ProjectId,
  ThreadId,
  type FlowRunSnapshot,
} from "@t3tools/contracts";
import { flowStepStatusById } from "@t3tools/client-runtime/flows";
import { render } from "../../../test/render";
import { FlowStepNode, FlowRunContext } from "./FlowCanvas";

it("maps the latest step attempt without putting flow-run state into canvas data", async () => {
  const summary: FlowRunSnapshot["summary"] = {
    id: FlowRunId.make("run"),
    flowId: FlowId.make("flow"),
    projectId: ProjectId.make("project"),
    flowRunThreadId: ThreadId.make("thread"),
    status: "running",
    activeStepRunIds: [],
    error: null,
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: null,
    finishedAt: null,
  };
  const snapshot: FlowRunSnapshot = {
    summary,
    approvals: [],
    stepRuns: [
      {
        id: FlowStepRunId.make("failed"),
        flowRunId: summary.id,
        stepPath: ["check"],
        attempt: 1,
        status: "failed",
        threadId: null,
        outputFields: null,
        error: null,
        createdAt: summary.createdAt,
        startedAt: null,
        finishedAt: null,
      },
    ],
  };
  const data = { step: { id: "check", kind: "command", command: "echo check" } } as const;
  const view = (snapshot: FlowRunSnapshot | null) => (
    <ReactFlowProvider>
      <FlowRunContext value={snapshot ? flowStepStatusById(snapshot) : new Map()}>
        <FlowStepNode
          id="check"
          type="step"
          data={data}
          selected={false}
          dragging={false}
          draggable={false}
          selectable
          isConnectable={false}
          deletable={false}
          zIndex={0}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
        />
      </FlowRunContext>
    </ReactFlowProvider>
  );
  await using screen = await render(view(snapshot));
  await expect.element(screen.getByText("command step · failed")).toBeVisible();
  await screen.rerender(
    view({
      ...snapshot,
      stepRuns: [
        ...snapshot.stepRuns,
        {
          ...snapshot.stepRuns[0]!,
          id: FlowStepRunId.make("retry"),
          attempt: 2,
          status: "running",
          createdAt: "2026-01-01T00:00:01Z",
        },
      ],
    }),
  );
  await expect.element(screen.getByText("command step · running")).toBeVisible();
  expect(data).toEqual({ step: { id: "check", kind: "command", command: "echo check" } });
  await screen.rerender(view(null));
  await expect.element(screen.getByText("command step", { exact: true })).toBeVisible();
});
