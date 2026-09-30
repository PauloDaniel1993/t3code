import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  formatSidebarTaskStatus,
  resolveSidebarTaskState,
  sidebarTaskWasReturned,
} from "@t3tools/client-runtime/state/sidebar-task-subthreads";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type OrchestrationV2Subagent, type ScopedThreadRef } from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { newMessageId } from "../lib/utils";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { useThreadProjection, useThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import { SidebarTaskMark } from "./SidebarTaskMark";
import { sidebarTaskLeaseClock } from "./sidebarTaskLeases";

type Peek = {
  anchor: HTMLElement;
  thread: EnvironmentThreadShell;
  task: OrchestrationV2Subagent | undefined;
  nativeAgent?: OrchestrationV2Subagent;
};
const usePeek = create<{ entry: Peek | null }>(() => ({ entry: null }));
let opening: (() => void) | undefined;
let closing: (() => void) | undefined;
export function closeSidebarTaskPeek() {
  opening?.();
  closing?.();
  usePeek.setState({ entry: null });
}
export function keepSidebarTaskPeekOpen() {
  closing?.();
}
export function leaveSidebarTaskPeek() {
  opening?.();
  closing?.();
  closing = sidebarTaskLeaseClock.after(220, closeSidebarTaskPeek);
}
export function openSidebarTaskPeek(entry: Peek) {
  opening?.();
  closing?.();
  if (usePeek.getState().entry !== null) usePeek.setState({ entry });
  else opening = sidebarTaskLeaseClock.after(260, () => usePeek.setState({ entry }));
}

function usePeekClock(anchor: HTMLElement) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let cancel: (() => void) | undefined;
    const tick = () => {
      if (!anchor.isConnected) closeSidebarTaskPeek();
      else {
        setNow(Date.now());
        cancel = sidebarTaskLeaseClock.after(1000, tick);
      }
    };
    cancel = sidebarTaskLeaseClock.after(1000, tick);
    return () => cancel?.();
  }, [anchor]);
  return now;
}

/** Chrome switches immediately; a fleeting hover never hydrates a transcript. */
function usePeekDetailDwell(key: string) {
  const [readyKey, setReadyKey] = useState<string | null>(null);
  useEffect(() => sidebarTaskLeaseClock.after(150, () => setReadyKey(key)), [key]);
  return readyKey === key;
}

export function SidebarTaskPeek({
  onOpenThread,
}: {
  onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const entry = usePeek((state) => state.entry);
  useEffect(() => closeSidebarTaskPeek, []);
  return entry === null ? null : entry.nativeAgent === undefined ? (
    <TaskPeek
      key={`${entry.thread.environmentId}:${entry.thread.id}`}
      entry={entry}
      onOpenThread={onOpenThread}
    />
  ) : (
    <NativePeek entry={entry} agent={entry.nativeAgent} />
  );
}

function NativePeek({
  entry,
  agent: initialAgent,
}: {
  entry: Peek;
  agent: OrchestrationV2Subagent;
}) {
  const ready = usePeekDetailDwell(
    `${entry.thread.environmentId}:${entry.thread.id}:${initialAgent.id}`,
  );
  const parent = useThreadProjection(
    ready ? scopeThreadRef(entry.thread.environmentId, entry.thread.id) : null,
  )?.projection;
  const agent =
    parent?.subagents.find((candidate) => candidate.id === initialAgent.id) ?? initialAgent;
  const now = usePeekClock(entry.anchor);
  const elapsed = deriveSubagentElapsedMs(
    {
      status: agent.status,
      startedAt: agent.startedAt === null ? null : DateTime.formatIso(agent.startedAt),
      completedAt: agent.completedAt === null ? null : DateTime.formatIso(agent.completedAt),
    },
    now,
  );
  const frame = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const place = () => {
      if (!entry.anchor.isConnected) {
        closeSidebarTaskPeek();
        return;
      }
      const rect = entry.anchor.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(rect.right + 14, window.innerWidth - 360)),
        top: Math.max(
          8,
          Math.min(rect.top - 8, window.innerHeight - (frame.current?.offsetHeight ?? 0) - 12),
        ),
      });
    };
    place();
    const resize = new ResizeObserver(place);
    if (frame.current) resize.observe(frame.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      resize.disconnect();
    };
  }, [entry.anchor]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebarTaskPeek();
    };
    const pointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !frame.current?.contains(event.target) &&
        !entry.anchor.contains(event.target)
      )
        closeSidebarTaskPeek();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", pointer);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", pointer);
    };
  }, [entry.anchor]);
  return createPortal(
    <div
      ref={frame}
      role="dialog"
      aria-label={`Agent: ${agent.title ?? "Agent"}`}
      style={position}
      onPointerEnter={keepSidebarTaskPeekOpen}
      onPointerLeave={leaveSidebarTaskPeek}
      onFocusCapture={keepSidebarTaskPeekOpen}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) leaveSidebarTaskPeek();
      }}
      className="fixed z-50 w-[22rem] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
    >
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{agent.title ?? "Agent"}</h2>
        <Button
          size="xs"
          variant="ghost"
          aria-label="Close agent details"
          onClick={closeSidebarTaskPeek}
        >
          ×
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {agent.status === "completed"
          ? "Done"
          : agent.status === "cancelled" || agent.status === "interrupted"
            ? "Cancelled"
            : agent.status === "failed"
              ? "Failed"
              : agent.status === "idle"
                ? "Idle"
                : "Working"}
        {elapsed === null ? "" : ` · ${formatDuration(elapsed)}`}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        Provider-owned agent · All active agents plus the newest 12 inactive agents
      </p>
      <p className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap text-xs">{agent.prompt}</p>
      <p className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
        {agent.progress || agent.result}
      </p>
    </div>,
    document.body,
  );
}

function TaskPeek({
  entry,
  onOpenThread,
}: {
  entry: Peek;
  onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const ref = scopeThreadRef(entry.thread.environmentId, entry.thread.id);
  const shell = useThreadShell(ref) ?? entry.thread;
  const ready = usePeekDetailDwell(`${ref.environmentId}:${ref.threadId}`);
  const detail = useThreadProjection(ready ? ref : null)?.projection;
  const parentRef =
    shell.lineage.parentThreadId === null
      ? null
      : scopeThreadRef(shell.environmentId, shell.lineage.parentThreadId);
  const parent = useThreadProjection(ready ? parentRef : null)?.projection;
  const task =
    parent?.subagents.find(
      (agent) => agent.origin === "app_owned" && agent.childThreadId === shell.id,
    ) ?? entry.task;
  const frame = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const now = usePeekClock(entry.anchor);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = useAtomCommand(threadEnvironment.startTurn);
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn);
  const cancelQueued = useAtomCommand(threadEnvironment.cancelQueuedRun);
  useLayoutEffect(() => {
    const place = () => {
      if (!entry.anchor.isConnected) {
        closeSidebarTaskPeek();
        return;
      }
      const rect = entry.anchor.getBoundingClientRect();
      setPosition({
        left: Math.max(8, Math.min(rect.right + 14, window.innerWidth - 360)),
        top: Math.max(
          8,
          Math.min(rect.top - 8, window.innerHeight - (frame.current?.offsetHeight ?? 0) - 12),
        ),
      });
    };
    place();
    const resize = new ResizeObserver(place);
    if (frame.current) resize.observe(frame.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      resize.disconnect();
    };
  }, [entry.anchor]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebarTaskPeek();
    };
    const pointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !frame.current?.contains(event.target) &&
        !entry.anchor.contains(event.target)
      )
        closeSidebarTaskPeek();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", pointer);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", pointer);
    };
  }, [entry.anchor]);
  const blocked = shell.hasPendingApprovals || shell.hasPendingUserInput;
  const state = resolveSidebarTaskState(shell, task);
  const native = shell.source.creationSource === "provider";
  const prompt =
    task?.prompt ?? detail?.messages.find((message) => message.role === "user")?.text ?? "";
  const preview =
    detail?.messages.findLast(
      (message) => message.role === "assistant" && message.text.trim() !== "",
    )?.text ??
    task?.result ??
    "";
  const reportFailure = useCallback((result: Awaited<ReturnType<typeof send>>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Task action failed",
        description: String(squashAtomCommandFailure(result)),
      });
    }
  }, []);
  const steer = async () => {
    if (busy || text.trim() === "" || blocked || native) return;
    setBusy(true);
    try {
      const result = await send({
        environmentId: shell.environmentId,
        input: {
          threadId: shell.id,
          message: { messageId: newMessageId(), role: "user", text: text.trim(), attachments: [] },
          runtimeMode: shell.runtimeMode,
          interactionMode: shell.interactionMode,
          dispatchMode: state === "running" ? "steer" : "auto",
        },
      });
      reportFailure(result);
      if (result._tag === "Success") setText("");
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div
      ref={frame}
      role="dialog"
      aria-label={`Task: ${shell.title}`}
      style={position}
      onPointerEnter={keepSidebarTaskPeekOpen}
      onPointerLeave={leaveSidebarTaskPeek}
      onFocusCapture={keepSidebarTaskPeekOpen}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) leaveSidebarTaskPeek();
      }}
      className="fixed z-50 w-[22rem] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
    >
      <div className="flex items-center gap-2">
        <SidebarTaskMark state={state} />
        <span className="flex-1 text-sm">{formatSidebarTaskStatus(shell, task, now)}</span>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Close task details"
          onClick={closeSidebarTaskPeek}
        >
          ×
        </Button>
      </div>
      <h2 className="mt-2 text-sm font-semibold">{shell.title}</h2>
      {task ? (
        <div className="mt-2 flex gap-2 text-xs text-muted-foreground">
          <span>
            {task.createdBy === "agent" ? "✦ agent" : task.createdBy === "user" ? "you" : "system"}
          </span>
          <span>prompt-only context</span>
        </div>
      ) : null}
      {prompt ? (
        <p className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap text-xs">{prompt}</p>
      ) : null}
      {preview ? (
        <p className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {preview}
        </p>
      ) : null}
      {task?.completionDelivery ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {sidebarTaskWasReturned(task)
            ? "↩ Returned results to the parent thread"
            : task.completionDelivery.state === "disposed"
              ? "Result delivery stopped"
              : task.completionDelivery.state === "acknowledged"
                ? "Result read by the parent agent"
                : "Result delivery pending"}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            closeSidebarTaskPeek();
            onOpenThread(ref);
          }}
        >
          Open thread
        </Button>
        {!native && (state === "running" || state === "queued") ? (
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result =
                  shell.latestRun?.status === "queued"
                    ? await cancelQueued({
                        environmentId: shell.environmentId,
                        input: { threadId: shell.id, runId: shell.latestRun.runId },
                      })
                    : await interrupt({
                        environmentId: shell.environmentId,
                        input: {
                          threadId: shell.id,
                          ...(shell.runtime?.activeRunId == null
                            ? shell.latestRun == null
                              ? {}
                              : { runId: shell.latestRun.runId }
                            : { runId: shell.runtime.activeRunId }),
                        },
                      });
                reportFailure(result);
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel task
          </Button>
        ) : null}
      </div>
      {blocked ? (
        <p className="mt-3 text-xs">This task is waiting on you. Open the thread to respond.</p>
      ) : native ? null : (
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void steer();
          }}
        >
          <textarea
            aria-label="Steer task"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-input bg-background p-2 text-xs"
          />
          <Button
            type="submit"
            size="xs"
            disabled={busy || text.trim() === ""}
            aria-label="Send task steering"
          >
            Send
          </Button>
        </form>
      )}
    </div>,
    document.body,
  );
}
