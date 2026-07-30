import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createPortal } from "react-dom";
import type { ScopedThreadRef, ThreadNativeAgent } from "@t3tools/contracts";
import {
  ArrowUpIcon,
  CheckIcon,
  CrosshairIcon,
  ExternalLinkIcon,
  LoaderIcon,
  XIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "../lib/utils";
import { useThread, useThreadShell } from "../state/entities";
import { formatNativeAgentStatusLine, resolveNativeAgentBody } from "./SidebarNativeAgents.logic";
import {
  resolveNativeAgentPeekChips,
  resolveNativeAgentRetryLinks,
} from "./SidebarNativeAgentGroups.logic";
import {
  formatTaskStatusLine,
  resolveMiniWindowMode,
  resolveTaskChips,
  taskIsCancellable,
  taskIsRedeliverable,
  taskThreadIsWorking,
} from "./SidebarTaskRows.logic";

// Placement has to land before paint or the card flashes at the previous
// row-s coordinates; on the server there is no layout to measure.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Keeps elapsed labels honest while a peek window stays open. */
function usePeekNowTicker(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);
  return nowMs;
}

/**
 * Anchored to the row the way the mockup does it: just outside the sidebar,
 * aligned a little above the row so the caret lands on its centre, and
 * clamped so a card near the bottom of a long list stays on screen.
 */
function usePeekPlacement(
  anchor: HTMLElement | null,
  containerRef: RefObject<HTMLDivElement | null>,
): { left: number; top: number } | undefined {
  const [placement, setPlacement] = useState<{ left: number; top: number } | undefined>(undefined);
  useIsomorphicLayoutEffect(() => {
    if (anchor === null) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const height = containerRef.current?.offsetHeight ?? 0;
      setPlacement({
        left: rect.right + 14,
        top: Math.max(10, Math.min(rect.top - 8, window.innerHeight - height - 12)),
      });
    };
    place();
    // Capture phase: the sidebar scrolls, not the window.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, containerRef]);
  return placement;
}

/** Escape or a pointer landing outside both the card and its row closes the peek. */
function usePeekDismiss(
  anchor: HTMLElement | null,
  containerRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
): void {
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
  }, [anchor, containerRef, onClose]);
}

/**
 * The floating card frame every peek shares: fixed so it escapes the sidebar's
 * scroll container, portalled to the body so no ancestor's transform can
 * become its containing block, with a caret aimed at the row it belongs to.
 */
function PeekWindowFrame(props: {
  containerRef: RefObject<HTMLDivElement | null>;
  placement: { left: number; top: number } | undefined;
  ariaLabel: string;
  testId: string;
  onKeepOpen: () => void;
  onPeekLeave: () => void;
  children: ReactNode;
}) {
  const card = (
    <div
      ref={props.containerRef}
      onMouseEnter={props.onKeepOpen}
      onMouseLeave={props.onPeekLeave}
      role="dialog"
      aria-label={props.ariaLabel}
      data-testid={props.testId}
      style={props.placement}
      className={cn(
        // Fixed, not absolute: inside the sidebar-s scroll container an
        // absolutely-positioned card 352px wide hangs off a ~264px sidebar and
        // adds that overhang to the container-s scrollable area, so scrollbars
        // appeared for as long as the card was open.
        "pointer-events-auto fixed z-50 w-[22rem] rounded-2xl",
        "border border-border/60 bg-popover/95 shadow-xl backdrop-blur-md",
        props.placement === undefined ? "invisible" : "animate-mini-thread-in",
        // Caret tying the card to the row it belongs to, aimed at the row-s
        // vertical centre.
        "before:absolute before:-left-[5px] before:top-[18px] before:size-[9px] before:rotate-45",
        "before:border-b before:border-l before:border-border/60 before:bg-popover/95 before:content-['']",
      )}
    >
      {props.children}
    </div>
  );

  // Portalled to the body, not just fixed: an ancestor of the sidebar rows
  // establishes a containing block (a transform or backdrop-filter is enough),
  // which makes a fixed card resolve against that ancestor instead of the
  // viewport — mispositioning it and still stretching the sidebar's scroll
  // area, which is what put scrollbars on screen for as long as it was open.
  return typeof document === "undefined" ? card : createPortal(card, document.body);
}

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
  /** Reaching for the card must not count as leaving the row that opened it. */
  onKeepOpen: () => void;
  onPeekLeave: () => void;
}) {
  const {
    anchor,
    isMobile,
    onCancelTask,
    onClose,
    onKeepOpen,
    onOpenThread,
    onPeekLeave,
    onRedeliver,
    onSteer,
    threadRef,
  } = props;
  const thread = useThread(threadRef);
  const shell = useThreadShell(threadRef);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState("");
  const placement = usePeekPlacement(anchor, containerRef);
  const nowMs = usePeekNowTicker();
  usePeekDismiss(anchor, containerRef, onClose);

  // A settled task whose thread starts a new turn is working again; the card
  // has to say so rather than keep reporting the recorded result.
  const activity = useMemo(
    () => ({ latestTurn: thread?.latestTurn ?? null, session: thread?.session ?? null }),
    [thread?.latestTurn, thread?.session],
  );
  const working = taskThreadIsWorking(activity);
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
    <PeekWindowFrame
      containerRef={containerRef}
      placement={placement}
      ariaLabel={`Task: ${task.title}`}
      testId="mini-thread-window"
      onKeepOpen={onKeepOpen}
      onPeekLeave={onPeekLeave}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        {working || task.status === "running" || task.status === "queued" ? (
          <LoaderIcon
            aria-hidden
            className="size-3 shrink-0 animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-400"
          />
        ) : task.status === "failed" ? (
          <XIcon aria-hidden className="size-3 shrink-0 text-red-600 dark:text-red-400" />
        ) : (
          <CheckIcon
            aria-hidden
            className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
        )}
        <span
          data-testid="mini-thread-status"
          className={cn(
            "font-mono text-[11px]",
            working || task.status === "running" || task.status === "queued"
              ? "text-sky-600 dark:text-sky-400"
              : task.status === "failed"
                ? "text-red-600 dark:text-red-400"
                : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {formatTaskStatusLine({ task, activity, nowMs })}
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
              // Every chip is an outlined pill; the two that carry meaning
              // (who asked, and whether it woke the parent) are tinted.
              "rounded-full border px-2 py-0.5 text-[11px]",
              chip.tone === "returned"
                ? "border-blue-400/40 bg-blue-400/10 text-blue-600 dark:text-blue-300"
                : chip.tone === "creator"
                  ? "border-indigo-400/40 bg-indigo-400/12 text-indigo-600 dark:text-indigo-200"
                  : "border-border/60 bg-muted/60 text-muted-foreground",
            )}
          >
            {chip.label}
          </span>
        ))}
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto px-3 py-3">
        {promptMessage === null ? null : (
          <p className="ml-auto max-w-[86%] rounded-xl border border-border/60 bg-foreground/[0.07] px-2.5 py-1.5 text-[12px] leading-snug text-foreground/90">
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
        {taskIsCancellable(task.status, activity) ? (
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
    </PeekWindowFrame>
  );
}

/**
 * Peek at an in-session agent. The frame is the task peek's; the contents are
 * honestly different because the run is not a thread: no transcript to open,
 * nothing to cancel, and a composer that says why it is disabled rather than
 * pretending a steer could reach it.
 *
 * The agent is read off the parent thread's shell, so the window tracks the
 * run live as the provider streams progress. A run that drops out of the
 * thread's bounded `nativeAgents` set closes the window rather than showing a
 * frozen copy the session no longer reports.
 */
export function MiniNativeAgentWindow(props: {
  parentThreadRef: ScopedThreadRef;
  taskId: string;
  anchor: HTMLElement | null;
  isMobile: boolean;
  onClose: () => void;
  /** "Show in transcript": locate the run's row in the turn's workflow card. */
  onShowInTranscript: (agent: ThreadNativeAgent) => void;
  /** Retry links swap the peek to the other run, keeping the same anchor. */
  onOpenAgent: (taskId: string) => void;
  onKeepOpen: () => void;
  onPeekLeave: () => void;
}) {
  const {
    anchor,
    isMobile,
    onClose,
    onKeepOpen,
    onOpenAgent,
    onPeekLeave,
    onShowInTranscript,
    parentThreadRef,
    taskId,
  } = props;
  const shell = useThreadShell(parentThreadRef);
  const agents = shell?.nativeAgents ?? null;
  const agent = agents?.find((candidate) => candidate.taskId === taskId) ?? null;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const placement = usePeekPlacement(anchor, containerRef);
  const nowMs = usePeekNowTicker();
  usePeekDismiss(anchor, containerRef, onClose);

  // As on the task peek, mobile taps act directly (here: jump to the
  // transcript) instead of floating a card.
  if (isMobile || agent === null) {
    return null;
  }

  const chips = resolveNativeAgentPeekChips(agent);
  const body = resolveNativeAgentBody(agent);
  const retryLinks = resolveNativeAgentRetryLinks(agent, agents ?? []);

  return (
    <PeekWindowFrame
      containerRef={containerRef}
      placement={placement}
      ariaLabel={`In-session agent: ${agent.description}`}
      testId="mini-native-agent-window"
      onKeepOpen={onKeepOpen}
      onPeekLeave={onPeekLeave}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        {agent.status === "running" ? (
          <LoaderIcon
            aria-hidden
            className="size-3 shrink-0 animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-400"
          />
        ) : agent.status === "failed" ? (
          <XIcon aria-hidden className="size-3 shrink-0 text-red-600 dark:text-red-400" />
        ) : (
          <CheckIcon
            aria-hidden
            className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
          />
        )}
        <span
          data-testid="mini-native-agent-status"
          className={cn(
            "font-mono text-[11px]",
            agent.status === "running"
              ? "text-sky-600 dark:text-sky-400"
              : agent.status === "failed"
                ? "text-red-600 dark:text-red-400"
                : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          {formatNativeAgentStatusLine({ agent, nowMs })}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="mini-native-agent-show"
          onClick={() => onShowInTranscript(agent)}
          className="flex cursor-pointer items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-accent"
        >
          <CrosshairIcon aria-hidden className="size-3" />
          Show in transcript
        </button>
        <button
          type="button"
          aria-label="Close agent preview"
          onClick={onClose}
          className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </div>

      <h3 className="px-3 pt-1.5 text-sm font-medium text-foreground">{agent.description}</h3>

      <div className="flex flex-wrap gap-1 px-3 pt-2">
        {chips.map((chip) => (
          <span
            key={chip.id}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px]",
              chip.tone === "kind"
                ? "border-indigo-400/40 bg-indigo-400/12 text-indigo-600 dark:text-indigo-200"
                : "border-border/60 bg-muted/60 text-muted-foreground",
            )}
          >
            {chip.label}
          </span>
        ))}
      </div>

      <div className="max-h-64 space-y-2 overflow-y-auto px-3 py-3">
        {agent.prompt === undefined ? null : (
          <p className="ml-auto max-w-[86%] rounded-xl border border-border/60 bg-foreground/[0.07] px-2.5 py-1.5 text-[12px] leading-snug text-foreground/90">
            {agent.prompt}
          </p>
        )}
        {body.tone === "error" ? (
          <p className="text-[12px] leading-snug text-red-600 dark:text-red-400">
            <span className="font-medium">Error: </span>
            {body.text}
          </p>
        ) : body.tone === "pending" ? (
          <p className="text-[12px] leading-snug text-muted-foreground/70">{body.text}</p>
        ) : (
          <p className="text-[12px] leading-snug text-foreground/80">
            <span className="font-medium">{body.tone === "result" ? "Result: " : "Working… "}</span>
            {body.text}
          </p>
        )}
        {agent.lastToolName === undefined ? null : (
          <p className="text-[11px] text-muted-foreground/60">Last tool: {agent.lastToolName}</p>
        )}
        {retryLinks.map((link) =>
          link.target === null ? (
            <p key={link.direction} className="text-[11px] text-muted-foreground/70">
              ↺ {link.label}
            </p>
          ) : (
            <button
              key={link.direction}
              type="button"
              data-testid={`mini-native-agent-retry-${link.direction}`}
              onClick={() => onOpenAgent(link.targetTaskId)}
              className="cursor-pointer text-left text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              ↺ {link.label} <span className="text-foreground/70">→</span>
            </button>
          ),
        )}
      </div>

      <div className="border-t border-border/50 px-2 py-2">
        <div className="flex items-end gap-2">
          <textarea
            data-testid="mini-native-agent-steer"
            disabled
            rows={1}
            placeholder="Steer this agent…"
            aria-label="Steering is unavailable for in-session agents"
            className="max-h-24 min-h-7 flex-1 cursor-not-allowed resize-none bg-transparent px-1 py-1 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/40 disabled:opacity-60"
          />
          <button
            type="button"
            aria-label="Send"
            disabled
            className="flex size-6 shrink-0 cursor-not-allowed items-center justify-center rounded-full bg-primary text-primary-foreground opacity-40"
          >
            <ArrowUpIcon aria-hidden className="size-3.5" />
          </button>
        </div>
        <p className="px-1 pt-1 text-[11px] text-muted-foreground/70">
          Runs inside the parent session — to stop it, interrupt the parent turn.
        </p>
      </div>
    </PeekWindowFrame>
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
