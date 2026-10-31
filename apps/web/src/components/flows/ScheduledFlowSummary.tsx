import { useEffect, useEffectEvent, useState } from "react";
import { findScheduledFlowRun } from "./scheduledFlowRun";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
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
  const entry = definitions.data?.flows.find((flow) => flow.flowId === task.flow?.flowId);
  const recent = runs.data?.runs
    .filter((run) => run.scheduledTaskId === task.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const loadPage = useAtomCommand(flowEnvironment.runsPage);
  const [older, setOlder] = useState<{
    key: string;
    run: Awaited<ReturnType<typeof findScheduledFlowRun>>;
    error: string | null;
  } | null>(null);
  const historyKey =
    task.flow && !recent && runs.data?.nextCursor
      ? JSON.stringify([environmentId, task.id, task.lastRunAt, task.runCount])
      : null;
  const loadOlder = useEffectEvent(async (key: string, active: () => boolean) => {
    if (!runs.data) return;
    try {
      const run = await findScheduledFlowRun(runs.data, task.id, async (before) => {
        if (!active()) return { runs: [], nextCursor: null };
        const result = await loadPage({
          environmentId,
          input: { projectId: task.projectId, before },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      });
      if (active()) setOlder({ key, run, error: null });
    } catch (error) {
      if (active())
        setOlder({ key, run: null, error: error instanceof Error ? error.message : String(error) });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches older history when a schedule's latest flow run is outside the live page
  useEffect(() => {
    if (!historyKey) return;
    let active = true;
    // oxlint-disable-next-line react/set-state-in-effect -- publishes history only after the page request resolves
    void loadOlder(historyKey, () => active);
    return () => {
      active = false;
    };
  }, [historyKey]);
  const history = older?.key === historyKey ? older : null;
  const latest = recent ?? history?.run;
  if (!task.flow) return null;
  return (
    <span className="flex flex-wrap gap-2">
      <span>Runs flow: {entry?.definition?.title ?? task.prompt.replace(/^Run flow: /, "")}</span>
      {definitions.data && !entry && <span role="status">Flow not found</span>}
      {entry && !entry.validation.valid && <span role="status">Invalid flow</span>}
      {history?.error && <span role="status">Could not load flow run: {history.error}</span>}
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
