import { flowRunIdFromMetadata } from "@t3tools/client-runtime/flows";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { flowEnvironment } from "../../state/flows";
import { Button } from "../ui/button";
import { FlowRunActions, FlowRunTimeline, StepRunInspector } from "./FlowRunView";
import { useFlowPanelRequest } from "./flowPanelState";

export function FlowRunThreadCard({
  threadRef,
  projectId,
  metadata,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  metadata: unknown;
}) {
  const history = useEnvironmentQuery(
    flowEnvironment.runs({ environmentId: threadRef.environmentId, input: { projectId } }),
  );
  const id =
    flowRunIdFromMetadata(metadata) ??
    history.data?.runs.find((run) => run.flowRunThreadId === threadRef.threadId)?.id;
  const detail = useEnvironmentQuery(
    id
      ? flowEnvironment.run({ environmentId: threadRef.environmentId, input: { flowRunId: id } })
      : null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const snapshot = detail.data;
  if (!snapshot) return id && detail.error ? <p role="alert">{detail.error}</p> : null;
  const selected = snapshot.stepRuns.find((step) => step.id === selectedId);
  return (
    <section
      aria-label="Flow run"
      className="max-h-80 shrink-0 overflow-auto border-b border-border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {snapshot.summary.flowTitle} · Flow run {snapshot.summary.runNumber}
        </h2>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            useFlowPanelRequest
              .getState()
              .open(threadRef, { flowId: snapshot.summary.flowId, flowRunId: snapshot.summary.id })
          }
        >
          Open in Flow panel
        </Button>
      </div>
      <FlowRunActions environmentId={threadRef.environmentId} summary={snapshot.summary} />
      <FlowRunTimeline snapshot={snapshot} onSelect={(step) => setSelectedId(step.id)} />
      {selected && (
        <StepRunInspector
          key={selected.id}
          environmentId={threadRef.environmentId}
          snapshot={snapshot}
          stepRun={selected}
        />
      )}
    </section>
  );
}
