import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import { boundTerminalToolData } from "../TerminalToolData.ts";

export interface AcpNormalizedToolActivity {
  readonly title?: string;
  readonly detail?: string;
  readonly data?: unknown;
}

const SENSITIVE_FIELD_PATTERN =
  /^(authorization|cookie|credential|password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key)$/i;
const OMITTED_PROTOCOL_FIELDS = new Set(["rawInput", "toolCallId", "kind", "command"]);
const MAX_COLLECTION_ENTRIES = 200;
const MAX_NORMALIZATION_DEPTH = 12;

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) {
    return value;
  }

  let end = maximumBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${encoded.subarray(0, end).toString("utf8")}…`;
}

function normalizeSecretSafe(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth >= MAX_NORMALIZATION_DEPTH) {
    return "[DEPTH_LIMIT]";
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const entries = value
      .slice(0, MAX_COLLECTION_ENTRIES)
      .map((entry) => normalizeSecretSafe(entry, seen, depth + 1));
    if (value.length > MAX_COLLECTION_ENTRIES) {
      entries.push(`[${value.length - MAX_COLLECTION_ENTRIES} MORE ITEMS]`);
    }
    return entries;
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_COLLECTION_ENTRIES);
  for (const [key, entry] of entries) {
    if (OMITTED_PROTOCOL_FIELDS.has(key)) {
      continue;
    }
    result[key] = SENSITIVE_FIELD_PATTERN.test(key)
      ? "[REDACTED]"
      : normalizeSecretSafe(entry, seen, depth + 1);
  }
  if (Object.keys(value as object).length > MAX_COLLECTION_ENTRIES) {
    result._omittedFieldCount = Object.keys(value as object).length - MAX_COLLECTION_ENTRIES;
  }
  return result;
}

function terminalResultData(
  toolCall: AcpToolCallState,
  maximumBytes: number,
): AcpNormalizedToolActivity["data"] | undefined {
  const selected: Record<string, unknown> = {};
  for (const key of ["rawOutput", "content", "locations"] as const) {
    if (toolCall.data[key] !== undefined) {
      selected[key] = toolCall.data[key];
    }
  }
  if (Object.keys(selected).length === 0) {
    return undefined;
  }

  const normalized = normalizeSecretSafe(selected, new WeakSet(), 0);
  return boundTerminalToolData(normalized, maximumBytes);
}

export function normalizeAcpToolActivity(
  toolCall: AcpToolCallState,
  options: {
    readonly detailMaximumBytes: number;
    readonly terminalDataMaximumBytes: number;
  },
): AcpNormalizedToolActivity {
  const terminal = toolCall.status === "completed" || toolCall.status === "failed";
  const data = terminal
    ? terminalResultData(toolCall, options.terminalDataMaximumBytes)
    : undefined;
  return {
    ...(toolCall.title ? { title: truncateUtf8(toolCall.title, options.detailMaximumBytes) } : {}),
    ...(toolCall.detail
      ? { detail: truncateUtf8(toolCall.detail, options.detailMaximumBytes) }
      : {}),
    ...(data ? { data } : {}),
  };
}
