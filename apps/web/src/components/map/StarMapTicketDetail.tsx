import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { FileText, ListTodo, TriangleAlert } from "lucide-react";
import { useId } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import type { WorkspaceFileContext } from "~/components/files/workspaceFiles";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useNewThreadTaskAvailability } from "~/hooks/useNewThreadTaskAvailability";
import { useRightPanelStore } from "~/rightPanelStore";

import { openStarMapTicketAsTask } from "./StarMapTicketDetail.logic";
import {
  starMapFileTarget,
  starMapMarkdownContext,
  starMapTaskSourcePath,
} from "./StarMapSurface.logic";
import type { StarMapGraph, StarMapGraphNode } from "./starMapGraph";

export interface StarMapTicketDetailProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly workspace?: WorkspaceFileContext | undefined;
  readonly graph: StarMapGraph;
  readonly node: StarMapGraphNode;
  /** Current thread's panel scope; the open-as-file action hides without it. */
  readonly threadRef: ScopedThreadRef | null;
  readonly onSelectTicket: (ticketId: string) => void;
}

function statusText(node: StarMapGraphNode): string {
  switch (node.status) {
    case "open":
      return "open";
    case "claimed":
      return node.claimedBy !== null ? `claimed by ${node.claimedBy}` : "claimed";
    case "resolved":
      return "resolved";
    case "out_of_scope":
      return "out of scope";
  }
}

/** Every blocker of the ticket, resolved or not, so the chips tell the whole story. */
function blockersOf(graph: StarMapGraph, nodeId: string): ReadonlyArray<StarMapGraphNode> {
  const incoming = graph.incoming.get(nodeId);
  if (!incoming) return [];
  return incoming.blocks.flatMap((edge) => {
    const blocker = graph.nodeById.get(edge.from);
    return blocker !== undefined ? [blocker] : [];
  });
}

// Ticket bodies use the Files read path and stay off the map subscription wire.
export function StarMapTicketDetail(props: StarMapTicketDetailProps) {
  const { node } = props;
  const taskUnavailableId = useId();
  const fileTarget = starMapFileTarget(node.relativePath, props.cwd, props.workspace);
  const fileQuery = useProjectFileQuery(
    props.environmentId,
    props.cwd,
    fileTarget?.path ?? null,
    fileTarget !== null,
    fileTarget?.folderPath && props.workspace
      ? { ...props.workspace.scope, folderPath: fileTarget.folderPath }
      : undefined,
  );
  const blockers = blockersOf(props.graph, node.id);
  // The parent is this panel's own thread, whichever thread it is. The New task host's shared
  // guard decides whether that thread can take a task, and says why when it cannot.
  const { problem: taskUnavailable } = useNewThreadTaskAvailability(props.threadRef);
  const openAsFile = () => {
    if (props.threadRef === null) return;
    // openFile replaces the standalone explorer; the file preview embeds its own.
    if (fileTarget === null) return;
    useRightPanelStore
      .getState()
      .openFile(props.threadRef, fileTarget.path, undefined, fileTarget.folderPath);
  };

  const openAsTask = () => {
    if (props.threadRef === null || taskUnavailable !== null) return;
    openStarMapTicketAsTask({
      threadRef: props.threadRef,
      node: {
        ...node,
        relativePath: starMapTaskSourcePath(node.relativePath, props.cwd, props.workspace),
      },
      contents: fileQuery.data?.contents ?? null,
      truncated: fileQuery.data?.truncated ?? false,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-star-map-ticket-detail="">
      <div className="shrink-0 space-y-2 border-b border-border/60 px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground">
              {node.ordinal}. {node.label}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {statusText(node)}
              {node.isFrontier ? " · frontier" : ""}
            </p>
          </div>
          {props.threadRef !== null ? (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              <button
                type="button"
                onClick={openAsFile}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                aria-label={`Open ${node.relativePath} as a file`}
              >
                <FileText className="size-3.5" aria-hidden />
                Open as file
              </button>
              {/* Unavailable stays a focusable `aria-disabled` button, as the right panel launcher
                  and the Git quick action do: the element Tab reaches carries the name and the
                  reason, the tooltip opens on hover and focus, and activating it does nothing. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-disabled={taskUnavailable === null ? undefined : true}
                      aria-describedby={taskUnavailable === null ? undefined : taskUnavailableId}
                      onClick={openAsTask}
                      className={cn(
                        "flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground",
                        taskUnavailable === null
                          ? "hover:bg-accent/60 hover:text-foreground"
                          : "cursor-not-allowed opacity-50",
                      )}
                      aria-label={`Open ${node.label} as a task`}
                    >
                      <ListTodo className="size-3.5" aria-hidden />
                      Open as task
                    </button>
                  }
                />
                {taskUnavailable === null ? null : (
                  <TooltipPopup side="bottom">{taskUnavailable}</TooltipPopup>
                )}
              </Tooltip>
              {taskUnavailable === null ? null : (
                <span id={taskUnavailableId} className="sr-only">
                  {taskUnavailable}
                </span>
              )}
            </div>
          ) : null}
        </div>
        {blockers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-muted-foreground">Blocked by</span>
            {blockers.map((blocker) => (
              <Tooltip key={blocker.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => props.onSelectTicket(blocker.id)}
                      aria-label={`Go to ticket ${blocker.ordinal}. ${blocker.label}, ${statusText(blocker)}`}
                      className={cn(
                        "max-w-full truncate rounded-full border border-border/60 px-2 py-0.5 text-xs",
                        blocker.status === "resolved" || blocker.status === "out_of_scope"
                          ? "text-muted-foreground/70 line-through decoration-muted-foreground/40 hover:bg-accent/60 hover:text-foreground"
                          : "text-foreground hover:bg-accent/60",
                      )}
                    >
                      {blocker.ordinal}. {blocker.label}
                    </button>
                  }
                />
                <TooltipPopup side="bottom">
                  {blocker.ordinal}. {blocker.label}: {statusText(blocker)}
                </TooltipPopup>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {fileQuery.error !== null ? (
          <p className="px-4 py-3 text-xs leading-relaxed text-destructive">{fileQuery.error}</p>
        ) : fileQuery.data !== null ? (
          <>
            {fileQuery.data.truncated ? (
              <p className="flex items-center gap-1 border-b border-border/60 px-4 py-2 text-xs text-muted-foreground">
                <TriangleAlert className="size-3.5" aria-hidden />
                This ticket file is too large to show in full; the preview is truncated.
              </p>
            ) : null}
            <ChatMarkdown
              text={fileQuery.data.contents}
              {...starMapMarkdownContext(props.cwd, props.workspace)}
              threadRef={props.threadRef ?? undefined}
              className="px-4 py-3 text-sm"
            />
          </>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">
            {fileQuery.isPending ? "Loading ticket…" : "No ticket content."}
          </p>
        )}
      </div>
    </div>
  );
}
