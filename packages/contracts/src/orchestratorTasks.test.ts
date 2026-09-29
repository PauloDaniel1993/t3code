import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ForkTaskCancelInput,
  ForkTaskCreateInput,
  OrchestratorMcpTaskListInput,
} from "./orchestratorTasks.ts";

const decode = Schema.decodeUnknownSync(OrchestratorMcpTaskListInput);

describe("delegated task list input", () => {
  it("accepts discovery without a remembered task ID and continuation pages", () => {
    expect(decode({})).toEqual({});
    expect(decode({ limit: 65, cursor: "opaque-cursor", status: "finished" })).toEqual({
      limit: 65,
      cursor: "opaque-cursor",
      status: "finished",
    });
  });

  it.each([0, -1, 1.5, "20"])("rejects an invalid page size %s", (limit) => {
    expect(() => decode({ limit })).toThrow();
  });

  it("rejects an empty continuation cursor", () => {
    expect(() => decode({ cursor: "" })).toThrow();
  });

  it("honours fork input bounds and requires a cancellation target", () => {
    const create = Schema.decodeUnknownSync(ForkTaskCreateInput);
    expect(
      create({
        title: "Review",
        prompt: "Review this module",
        context: "none",
        model: { instanceId: "codex", model: "gpt" },
        reasoning: "xhigh",
      }),
    ).toMatchObject({ reasoning: "xhigh" });
    expect(() => create({ title: "x".repeat(121), prompt: "Review", context: "none" })).toThrow();
    expect(() =>
      create({ title: "Review", prompt: "x".repeat(100_001), context: "none" }),
    ).toThrow();
    const cancel = Schema.decodeUnknownSync(ForkTaskCancelInput);
    expect(cancel({ threadId: "child" })).toEqual({ threadId: "child" });
    expect(cancel({ taskId: "task" })).toEqual({ taskId: "task" });
    expect(() => cancel({})).toThrow();
    expect(() => decode({ status: "completed" })).toThrow();
  });
});
