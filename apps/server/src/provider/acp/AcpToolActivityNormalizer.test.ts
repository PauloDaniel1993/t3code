import { describe, expect, it } from "vite-plus/test";
import { TerminalToolDataTruncationEnvelope } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { normalizeAcpToolActivity } from "./AcpToolActivityNormalizer.ts";

const isTerminalToolDataTruncationEnvelope = Schema.is(TerminalToolDataTruncationEnvelope);

describe("normalizeAcpToolActivity", () => {
  it("omits full intermediate tool data and bounds presentation fields", () => {
    const normalized = normalizeAcpToolActivity(
      {
        toolCallId: "tool-1",
        status: "inProgress",
        title: "Run command",
        detail: "x".repeat(10_000),
        data: {
          rawInput: { command: "echo secret" },
          rawOutput: "x".repeat(100_000),
          content: [{ type: "text", text: "cumulative" }],
        },
      },
      {
        detailMaximumBytes: 1_024,
        terminalDataMaximumBytes: 4_096,
      },
    );

    expect(normalized.data).toBeUndefined();
    expect(Buffer.byteLength(normalized.detail ?? "", "utf8")).toBeLessThanOrEqual(1_028);
  });

  it("caps terminal output and redacts sensitive fields deterministically", () => {
    const toolCall = {
      toolCallId: "tool-1",
      status: "completed" as const,
      title: "Run command",
      detail: "Done",
      data: {
        rawInput: { apiKey: "input-secret" },
        rawOutput: {
          access_token: "output-secret",
          value: "x".repeat(20_000),
        },
      },
    };
    const first = normalizeAcpToolActivity(toolCall, {
      detailMaximumBytes: 1_024,
      terminalDataMaximumBytes: 4_096,
    });
    const second = normalizeAcpToolActivity(toolCall, {
      detailMaximumBytes: 1_024,
      terminalDataMaximumBytes: 4_096,
    });

    expect(first).toEqual(second);
    expect(isTerminalToolDataTruncationEnvelope(first.data)).toBe(true);
    if (!isTerminalToolDataTruncationEnvelope(first.data)) {
      return;
    }
    expect(first.data.value).toContain("[REDACTED]");
    expect(first.data.value).not.toContain("output-secret");
    expect(first.data.value).not.toContain("input-secret");
    expect(Buffer.byteLength(JSON.stringify(first.data), "utf8")).toBeLessThanOrEqual(4_096);
  });

  it("handles circular terminal output without leaking protocol input", () => {
    const circular: Record<string, unknown> = { result: "ok" };
    circular.self = circular;
    const normalized = normalizeAcpToolActivity(
      {
        toolCallId: "tool-1",
        status: "failed",
        data: {
          rawInput: { password: "never-store" },
          rawOutput: circular,
        },
      },
      {
        detailMaximumBytes: 1_024,
        terminalDataMaximumBytes: 4_096,
      },
    );

    expect(normalized.data).toEqual({
      rawOutput: {
        result: "ok",
        self: "[CIRCULAR]",
      },
    });
    expect(JSON.stringify(normalized.data)).not.toContain("never-store");
  });

  it("keeps small terminal data as a raw normalized object", () => {
    const normalized = normalizeAcpToolActivity(
      {
        toolCallId: "tool-1",
        status: "completed",
        data: {
          rawOutput: { exitCode: 0 },
        },
      },
      {
        detailMaximumBytes: 1_024,
        terminalDataMaximumBytes: 4_096,
      },
    );

    expect(normalized.data).toEqual({
      rawOutput: { exitCode: 0 },
    });
  });
});
