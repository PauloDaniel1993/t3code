import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { flowEnvironment } from "../../state/flows";
import { useFlowPanelRequest } from "./flowPanelState";

export function ScheduledFlowSummary({
  environmentId,
  task,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
}) {
  const navigate = useNavigate();
  const definitions = useEnvironmentQuery(
    task.flow
      ? flowEnvironment.list({ environmentId, input: { projectId: task.projectId } })
      : null,
  );
  const runs = useEnvironmentQuery(
    task.flow
      ? flowEnvironment.runs({ environmentId, input: { projectId: task.projectId } })
      : null,
  );
  if (!task.flow) return null;
  const entry = definitions.data?.flows.find((flow) => flow.flowId === task.flow?.flowId);
  const latest = runs.data?.runs
    .filter((run) => run.scheduledTaskId === task.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return (
    <span className="flex flex-wrap gap-2">
      <span>Runs flow: {entry?.definition?.title ?? task.prompt.replace(/^Run flow: /, "")}</span>
      {definitions.data && !entry && <span role="status">Flow not found</span>}
      {entry && !entry.validation.valid && <span role="status">Invalid flow</span>}
      {latest && (
        <button
          type="button"
          className="text-primary underline"
          onClick={() => {
            useFlowPanelRequest
              .getState()
              .open(
                { environmentId, threadId: latest.flowRunThreadId },
                { flowId: latest.flowId, flowRunId: latest.id },
              );
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: latest.flowRunThreadId },
            });
          }}
        >
          Flow run {latest.runNumber}: {latest.status.replaceAll("_", " ")}
        </button>
      )}
    </span>
  );
}
