import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestratorMcpDelegateTaskInput } from "./orchestratorMcp.ts";

import {
  ForkTaskCancelInput,
  ForkTaskCreateInput,
  ForkTaskModelsInput,
  ForkTaskModelsResult,
  OrchestratorMcpTaskListInput,
  OrchestratorMcpTaskListResult,
} from "./orchestratorTasks.ts";

const decode = Schema.decodeUnknownSync(OrchestratorMcpTaskListInput);
const decodeTaskModelsInput = Schema.decodeUnknownSync(ForkTaskModelsInput);
const decodeTaskCreate = Schema.decodeSync(ForkTaskCreateInput);
const decodeDelegateTask = Schema.decodeSync(OrchestratorMcpDelegateTaskInput);

describe("delegated task model catalog", () => {
  it("accepts existing requests and optional model search", () => {
    const decodeModels = Schema.decodeUnknownSync(ForkTaskModelsInput);
    expect(decodeModels({})).toEqual({});
    expect(decodeModels({ instanceId: "codex", search: "  model 11  " })).toEqual({
      instanceId: "codex",
      search: "model 11",
    });
  });

  it.each(["", "   ", "x".repeat(201), 123])("rejects invalid model search %s", (search) => {
    expect(() => decodeTaskModelsInput({ search })).toThrow();
  });

  it("accepts legacy results and preserves optional omission counts", () => {
    const decodeModels = Schema.decodeUnknownSync(ForkTaskModelsResult);
    const result = {
      current: { instanceId: "codex", model: "model", reasoning: null },
      instances: [
        { instanceId: "codex", provider: "codex", displayName: "Codex", ready: true, models: [] },
      ],
    };
    expect(decodeModels(result)).toEqual(result);
    const withOmissions = {
      ...result,
      instances: [{ ...result.instances[0], omittedModels: 4 }],
    };
    expect(decodeModels(withOmissions)).toEqual(withOmissions);
    for (const omittedModels of [-1, 1.5, "4"]) {
      expect(() =>
        decodeModels({
          ...result,
          instances: [{ ...result.instances[0], omittedModels }],
        }),
      ).toThrow();
    }
  });
});

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
    expect(() => create({ title: "x".repeat(513), prompt: "Review", context: "none" })).toThrow();
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

it.each([121, 512])("allows a %s-character task title in both delegation tools", (length) => {
  const title = "x".repeat(length);
  expect(decodeTaskCreate({ title, prompt: "Review", context: "none" }).title).toBe(title);
  expect(decodeDelegateTask({ title, task: "Review" }).title).toBe(title);
});

it("rejects task titles over 512 characters in both delegation tools", () => {
  const title = "x".repeat(513);
  expect(() => decodeTaskCreate({ title, prompt: "Review", context: "none" })).toThrow();
  expect(() => decodeDelegateTask({ title, task: "Review" })).toThrow();
});

it("represents an unreadable task explicitly in list results", () => {
  const decodeResult = Schema.decodeUnknownSync(OrchestratorMcpTaskListResult);
  expect(
    decodeResult({
      parentThreadId: "parent",
      nextCursor: null,
      tasks: [
        {
          threadId: "child",
          taskId: "task",
          title: "Check",
          status: "unreadable",
          createdBy: "agent",
          context: { kind: "none" },
          createdAt: "2026-09-29T12:00:00.000Z",
          result: null,
          error: "Could not read this child.",
        },
      ],
    }).tasks[0]?.status,
  ).toBe("unreadable");
});
