import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./ThreadErrorBanner";
import { deriveThreadErrorOccurrence } from "./threadErrorOccurrence";

const providerInstanceId = ProviderInstanceId.make("codex");
const otherInstanceId = ProviderInstanceId.make("claude");

function sessionAt(iso: string, lastError: string | null) {
  return {
    providerInstanceId,
    lastError,
    updatedAt: DateTime.makeUnsafe(iso),
  };
}

function projectionWith(sessions: ReadonlyArray<ReturnType<typeof sessionAt>>) {
  return { thread: { providerInstanceId }, providerSessions: sessions };
}

const noRun = null;
const run1 = { runId: RunId.make("run-1"), completedAt: "2026-03-29T00:00:10.000Z" };
const run2 = { runId: RunId.make("run-2"), completedAt: "2026-03-29T00:01:10.000Z" };

/** What the chat view shows for one render: the banner text, or null once masked. */
function shownError(threadKey: string, error: string | null, occurrence: string) {
  const key = getThreadErrorBannerKey(threadKey, error, occurrence);
  return shouldShowThreadErrorBanner(threadKey, error, isThreadErrorBannerDismissedForSession(key))
    ? error
    : null;
}

function dismiss(threadKey: string, error: string | null, occurrence: string) {
  dismissThreadErrorBannerForSession(getThreadErrorBannerKey(threadKey, error, occurrence));
}

describe("deriveThreadErrorOccurrence", () => {
  it("changes when the provider session writes the same error again", () => {
    const first = deriveThreadErrorOccurrence({
      localError: undefined,
      projection: projectionWith([sessionAt("2026-03-29T00:00:00.000Z", "Provider crashed")]),
      latestRun: run1,
    });
    const again = deriveThreadErrorOccurrence({
      localError: undefined,
      projection: projectionWith([sessionAt("2026-03-29T00:02:00.000Z", "Provider crashed")]),
      latestRun: run1,
    });

    expect(again).not.toBe(first);
  });

  it("stays put while the thread updates without a new session error", () => {
    const failedRun = (updatedAt: string) =>
      deriveThreadErrorOccurrence({
        localError: undefined,
        projection: projectionWith([sessionAt(updatedAt, null)]),
        latestRun: run1,
      });

    expect(failedRun("2026-03-29T00:00:20.000Z")).toBe(failedRun("2026-03-29T00:05:00.000Z"));
  });

  it("tells failed runs apart and ignores other providers' sessions", () => {
    const sessions = [
      sessionAt("2026-03-29T00:00:00.000Z", null),
      {
        ...sessionAt("2026-03-29T00:09:00.000Z", "Other provider crashed"),
        providerInstanceId: otherInstanceId,
      },
    ];
    const forRun = (latestRun: typeof run1) =>
      deriveThreadErrorOccurrence({
        localError: undefined,
        projection: projectionWith(sessions),
        latestRun,
      });

    expect(forRun(run2)).not.toBe(forRun(run1));
    expect(forRun(run1)).toBe(forRun(run1));
  });

  it("keys a client-local error by when it was written, and ignores a cleared one", () => {
    const projection = projectionWith([sessionAt("2026-03-29T00:00:00.000Z", null)]);
    const local = (message: string | null, at: number) =>
      deriveThreadErrorOccurrence({ localError: { message, at }, projection, latestRun: noRun });

    expect(local("Failed to send.", 2)).not.toBe(local("Failed to send.", 1));
    expect(local(null, 3)).toBe(
      deriveThreadErrorOccurrence({ localError: undefined, projection, latestRun: noRun }),
    );
  });
});

describe("dismissing a saved thread error", () => {
  it("hides the dismissed error at once and shows the same text failing again", () => {
    const threadKey = "env:thread-repeat";
    const firstFailure = deriveThreadErrorOccurrence({
      localError: undefined,
      projection: projectionWith([sessionAt("2026-03-29T00:00:00.000Z", "Provider crashed")]),
      latestRun: run1,
    });

    expect(shownError(threadKey, "Provider crashed", firstFailure)).toBe("Provider crashed");
    dismiss(threadKey, "Provider crashed", firstFailure);
    expect(shownError(threadKey, "Provider crashed", firstFailure)).toBeNull();

    const secondFailure = deriveThreadErrorOccurrence({
      localError: undefined,
      projection: projectionWith([sessionAt("2026-03-29T00:02:00.000Z", "Provider crashed")]),
      latestRun: run2,
    });
    expect(shownError(threadKey, "Provider crashed", secondFailure)).toBe("Provider crashed");
  });

  it("shows a repeated run failure and a repeated client-local error after a dismissal", () => {
    const threadKey = "env:thread-run";
    const projection = projectionWith([sessionAt("2026-03-29T00:00:00.000Z", null)]);
    const runFailure = (latestRun: typeof run1) =>
      deriveThreadErrorOccurrence({ localError: undefined, projection, latestRun });

    dismiss(threadKey, "Turn failed", runFailure(run1));
    expect(shownError(threadKey, "Turn failed", runFailure(run1))).toBeNull();
    expect(shownError(threadKey, "Turn failed", runFailure(run2))).toBe("Turn failed");

    const localFailure = (at: number) =>
      deriveThreadErrorOccurrence({
        localError: { message: "Failed to send.", at },
        projection,
        latestRun: noRun,
      });
    dismiss(threadKey, "Failed to send.", localFailure(1));
    expect(shownError(threadKey, "Failed to send.", localFailure(1))).toBeNull();
    expect(shownError(threadKey, "Failed to send.", localFailure(2))).toBe("Failed to send.");
  });
});
