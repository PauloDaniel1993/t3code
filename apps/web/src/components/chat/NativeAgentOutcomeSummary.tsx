import { nativeAgentOutcomeSummary } from "@t3tools/client-runtime/state/native-agent-rollup";
import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import { CheckIcon, XIcon } from "lucide-react";

import { Badge } from "../ui/badge";

/** The fork's outcome counters, with V2's resumable and stopped states retained. */
export function NativeAgentOutcomeSummary(props: {
  readonly agents: ReadonlyArray<Pick<OrchestrationV2Subagent, "status">>;
}) {
  const summary = nativeAgentOutcomeSummary(props.agents);
  return (
    <span
      className="flex flex-nowrap items-center gap-1 overflow-hidden"
      role="group"
      aria-label={summary.label}
    >
      {summary.runningCount > 0 ? (
        <Badge size="sm" variant="info">
          {summary.runningCount} running
        </Badge>
      ) : null}
      {summary.finishedCount > 0 ? (
        <Badge size="sm" variant="success">
          <CheckIcon aria-hidden />
          {summary.finishedCount} finished
        </Badge>
      ) : null}
      {summary.failedCount > 0 ? (
        <Badge size="sm" variant="error">
          <XIcon aria-hidden />
          {summary.failedCount} failed
        </Badge>
      ) : null}
      {summary.stoppedCount > 0 ? (
        <Badge size="sm" variant="secondary">
          {summary.stoppedCount} stopped
        </Badge>
      ) : null}
      {summary.idleCount > 0 ? (
        <Badge size="sm" variant="outline">
          {summary.idleCount} idle · resumable
        </Badge>
      ) : null}
    </span>
  );
}
