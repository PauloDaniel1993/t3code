import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ArrowUpIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { cn } from "../lib/utils";
import { useThread, useThreadShell } from "../state/entities";
import {
  formatTaskStatusLine,
  resolveMiniWindowMode,
  resolveTaskChips,
  taskIsCancellable,
  taskIsRedeliverable,
} from "./SidebarTaskRows.logic";

/**
 * Peek at a task without navigating: status, chips, a live mini timeline, and a
 * plain-text steer composer.
 *
 * Mounting `useThread` here is what makes the window live — the thread-detail
 * atom family is keyed per thread with an idle TTL, so opening the window
 * subscribes to the task thread and closing it lets the subscription lapse.
 */
export function MiniThreadWindow(props: {
  threadRef: ScopedThreadRef;
  anchor: HTMLElement | null;
  modelLabel: string | null;
  isMobile: boolean;
  onClose: () => void;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
  onSteer: (threadRef: ScopedThreadRef, text: string) => void;
  onCancelTask: (threadRef: ScopedThreadRef) => void;
  onRedeliver: (threadRef: ScopedThreadRef) => void;
}) {
  const { anchor, isMobile, onCancelTask, onClose, onOpenThread, onRedeliver, onSteer, threadRef } =
    props;
  const thread = useThread(threadRef);
  const shell = useThreadShell(threadRef);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Keeps the elapsed label honest while the window stays open.
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target) === true) return;
      if (anchor?.contains(target) === true) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [anchor, onClose]);

  const task = thread?.task ?? null;
  const chips = useMemo(
    () => (task === null ? [] : resolveTaskChips({ task, modelLabel: props.modelLabel })),
    [props.modelLabel, task],
  );

  const submitSteer = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0) return;
    onSteer(threadRef, text);
    setDraft("");
  }, [draft, onSteer, threadRef]);

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitSteer();
    }
  };

  if (task === null || thread === null) {
    return null;
  }

  // Mobile has no room for a floating card anchored to a sidebar row; tapping a
  // task row navigates straight to the full thread instead.
  if (isMobile) {
    return null;
  }

  const mode = resolveMiniWindowMode({
    status: task.status,
    hasPendingApprovals: shell?.hasPendingApprovals === true,
    hasPendingUserInput: shell?.hasPendingUserInput === true,
  });
  const promptMessage = thread.messages.find((message) => message.role === "user") ?? null;
  const latestAssistant = [...thread.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={`Task: ${task.title}`}
      data-testid="mini-thread-window"
      className="pointer-events-auto absolute left-full z-50 ml-2 w-[26rem] rounded-xl border border-border/60 bg-popover/95 shadow-xl backdrop-blur-md"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <span
          data-testid="mini-thread-status"
          className={cn(
            "font-mono text-[11px]",
            task.status === "running" || task.status === "queued"
              ? "text-sky-600 dark:text-sky-400"
              : task.status === "failed"
                ? "text-red-600 dark:text-red-400"
                : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {formatTaskStatusLine({ task, nowMs })}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="mini-thread-open"
          onClick={() => onOpenThread(threadRef)}
          className="flex cursor-pointer items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-accent"
        >
          Open thread
          <ExternalLinkIcon aria-hidden className="size-3" />
        </button>
        <button
          type="button"
          aria-label="Close task preview"
          onClick={onClose}
          className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </div>

      <h3 className="px-3 pt-1.5 text-sm font-medium text-foreground">{task.title}</h3>

      <div className="flex flex-wrap gap-1 px-3 pt-2">
        {chips.map((chip) => (
          <span
            key={chip.id}
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px]",
              chip.tone === "returned"
                ? "bg-blue-500/10 text-blue-600 dark:text-blue-300"
                : chip.tone === "creator"
                  ? "bg-violet-500/10 text-violet-600 dark:text-violet-300"
                  : "bg-muted text-muted-foreground",
            )}
          >
            {chip.label}
          </span>
        ))}
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto px-3 py-3">
        {promptMessage === null ? null : (
          <p className="ml-6 rounded-lg bg-muted/70 px-2.5 py-1.5 text-[12px] leading-snug text-foreground/90">
            {task.prompt}
          </p>
        )}
        {latestAssistant === undefined ? null : (
          <p className="text-[12px] leading-snug text-foreground/80">
            {truncateForPreview(latestAssistant.text)}
          </p>
        )}
        {task.delivery?.state === "delivered" ? (
          <p className="pt-1 text-[11px] text-blue-600 dark:text-blue-400">
            ↩ Returned to parent — main thread resumed
          </p>
        ) : task.delivery?.state === "skipped" ? (
          <p className="pt-1 text-[11px] text-amber-600 dark:text-amber-400">
            Results were not delivered ({task.delivery.reason ?? "unknown reason"})
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-1 border-t border-border/50 px-2 py-1.5">
        {taskIsCancellable(task.status) ? (
          <button
            type="button"
            data-testid="mini-thread-cancel"
            onClick={() => onCancelTask(threadRef)}
            className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Cancel task
          </button>
        ) : null}
        {taskIsRedeliverable(task) ? (
          <button
            type="button"
            data-testid="mini-thread-redeliver"
            onClick={() => onRedeliver(threadRef)}
            className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Return results again
          </button>
        ) : null}
      </div>

      {mode === "blocked" ? (
        <p className="border-t border-border/50 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
          This task is waiting on you. Open the thread to respond.
        </p>
      ) : (
        <div className="flex items-end gap-2 border-t border-border/50 px-2 py-2">
          <textarea
            data-testid="mini-thread-steer"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            rows={1}
            placeholder="Steer this task…"
            aria-label="Steer this task"
            className="max-h-24 min-h-7 flex-1 resize-none bg-transparent px-1 py-1 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            aria-label="Send"
            disabled={draft.trim().length === 0}
            onClick={submitSteer}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ArrowUpIcon aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

const PREVIEW_MAX_CHARS = 400;

function truncateForPreview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= PREVIEW_MAX_CHARS ? trimmed : `${trimmed.slice(0, PREVIEW_MAX_CHARS)}…`;
}

export function miniThreadWindowKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}
