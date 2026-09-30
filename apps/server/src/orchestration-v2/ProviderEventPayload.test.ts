import { describe, expect, it, vi } from "@effect/vitest";

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
        expect(Buffer.byteLength(JSON.stringify(item.output))).toBeLessThanOrEqual(65_536);
        expect(Buffer.byteLength(JSON.stringify(item.input))).toBeLessThanOrEqual(16_384);
      }
    },
  );

  it("keeps task links readable above the tool-summary parser's text allowance", () => {
    const output = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ padding: "o".repeat(70_000), threadId: "child", taskId: "task" }),
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
    expect(Buffer.byteLength(JSON.stringify(item.output))).toBeLessThanOrEqual(65_536);
    expect(Buffer.byteLength(JSON.stringify(item.input))).toBeLessThanOrEqual(16_384);
  });

  it("preserves a small completed result with one content read and no metadata pass", () => {
    let reads = 0;
    const text = JSON.stringify({ body: "x".repeat(1024), threadId: "child", taskId: "task" });
    const output = {
      content: [
        new Proxy(
          { type: "text", text },
          {
            get(target, key, receiver) {
              if (key === "text") reads++;
              return Reflect.get(target, key, receiver);
            },
          },
        ),
      ],
      isError: false,
    };
    const event = decodeEvent({
      type: "turn_item.updated",
      driver: "codex",
      turnItem: {
        ...base,
        type: "dynamic_tool",
        toolName: "task_create",
        input: {},
        output: null,
      },
    });
    if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
      throw new Error("Expected dynamic tool");
    const result = sanitizeProviderEvent({ ...event, turnItem: { ...event.turnItem, output } });
    expect(result).toMatchObject({
      turnItem: { output: { content: [{ type: "text", text }], isError: false } },
    });
    expect(reads).toBe(1);
  });

  it("bounds reads of 200,000 content blocks while retaining the known links and flag", () => {
    let reads = 0;
    const content = new Proxy(
      Array.from({ length: 200_000 }, (_, index) => ({
        type: "text",
        text: index === 0 ? '{"threadId":"child","taskId":"task"}' : '{"a":1}',
      })),
      {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const event = decodeEvent({
      type: "turn_item.updated",
      driver: "codex",
      turnItem: {
        ...base,
        type: "dynamic_tool",
        toolName: "task_create",
        input: {},
        output: null,
      },
    });
    if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
      throw new Error("Expected dynamic tool");
    const result = sanitizeProviderEvent({
      ...event,
      turnItem: { ...event.turnItem, output: { content, isError: true } },
    });
    if (result.type !== "turn_item.updated" || result.turnItem.type !== "dynamic_tool")
      throw new Error("Expected dynamic tool");
    expect(reads).toBeLessThan(4096);
    expect(compactDynamicToolOutput(result.turnItem.output)).toEqual({
      threadId: "child",
      taskId: "task",
      isError: true,
    });
    expect(Buffer.byteLength(JSON.stringify(result.turnItem.output))).toBeLessThanOrEqual(65_536);
  });

  it("skips parsing huge JSON text and retains its envelope metadata ahead of the preview", () => {
    const output = {
      content: [{ type: "text", text: JSON.stringify({ padding: "x".repeat(16 * 1024 * 1024) }) }],
      threadId: "child",
      taskId: "task",
      isError: true,
    };
    const parse = vi.spyOn(JSON, "parse");
    try {
      const item = sanitize({
        ...base,
        type: "dynamic_tool",
        toolName: "task_create",
        input: {},
        output,
      });
      if (item.type !== "dynamic_tool") throw new Error("Expected dynamic tool");
      expect(parse).not.toHaveBeenCalled();
      expect(compactDynamicToolOutput(item.output)).toEqual({
        threadId: "child",
        taskId: "task",
        isError: true,
      });
      expect(Buffer.byteLength(JSON.stringify(item.output))).toBeLessThanOrEqual(65_536);
    } finally {
      parse.mockRestore();
    }
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

// Expected values captured from ticket 35's isSensitiveAcpField at 7246930db5.
const acpFieldCases = [
  ["max_tokens", false],
  ["token_count", false],
  ["tokenLimit", false],
  ["tokenizer", false],
  ["idToken", true],
  ["x-api-key", true],
  ["accessTokens", true],
  ["passwordHint", false],
  ["maxTokens", false],
  ["inputTokens", true],
  ["total_secrets", false],
  ["tokens", true],
  ["secrets", true],
  ["passwords", true],
  ["apiKeys", true],
  ["api_keys", true],
  ["access_key", true],
  ["accessKey", true],
  ["secretKey", true],
  ["secret_key", true],
  ["token_type", false],
  ["api_key_id", false],
  ["privateKeyPath", false],
  ["authorizationUrl", false],
  ["cookieJar", false],
  ["ssoTokenId", false],
  ["ApiKeyHeader", false],
  ["passwordType", false],
  ["secret_name", false],
  ["Authorization", true],
  ["Cookie", true],
  ["Set-Cookie", true],
  ["password", true],
  ["passwd", true],
  ["clientSecret", true],
  ["GITHUB_TOKEN", true],
  ["sessionToken", true],
  ["AWS_SECRET_ACCESS_KEY", true],
  ["privateKey", true],
  ["X-Auth-Token", true],
  ["monkey", false],
  ["keyboard", false],
  ["author", false],
  ["secretary", false],
] as const;

describe("ACP redaction parity", () => {
  it.each(acpFieldCases)("matches ACP for %s (sensitive=%s)", (name, sensitive) => {
    const value = { [name]: "v" };
    const expected = { [name]: sensitive ? "[REDACTED]" : "v" };
    expect(boundProviderToolResult(value)).toEqual(expected);
    for (const status of ["running", "completed"] as const) {
      const item = sanitize({
        ...base,
        type: "dynamic_tool",
        toolName: "test",
        status,
        input: value,
        output: value,
      });
      expect(item).toMatchObject({ input: expected, output: expected });
      expect(sanitize(item)).toEqual(item);
    }
  });

  it.each([
    [
      "headerObjects",
      {
        headers: [
          { name: "Authorization", value: "Bearer abc" },
          { name: "x-api-key", value: "k" },
          { name: "Accept", value: "json" },
        ],
      },
      {
        headers: [
          { name: "Authorization", value: "[REDACTED]" },
          { name: "x-api-key", value: "[REDACTED]" },
          { name: "Accept", value: "json" },
        ],
      },
    ],
    [
      "headerTuples",
      {
        headers: [
          ["Authorization", "Bearer abc"],
          ["x-api-key", "k"],
          ["Accept", "json"],
        ],
      },
      {
        headers: [
          ["Authorization", "[REDACTED]"],
          ["x-api-key", "[REDACTED]"],
          ["Accept", "json"],
        ],
      },
    ],
    [
      "requestHeadersTuples",
      {
        requestHeaders: [
          ["Cookie", "c=1"],
          ["accessTokens", "t"],
        ],
      },
      {
        requestHeaders: [
          ["Cookie", "[REDACTED]"],
          ["accessTokens", "[REDACTED]"],
        ],
      },
    ],
    [
      "bareTuples",
      { args: [["Authorization", "Bearer abc"]] },
      { args: [["Authorization", "Bearer abc"]] },
    ],
    [
      "countPair",
      [
        { name: "max_tokens", value: 4096 },
        { name: "passwordHint", value: "first pet" },
        { key: "accessTokens", value: "x" },
      ],
      [
        { name: "max_tokens", value: 4096 },
        { name: "passwordHint", value: "first pet" },
        { key: "accessTokens", value: "[REDACTED]" },
      ],
    ],
    [
      "headerObjectMap",
      { headers: { Authorization: "Bearer abc", "x-api-key": "k", Accept: "json" } },
      { headers: { Authorization: "[REDACTED]", "x-api-key": "[REDACTED]", Accept: "json" } },
    ],
  ])("matches ACP's header and pair fixture %s", (_name, value, expected) => {
    expect(boundProviderToolResult(value)).toEqual(expected);
    expect(boundProviderToolResult(expected)).toEqual(expected);
  });

  it("recognizes only complete two-string tuples in headers and suffix Headers fields", () => {
    const pairs = [
      ["Authorization", "hidden"],
      ["Cookie", 3],
      ["Authorization", "one", "two"],
    ];
    const redacted = [
      ["Authorization", "[REDACTED]"],
      ["Cookie", 3],
      ["Authorization", "one", "two"],
    ];
    expect(
      boundProviderToolResult({
        HEADERS: pairs,
        responseHeaders: pairs,
        responseheaders: pairs,
        args: pairs,
      }),
    ).toEqual({
      HEADERS: redacted,
      responseHeaders: redacted,
      responseheaders: pairs,
      args: pairs,
    });
    expect(boundProviderToolResult(["Authorization", "hidden"])).toEqual([
      "Authorization",
      "hidden",
    ]);
  });

  it.each(["max", "min", "total", "num", "count"])(
    "keeps %s plural quantities across word spellings",
    (quantity) => {
      for (const plural of [
        "authorizations",
        "cookies",
        "credentials",
        "passwords",
        "passwds",
        "secrets",
        "tokens",
      ]) {
        const names = [
          `${quantity}_${plural}`,
          `${quantity}-${plural}`,
          `${quantity}${plural[0]!.toUpperCase()}${plural.slice(1)}`,
          `__${quantity.toUpperCase()}_${plural.toUpperCase()}__`,
        ];
        const value = Object.fromEntries(names.map((name) => [name, 10]));
        expect(boundProviderToolResult(value)).toEqual(value);
      }
    },
  );
});

describe("bounded live tool data", () => {
  it("preserves optional undefined fields and typed result property order on the wire", () => {
    const value = {
      present: "kept",
      optional: undefined,
      nested: { value: undefined },
      array: [undefined],
    };
    expect(JSON.stringify(boundProviderToolResult(value))).toBe(JSON.stringify(value));
    const baseEvent = decodeEvent({
      type: "turn_item.updated",
      driver: "acp",
      turnItem: {
        ...base,
        status: "running",
        type: "file_change",
        fileName: "a.ts",
        changes: [],
      },
    });
    if (baseEvent.type !== "turn_item.updated" || baseEvent.turnItem.type !== "file_change")
      throw new Error("Expected file change");
    const event = {
      ...baseEvent,
      turnItem: {
        ...baseEvent.turnItem,
        changes: [{ path: "a.ts", operation: "modify", oldPath: undefined }],
      },
    };
    expect(JSON.stringify(sanitizeProviderEvent(event))).toBe(JSON.stringify(event));
  });
  it("preserves ACP's exact running diff envelope independently of path metadata", () => {
    const value = {
      ...base,
      status: "running",
      type: "file_change",
      fileName: "a.ts",
      diffStr: "x".repeat(16_384 - 14),
      changes: [{ operation: "modify", path: "a.ts" }],
    };
    expect(Buffer.byteLength(JSON.stringify({ diffStr: value.diffStr }))).toBe(16_384);
    const event = decodeEvent({ type: "turn_item.updated", driver: "acp", turnItem: value });
    expect(JSON.stringify(sanitizeProviderEvent(event))).toBe(JSON.stringify(event));
  });

  it("preserves queries above 4 KiB and the exact 16 KiB query array", () => {
    const pattern = "q".repeat(8000);
    const patterns = ["q".repeat(16_384 - 4)];
    expect(Buffer.byteLength(JSON.stringify(patterns))).toBe(16_384);
    for (const value of [
      { ...base, status: "running", type: "file_search", pattern },
      { ...base, status: "running", type: "web_search", patterns },
    ]) {
      const event = decodeEvent({ type: "turn_item.updated", driver: "acp", turnItem: value });
      expect(JSON.stringify(sanitizeProviderEvent(event))).toBe(JSON.stringify(event));
    }
  });

  it("keeps a nested failure even when the outer envelope has isError false", () => {
    const output = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            padding: "x".repeat(70_000),
            threadId: "child",
            taskId: "task",
            isError: true,
          }),
        },
      ],
      isError: false,
    };
    const item = sanitize({ ...base, type: "dynamic_tool", toolName: "mcp", input: {}, output });
    if (item.type !== "dynamic_tool") throw new Error("Expected dynamic tool");
    expect(compactDynamicToolOutput(item.output)).toEqual({
      threadId: "child",
      taskId: "task",
      isError: true,
    });
    expect(item.output).toMatchObject({ isError: true });
  });
  it.each([
    [
      "running dynamic output",
      {
        ...base,
        status: "running",
        type: "dynamic_tool",
        toolName: "mcp",
        input: { blob: "x".repeat(10_000) },
        output: { progress: "step 3 of 9" },
      },
    ],
    [
      "exact 16 KiB input",
      {
        ...base,
        status: "running",
        type: "dynamic_tool",
        toolName: "mcp",
        input: { blob: "y".repeat(16_384 - 11) },
      },
    ],
    [
      "ACP input envelope",
      {
        ...base,
        status: "running",
        type: "dynamic_tool",
        toolName: "mcp",
        input: {
          command: "ls",
          truncated: true,
          limitBytes: 16_384,
          preview: `{"blob":"${"x".repeat(16_000)}…`,
        },
      },
    ],
    [
      "running command output",
      {
        ...base,
        status: "running",
        type: "command_execution",
        input: "echo progress",
        output: "line\n".repeat(100),
      },
    ],
    [
      "exact 16 KiB running output",
      {
        ...base,
        status: "running",
        type: "command_execution",
        input: "echo",
        output: "y".repeat(16_384 - 2),
      },
    ],
    [
      "final command",
      {
        ...base,
        type: "command_execution",
        input: "GITHUB_TOKEN=ghp_abc echo secret",
        output: "done",
      },
    ],
    [
      "JSON inside code",
      {
        ...base,
        type: "dynamic_tool",
        toolName: "mcp",
        input: { code: 'const data = {"password":"literal"};' },
        output: { content: [{ type: "text", text: '{"secret":"literal"}' }] },
      },
    ],
    [
      "separate final budgets",
      {
        ...base,
        type: "dynamic_tool",
        toolName: "mcp",
        input: { q: "i".repeat(12_000) },
        output: { text: "o".repeat(60_000) },
      },
    ],
    [
      "usage counts",
      {
        ...base,
        type: "dynamic_tool",
        toolName: "mcp",
        input: {},
        output: { token_count: 12, tokenLimit: 99, max_tokens: 5, inputTokens: "[REDACTED]" },
      },
    ],
    [
      "running .env diff",
      {
        ...base,
        status: "running",
        type: "file_change",
        fileName: ".env",
        diffStr: "+GITHUB_TOKEN=literal",
        changes: [],
      },
    ],
    [
      "final .env diff",
      {
        ...base,
        type: "file_change",
        fileName: ".env",
        diffStr: "+AWS_SECRET_ACCESS_KEY=literal",
        oldStr: "old",
        newStr: "new",
      },
    ],
    [
      "running file search",
      {
        ...base,
        status: "running",
        type: "file_search",
        pattern: "foo",
        results: [{ fileName: "a.ts", line: 3, preview: "foo()" }],
      },
    ],
    [
      "running web search",
      {
        ...base,
        status: "running",
        type: "web_search",
        patterns: ["foo"],
        results: [{ url: "https://example.com", title: "Example", snippet: "foo" }],
      },
    ],
  ])("leaves already-normalized %s bytes unchanged", (_name, value) => {
    const event = decodeEvent({ type: "turn_item.updated", driver: "acp", turnItem: value });
    expect(JSON.stringify(sanitizeProviderEvent(event))).toBe(JSON.stringify(event));
  });

  it.each(["running", "completed", "failed", "interrupted", "cancelled"] as const)(
    "applies the 16 KiB limit to the input itself at %s",
    (status) => {
      const input = { blob: "x".repeat(16_384 - 11) };
      expect(Buffer.byteLength(JSON.stringify(input))).toBe(16_384);
      const item = sanitize({
        ...base,
        status,
        type: "dynamic_tool",
        toolName: "mcp",
        input,
        output: { text: "y".repeat(12_000) },
      });
      expect(item).toMatchObject({ input });
    },
  );

  it("keeps the latest command output tail within 16 KiB, with whole redaction marks", () => {
    const output = `${"界\\\u0000[REDACTED]".repeat(5000)}latest progress`;
    const item = sanitize({
      ...base,
      status: "running",
      type: "command_execution",
      input: "echo",
      output,
    });
    if (item.type !== "command_execution" || item.output === undefined)
      throw new Error("Expected command output");
    expect(Buffer.byteLength(JSON.stringify(item.output))).toBeLessThanOrEqual(16_384);
    expect(item.output).toMatch(/^…/);
    expect(item.output.endsWith("latest progress")).toBe(true);
    expect(output.endsWith(item.output.slice(1))).toBe(true);
    expect(item.output.replaceAll("[REDACTED]", "")).not.toMatch(/REDACTED|REDACT|ACTED\]/);
  });
});
