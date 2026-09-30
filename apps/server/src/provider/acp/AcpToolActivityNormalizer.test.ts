import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2TurnItem, TurnItemId, ThreadId } from "@t3tools/contracts";
import { formatSearchToolLabel, collectToolFilePaths } from "@t3tools/shared/toolActivity";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  ACP_TOOL_INPUT_BYTES,
  ACP_TOOL_LABEL_BYTES,
  ACP_TOOL_OUTPUT_BYTES,
  isSensitiveAcpField,
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
  it("keeps redacted MCP arguments, identity and live results", () => {
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
    assert.deepEqual(normalized.output, { progress: "working", password: "[REDACTED]" });
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

  it("preserves command text and live stdout byte for byte within the limit", () => {
    const item = decode({
      ...base,
      type: "command_execution",
      title: "curl private-key",
      input: "curl --header 'Authorization: Bearer private-key'",
      output: 'apiKey="private-key"\nfinished',
    });
    const running = normalizeAcpToolActivity(item);
    assert.deepEqual(running, item);
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

  it("retains live diffs and search results as well as final typed output", () => {
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
      assert.deepEqual(running, item);
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
        input: { path: "a.ts", content: code },
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

  it("matches sensitive suffixes across case and camel, snake and kebab spellings", () => {
    const names = [
      "idToken",
      "authToken",
      "id_token",
      "x-api-key",
      "githubToken",
      "sessionToken",
      "npm_config__authToken",
      "ApiKey",
      "APIKey",
      "GITHUB_TOKEN",
      "clientSecret",
      "privateKey",
      "cookies",
      "credentials",
    ];
    const fields = Object.fromEntries(names.map((name) => [name, "private"]));
    const once = secretSafeAcpActivity({
      ...fields,
      tokenizer: "kept",
      max_tokens: 7,
      token_count: 7,
      secret_name: "kept",
      password_hint: "kept",
      key: "kept",
      auth: "kept",
    });
    assert.deepEqual(once, {
      ...Object.fromEntries(names.map((name) => [name, "[REDACTED]"])),
      tokenizer: "kept",
      max_tokens: 7,
      token_count: 7,
      secret_name: "kept",
      password_hint: "kept",
      key: "kept",
      auth: "kept",
    });
    assert.deepEqual(secretSafeAcpActivity(once), once);
  });

  it.each([
    ["idToken", true],
    ["authToken", true],
    ["id_token", true],
    ["x-api-key", true],
    ["tokenizer", false],
    ["author", false],
    ["keyboard", false],
    ["secretary", false],
    ["passwordHint", false],
    ["max_tokens", false],
    ["token_count", false],
    ["totalTokenCount", false],
    ["promptTokenCount", false],
    ["candidatesTokenCount", false],
    ["token_type", false],
    ["tokenLimit", false],
    ["maxToken", true],
    ["secret_name", false],
    ["aws_secret_access_key", true],
    ["set-cookie", true],
    ["tokens", true],
    ["accessTokens", true],
    ["OPENAI_API_KEY", true],
    ["apiKeys", true],
    ["apiKey", true],
    ["access_token", true],
    ["clientSecret", true],
    ["password", true],
    ["Authorization", true],
    ["privateKey", true],
    ["secretKey", true],
    ["accessKey", true],
    ["privateKeys", true],
    ["secretKeys", true],
    ["accessKeys", true],
    ["passwords", true],
    ["passwds", true],
    ["secrets", true],
    ["authorizations", true],
    ["minTokens", false],
    ["total_tokens", false],
    ["num-tokens", false],
    ["countTokens", false],
    ["maxPasswords", false],
    ["totalCookies", false],
    ["numCredentials", false],
    ["apiKeyHint", false],
    ["privateKeyPath", false],
  ])(
    "preserves the verification probe's %s field unless its suffix is sensitive (%s)",
    (name, sensitive) => {
      assert.equal(isSensitiveAcpField(name), sensitive);
      const value = { [name]: 812 };
      const expected = { [name]: sensitive ? "[REDACTED]" : 812 };
      for (const status of ["running", "completed"]) {
        const item = decode({
          ...base,
          type: "dynamic_tool",
          toolName: "Tool",
          status,
          input: value,
          output: { usage: value },
        });
        const once = normalizeAcpToolActivity(item);
        if (once.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
        assert.deepEqual(once.input, expected);
        assert.deepEqual(once.output, { usage: expected });
        assert.deepEqual(normalizeAcpToolActivity(once), once);
        if (item.type !== "dynamic_tool") return assert.fail("Expected original dynamic tool");
        assert.deepEqual(item.input, value);
        assert.deepEqual(item.output, { usage: value });
      }
    },
  );

  it("redacts sensitive header values in object and tuple lists", () => {
    const payload = {
      headers: [
        { name: "Authorization", value: "Bearer private" },
        { key: "x-api-key", value: "private" },
        { Name: "GITHUB_TOKEN", Value: { credential: "private" } },
        { name: "Accept", value: "application/json" },
        ["Authorization", "Bearer abc"],
        ["Accept", "json"],
      ],
      command: "curl -H 'Authorization: Bearer private'",
    };
    const once = secretSafeAcpActivity(payload);
    assert.deepEqual(once, {
      ...payload,
      headers: [
        { name: "Authorization", value: "[REDACTED]" },
        { key: "x-api-key", value: "[REDACTED]" },
        { Name: "GITHUB_TOKEN", Value: "[REDACTED]" },
        { name: "Accept", value: "application/json" },
        ["Authorization", "[REDACTED]"],
        ["Accept", "json"],
      ],
    });
    assert.deepEqual(secretSafeAcpActivity(once), once);
  });

  it.each(["headers", "requestHeaders", "responseHeaders"])(
    "redacts two-string tuples only inside %s fields",
    (field) => {
      const tuples = [
        ["Authorization", "Bearer abc"],
        ["apiKeys", "private"],
        ["Accept", "json"],
        ["token_count", "7"],
        ["Authorization", "first", "second"],
        ["Authorization", 812],
        { args: ["Authorization", "ordinary argument"] },
      ];
      const payload = {
        nested: { [field]: tuples },
        args: ["Authorization", "ordinary argument"],
        rows: [["Authorization", "ordinary row"]],
        other: { pairs: tuples },
        notheaders: [["Authorization", "ordinary row"]],
      };
      const expected = {
        ...payload,
        nested: {
          [field]: [["Authorization", "[REDACTED]"], ["apiKeys", "[REDACTED]"], ...tuples.slice(2)],
        },
      };
      const once = secretSafeAcpActivity(payload);
      assert.deepEqual(once, expected);
      assert.deepEqual(secretSafeAcpActivity(once), once);
      const item = decode({
        ...base,
        type: "dynamic_tool",
        toolName: "Tool",
        status: "completed",
        input: payload,
        output: payload,
      });
      const normalized = normalizeAcpToolActivity(item);
      if (normalized.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
      assert.deepEqual(normalized.input, expected);
      assert.deepEqual(normalized.output, expected);
      assert.deepEqual(normalizeAcpToolActivity(normalized), normalized);
      assert.deepEqual(payload.nested[field], tuples);
    },
  );

  it("keeps individually bounded label fields beside a preview of oversized arguments", () => {
    const input = {
      file_path: "src/a.ts",
      command: "pnpm build",
      query: "where is auth?",
      path: "src",
      globPattern: "*.ts",
      content: "large content ".repeat(3_000),
    };
    const normalized = normalizeAcpToolActivity(
      decode({ ...base, type: "dynamic_tool", toolName: "Write", input }),
    );
    for (const key of ["file_path", "command", "query", "path", "globPattern"] as const)
      assert.nestedPropertyVal(normalized, `input.${key}`, input[key]);
    assert.deepEqual(collectToolFilePaths(normalized), ["src", "src/a.ts"]);
    assert.equal(formatSearchToolLabel(normalized), "Searched where is auth? in src");
    assert.isAtMost(
      Buffer.byteLength(
        JSON.stringify(normalized.type === "dynamic_tool" ? normalized.input : null),
      ),
      ACP_TOOL_INPUT_BYTES,
    );
    assert.deepEqual(normalizeAcpToolActivity(normalized), normalized);
    const hugeLabels = normalizeAcpToolActivity(
      decode({
        ...base,
        type: "dynamic_tool",
        toolName: "Write",
        input: {
          ...input,
          file_path: "🦊".repeat(10_000),
          command: '"\\'.repeat(10_000),
          query: "q".repeat(10_000),
        },
      }),
    );
    if (hugeLabels.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
    assert.isAtMost(Buffer.byteLength(JSON.stringify(hugeLabels.input)), ACP_TOOL_INPUT_BYTES);
    if (!Predicate.isObject(hugeLabels.input)) return assert.fail("Expected label fields");
    for (const field of ["file_path", "command", "query"] as const) {
      if (!(field in hugeLabels.input)) return assert.fail("Missing label field");
      assert.isAtMost(
        Buffer.byteLength(JSON.stringify(hugeLabels.input[field])),
        ACP_TOOL_LABEL_BYTES,
      );
    }
    assert.deepEqual(normalizeAcpToolActivity(hugeLabels), hugeLabels);
  });

  it("never cuts inside a redaction marker at the preview boundary", () => {
    for (let offset = 0; offset < 32; offset++) {
      const item = decode({
        ...base,
        type: "dynamic_tool",
        toolName: "Write",
        input: {
          padding: "p".repeat(ACP_TOOL_INPUT_BYTES - 100 - offset),
          token: "private",
          rest: "r".repeat(200),
        },
      });
      const normalized = normalizeAcpToolActivity(item);
      if (
        normalized.type !== "dynamic_tool" ||
        !normalized.input ||
        typeof normalized.input !== "object" ||
        !("preview" in normalized.input) ||
        typeof normalized.input.preview !== "string"
      )
        return assert.fail("Expected a truncated preview");
      for (let length = 1; length < "[REDACTED]".length; length++)
        assert.isFalse(normalized.input.preview.endsWith(`${"[REDACTED]".slice(0, length)}…`));
      assert.notInclude(JSON.stringify(normalized.input), "private");
      assert.deepEqual(normalizeAcpToolActivity(normalized), normalized);
    }
    for (let offset = 0; offset < 120; offset++) {
      const normalized = normalizeAcpToolActivity(
        decode({
          ...base,
          type: "dynamic_tool",
          toolName: "Tool",
          input: {},
          output: { token: "private", padding: "p".repeat(ACP_TOOL_OUTPUT_BYTES - 50 + offset) },
        }),
      );
      if (normalized.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
      assert.isAtMost(Buffer.byteLength(JSON.stringify(normalized.output)), ACP_TOOL_OUTPUT_BYTES);
      if (!Predicate.isObject(normalized.output) || typeof normalized.output.preview !== "string")
        continue;
      for (let index = 1; index < "[REDACTED]".length; index++)
        assert.isFalse(normalized.output.preview.startsWith(`…${"[REDACTED]".slice(index)}`));
      assert.deepEqual(normalizeAcpToolActivity(normalized), normalized);
    }
  });

  it("bounds running command and dynamic output while keeping the latest command progress", () => {
    const command = normalizeAcpToolActivity(
      decode({
        ...base,
        type: "command_execution",
        input: "long command",
        output: `${"old output".repeat(10_000)}\nlatest progress`,
      }),
    );
    if (command.type !== "command_execution") return assert.fail("Expected command");
    assert.include(command.output ?? "", "latest progress");
    assert.isAtMost(Buffer.byteLength(JSON.stringify(command.output)), ACP_TOOL_OUTPUT_BYTES);
    const dynamic = normalizeAcpToolActivity(
      decode({
        ...base,
        type: "dynamic_tool",
        toolName: "Tool",
        input: {},
        output: { text: '"\\🦊'.repeat(20_000), authToken: "private" },
      }),
    );
    if (dynamic.type !== "dynamic_tool") return assert.fail("Expected dynamic tool");
    assert.isAtMost(Buffer.byteLength(JSON.stringify(dynamic.output)), ACP_TOOL_OUTPUT_BYTES);
    assert.notInclude(JSON.stringify(dynamic.output), "private");
    assert.deepEqual(normalizeAcpToolActivity(dynamic), dynamic);
  });

  it("keeps bounded live diffs and typed search results", () => {
    const large = '🦊\\"'.repeat(20_000);
    for (const detail of [
      { type: "file_change", fileName: "a.ts", diffStr: large, oldStr: large, newStr: large },
      {
        type: "file_search",
        results: Array.from({ length: 30 }, () => ({ fileName: "a.ts", preview: large })),
      },
      {
        type: "web_search",
        results: Array.from({ length: 30 }, () => ({ url: "https://example.com", snippet: large })),
      },
    ]) {
      const normalized = normalizeAcpToolActivity(decode({ ...base, ...detail }));
      assert.deepEqual(decode(normalized), normalized);
      if (normalized.type === "file_change") {
        assert.isAtMost(
          Buffer.byteLength(
            JSON.stringify({
              diffStr: normalized.diffStr,
              oldStr: normalized.oldStr,
              newStr: normalized.newStr,
            }),
          ),
          ACP_TOOL_OUTPUT_BYTES,
        );
        assert.isNotEmpty(normalized.diffStr);
      } else if (normalized.type === "file_search" || normalized.type === "web_search") {
        assert.isAtMost(
          Buffer.byteLength(JSON.stringify(normalized.results)),
          ACP_TOOL_OUTPUT_BYTES,
        );
        assert.isNotEmpty(normalized.results);
      } else return assert.fail("Expected diff or search results");
      assert.deepEqual(normalizeAcpToolActivity(normalized), normalized);
    }
  });
});
