import type {
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { deriveThreadRuntime } from "@t3tools/client-runtime/state/thread-execution";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { dismissThreadError, presentThreadError } from "./threadErrorDismissal";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 2, 29, 0, minute));

type RunStatus = "queued" | "running" | "completed" | "failed";

interface ThreadParts {
  runs?: ReadonlyArray<object>;
  turnItems?: ReadonlyArray<object>;
  providerSessions?: ReadonlyArray<object>;
}

function session(lastError: string | null, updatedAtMinute: number): ThreadParts {
  return {
    providerSessions: [
      { id: "session-1", providerInstanceId: "codex", lastError, updatedAt: at(updatedAtMinute) },
    ],
  };
}

function run(id: string, ordinal: number, status: RunStatus): ThreadParts {
  const minute = ordinal * 10;
  return {
    runs: [
      {
        id,
        ordinal,
        status,
        requestedAt: at(minute),
        startedAt: status === "queued" ? null : at(minute),
        completedAt: status === "running" || status === "queued" ? null : at(minute + 1),
        rootNodeId: `root-${id}`,
      },
    ],
  };
}

/** The error item a failed run's root turn records. */
function failure(
  runId: string,
  message: string,
  failureClass: OrchestrationV2ProviderFailureClass = "provider_error",
): ThreadParts {
  return {
    turnItems: [
      {
        id: `error-${runId}`,
        runId,
        nodeId: `root-${runId}`,
        type: "error",
        status: "failed",
        ordinal: 1,
        updatedAt: at(1),
        failure: { class: failureClass, message, code: null, retryable: null },
      },
    ],
  };
}

function failedRun(id: string, ordinal: number, message: string): ThreadParts[] {
  return [run(id, ordinal, "failed"), failure(id, message)];
}

/** A projection with only the parts the error banner reads. */
function thread(...parts: ReadonlyArray<ThreadParts | ThreadParts[]>) {
  const flat = parts.flat();
  return {
    thread: { providerInstanceId: "codex", activeProviderThreadId: null },
    runs: flat.flatMap((part) => part.runs ?? []),
    turnItems: flat.flatMap((part) => part.turnItems ?? []),
    providerSessions: flat.flatMap((part) => part.providerSessions ?? []),
    messages: [],
    providerThreads: [],
    updatedAt: at(0),
  } as unknown as OrchestrationV2ThreadProjection;
}

/** What the chat view presents for this thread, from the real runtime derivation. */
function banner(
  threadKey: string,
  projection: OrchestrationV2ThreadProjection,
  localError: string | null = null,
) {
  const runtime = deriveThreadRuntime(projection);
  return presentThreadError({
    threadKey,
    localError,
    serverError: runtime?.lastError ?? null,
    serverErrorClass: runtime?.lastErrorClass ?? null,
    projection,
  });
}

const onScreen = (
  threadKey: string,
  projection: OrchestrationV2ThreadProjection,
  localError?: string,
) => banner(threadKey, projection, localError).message;

/** Clicks Dismiss on whatever the banner shows. */
function dismiss(
  threadKey: string,
  projection: OrchestrationV2ThreadProjection,
  localError?: string,
) {
  dismissThreadError(banner(threadKey, projection, localError).dismissal);
}

describe("dismissing a thread error", () => {
  it("stays dismissed when an unrelated session update arrives", () => {
    const key = "env:unrelated-update";
    const failed = failedRun("run-1", 1, "Provider crashed");
    const before = thread(failed, session("Provider crashed", 12));
    expect(onScreen(key, before)).toBe("Provider crashed");

    dismiss(key, before);
    expect(onScreen(key, before)).toBeNull();

    // A model change touches the session again; nothing new failed.
    expect(onScreen(key, thread(failed, session("Provider crashed", 40)))).toBeNull();
  });

  it("stays dismissed when the session goes idle and is released", () => {
    const key = "env:idle-release";
    const failed = failedRun("run-1", 1, "Provider crashed");
    const before = thread(failed, session("Provider crashed", 12));
    expect(onScreen(key, before)).toBe("Provider crashed");
    dismiss(key, before);

    // Release clears the session's error; the failed run still reports it.
    const released = thread(failed, session(null, 40));
    expect(deriveThreadRuntime(released)?.lastError).toBe("Provider crashed");
    expect(onScreen(key, released)).toBeNull();
  });

  it("stays dismissed when a failure published on the session is then finalised on its run", () => {
    const key = "env:publish-then-finalise";
    const published = thread(run("run-1", 1, "running"), session("Stream dropped", 11));
    expect(onScreen(key, published)).toBe("Stream dropped");
    dismiss(key, published);

    const finalised = thread(
      failedRun("run-1", 1, "Stream dropped"),
      session("Stream dropped", 12),
    );
    expect(onScreen(key, finalised)).toBeNull();
    expect(onScreen(key, thread(failedRun("run-1", 1, "Stream dropped"), session(null, 13)))).toBe(
      null,
    );
  });

  it("shows the run that was running at dismissal when it fails with other text", () => {
    const key = "env:running-run-fails-differently";
    const stale = thread(
      failedRun("run-1", 1, "Provider crashed"),
      run("run-2", 2, "running"),
      session("Provider crashed", 21),
    );
    expect(onScreen(key, stale)).toBe("Provider crashed");
    dismiss(key, stale);

    const failed = thread(
      failedRun("run-1", 1, "Provider crashed"),
      failedRun("run-2", 2, "Authentication expired"),
      session("Provider crashed", 21),
    );
    expect(onScreen(key, failed)).toBe("Authentication expired");
  });

  it("stays dismissed while a later run starts and succeeds", () => {
    const key = "env:later-success";
    const failed = failedRun("run-1", 1, "Provider crashed");
    const before = thread(failed, session("Provider crashed", 12));
    expect(onScreen(key, before)).toBe("Provider crashed");
    dismiss(key, before);

    const starting = thread(failed, run("run-2", 2, "running"), session("Provider crashed", 21));
    expect(deriveThreadRuntime(starting)?.lastError).toBe("Provider crashed");
    expect(onScreen(key, starting)).toBeNull();
    const succeeded = thread(failed, run("run-2", 2, "completed"), session("Provider crashed", 22));
    expect(deriveThreadRuntime(succeeded)?.lastError).toBe("Provider crashed");
    expect(onScreen(key, succeeded)).toBeNull();
  });

  it("keeps a session-only error dismissed while a later run starts and succeeds", () => {
    const key = "env:session-only-later-success";
    const before = thread(run("run-1", 1, "completed"), session("Transport closed", 12));
    expect(onScreen(key, before)).toBe("Transport closed");
    dismiss(key, before);

    const later = (status: RunStatus) =>
      thread(
        run("run-1", 1, "completed"),
        run("run-2", 2, status),
        session("Transport closed", 21),
      );
    expect(onScreen(key, later("running"))).toBeNull();
    expect(onScreen(key, later("completed"))).toBeNull();
  });

  it("shows a later run that fails with the same text", () => {
    const key = "env:same-text-again";
    const first = failedRun("run-1", 1, "Provider crashed");
    const before = thread(first, session("Provider crashed", 12));
    expect(onScreen(key, before)).toBe("Provider crashed");
    dismiss(key, before);
    expect(onScreen(key, before)).toBeNull();

    const again = thread(
      first,
      failedRun("run-2", 2, "Provider crashed"),
      session("Provider crashed", 22),
    );
    expect(onScreen(key, again)).toBe("Provider crashed");

    dismiss(key, again);
    expect(onScreen(key, again)).toBeNull();
  });

  it("shows a later run's own message while the old session text is still stored", () => {
    const key = "env:other-text-old-session";
    const first = failedRun("run-1", 1, "Provider crashed");
    const old = session("Provider crashed", 12);
    expect(onScreen(key, thread(first, old))).toBe("Provider crashed");
    dismiss(key, thread(first, old));

    // The next attempt fails before a session opens, so the old row stays untouched.
    const limited = thread(
      first,
      run("run-2", 2, "failed"),
      failure("run-2", "Usage limit reached", "usage_limit"),
      old,
    );
    expect(deriveThreadRuntime(limited)?.lastError).toBe("Provider crashed");
    const shown = banner(key, limited);
    expect(shown.message).toBe("Usage limit reached");
    expect(shown.errorClass).toBe("usage_limit");

    // Dismissing it hides both texts, including after release clears the session.
    dismiss(key, limited);
    expect(onScreen(key, limited)).toBeNull();
    const released = thread(
      first,
      run("run-2", 2, "failed"),
      failure("run-2", "Usage limit reached", "usage_limit"),
      session(null, 30),
    );
    expect(deriveThreadRuntime(released)?.lastError).toBe("Usage limit reached");
    expect(onScreen(key, released)).toBeNull();
  });

  it("stays dismissed when earlier history loads and when a reconnect brings a bounded snapshot", () => {
    const key = "env:history-window";
    const runs = [run("run-1", 1, "failed"), run("run-2", 2, "failed")];
    const old = session("Provider crashed", 22);
    const earlier = failure("run-1", "Provider crashed");
    const latest = failure("run-2", "Could not open a session");
    const bounded = () => thread(runs, latest, old);
    const expanded = () => thread(runs, earlier, latest, old);
    expect(onScreen(key, bounded())).toBe("Provider crashed");
    dismiss(key, bounded());

    expect(onScreen(key, expanded())).toBeNull();
    expect(onScreen(key, bounded())).toBeNull();
    expect(onScreen(key, expanded())).toBeNull();
  });

  it("stays dismissed when a fuller run history brings an older failed run", () => {
    const key = "env:run-window";
    const old = session("Provider crashed", 22);
    // A bounded snapshot holds only the latest run; run-1 failed before it.
    const windowed = thread(run("run-2", 2, "completed"), old);
    expect(onScreen(key, windowed)).toBe("Provider crashed");
    dismiss(key, windowed);

    const fuller = thread(
      failedRun("run-1", 1, "Provider crashed"),
      run("run-2", 2, "completed"),
      old,
    );
    expect(onScreen(key, fuller)).toBeNull();

    const later = thread(
      failedRun("run-1", 1, "Provider crashed"),
      run("run-2", 2, "completed"),
      failedRun("run-3", 3, "Provider crashed"),
      old,
    );
    expect(onScreen(key, later)).toBe("Provider crashed");
  });

  it("shows a run that was queued at dismissal when it later fails", () => {
    const key = "env:queued-at-dismissal";
    const first = failedRun("run-1", 1, "Provider crashed");
    const old = session("Provider crashed", 12);
    // run-3 was queued ahead of run-2, so the watermark is run-3's ordinal.
    const before = thread(first, run("run-2", 2, "queued"), run("run-3", 3, "running"), old);
    expect(onScreen(key, before)).toBe("Provider crashed");
    dismiss(key, before);

    const settled = thread(first, run("run-2", 2, "queued"), run("run-3", 3, "completed"), old);
    expect(onScreen(key, settled)).toBeNull();
    const failed = thread(
      first,
      failedRun("run-2", 2, "Provider crashed"),
      run("run-3", 3, "completed"),
      old,
    );
    expect(onScreen(key, failed)).toBe("Provider crashed");
  });

  it("keeps a dismissal after two hundred and one dismissals on other threads", () => {
    const projection = thread(failedRun("run-1", 1, "Provider crashed"));
    expect(onScreen("env:first", projection)).toBe("Provider crashed");
    dismiss("env:first", projection);
    for (let index = 0; index <= 200; index += 1) {
      const other = `env:other-${index}`;
      expect(onScreen(other, projection)).toBe("Provider crashed");
      dismiss(other, projection);
    }
    expect(onScreen("env:first", projection)).toBeNull();
    expect(onScreen("env:never-dismissed", projection)).toBe("Provider crashed");
  });

  it("dismisses a client-local error without bringing back the dismissed saved error", () => {
    const key = "env:local-over-saved";
    const projection = thread(failedRun("run-1", 1, "Provider crashed"));
    expect(onScreen(key, projection)).toBe("Provider crashed");
    dismiss(key, projection);

    expect(onScreen(key, projection, "Failed to send.")).toBe("Failed to send.");
    dismiss(key, projection, "Failed to send.");
    // The chat view clears the local error on dismiss; the saved one stays hidden.
    expect(onScreen(key, projection)).toBeNull();
  });
});
