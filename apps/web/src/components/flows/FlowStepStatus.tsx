import type { FlowStepRunStatus, FlowRunSummary, FlowStep } from "@t3tools/contracts";
import { Bot, Terminal, CheckCheck, Repeat2, Layers } from "lucide-react";
import { cn } from "../../lib/utils";

type Status = FlowStepRunStatus | FlowRunSummary["status"];
const labels: Record<Status, string> = {
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  waiting_report: "Waiting for report",
  waiting_approval: "Waiting for approval",
  succeeded: "Succeeded",
  failed: "Failed",
  interrupted: "Interrupted",
  skipped: "Skipped",
  cancelled: "Cancelled",
};
function flowStatusTone(status: Status) {
  if (status === "succeeded") return "text-success-foreground";
  if (status === "failed" || status === "interrupted") return "text-destructive";
  if (status === "waiting_approval") return "text-warning-foreground";
  if (status === "running" || status === "starting" || status === "waiting_report")
    return "text-primary";
  return "text-muted-foreground";
}
export function FlowStepStatus({ status }: { status: Status }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-2xs",
        flowStatusTone(status),
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {labels[status]}
    </span>
  );
}
const icons = { agent: Bot, command: Terminal, approval: CheckCheck, loop: Repeat2, map: Layers };
export function FlowKindIcon({ kind }: { kind: FlowStep["kind"] }) {
  const Icon = icons[kind];
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}
