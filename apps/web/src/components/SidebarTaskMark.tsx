import type { SidebarTaskState } from "@t3tools/client-runtime/state/sidebar-task-subthreads";
import { sidebarTaskStatusWord } from "@t3tools/client-runtime/state/sidebar-task-subthreads";
import { CheckIcon, ChevronDownIcon, LoaderIcon, CircleHelpIcon, XIcon } from "lucide-react";

export function SidebarTaskMark({ state }: { state: SidebarTaskState }) {
  const running = state === "queued" || state === "running";
  const Icon = running
    ? LoaderIcon
    : state === "finished"
      ? CheckIcon
      : state === "failed"
        ? XIcon
        : state === "cancelled"
          ? ChevronDownIcon
          : CircleHelpIcon;
  return (
    <span
      role="img"
      aria-label={sidebarTaskStatusWord(state)}
      className={
        running
          ? "text-info-foreground"
          : state === "finished"
            ? "text-success-foreground"
            : state === "failed"
              ? "text-destructive-foreground"
              : "text-muted-foreground"
      }
    >
      <Icon
        aria-hidden
        className={running ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"}
      />
    </span>
  );
}
