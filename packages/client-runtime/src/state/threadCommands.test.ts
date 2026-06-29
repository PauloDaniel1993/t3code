import { describe, expect, it } from "vite-plus/test";

import { handoffThreadConcurrencyKey, threadCommandConcurrencyKey } from "./threadCommands.ts";

describe("thread command state", () => {
  it("keys handoff concurrency by source thread id", () => {
    const first = handoffThreadConcurrencyKey({
      environmentId: "environment-1",
      input: {
        sourceThreadId: "source-thread",
      },
    });
    const sameSourceDifferentTarget = handoffThreadConcurrencyKey({
      environmentId: "environment-1",
      input: {
        sourceThreadId: "source-thread",
      },
    });
    const differentSource = handoffThreadConcurrencyKey({
      environmentId: "environment-1",
      input: {
        sourceThreadId: "other-source-thread",
      },
    });

    expect(first).toBe(sameSourceDifferentTarget);
    expect(first).not.toBe(differentSource);
  });

  it("keeps non-handoff thread commands keyed by thread id", () => {
    expect(
      threadCommandConcurrencyKey({
        environmentId: "environment-1",
        input: {
          threadId: "thread-1",
        },
      }),
    ).toBe(JSON.stringify(["environment-1", "thread-1"]));
  });
});
