"use client";

import type {
  ToastManager,
  ToastManagerAddOptions,
  ToastManagerUpdateOptions,
} from "@base-ui/react/toast";
import * as Effect from "effect/Effect";

import { ClientTracingLive } from "./clientTracing";

export type ToastManagerName = "anchored" | "viewport";

export type ToastCloseReason =
  | "manager-close-all"
  | "manual-dismiss"
  | "programmatic-close"
  | "provider-close"
  | "provider-remove"
  | "visible-timeout";

export type ToastVisibilityReason =
  | "thread-scope-filtered"
  | "thread-scope-visible"
  | "unscoped-visible";

export interface ObservableToastData {
  readonly threadRef?: {
    readonly environmentId: string;
    readonly threadId: string;
  } | null;
  readonly threadId?: string | null;
  readonly dismissAfterVisibleMs?: number;
}

interface ToastSummary {
  readonly type: string | null;
  readonly title: string | null;
  readonly timeoutMs: number | null;
  readonly dismissAfterVisibleMs: number | null;
  readonly environmentId: string | null;
  readonly threadId: string | null;
}

interface ToastLifecycleState {
  readonly manager: ToastManagerName;
  readonly toastId: string;
  readonly addedAtMs: number;
  summary: ToastSummary;
  closeReason: ToastCloseReason | null;
  closeRequestedAtMs: number | null;
  visible: boolean;
  visibleStartedAtMs: number | null;
  visibleDurationMs: number;
}

export interface ToastLifecycleRecord extends ToastSummary {
  readonly event:
    | "added"
    | "close-requested"
    | "closed"
    | "hidden"
    | "removed"
    | "rendered"
    | "updated";
  readonly manager: ToastManagerName;
  readonly toastId: string;
  readonly occurredAtMs: number;
  readonly elapsedSinceAddedMs: number;
  readonly visibleDurationMs: number;
  readonly closeReason: ToastCloseReason | null;
  readonly visibilityReason: ToastVisibilityReason | null;
  readonly activeEnvironmentId: string | null;
  readonly activeThreadId: string | null;
}

export interface ToastLifecycleObserver {
  readonly added: <Data extends ObservableToastData>(
    manager: ToastManagerName,
    toastId: string,
    options: ToastManagerAddOptions<Data>,
  ) => void;
  readonly updated: <Data extends ObservableToastData>(
    manager: ToastManagerName,
    toastId: string,
    updates: ToastManagerUpdateOptions<Data>,
  ) => void;
  readonly requestClose: (
    manager: ToastManagerName,
    toastId: string | undefined,
    reason: ToastCloseReason,
  ) => void;
  readonly closed: (manager: ToastManagerName, toastId: string) => void;
  readonly removed: (manager: ToastManagerName, toastId: string) => void;
  readonly visibilityChanged: (
    manager: ToastManagerName,
    toastId: string,
    visible: boolean,
    reason: ToastVisibilityReason,
    activeThreadRef: {
      readonly environmentId: string;
      readonly threadId: string;
    } | null,
  ) => void;
}

export interface ToastLifecycleObserverOptions {
  readonly now?: () => number;
  readonly record: (record: ToastLifecycleRecord) => void;
}

function boundedTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, 160) : null;
}

function summarizeToast<Data extends ObservableToastData>(
  options: ToastManagerAddOptions<Data> | ToastManagerUpdateOptions<Data>,
  previous?: ToastSummary,
): ToastSummary {
  const data = options.data;
  const threadRef = data?.threadRef;
  const hasDataUpdate = Object.hasOwn(options, "data");
  const hasTimeoutUpdate = Object.hasOwn(options, "timeout");
  const hasTitleUpdate = Object.hasOwn(options, "title");
  const hasTypeUpdate = Object.hasOwn(options, "type");
  return {
    type: hasTypeUpdate
      ? typeof options.type === "string"
        ? options.type
        : null
      : (previous?.type ?? null),
    title: hasTitleUpdate ? boundedTitle(options.title) : (previous?.title ?? null),
    timeoutMs: hasTimeoutUpdate
      ? typeof options.timeout === "number"
        ? options.timeout
        : null
      : (previous?.timeoutMs ?? null),
    dismissAfterVisibleMs: hasDataUpdate
      ? typeof data?.dismissAfterVisibleMs === "number"
        ? data.dismissAfterVisibleMs
        : null
      : (previous?.dismissAfterVisibleMs ?? null),
    environmentId: hasDataUpdate
      ? typeof threadRef?.environmentId === "string"
        ? threadRef.environmentId
        : null
      : (previous?.environmentId ?? null),
    threadId: hasDataUpdate
      ? typeof threadRef?.threadId === "string"
        ? threadRef.threadId
        : typeof data?.threadId === "string"
          ? data.threadId
          : null
      : (previous?.threadId ?? null),
  };
}

function toastStateKey(manager: ToastManagerName, toastId: string): string {
  return `${manager}:${toastId}`;
}

export function createToastLifecycleObserver(
  options: ToastLifecycleObserverOptions,
): ToastLifecycleObserver {
  const now = options.now ?? (() => globalThis.performance.now());
  const states = new Map<string, ToastLifecycleState>();

  const safeRecord = (record: ToastLifecycleRecord) => {
    try {
      options.record(record);
    } catch {
      // Observability must never change notification behavior.
    }
  };

  const stopVisibility = (state: ToastLifecycleState, observedAtMs: number) => {
    if (!state.visible || state.visibleStartedAtMs === null) {
      return;
    }
    state.visibleDurationMs += Math.max(0, observedAtMs - state.visibleStartedAtMs);
    state.visible = false;
    state.visibleStartedAtMs = null;
  };

  const emit = (
    state: ToastLifecycleState,
    event: ToastLifecycleRecord["event"],
    observedAtMs: number,
    input?: {
      readonly visibilityReason?: ToastVisibilityReason;
      readonly activeThreadRef?: {
        readonly environmentId: string;
        readonly threadId: string;
      } | null;
    },
  ) => {
    safeRecord({
      event,
      manager: state.manager,
      toastId: state.toastId,
      occurredAtMs: observedAtMs,
      elapsedSinceAddedMs: Math.max(0, observedAtMs - state.addedAtMs),
      visibleDurationMs:
        state.visible && state.visibleStartedAtMs !== null
          ? state.visibleDurationMs + Math.max(0, observedAtMs - state.visibleStartedAtMs)
          : state.visibleDurationMs,
      closeReason: state.closeReason,
      visibilityReason: input?.visibilityReason ?? null,
      activeEnvironmentId: input?.activeThreadRef?.environmentId ?? null,
      activeThreadId: input?.activeThreadRef?.threadId ?? null,
      ...state.summary,
    });
  };

  const requestCloseState = (
    state: ToastLifecycleState,
    reason: ToastCloseReason,
    observedAtMs: number,
  ) => {
    if (state.closeRequestedAtMs !== null) {
      return;
    }
    state.closeReason = reason;
    state.closeRequestedAtMs = observedAtMs;
    emit(state, "close-requested", observedAtMs);
  };

  return {
    added(manager, toastId, addOptions) {
      const observedAtMs = now();
      const state: ToastLifecycleState = {
        manager,
        toastId,
        addedAtMs: observedAtMs,
        summary: summarizeToast(addOptions),
        closeReason: null,
        closeRequestedAtMs: null,
        visible: false,
        visibleStartedAtMs: null,
        visibleDurationMs: 0,
      };
      states.set(toastStateKey(manager, toastId), state);
      emit(state, "added", observedAtMs);
    },
    updated(manager, toastId, updates) {
      const state = states.get(toastStateKey(manager, toastId));
      if (!state) {
        return;
      }
      const observedAtMs = now();
      state.summary = summarizeToast(updates, state.summary);
      emit(state, "updated", observedAtMs);
    },
    requestClose(manager, toastId, reason) {
      const observedAtMs = now();
      if (toastId !== undefined) {
        const state = states.get(toastStateKey(manager, toastId));
        if (state) {
          requestCloseState(state, reason, observedAtMs);
        }
        return;
      }
      for (const state of states.values()) {
        if (state.manager === manager) {
          requestCloseState(state, "manager-close-all", observedAtMs);
        }
      }
    },
    closed(manager, toastId) {
      const state = states.get(toastStateKey(manager, toastId));
      if (!state) {
        return;
      }
      const observedAtMs = now();
      if (state.closeRequestedAtMs === null) {
        state.closeReason = "provider-close";
        state.closeRequestedAtMs = observedAtMs;
      }
      stopVisibility(state, observedAtMs);
      emit(state, "closed", observedAtMs);
    },
    removed(manager, toastId) {
      const state = states.get(toastStateKey(manager, toastId));
      if (!state) {
        return;
      }
      const observedAtMs = now();
      if (state.closeRequestedAtMs === null) {
        state.closeReason = "provider-remove";
        state.closeRequestedAtMs = observedAtMs;
      }
      stopVisibility(state, observedAtMs);
      emit(state, "removed", observedAtMs);
      states.delete(toastStateKey(manager, toastId));
    },
    visibilityChanged(manager, toastId, visible, reason, activeThreadRef) {
      const state = states.get(toastStateKey(manager, toastId));
      if (!state || state.visible === visible) {
        return;
      }
      const observedAtMs = now();
      if (visible) {
        state.visible = true;
        state.visibleStartedAtMs = observedAtMs;
        emit(state, "rendered", observedAtMs, { visibilityReason: reason, activeThreadRef });
        return;
      }
      stopVisibility(state, observedAtMs);
      emit(state, "hidden", observedAtMs, { visibilityReason: reason, activeThreadRef });
    },
  };
}

function recordToastLifecycleTrace(record: ToastLifecycleRecord): void {
  const attributes: Record<string, string | number | boolean> = {
    "toast.event": record.event,
    "toast.manager": record.manager,
    "toast.id": record.toastId,
    "toast.elapsed_since_added_ms": record.elapsedSinceAddedMs,
    "toast.visible_duration_ms": record.visibleDurationMs,
  };
  if (record.type !== null) attributes["toast.type"] = record.type;
  if (record.title !== null) attributes["toast.title"] = record.title;
  if (record.timeoutMs !== null) attributes["toast.timeout_ms"] = record.timeoutMs;
  if (record.dismissAfterVisibleMs !== null) {
    attributes["toast.dismiss_after_visible_ms"] = record.dismissAfterVisibleMs;
  }
  if (record.environmentId !== null) attributes["toast.environment_id"] = record.environmentId;
  if (record.threadId !== null) attributes["toast.thread_id"] = record.threadId;
  if (record.activeEnvironmentId !== null) {
    attributes["toast.active_environment_id"] = record.activeEnvironmentId;
  }
  if (record.activeThreadId !== null) {
    attributes["toast.active_thread_id"] = record.activeThreadId;
  }
  if (record.closeReason !== null) attributes["toast.close_reason"] = record.closeReason;
  if (record.visibilityReason !== null) {
    attributes["toast.visibility_reason"] = record.visibilityReason;
  }

  Effect.logInfo("web.toast.lifecycle").pipe(
    Effect.annotateLogs(attributes),
    Effect.withSpan("web.toast.lifecycle", { root: true, attributes }),
    Effect.provide(ClientTracingLive),
    Effect.runFork,
  );
}

export const toastLifecycleObserver = createToastLifecycleObserver({
  record: recordToastLifecycleTrace,
});

export function createObservedToastManager<Data extends ObservableToastData>(
  manager: ToastManager<Data>,
  managerName: ToastManagerName,
  observer: ToastLifecycleObserver = toastLifecycleObserver,
): ToastManager<Data> {
  const callbacksByToastId = new Map<
    string,
    {
      readonly onClose?: (() => void) | undefined;
      readonly onRemove?: (() => void) | undefined;
    }
  >();

  const observedCallbacks = (toastId: () => string) => ({
    onClose() {
      const id = toastId();
      observer.closed(managerName, id);
      callbacksByToastId.get(id)?.onClose?.();
    },
    onRemove() {
      const id = toastId();
      observer.removed(managerName, id);
      const callback = callbacksByToastId.get(id)?.onRemove;
      callbacksByToastId.delete(id);
      callback?.();
    },
  });

  return {
    " subscribe": manager[" subscribe"],
    add(options) {
      let toastId = options.id ?? "";
      toastId = manager.add({
        ...options,
        ...observedCallbacks(() => toastId),
      });
      callbacksByToastId.set(toastId, {
        onClose: options.onClose,
        onRemove: options.onRemove,
      });
      observer.added(managerName, toastId, options);
      return toastId;
    },
    close(toastId) {
      observer.requestClose(
        managerName,
        toastId,
        toastId === undefined ? "manager-close-all" : "programmatic-close",
      );
      manager.close(toastId);
    },
    update(toastId, updates) {
      const previousCallbacks = callbacksByToastId.get(toastId);
      callbacksByToastId.set(toastId, {
        onClose: updates.onClose ?? previousCallbacks?.onClose,
        onRemove: updates.onRemove ?? previousCallbacks?.onRemove,
      });
      manager.update(toastId, {
        ...updates,
        ...observedCallbacks(() => toastId),
      });
      observer.updated(managerName, toastId, updates);
    },
    promise(promiseValue, options) {
      return manager.promise(promiseValue, options);
    },
  };
}

export function closeObservedToast<Data extends ObservableToastData>(
  manager: ToastManager<Data>,
  managerName: ToastManagerName,
  toastId: string,
  reason: ToastCloseReason,
  observer: ToastLifecycleObserver = toastLifecycleObserver,
): void {
  observer.requestClose(managerName, toastId, reason);
  manager.close(toastId);
}
