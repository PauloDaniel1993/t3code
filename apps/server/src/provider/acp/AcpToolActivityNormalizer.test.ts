import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2TurnItem, TurnItemId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { normalizeAcpToolActivity, secretSafeAcpActivity } from "./AcpToolActivityNormalizer.ts";

const base = {
  id: TurnItemId.make("tool"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running" as const,
  title: "Tool",
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
};
const decode = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("secret-safe ACP tool activity", () => {
  it("keeps MCP identity while removing raw inputs and intermediate results", () => {
    const item = decode({
      ...base,
      type: "dynamic_tool",
      toolName: "t3.task_status",
      input: { taskId: "task", apiKey: "private-key" },
      output: { progress: "working", password: "private-password" },
    });
    const normalized = normalizeAcpToolActivity(item);
    assert.equal(normalized.type, "dynamic_tool");
    if (normalized.type !== "dynamic_tool") return;
    assert.equal(normalized.toolName, "t3.task_status");
    assert.deepEqual(normalized.input, {});
    assert.notProperty(normalized, "output");
    if (item.type !== "dynamic_tool") return assert.fail("Expected dynamic tool input");
    assert.deepEqual(item.input, { taskId: "task", apiKey: "private-key" });
  });

  it("retains terminal results with recursive redaction and omits protocol wrappers", () => {
    const item = decode({
      ...base,
      status: "completed",
      type: "dynamic_tool",
      toolName: "tool",
      input: { secret: "input-secret" },
      output: {
        result: "done",
        nested: [{ authorization: "Bearer private-token", count: 2 }],
        rawInput: { private: "protocol" },
        meta: { hidden: "protocol" },
      },
    });
    const normalized = normalizeAcpToolActivity(item);
    if (normalized.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
    assert.deepEqual(normalized.output, {
      result: "done",
      nested: [{ authorization: "[REDACTED]", count: 2 }],
    });
  });

  it("removes command stdout until terminal and redacts secret values in presentation", () => {
    const toolCall = { toolCallId: "tool", data: { rawInput: { apiKey: "private-key" } } };
    const item = decode({
      ...base,
      type: "command_execution",
      title: "curl private-key",
      input: "curl --header 'Authorization: Bearer private-key'",
      output: 'apiKey="private-key"\nfinished',
    });
    const running = normalizeAcpToolActivity(item, toolCall);
    assert.notProperty(running, "output");
    const completed = normalizeAcpToolActivity({ ...item, status: "completed" }, toolCall);
    assert.notInclude(encode(completed), "private-key");
    assert.include(encode(completed), "finished");
  });

  it("handles cycles and preserves repeated non-cyclic results", () => {
    const shared = { result: "done" };
    assert.deepEqual(secretSafeAcpActivity({ value: 12n }), { value: "12" });
    const cycle: Record<string, unknown> = { shared };
    cycle.self = cycle;
    assert.deepEqual(secretSafeAcpActivity({ first: shared, second: shared, cycle }), {
      first: shared,
      second: shared,
      cycle: { shared, self: "[REDACTED]" },
    });
  });

  it("removes intermediate diffs and search results but retains final typed output", () => {
    for (const detail of [
      { type: "file_change", fileName: "file.ts", diffStr: 'password="private-password"' },
      { type: "file_search", results: [{ fileName: "file.ts", preview: "apiKey=private-key" }] },
      {
        type: "web_search",
        results: [{ url: "https://example.com", snippet: "token=private-token" }],
      },
    ]) {
      const item = decode({ ...base, ...detail });
      const running = normalizeAcpToolActivity(item);
      assert.notProperty(running, "results");
      assert.notProperty(running, "diffStr");
      const final = normalizeAcpToolActivity({ ...item, status: "failed" });
      assert.notInclude(encode(final), "private-");
      assert.deepEqual(decode(final), final);
    }
  });
});
