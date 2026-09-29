import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { deriveThreadRuntime } from "@t3tools/client-runtime/state/thread-execution";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  MAX_DISMISSED_THREAD_ERROR_KEYS,
  shouldShowThreadErrorBanner,
} from "./ThreadErrorBanner";
import { deriveThreadErrorOccurrence } from "./threadErrorOccurrence";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 2, 29, 0, minute));

interface ThreadParts {
  runs?: ReadonlyArray<object>;
  turnItems?: ReadonlyArray<object>;
  providerSessions?: ReadonlyArray<object>;
}

function session(lastError: string | null, updatedAtMinute: number, id = "session-1") {
  return {
    providerSessions: [
      { id, providerInstanceId: "codex", lastError, updatedAt: at(updatedAtMinute) },
    ],
  };
}

function failedRun(id: string, ordinal: number, message: string, minute: number): ThreadParts {
  return {
    runs: [
      {
        id,
        ordinal,
        status: "failed",
        requestedAt: at(minute),
        startedAt: at(minute),
        completedAt: at(minute + 1),
        rootNodeId: `root-${id}`,
      },
    ],
    turnItems: [
      {
        id: `error-${id}`,
        runId: id,
        nodeId: `root-${id}`,
        type: "error",
        status: "failed",
        ordinal: 1,
        updatedAt: at(minute + 1),
        failure: { class: "unknown", message, code: null, retryable: null },
      },
    ],
  };
}

/** A projection with only the parts the error banner reads. */
function thread(...parts: ThreadParts[]): OrchestrationV2ThreadProjection {
  return {
    thread: { providerInstanceId: "codex", activeProviderThreadId: null },
    runs: parts.flatMap((part) => part.runs ?? []),
    turnItems: parts.flatMap((part) => part.turnItems ?? []),
    providerSessions: parts.flatMap((part) => part.providerSessions ?? []),
    messages: [],
    providerThreads: [],
    updatedAt: at(0),
  } as unknown as OrchestrationV2ThreadProjection;
}

type LocalError = { message: string | null; at: number };

/** The error the chat view derives for this render, and the key that masks it. */
function shown(
  threadKey: string,
  projection: OrchestrationV2ThreadProjection,
  localError?: LocalError,
) {
  const error = localError?.message ?? deriveThreadRuntime(projection)?.lastError ?? null;
  const key = getThreadErrorBannerKey(
    threadKey,
    error,
    deriveThreadErrorOccurrence({ error, localError, projection }),
  );
  return { error, key };
}

/** The banner text after the chat view has masked what the user dismissed. */
function onScreen(
  threadKey: string,
  projection: OrchestrationV2ThreadProjection,
  local?: LocalError,
) {
  const { error, key } = shown(threadKey, projection, local);
  return shouldShowThreadErrorBanner(threadKey, error, isThreadErrorBannerDismissedForSession(key))
    ? error
    : null;
}

function dismiss(
  threadKey: string,
  projection: OrchestrationV2ThreadProjection,
  local?: LocalError,
) {
  dismissThreadErrorBannerForSession(shown(threadKey, projection, local).key);
}

describe("dismissing a saved thread error", () => {
  it("stays dismissed when an unrelated session update arrives", () => {
    const key = "env:unrelated-update";
    const failed = failedRun("run-1", 1, "Provider crashed", 1);
    const before = thread(failed, session("Provider crashed", 2));
    expect(onScreen(key, before)).toBe("Provider crashed");

    dismiss(key, before);
    expect(onScreen(key, before)).toBeNull();

    // A model change touches the session again; the error is the same one.
    expect(onScreen(key, thread(failed, session("Provider crashed", 40)))).toBeNull();
  });

  it("stays dismissed when the same session error is written twice for one failure", () => {
    const key = "env:double-write";
    dismiss(key, thread(session("Stream dropped", 1)));
    expect(onScreen(key, thread(session("Stream dropped", 1)))).toBeNull();
    expect(onScreen(key, thread(session("Stream dropped", 2)))).toBeNull();
  });

  it("stays dismissed when the session goes idle and is released", () => {
    const key = "env:idle-release";
    const failed = failedRun("run-1", 1, "Provider crashed", 1);
    const withSessionError = thread(failed, session("Provider crashed", 2));
    dismiss(key, withSessionError);
    expect(onScreen(key, withSessionError)).toBeNull();

    // Idle release clears the session's error; the failed run still says it.
    const released = thread(failed, session(null, 32));
    expect(deriveThreadRuntime(released)?.lastError).toBe("Provider crashed");
    expect(onScreen(key, released)).toBeNull();
  });

  it("shows the same error text again when a new run fails with it", () => {
    const key = "env:same-text-again";
    const first = failedRun("run-1", 1, "Provider crashed", 1);
    const second = failedRun("run-2", 2, "Provider crashed", 10);
    dismiss(key, thread(first, session("Provider crashed", 2)));
    expect(onScreen(key, thread(first, session("Provider crashed", 2)))).toBeNull();

    const afterSecond = thread(first, second, session("Provider crashed", 11));
    expect(onScreen(key, afterSecond)).toBe("Provider crashed");

    dismiss(key, afterSecond);
    expect(onScreen(key, afterSecond)).toBeNull();
  });

  it("shows a new failed run while an old session error is still on the thread", () => {
    const key = "env:old-session-error";
    const first = failedRun("run-1", 1, "Provider crashed", 1);
    const old = session("Provider crashed", 2);
    dismiss(key, thread(first, old));
    expect(onScreen(key, thread(first, old))).toBeNull();

    // The next attempt fails before a session opens, so the old row is untouched.
    const sameText = thread(first, failedRun("run-2", 2, "Provider crashed", 10), old);
    expect(onScreen(key, sameText)).toBe("Provider crashed");

    // With other text V2 still prefers the session's text, but the failure is not hidden.
    const otherText = thread(first, failedRun("run-2", 2, "Could not open a session", 10), old);
    expect(onScreen(key, otherText)).toBe("Provider crashed");
  });

  it("stays dismissed when the client reconnects and receives the thread again", () => {
    const key = "env:reconnect";
    const snapshot = () =>
      thread(failedRun("run-1", 1, "Provider crashed", 1), session("Provider crashed", 2));
    dismiss(key, snapshot());

    // A fresh snapshot is a new object with the same content.
    expect(onScreen(key, snapshot())).toBeNull();
  });

  it("shows a new client-local error with the same text after a dismissal", () => {
    const key = "env:local";
    const projection = thread();
    dismiss(key, projection, { message: "Failed to send.", at: 100 });
    expect(onScreen(key, projection, { message: "Failed to send.", at: 100 })).toBeNull();
    expect(onScreen(key, projection, { message: "Failed to send.", at: 200 })).toBe(
      "Failed to send.",
    );
  });

  it("keeps a dismissal to the thread it was made on", () => {
    const projection = thread(failedRun("run-1", 1, "Provider crashed", 1));
    dismiss("env:one", projection);
    expect(onScreen("env:two", projection)).toBe("Provider crashed");
  });

  it("forgets the oldest dismissals first once the set is full", () => {
    const projection = thread(failedRun("run-1", 1, "Provider crashed", 1));
    for (let index = 0; index <= MAX_DISMISSED_THREAD_ERROR_KEYS; index += 1) {
      dismiss(`env:bounded-${index}`, projection);
    }
    expect(onScreen("env:bounded-0", projection)).toBe("Provider crashed");
    expect(onScreen("env:bounded-1", projection)).toBeNull();
    expect(onScreen(`env:bounded-${MAX_DISMISSED_THREAD_ERROR_KEYS}`, projection)).toBeNull();
  });
});
