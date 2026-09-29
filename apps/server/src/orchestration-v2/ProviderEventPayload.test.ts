import { describe, expect, it } from "@effect/vitest";

import * as DateTime from "effect/DateTime";

import * as Schema from "effect/Schema";

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

  it("redacts escaped JSON secrets as complete strings and leaves valid JSON", () => {
    const text = JSON.stringify({
      password: 'prefix"REVIEW_SECRET_SUFFIX\\tail',
      message: 'keep "quotes"',
    });

    const result = boundProviderToolResult(text);

    expect(result).toBe(JSON.stringify({ password: "[REDACTED]", message: 'keep "quotes"' }));

    expect(JSON.parse(String(result))).toEqual({
      password: "[REDACTED]",
      message: 'keep "quotes"',
    });

    expect(boundProviderToolResult('{"password":"' + "hidden".repeat(20_000))).toBe(
      '{"password":"[REDACTED]"\u2026',
    );
  });

  it.each(["source", "shell", "json", "diff"])(
    "redacts specific credentials in %s containers",
    (container) => {
      const secrets = ["ghp_abc", "sk-abcdefghijklmnop1234", "AKIA1234567890ABCDEF"];

      const body = secrets.join(" ");

      const text =
        container === "json"
          ? JSON.stringify({ text: body, password: 'prefix"suffix' })
          : container === "shell"
            ? `export GITHUB_TOKEN=ghp_abc AWS_SECRET_ACCESS_KEY=xyz\n${body}`
            : container === "diff"
              ? `+const key = "${body}";`
              : `const key = "${body}";`;

      const result = String(boundProviderToolResult(text));

      for (const secret of secrets) expect(result).not.toContain(secret);

      expect(result).not.toContain("prefix");

      if (container === "shell") expect(result).not.toContain("=xyz");
    },
  );

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
