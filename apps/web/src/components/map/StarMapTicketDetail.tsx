import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  ScopedThreadRef,
  ThreadId,
  ThreadTaskContextSpec,
} from "@t3tools/contracts";
import { FileText, ListTodo, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";
import { NewThreadTaskDialog } from "~/components/NewThreadTaskDialog";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { environmentServerConfigsAtom } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import type { StarMapGraph, StarMapGraphNode } from "./starMapGraph";
import { buildStarMapTicketTaskDraft } from "./StarMapTicketDetail.logic";

export interface StarMapTicketDetailProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly graph: StarMapGraph;
  readonly node: StarMapGraphNode;
  /** Current thread's panel scope; the open-as-file action hides without it. */
  readonly threadRef: ScopedThreadRef | null;
  /**
   * Set when `cwd` is not the root the rest of the thread's surfaces use, which
   * happens when a worktree thread reads the project root's maps. The file
   * surface can only show the thread's own root, so this both explains where
   * the body came from and takes the open-as-file hand-off away.
   */
  readonly rootNotice: string | null;
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
  const fileQuery = useProjectFileQuery(props.environmentId, props.cwd, node.relativePath);
  const blockers = blockersOf(props.graph, node.id);
  const thread = useThreadShell(props.threadRef);
  const threadTasksEnabled = useClientSettings((settings) => settings.threadTasksEnabled);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const createTaskMutation = useAtomCommand(threadEnvironment.createTask, { reportFailure: false });
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const canOpenAsTask =
    props.threadRef !== null &&
    thread !== null &&
    thread.parentThreadId == null &&
    threadTasksEnabled &&
    serverConfigs.get(props.threadRef.environmentId)?.environment.capabilities.threadTasks === true;

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

  const submitNewTask = useCallback(
    async (input: {
      readonly parentThreadId: ThreadId;
      readonly taskThreadId: ThreadId;
      readonly title: string;
      readonly prompt: string;
      readonly context: ThreadTaskContextSpec;
      readonly modelSelection?: ModelSelection;
    }): Promise<string | null> => {
      if (props.threadRef === null) return "This thread is no longer open.";
      const result = await createTaskMutation({
        environmentId: props.threadRef.environmentId,
        input,
      });
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
      const error = squashAtomCommandFailure(result);
      return error instanceof Error ? error.message : "Could not create the task.";
    },
    [createTaskMutation, props.threadRef],
  );

  const taskDraft = useMemo(
    () =>
      buildStarMapTicketTaskDraft({
        node,
        contents: fileQuery.data?.contents ?? null,
        truncated: fileQuery.data?.truncated ?? false,
      }),
    [fileQuery.data?.contents, fileQuery.data?.truncated, node],
  );

  return (
    <>
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
              {props.rootNotice !== null ? (
                <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
                  {props.rootNotice}
                </p>
              ) : null}
            </div>
            {/* Both hand-offs address the thread's own root — `openFile` opens
                the file surface there, and the task draft cites the ticket's
                relative path for an agent working there. Reading the other
                root makes both of them point at a file that may not exist or
                may differ, so the pair goes together. */}
            {props.threadRef !== null && props.rootNotice === null ? (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={openAsFile}
                  className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  aria-label={`Open ${node.relativePath} as a file`}
                  title="Open as file"
                >
                  <FileText className="size-3.5" aria-hidden />
                  Open as file
                </button>
                {canOpenAsTask ? (
                  <button
                    type="button"
                    onClick={() => setTaskDialogOpen(true)}
                    className="flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    aria-label={`Open ${node.label} as a task`}
                    title="Open as task"
                  >
                    <ListTodo className="size-3.5" aria-hidden />
                    Open as task
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {blockers.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">Blocked by</span>
              {blockers.map((blocker) => (
                <button
                  key={blocker.id}
                  type="button"
                  onClick={() => props.onSelectTicket(blocker.id)}
                  aria-label={`Go to ticket ${blocker.ordinal}. ${blocker.label}, ${statusText(blocker)}`}
                  title={`${blocker.ordinal}. ${blocker.label} — ${statusText(blocker)}`}
                  className={cn(
                    "max-w-full truncate rounded-full border border-border/60 px-2 py-0.5 text-xs",
                    blocker.status === "resolved" || blocker.status === "out_of_scope"
                      ? "text-muted-foreground/70 line-through decoration-muted-foreground/40 hover:bg-accent/60 hover:text-foreground"
                      : "text-foreground hover:bg-accent/60",
                  )}
                >
                  {blocker.ordinal}. {blocker.label}
                </button>
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
      {taskDialogOpen && props.threadRef !== null ? (
        <NewThreadTaskDialog
          parentThreadRef={props.threadRef}
          initialDraft={taskDraft}
          onClose={() => setTaskDialogOpen(false)}
          onCreate={submitNewTask}
        />
      ) : null}
    </>
  );
}
