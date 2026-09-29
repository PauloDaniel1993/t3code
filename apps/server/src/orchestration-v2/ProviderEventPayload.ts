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

/**
 * Tool payload limits apply before persistence and before live fan-out, including
 * runless artifacts. They do not modify the provider's own context. Messages,
 * reasoning, errors and approval/input requests are never clipped or redacted.
 * Named credential fields (including environment/header names) are redacted by
 * structure. Text only redacts literal credential formats, literal sensitive
 * environment assignments, JSON string fields and Authorization header lines.
 * Ordinary identifiers, expressions and prose such as `token = getToken()` pass
 * through unchanged. This is not a general secret detector.
 *
 * Final tool data has a shared 64 KiB encoded JSON budget, including keys and
 * escaping. Titles/names/paths use 4 KiB; command arguments use 16 KiB. Running
 * dynamic input uses 4 KiB so its purpose remains visible, with no output.
 * Search queries share 16 KiB, with 4 KiB per query: normal questions survive.
 * Traversal charges every inspected field; JS own-key enumeration, adapter
 * decoding and the incoming raw object are outside this allocation guarantee.
 */
export const PROVIDER_TOOL_DETAIL_BYTES = 4 * 1024;
export const PROVIDER_TOOL_INPUT_BYTES = 16 * 1024;
export const PROVIDER_TOOL_RESULT_BYTES = 64 * 1024;
export const PROVIDER_SEARCH_QUERY_BYTES = 16 * 1024;
const SENSITIVE_FIELD =
  /(?:^|[_-])(?:authorization|cookie|credentials?|password|secret|token|(?:access|refresh)[_-]?token|(?:api|private)[_-]?key|secret[_-]access[_-]key|client[_-]secret)$/i;
const JSON_SECRET =
  /("(?:[^"\\]*[_-])?(?:authorization|cookie|credentials?|password|secret|token|(?:access|refresh)[_-]?token|(?:api|private)[_-]?key|secret[_-]access[_-]key|client[_-]secret)"\s*:\s*)"(?:\\.|[^"\\])*(?:"|$)/giu;
const ENV_SECRET =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|SECRET_ACCESS_KEY|API_KEY|PRIVATE_KEY))=("(?:\\.|[^"\\])*"|'[^']*'|[^\s;]+)/gu;

function redactText(value: string): string {
  if (!/["=]|sk-|gh[pousr]_|github_pat_|AKIA|authorization:/iu.test(value)) return value;
  return value
    .replace(JSON_SECRET, '$1"[REDACTED]"')
    .replace(ENV_SECRET, (match, name: string, literal: string) =>
      /[$`]/u.test(literal) ? match : `${name}=[REDACTED]`,
    )
    .replace(
      /^(\s*[+-]?\s*Authorization:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9+/_=.-]{8,}/gimu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{3,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/gu,
      "[REDACTED]",
    );
}

/** Includes JSON escaping; only materializes a bounded prefix of large text. */
function boundedString(value: string, maxBytes: number): string {
  const prefix = value.slice(0, maxBytes + 1024);
  const redacted = redactText(prefix);
  // Six bytes per UTF-16 unit covers JSON escaping and UTF-8 without encoding
  // the usual short title/argument strings on the shared pump.
  if (prefix.length === value.length && redacted.length * 6 + 2 <= maxBytes) return redacted;
  if (prefix.length === value.length && Buffer.byteLength(JSON.stringify(redacted)) <= maxBytes)
    return redacted;
  if (maxBytes < 5) return "";
  let low = 0;
  let high = Math.min(redacted.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(`${redacted.slice(0, middle)}…`)) <= maxBytes)
      low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(redacted[low - 1]!)) low -= 1;
  return `${redacted.slice(0, low)}…`;
}

/** Iterative cloning preserves every JSON value that fits, including deep arrays. */
export function boundProviderToolResult(
  value: unknown,
  maxBytes = PROVIDER_TOOL_RESULT_BYTES,
): unknown {
  let remaining = maxBytes;
  let inspected = maxBytes;
  const ancestors = new WeakSet<object>();
  type Container = unknown[] | Record<string, unknown>;
  type Frame = { source: object; target: Container; keys: Iterator<string>; count: number };
  const stack: Frame[] = [];
  function* keys(source: object): Generator<string> {
    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i++) yield String(i);
    } else {
      for (const key in source) yield key;
    }
  }
  const visit = (current: unknown): unknown => {
    if (Predicate.isString(current)) {
      const text = boundedString(current, remaining);
      remaining -= Buffer.byteLength(JSON.stringify(text));
      return text;
    }
    if (current === null || Predicate.isBoolean(current) || Predicate.isNumber(current)) {
      remaining -= Buffer.byteLength(JSON.stringify(current));
      return current;
    }
    if ((!Array.isArray(current) && !Predicate.isObject(current)) || ancestors.has(current)) {
      remaining -= 4;
      return null;
    }
    const target: Container = Array.isArray(current) ? [] : {};
    remaining -= 2;
    ancestors.add(current);
    stack.push({ source: current, target, keys: keys(current), count: 0 });
    return target;
  };
  const result = visit(value);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (remaining < 1 || inspected <= 0) {
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    const next = frame.keys.next();
    if (next.done) {
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    inspected -= 1;
    const key = next.value;
    if (!Object.hasOwn(frame.source, key)) continue;
    const isArray = Array.isArray(frame.target);
    // An oversized key exhausts this collection's allowance without reading its value.
    if (!isArray && key.length > remaining) {
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    const cost =
      (frame.count > 0 ? 1 : 0) + (isArray ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
    if (cost + 1 > remaining) {
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    const current =
      !isArray && SENSITIVE_FIELD.test(key) ? "[REDACTED]" : Reflect.get(frame.source, key);
    const minimum = Predicate.isString(current)
      ? 2
      : (Array.isArray(current) || Predicate.isObject(current)) && !ancestors.has(current)
        ? 2
        : current === null || (!Predicate.isNumber(current) && !Predicate.isBoolean(current))
          ? 4
          : Buffer.byteLength(JSON.stringify(current));
    if (cost + minimum > remaining) {
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    remaining -= cost;
    const child = visit(current);
    Object.defineProperty(frame.target, key, {
      value: child,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    frame.count += 1;
  }
  return result;
}

const decodeFileChange = Schema.decodeUnknownOption(OrchestrationV2FileChangeDetail);
const decodeFileSearchResult = Schema.decodeUnknownOption(OrchestrationV2FileSearchResult);
const decodeWebSearchResult = Schema.decodeUnknownOption(OrchestrationV2WebSearchResult);
function boundedResults<A>(values: unknown, decode: (value: unknown) => Option.Option<A>): A[] {
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
  const final = isFinal(item);
  const title = item.title === null ? null : boundedString(item.title, PROVIDER_TOOL_DETAIL_BYTES);
  switch (item.type) {
    case "dynamic_tool": {
      const { input, output, ...detail } = item;
      const result = boundProviderToolResult(
        { input, ...(final && output !== undefined ? { output } : {}) },
        final ? PROVIDER_TOOL_RESULT_BYTES : PROVIDER_TOOL_DETAIL_BYTES,
      );
      return {
        ...detail,
        title,
        toolName:
          item.toolName === null ? null : boundedString(item.toolName, PROVIDER_TOOL_DETAIL_BYTES),
        input: Predicate.isObject(result) ? (result.input ?? null) : null,
        ...(final && Predicate.isObject(result) && "output" in result
          ? { output: result.output }
          : {}),
      };
    }
    case "command_execution": {
      const { output, ...detail } = item;
      return {
        ...detail,
        title,
        input: boundedString(item.input, PROVIDER_TOOL_INPUT_BYTES),
        ...(final && output !== undefined
          ? { output: boundedString(output, PROVIDER_TOOL_RESULT_BYTES) }
          : {}),
      };
    }
    case "file_change": {
      const { diffStr, oldStr, newStr, changes, ...detail } = item;
      const result = final
        ? boundProviderToolResult({
            ...(changes === undefined ? {} : { changes }),
            ...(diffStr === undefined ? {} : { diffStr }),
            ...(oldStr === undefined ? {} : { oldStr }),
            ...(newStr === undefined ? {} : { newStr }),
          })
        : null;
      return {
        ...detail,
        title,
        fileName: boundedString(item.fileName, PROVIDER_TOOL_DETAIL_BYTES),
        ...(Predicate.isObject(result)
          ? {
              ...(Predicate.isString(result.diffStr) ? { diffStr: result.diffStr } : {}),
              ...(Predicate.isString(result.oldStr) ? { oldStr: result.oldStr } : {}),
              ...(Predicate.isString(result.newStr) ? { newStr: result.newStr } : {}),
              ...(Array.isArray(result.changes)
                ? { changes: boundedResults(result.changes, decodeFileChange) }
                : {}),
            }
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
          ? { results: boundedResults(boundProviderToolResult(results), decodeFileSearchResult) }
          : {}),
      };
    }
    case "web_search": {
      const { results, patterns, ...detail } = item;
      const queries: string[] = [];
      let remaining = PROVIDER_SEARCH_QUERY_BYTES - 2;
      for (const pattern of patterns ?? []) {
        if (remaining < 8) break;
        const query = boundedString(pattern, Math.min(PROVIDER_TOOL_DETAIL_BYTES, remaining - 1));
        queries.push(query);
        remaining -= Buffer.byteLength(JSON.stringify(query)) + 1;
      }
      return {
        ...detail,
        title,
        ...(patterns === undefined ? {} : { patterns: queries }),
        ...(final && results !== undefined
          ? { results: boundedResults(boundProviderToolResult(results), decodeWebSearchResult) }
          : {}),
      };
    }
    default:
      return item;
  }
}
const sanitizedEvents = new WeakMap<ProviderAdapterV2Event, ProviderAdapterV2Event>();
/** Cached per immutable adapter event, so fan-out does not repeat the traversal. */
export function sanitizeProviderEvent(event: ProviderAdapterV2Event): ProviderAdapterV2Event {
  if (event.type !== "turn_item.updated") return event;
  switch (event.turnItem.type) {
    case "command_execution":
    case "dynamic_tool":
    case "file_change":
    case "file_search":
    case "web_search":
      break;
    default:
      return event;
  }
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
