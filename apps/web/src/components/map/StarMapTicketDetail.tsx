import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { FileText, ListTodo, TriangleAlert } from "lucide-react";
import { useId } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useNewThreadTaskAvailability } from "~/hooks/useNewThreadTaskAvailability";
import { useRightPanelStore } from "~/rightPanelStore";

import { openStarMapTicketAsTask } from "./StarMapTicketDetail.logic";
import type { StarMapGraph, StarMapGraphNode } from "./starMapGraph";

export interface StarMapTicketDetailProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
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

/**
 * Ticket level of the star map panel: the ticket's own markdown file read
 * through the same workspace file read path the Files surface uses
 * (`useProjectFileQuery` → `projects.readFile`), rendered through the shared
 * `ChatMarkdown`. There is deliberately no wayfinder-specific ticket RPC —
 * ticket bodies stay off the subscription wire and this view reuses what
 * already ships.
 */
export function StarMapTicketDetail(props: StarMapTicketDetailProps) {
  const { node } = props;
  const taskUnavailableId = useId();
  const fileQuery = useProjectFileQuery(props.environmentId, props.cwd, node.relativePath);
  const blockers = blockersOf(props.graph, node.id);
  // The parent is this panel's own thread, whichever thread it is. The New task host's shared
  // guard decides whether that thread can take a task, and says why when it cannot.
  const { problem: taskUnavailable } = useNewThreadTaskAvailability(props.threadRef);
  const openAsFile = () => {
    if (props.threadRef === null) return;
    // 9.2 decision — accepted and documented: `openFile` removes an open
    // standalone Files explorer surface (rightPanelStore.ts:286-288). That is
    // acceptable here rather than worth an explorer-preserving variant:
    //   1. The file surface this opens (FilePreviewPanel) embeds its own
    //      explorer with the same open state, so nothing is actually lost.
    //   2. Every other open-file path in the app (markdown links, diff
    //      actions, the file picker) routes through this same `openFile`, so
    //      a wayfinder-specific variant would fork behaviour users already
    //      learned.
    // The action is explicit and user-initiated — it never fires silently.
    useRightPanelStore.getState().openFile(props.threadRef, node.relativePath);
  };

  const openAsTask = () => {
    if (props.threadRef === null || taskUnavailable !== null) return;
    openStarMapTicketAsTask({
      threadRef: props.threadRef,
      node,
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
                  {blocker.ordinal}. {blocker.label} — {statusText(blocker)}
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
              cwd={props.cwd}
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
