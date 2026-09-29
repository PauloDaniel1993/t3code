import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2TurnItem, TurnItemId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  ACP_TOOL_INPUT_BYTES,
  normalizeAcpToolActivity,
  secretSafeAcpActivity,
} from "./AcpToolActivityNormalizer.ts";

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

describe("secret-safe ACP tool activity", () => {
  it("keeps redacted MCP arguments and identity while removing intermediate results", () => {
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
    assert.deepEqual(normalized.input, { taskId: "task", apiKey: "[REDACTED]" });
    assert.notProperty(normalized, "output");
    if (item.type !== "dynamic_tool") return assert.fail("Expected dynamic tool input");
    assert.deepEqual(item.input, { taskId: "task", apiKey: "private-key" });
  });

  it("retains terminal result fields and lists with recursive field redaction", () => {
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
      rawInput: { private: "protocol" },
      meta: { hidden: "protocol" },
    });
  });

  it("preserves command text byte for byte and removes stdout only until terminal", () => {
    const item = decode({
      ...base,
      type: "command_execution",
      title: "curl private-key",
      input: "curl --header 'Authorization: Bearer private-key'",
      output: 'apiKey="private-key"\nfinished',
    });
    const running = normalizeAcpToolActivity(item);
    assert.notProperty(running, "output");
    const completed = normalizeAcpToolActivity({ ...item, status: "completed" });
    assert.deepEqual(completed, { ...item, status: "completed" });
  });

  it("handles cycles and preserves repeated non-cyclic results", () => {
    const shared = { result: "done" };
    assert.deepEqual(secretSafeAcpActivity({ value: 12n }), { value: "12" });
    const cycle: Record<string, unknown> = { shared };
    cycle.self = cycle;
    assert.deepEqual(secretSafeAcpActivity({ first: shared, second: shared, cycle }), {
      first: shared,
      second: shared,
      cycle: { shared, self: "[CIRCULAR]" },
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
      assert.deepEqual(final, { ...item, status: "failed" });
      assert.deepEqual(decode(final), final);
    }
  });

  it("preserves the review probe's code, commands, escaped JSON, diffs and search text", () => {
    const code =
      'const token = getToken();\ninterface U { password: string }\nif (secret == null) return;\nheaders.Authorization = `Bearer ${key}`;\ngit commit -m "fix token: refresh flow"';
    for (const detail of [
      {
        type: "dynamic_tool",
        toolName: "write_file",
        input: {},
        output: {
          content: [{ type: "text", text: code }],
          matrix: [
            [1, 2],
            [3, [4, 5]],
          ],
        },
      },
      {
        type: "command_execution",
        input:
          "GITHUB_TOKEN=ghp_abc123 AWS_SECRET_ACCESS_KEY=xyz OPENAI_API_KEY=sk-live1 gh pr list",
        output: '{"token": "a\\\"b", "name": "x"}',
      },
      {
        type: "command_execution",
        input: "curl -H 'Authorization: Bearer abc.def' -H \"X-Api-Key: k123\" https://x",
        output: "sk-ant-123",
      },
      {
        type: "file_change",
        fileName: "auth.ts",
        diffStr: "--- a/auth.ts\n+++ b/auth.ts\n@@\n-  password: string;\n+  password?: string;\n",
        oldStr: "password: string",
        newStr: "password?: string",
      },
      {
        type: "file_search",
        pattern: "token",
        results: [{ fileName: "a.ts", line: 3, preview: code }],
      },
    ]) {
      const item = decode({ ...base, status: "completed", ...detail });
      const once = normalizeAcpToolActivity(item);
      assert.deepEqual(once, item);
      assert.deepEqual(normalizeAcpToolActivity(once), once);
    }
  });

  it("redacts structured fields without replacing their values elsewhere, including short values", () => {
    const payload = {
      token: "1",
      nested: [{ password: "private-password", text: "private-password" }],
      text: "10 files, 1 failed, 21 passed",
      headers: { Authorization: "Bearer key", Cookie: "sid=1" },
    };
    const once = secretSafeAcpActivity(payload);
    assert.deepEqual(once, {
      token: "[REDACTED]",
      nested: [{ password: "[REDACTED]", text: "private-password" }],
      text: payload.text,
      headers: { Authorization: "[REDACTED]", Cookie: "[REDACTED]" },
    });
    assert.deepEqual(secretSafeAcpActivity(once), once);
    const command = decode({
      ...base,
      status: "completed",
      type: "command_execution",
      input: "tool --token=1 run",
      output: payload.text,
    });
    assert.deepEqual(normalizeAcpToolActivity(command), command);
  });

  it("retains redacted arguments at every status and marks oversized UTF-8/escaped input", () => {
    const input = {
      path: "a.ts",
      content: "const token = getToken();",
      headers: { "x-api-key": "key", AWS_SECRET_ACCESS_KEY: "aws-key" },
      rawInput: { token: "1" },
    };
    for (const status of [
      "pending",
      "running",
      "waiting",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
    ]) {
      const item = decode({
        ...base,
        type: "dynamic_tool",
        toolName: "MCP.write_file",
        status,
        input,
      });
      const normalized = normalizeAcpToolActivity(item);
      if (normalized.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
      assert.deepEqual(normalized.input, {
        ...input,
        headers: { "x-api-key": "[REDACTED]", AWS_SECRET_ACCESS_KEY: "[REDACTED]" },
        rawInput: { token: "[REDACTED]" },
      });
      assert.deepEqual(normalizeAcpToolActivity(normalized), normalized);
    }
    const item = decode({
      ...base,
      type: "dynamic_tool",
      toolName: "MCP.write_file",
      input: { token: "private-token", code: '"\\\n🦊'.repeat(20_000) },
    });
    const normalized = normalizeAcpToolActivity(item);
    if (normalized.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
    const encoded = JSON.stringify(normalized.input);
    assert.isAtMost(Buffer.byteLength(encoded), ACP_TOOL_INPUT_BYTES);
    assert.notInclude(encoded, "private-token");
    assert.include(encoded, '"truncated":true');
    assert.include(encoded, '"limitBytes":16384');
    assert.include(encoded, "[REDACTED]");
    assert.notInclude(encoded, "�");
    assert.deepEqual(normalizeAcpToolActivity(normalized), normalized);
  });
});
