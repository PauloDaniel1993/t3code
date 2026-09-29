import {
  OrchestrationV2FileChangeDetail,
  OrchestrationV2FileSearchResult,
  OrchestrationV2WebSearchResult,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

export const PROVIDER_TOOL_DETAIL_BYTES = 4 * 1024;
export const PROVIDER_TOOL_RESULT_BYTES = 64 * 1024;
const SENSITIVE_FIELD =
  /^(authorization|cookie|credential|password|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key)$/i;
const MAX_ENTRIES = 200;
const MAX_DEPTH = 12;

function redactText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/giu, "$1 [REDACTED]")
    .replace(
      /(["'](?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /(\b(?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]");
}

/** Bound allocation as well as encoded size, including JSON string escaping. */
function boundedString(value: string, maxBytes: number): string {
  const redacted = redactText(value.slice(0, maxBytes + 1024));
  if (value.length <= maxBytes && Buffer.byteLength(JSON.stringify(redacted)) <= maxBytes) {
    return redacted;
  }
  let low = 0;
  let high = Math.min(redacted.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(`${redacted.slice(0, middle)}…`)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  // Never cut a surrogate pair.
  if (low > 0 && /[\uD800-\uDBFF]/u.test(redacted[low - 1]!)) low -= 1;
  return `${redacted.slice(0, low)}…`;
}

/** Only walk a bounded prefix of provider-controlled collections; never stringify raw output. */
export function boundProviderToolResult(value: unknown): unknown {
  let remaining = PROVIDER_TOOL_RESULT_BYTES;
  let entries = MAX_ENTRIES;
  const seen = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (remaining < 32 || entries-- <= 0 || depth >= MAX_DEPTH) {
      remaining -= 4;
      return null;
    }
    if (Predicate.isString(current)) {
      const text = boundedString(current, Math.max(32, remaining - 16));
      remaining -= Buffer.byteLength(JSON.stringify(text));
      return text;
    }
    if (current === null || Predicate.isBoolean(current) || Predicate.isNumber(current)) {
      remaining -= Buffer.byteLength(JSON.stringify(current));
      return current;
    }
    if (!Predicate.isObject(current)) {
      remaining -= 4;
      return null;
    }
    if (seen.has(current)) {
      remaining -= 4;
      return null;
    }
    seen.add(current);
    remaining -= 2;
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      for (const entry of current) {
        if (remaining < 32 || entries <= 0) break;
        remaining -= 1;
        result.push(visit(entry, depth + 1));
      }
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (remaining < 64 || entries <= 0) break;
      // Oversized keys are detail too; omit them rather than rename an object field.
      if (key.length > PROVIDER_TOOL_DETAIL_BYTES) continue;
      const keyBytes = Buffer.byteLength(JSON.stringify(key)) + 2;
      if (keyBytes + 32 > remaining) break;
      remaining -= keyBytes;
      Object.defineProperty(result, key, {
        value: visit(SENSITIVE_FIELD.test(key) ? "[REDACTED]" : current[key], depth + 1),
        enumerable: true,
      });
    }
    return result;
  };
  return visit(value, 0);
}

const FileResult = Schema.Struct({
  diffStr: Schema.optional(Schema.String),
  oldStr: Schema.optional(Schema.String),
  newStr: Schema.optional(Schema.String),
  changes: Schema.optional(Schema.Array(OrchestrationV2FileChangeDetail)),
});
const decodeFileResult = Schema.decodeUnknownOption(FileResult);
const decodeFileSearchResult = Schema.decodeUnknownOption(OrchestrationV2FileSearchResult);
const decodeWebSearchResult = Schema.decodeUnknownOption(OrchestrationV2WebSearchResult);

function boundedSearchResults<A>(
  values: unknown,
  decode: (value: unknown) => Option.Option<A>,
): A[] {
  return Array.isArray(values) ? values.flatMap((value) => Option.toArray(decode(value))) : [];
}

function isFinal(item: OrchestrationV2TurnItem): boolean {
  return (
    item.status === "completed" ||
    item.status === "failed" ||
    item.status === "cancelled" ||
    item.status === "interrupted"
  );
}

function sanitizeToolItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  const title = item.title === null ? null : boundedString(item.title, PROVIDER_TOOL_DETAIL_BYTES);
  const final = isFinal(item);
  switch (item.type) {
    case "dynamic_tool": {
      const { input, output, ...detail } = item;
      const result = final
        ? boundProviderToolResult({ ...(output === undefined ? {} : { output }), input })
        : null;
      return {
        ...detail,
        title,
        toolName:
          item.toolName === null ? null : boundedString(item.toolName, PROVIDER_TOOL_DETAIL_BYTES),
        input: Predicate.isObject(result) ? (result.input ?? null) : null,
        ...(Predicate.isObject(result) && "output" in result ? { output: result.output } : {}),
      };
    }
    case "command_execution": {
      const { output, ...detail } = item;
      return {
        ...detail,
        title,
        input: boundedString(item.input, PROVIDER_TOOL_DETAIL_BYTES),
        ...(final && output !== undefined
          ? { output: boundedString(output, PROVIDER_TOOL_RESULT_BYTES) }
          : {}),
      };
    }
    case "file_change": {
      const { diffStr, oldStr, newStr, changes, ...detail } = item;
      return {
        ...detail,
        title,
        fileName: boundedString(item.fileName, PROVIDER_TOOL_DETAIL_BYTES),
        ...(final
          ? Option.getOrElse(
              decodeFileResult(
                boundProviderToolResult({
                  ...(diffStr === undefined ? {} : { diffStr }),
                  ...(oldStr === undefined ? {} : { oldStr }),
                  ...(newStr === undefined ? {} : { newStr }),
                  ...(changes === undefined ? {} : { changes }),
                }),
              ),
              () => ({}),
            )
          : {}),
      };
    }
    case "file_search": {
      const { results, ...detail } = item;
      return {
        ...detail,
        title,
        ...(item.pattern === undefined
          ? {}
          : { pattern: boundedString(item.pattern, PROVIDER_TOOL_DETAIL_BYTES) }),
        ...(final && results !== undefined
          ? {
              results: boundedSearchResults(
                boundProviderToolResult(results),
                decodeFileSearchResult,
              ),
            }
          : {}),
      };
    }
    case "web_search": {
      const { results, patterns, ...detail } = item;
      return {
        ...detail,
        title,
        ...(patterns === undefined
          ? {}
          : {
              patterns: patterns
                .slice(0, MAX_ENTRIES)
                .map((pattern) => boundedString(pattern, PROVIDER_TOOL_DETAIL_BYTES / MAX_ENTRIES)),
            }),
        ...(final && results !== undefined
          ? {
              results: boundedSearchResults(
                boundProviderToolResult(results),
                decodeWebSearchResult,
              ),
            }
          : {}),
      };
    }
    default:
      return item;
  }
}

const sanitizedEvents = new WeakMap<ProviderAdapterV2Event, ProviderAdapterV2Event>();

/** Sanitize once before fan-out, so runless tool artifacts and every subscriber get the same limits. */
export function sanitizeProviderEvent(event: ProviderAdapterV2Event): ProviderAdapterV2Event {
  const cached = sanitizedEvents.get(event);
  if (cached) return cached;
  const sanitized =
    event.type === "turn_item.updated"
      ? { ...event, turnItem: sanitizeToolItem(event.turnItem) }
      : event;
  sanitizedEvents.set(event, sanitized);
  sanitizedEvents.set(sanitized, sanitized);
  return sanitized;
}
