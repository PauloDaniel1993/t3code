import { describe, expect, it } from "@effect/vitest";

import * as DateTime from "effect/DateTime";

import * as Schema from "effect/Schema";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";

import { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

import { boundProviderToolResult, sanitizeProviderEvent } from "./ProviderEventPayload.ts";

const now = DateTime.makeUnsafe("2026-09-29T00:00:00Z");

const base = {
  id: "tool",
  threadId: "thread",
  runId: "run",
  nodeId: null,

  providerThreadId: "pt",
  providerTurnId: "turn",
  nativeItemRef: null,

  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: "Tool",

  startedAt: now,
  completedAt: now,
  updatedAt: now,
} as const;

const decodeEvent = Schema.decodeUnknownSync(ProviderAdapterV2Event);
const isEvent = Schema.is(ProviderAdapterV2Event);

function sanitize(item: unknown) {
  const event = sanitizeProviderEvent(
    decodeEvent({ type: "turn_item.updated", driver: "codex", turnItem: item }),
  );

  if (event.type !== "turn_item.updated") throw new Error("Expected tool");

  return event.turnItem;
}

describe("provider payload preservation", () => {
  it("uses ACP's field words and name/value pairs without rewriting free text", () => {
    const value = {
      ssoTokenId: "hidden",
      "sso-token-id": "hidden",
      SSO_TOKEN_ID: "hidden",
      ApiKeyHeader: "hidden",
      passwordType: "hidden",
      monkey: "keep",
      tokenizer: "keep",
      pairs: [
        { NAME: "GitHubToken", VALUE: "hidden", description: "keep" },
        { Key: "PRIVATE_KEY", Value: "hidden" },
        { name: "PATH", value: "/bin" },
      ],
      command: 'GITHUB_TOKEN=ghp_abc echo "{\\"password\\":\\"literal\\"}"',
    };
    const expected = {
      ...value,
      ssoTokenId: "[REDACTED]",
      "sso-token-id": "[REDACTED]",
      SSO_TOKEN_ID: "[REDACTED]",
      ApiKeyHeader: "[REDACTED]",
      passwordType: "[REDACTED]",
      pairs: [
        { NAME: "GitHubToken", VALUE: "[REDACTED]", description: "keep" },
        { Key: "PRIVATE_KEY", Value: "[REDACTED]" },
        { name: "PATH", value: "/bin" },
      ],
    };
    expect(boundProviderToolResult(value)).toEqual(expected);
    expect(JSON.stringify(boundProviderToolResult(expected))).toBe(JSON.stringify(expected));
  });
  it("keeps task results ahead of oversized arguments", () => {
    const output = {
      content: [{ type: "text", text: JSON.stringify({ threadId: "child", taskId: "task" }) }],
      isError: true,
    };
    expect(
      sanitize({
        ...base,
        type: "dynamic_tool",
        toolName: "task_create",
        input: { prompt: "i".repeat(70_000) },
        output,
      }),
    ).toMatchObject({ output });
  });

  it.each([true, false])(
    "keeps links and the error flag when the result itself is oversized (%s)",
    (isError) => {
      const metadata = { threadId: "child", taskId: "task", isError };
      for (const output of [
        { padding: "o".repeat(70_000), ...metadata },
        {
          content: [
            { type: "text", text: JSON.stringify({ padding: "o".repeat(70_000), ...metadata }) },
          ],
          isError,
        },
      ]) {
        const item = sanitize({
          ...base,
          type: "dynamic_tool",
          toolName: "task_create",
          input: { prompt: "i".repeat(70_000) },
          output,
        });
        if (item.type !== "dynamic_tool") throw new Error("Expected dynamic tool");
        expect(compactDynamicToolOutput(item.output)).toEqual({
          threadId: "child",
          taskId: "task",
          ...(isError ? { isError: true } : {}),
        });
        expect(item.output).toMatchObject({ isError });
        expect(
          Buffer.byteLength(JSON.stringify({ input: item.input, output: item.output })),
        ).toBeLessThanOrEqual(65_536);
      }
    },
  );

  it("keeps task links readable above the tool-summary parser's text allowance", () => {
    const output = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ padding: "o".repeat(50_000), threadId: "child", taskId: "task" }),
        },
      ],
      isError: false,
    };
    const item = sanitize({
      ...base,
      type: "dynamic_tool",
      toolName: "task_create",
      input: { prompt: "i".repeat(70_000) },
      output,
    });
    if (item.type !== "dynamic_tool") throw new Error("Expected dynamic tool");
    expect(compactDynamicToolOutput(item.output)).toEqual({ threadId: "child", taskId: "task" });
    expect(item.output).toMatchObject({ isError: false });
    expect(
      Buffer.byteLength(JSON.stringify({ input: item.input, output: item.output })),
    ).toBeLessThanOrEqual(65_536);
  });

  it("marks nesting beyond the persistence-safe depth and preserves the shallow result", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 5_000; i++) deep = [deep];
    const result = boundProviderToolResult({ ok: true, deep });
    expect(JSON.stringify(result)).toContain("[TRUNCATED: depth limit]");
    expect(result).toMatchObject({ ok: true });
  });

  it("preserves a completed JSON result exactly at the encoded size cap", () => {
    const value = { body: "x".repeat(65_511), tail: [1, 2] };
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(65_535);
    expect(boundProviderToolResult(value)).toEqual(value);
  });
  it("preserves arrays, nested arrays, object arrays and shared references within the cap", () => {
    const shared = { paths: ["a.ts", "b.ts"] };

    const result = {
      rows: [[1, 2], [{ line: 3, names: ["foo", "bar"] }]],
      content: [{ type: "text", text: "hello" }],
      first: shared,
      second: shared,
      many: Array.from({ length: 500 }, (_, i) => i),
    };

    expect(boundProviderToolResult(result)).toEqual(result);

    const tool = sanitize({
      ...base,
      type: "dynamic_tool",
      toolName: "test",
      input: shared,
      output: result,
    });

    expect(tool).toMatchObject({ input: shared, output: result });

    expect(
      isEvent({
        type: "turn_item.updated",
        driver: "codex",
        turnItem: tool,
      }),
    ).toBe(true);
  });

  it("keeps file diffs and search result content", () => {
    const changes = [{ operation: "modify", path: "a.ts" }];

    expect(
      sanitize({
        ...base,
        type: "file_change",
        fileName: "a.ts",
        diffStr: "+foo()",
        oldStr: "old",
        newStr: "new",
        changes,
      }),
    ).toMatchObject({ changes, diffStr: "+foo()", oldStr: "old", newStr: "new" });

    const fileResults = [{ fileName: "a.ts", line: 3, preview: "foo()" }];

    expect(sanitize({ ...base, type: "file_search", results: fileResults })).toMatchObject({
      results: fileResults,
    });

    const webResults = [{ url: "https://example.com", snippet: "reference" }];

    expect(sanitize({ ...base, type: "web_search", results: webResults })).toMatchObject({
      results: webResults,
    });
  });

  it("keeps useful running inputs and ordinary web queries", () => {
    const query = "how to configure vite proxy for websockets";

    expect(
      sanitize({ ...base, status: "running", type: "web_search", patterns: [query] }),
    ).toMatchObject({ patterns: [query] });

    expect(
      sanitize({
        ...base,
        status: "running",
        type: "dynamic_tool",
        toolName: "search",
        input: { paths: ["src/a.ts"], query },
      }),
    ).toMatchObject({ input: { paths: ["src/a.ts"], query } });
  });

  it("retains a 16 KiB running input allowance to match ACP", () => {
    const input = { command: "echo " + "x".repeat(6_000) };
    expect(
      sanitize({ ...base, status: "running", type: "dynamic_tool", toolName: "shell", input }),
    ).toMatchObject({ input });
    const item = sanitize({
      ...base,
      status: "running",
      type: "dynamic_tool",
      toolName: "shell",
      input: { command: input.command.repeat(10) },
    });
    if (item.type !== "dynamic_tool") throw new Error("Expected dynamic tool");
    expect(Buffer.byteLength(JSON.stringify(item.input))).toBeLessThanOrEqual(16_384);
    expect(item.input).toMatchObject({ command: expect.stringContaining(input.command) });
  });

  it.each([
    "const token = getToken();\ninterface U { password: string }\nif (secret == null) {}\nheaders.Authorization = `Bearer ${key}`;",

    'git commit -m "fix token: refresh flow"\nexport GITHUB_TOKEN="$GITHUB_TOKEN"',

    JSON.stringify({
      message: 'a "quoted" string',
      path: "C:\\src\\file.ts",
      passwordType: "string",
    }),

    "@@ -1 +1 @@\n-const token = getToken();\n+const password: string = read();",
  ])("preserves ordinary source, commands, escaped JSON and diffs byte for byte: %s", (text) => {
    expect(boundProviderToolResult(text)).toBe(text);

    expect(
      sanitize({ ...base, type: "command_execution", input: text, output: text }),
    ).toMatchObject({ input: text, output: text });

    expect(
      sanitize({ ...base, type: "file_change", fileName: "a.ts", diffStr: text }),
    ).toMatchObject({ diffStr: text });
  });

  it("redacts structured environment/header/key fields without touching surrounding values", () => {
    expect(
      boundProviderToolResult({
        env: { GITHUB_TOKEN: "hidden-token", AWS_SECRET_ACCESS_KEY: "hidden-aws", PATH: "/bin" },
        headers: { Authorization: "hidden-auth", "X-API-Key": "hidden-key" },
        nested: [{ refresh_token: "hidden-refresh" }],
      }),
    ).toEqual({
      env: { GITHUB_TOKEN: "[REDACTED]", AWS_SECRET_ACCESS_KEY: "[REDACTED]", PATH: "/bin" },
      headers: { Authorization: "[REDACTED]", "X-API-Key": "[REDACTED]" },
      nested: [{ refresh_token: "[REDACTED]" }],
    });
  });

  it("preserves escaped JSON strings as free text", () => {
    const text = JSON.stringify({
      password: 'prefix"REVIEW_SECRET_SUFFIX\\tail',
      message: 'keep "quotes"',
    });

    const result = boundProviderToolResult(text);

    expect(result).toBe(text);

    expect(JSON.parse(String(result))).toEqual({
      password: 'prefix"REVIEW_SECRET_SUFFIX\\tail',
      message: 'keep "quotes"',
    });

    expect(String(boundProviderToolResult('{"password":"' + "hidden".repeat(20_000)))).toContain(
      "password",
    );
  });

  it.each(["source", "shell", "json", "diff"])(
    "preserves credential-looking free text in %s containers",
    (container) => {
      const secrets = ["ghp_abc", "sk-abcdefghijklmnop1234", "AKIA1234567890ABCDEF"];

      const body = secrets.join(" ");
      const credentials = {
        env: { GITHUB_TOKEN: "ghp_abc", AWS_SECRET_ACCESS_KEY: "xyz" },
        password: 'prefix"REVIEW_SECRET_SUFFIX\\tail',
        message: "keep this",
      };
      const embedded = JSON.stringify(credentials);

      const text =
        container === "json"
          ? JSON.stringify({ text: body, ...credentials })
          : container === "shell"
            ? `export GITHUB_TOKEN=ghp_abc AWS_SECRET_ACCESS_KEY=xyz\nprintf '%s' '${embedded}'\n${body}`
            : container === "diff"
              ? `+const key = "${body}";\n+const credentials = ${embedded};`
              : `const key = "${body}";\nconst credentials = ${embedded};`;

      const result = String(boundProviderToolResult(text));

      expect(result).toBe(text);
      expect(
        sanitize({ ...base, type: "command_execution", input: text, output: text }),
      ).toMatchObject({ input: result, output: result });
      expect(
        sanitize({ ...base, type: "file_change", fileName: "a.ts", diffStr: text }),
      ).toMatchObject({ diffStr: result });
    },
  );

  it("matches structured credential names across case and word separators idempotently", () => {
    const names = [
      "clientSecret",
      "CLIENT_SECRET",
      "client_secret",
      "client-secret",
      "githubToken",
      "GITHUB_TOKEN",
      "github-token",
      "authToken",
      "sessionToken",
      "dbPassword",
      "db_password",
      "db-password",
      "passwd",
      "Cookies",
      "API_KEY",
    ];
    const value = {
      nested: Object.fromEntries(names.map((name) => [name, "private value"])),
      description:
        'const GITHUB_TOKEN=process.env.GITHUB_TOKEN; curl -H "Authorization: Bearer secret" postgres://user:pw@host',
      passwordType: "string",
    };
    const expected = {
      ...value,
      nested: Object.fromEntries(names.map((name) => [name, "[REDACTED]"])),
      passwordType: "[REDACTED]",
    };
    expect(boundProviderToolResult(value)).toEqual(expected);
    expect(boundProviderToolResult(expected)).toEqual(expected);
  });

  it("charges oversized keys and bounds descriptor/value inspection", () => {
    const object = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, i) => [`${"k".repeat(4097)}${i}`, i]),
    );

    let inspected = 0;

    const observed = new Proxy(object, {
      getOwnPropertyDescriptor(target, key) {
        inspected++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const result = boundProviderToolResult(observed);

    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(65_536);

    expect(inspected).toBeLessThan(100);
  });
});
