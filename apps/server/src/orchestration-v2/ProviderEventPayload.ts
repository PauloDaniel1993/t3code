import {
  OrchestrationV2FileChangeDetail,
  OrchestrationV2FileSearchResult,
  OrchestrationV2WebSearchResult,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";

import type { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

/**
 * Tool payload limits apply before persistence and before live fan-out, including
 * runless artifacts. They do not modify the provider's own context. Messages,
 * reasoning, errors and approval/input requests are never clipped or redacted.
 * Split names at camelCase/acronym boundaries and separators, ignore case, and
 * match only the last word (authorization, cookie, credential, password, passwd,
 * secret, token) or pair (api/private/secret/access key), including plurals.
 * A plural preceded by max, min, total, num or count denotes a quantity and stays
 * intact. Name/value and key/value objects use the same rule; two-string tuples
 * count only inside headers or *Headers fields. Free text (source, commands,
 * diffs and JSON strings) is never searched. A command secret is stored as written.
 * Redaction is idempotent and preserves ACP's already-redacted values.
 *
 * Final tool output has its own 64 KiB encoded JSON budget, including keys and
 * escaping; input retains its own 16 KiB at every status. Only a truncated output
 * needs metadata recovery: at most 64 content blocks, 128 envelope nodes, four
 * levels and 1 MiB of JSON text are inspected. Larger text is never parsed whole.
 * Task/thread links and the error flag take priority over a large result preview.
 * Nesting beyond 128 containers becomes
 * "[TRUNCATED: depth limit]" so the store's native JSON encoder can persist it.
 * Titles/names/paths use 4 KiB; command arguments use 16 KiB. Running
 * output uses 16 KiB to match ACP; command output keeps the latest tail.
 * File-change text and path descriptors have separate running budgets, so the
 * text envelope ACP already bounded is not charged for its path metadata again.
 * Search queries share 16 KiB of input, including their array but no field wrapper.
 * Traversal charges every inspected field; JS own-key enumeration, adapter
 * decoding and the incoming raw object are outside this allocation guarantee.
 */
export const PROVIDER_TOOL_DETAIL_BYTES = 4 * 1024;
export const PROVIDER_TOOL_INPUT_BYTES = 16 * 1024;
export const PROVIDER_TOOL_RUNNING_OUTPUT_BYTES = 16 * 1024;
export const PROVIDER_TOOL_RESULT_BYTES = 64 * 1024;
export const PROVIDER_SEARCH_QUERY_BYTES = 16 * 1024;
export const PROVIDER_TOOL_RESULT_MAX_DEPTH = 128;
const SENSITIVE_FIELD =
  /(?:^|_)(?:authorizations?|cookies?|credentials?|passwords?|passwds?|secrets?|tokens?|(?:api|private|secret|access)_keys?)$/;
const QUANTITY_FIELD =
  /(?:^|_)(?:max|min|total|num|count)_(?:authorizations|cookies|credentials|passwords|passwds|secrets|tokens)$/;
function sensitiveField(key: string): boolean {
  // Common content/type/text fields need no word-splitting allocations on the pump.
  if (!/authorization|cookie|credential|password|passwd|secret|token|key/i.test(key)) return false;
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return SENSITIVE_FIELD.test(words) && !QUANTITY_FIELD.test(words);
}

function safeCut(value: string, index: number, tail: boolean): number {
  const marker = value.lastIndexOf("[REDACTED]", index);
  if (marker >= 0 && index > marker && index < marker + 10) index = tail ? marker + 10 : marker;
  if (tail && /[\uDC00-\uDFFF]/u.test(value[index] ?? "")) index += 1;
  if (!tail && /[\uD800-\uDBFF]/u.test(value[index - 1] ?? "")) index -= 1;
  return index;
}

/** Includes JSON escaping; only materializes a bounded prefix of large text. */
function boundedString(value: string, maxBytes: number, tail = false): string {
  const prefix = tail ? value.slice(-(maxBytes + 1024)) : value.slice(0, maxBytes + 1024);
  // Six bytes per UTF-16 unit covers JSON escaping and UTF-8 without encoding
  // the usual short title/argument strings on the shared pump.
  if (prefix.length === value.length && prefix.length * 6 + 2 <= maxBytes) return prefix;
  if (prefix.length === value.length && Buffer.byteLength(JSON.stringify(prefix)) <= maxBytes)
    return prefix;
  if (maxBytes < 5) return "";
  const slice = (length: number) =>
    tail ? `…${prefix.slice(prefix.length - length)}` : `${prefix.slice(0, length)}…`;
  let low = 0;
  let high = Math.min(prefix.length, maxBytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(slice(middle))) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  low = tail
    ? prefix.length - safeCut(prefix, prefix.length - low, true)
    : safeCut(prefix, low, false);
  // Copy UTF-16 units, including lone surrogates, out of any source-backed slice.
  return Buffer.from(slice(low), "utf16le").toString("utf16le");
}

/** Iterative cloning preserves JSON within the byte and persistence-safe depth limits. */
function boundToolResult(
  value: unknown,
  maxBytes = PROVIDER_TOOL_RESULT_BYTES,
): { value: unknown; truncated: boolean } {
  let remaining = maxBytes;
  let inspected = maxBytes;
  let truncated = false;
  const ancestors = new WeakSet<object>();
  type Container = unknown[] | Record<string, unknown>;
  type Frame = {
    source: object;
    target: Container;
    keys: Iterator<string>;
    count: number;
    sensitivePair: boolean;
    headerPairs: boolean;
  };
  const stack: Frame[] = [];
  function* keys(source: object): Generator<string> {
    if (Array.isArray(source)) {
      for (let i = 0; i < source.length; i++) yield String(i);
    } else {
      for (const key in source) yield key;
    }
  }
  const visit = (current: unknown, headerPairs = false): unknown => {
    if (Predicate.isString(current)) {
      const text = boundedString(current, remaining);
      if (text !== current) truncated = true;
      remaining -= Buffer.byteLength(JSON.stringify(text));
      return text;
    }
    if (current === null || Predicate.isBoolean(current) || Predicate.isNumber(current)) {
      remaining -= Buffer.byteLength(JSON.stringify(current));
      return current;
    }
    if ((!Array.isArray(current) && !Predicate.isObject(current)) || ancestors.has(current)) {
      truncated = true;
      remaining -= 4;
      return null;
    }
    if (stack.length >= PROVIDER_TOOL_RESULT_MAX_DEPTH) {
      truncated = true;
      return visit("[TRUNCATED: depth limit]");
    }
    const target: Container = Array.isArray(current) ? [] : {};
    remaining -= 2;
    ancestors.add(current);
    const sensitivePair = Array.isArray(current)
      ? headerPairs &&
        current.length === 2 &&
        typeof current[0] === "string" &&
        typeof current[1] === "string" &&
        sensitiveField(current[0])
      : Object.getOwnPropertyNames(current).some((key) => {
          if (!/^(?:name|key)$/i.test(key)) return false;
          const name = Reflect.get(current, key);
          return Predicate.isString(name) && sensitiveField(name);
        });
    stack.push({
      source: current,
      target,
      keys: keys(current),
      count: 0,
      sensitivePair,
      headerPairs,
    });
    return target;
  };
  const result = visit(value);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.keys.next();
    if (next.done) {
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    if (remaining < 1 || inspected <= 0) {
      truncated = true;
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
      truncated = true;
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    const cost =
      (frame.count > 0 ? 1 : 0) + (isArray ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
    if (cost + 1 > remaining) {
      truncated = true;
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    const current =
      (!isArray && sensitiveField(key)) ||
      (frame.sensitivePair && (isArray ? key === "1" : /^value$/i.test(key)))
        ? "[REDACTED]"
        : Reflect.get(frame.source, key);
    // JSON omits these object fields; optional adapter fields must not become null.
    if (
      !isArray &&
      (current === undefined || typeof current === "function" || typeof current === "symbol")
    )
      continue;
    const minimum = Predicate.isString(current)
      ? 2
      : (Array.isArray(current) || Predicate.isObject(current)) && !ancestors.has(current)
        ? 2
        : current === null || (!Predicate.isNumber(current) && !Predicate.isBoolean(current))
          ? 4
          : Buffer.byteLength(JSON.stringify(current));
    if (cost + minimum > remaining) {
      truncated = true;
      stack.pop();
      ancestors.delete(frame.source);
      continue;
    }
    remaining -= cost;
    const child = visit(
      current,
      isArray ? frame.headerPairs : /^headers$/i.test(key) || key.endsWith("Headers"),
    );
    Object.defineProperty(frame.target, key, {
      value: child,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    frame.count += 1;
  }
  return { value: result, truncated };
}

/** Iterative cloning within the encoded byte and persistence-safe depth limits. */
export function boundProviderToolResult(
  value: unknown,
  maxBytes = PROVIDER_TOOL_RESULT_BYTES,
): unknown {
  return boundToolResult(value, maxBytes).value;
}

/** Only recover known summary fields after truncation, within one shared read budget. */
function criticalToolResult(
  value: unknown,
  budget = { bytes: 1024 * 1024, nodes: 128, blocks: 64 },
  depth = 0,
): Record<string, unknown> | undefined {
  if (depth > 4 || budget.nodes-- <= 0) return undefined;
  if (Predicate.isString(value)) {
    // Length rejects large text without encoding or parsing its full allocation.
    if (value.length > budget.bytes) return undefined;
    const bytes = Buffer.byteLength(value);
    if (bytes > budget.bytes) return undefined;
    budget.bytes -= bytes;
    try {
      return criticalToolResult(JSON.parse(value), budget, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    let result: Record<string, unknown> | undefined;
    for (let index = 0; index < value.length && budget.blocks > 0 && budget.nodes > 0; index++) {
      budget.blocks -= 1;
      const block: unknown = value[index];
      const child = criticalToolResult(
        Predicate.isObject(block) ? block.text : undefined,
        budget,
        depth + 1,
      );
      if (child !== undefined) {
        const failed = child.isError === true || result?.isError === true;
        result = Object.assign(child, result);
        if (failed) result.isError = true;
      }
    }
    return result;
  }
  if (!Predicate.isObject(value)) return undefined;
  const content = value.structuredContent ?? value.content;
  const nested = content === undefined ? undefined : criticalToolResult(content, budget, depth + 1);
  const compact = compactDynamicToolOutput({
    threadId: value.threadId,
    messageId: value.messageId,
    taskId: value.taskId,
    scheduledTaskId: value.scheduledTaskId,
    thread: value.thread,
    threads: value.threads,
    status: value.status,
  });
  const flag =
    value.isError === true ||
    value.is_error === true ||
    value.error != null ||
    value._tag === "OrchestratorMcpFailure" ||
    nested?.isError === true
      ? true
      : Predicate.isBoolean(value.isError)
        ? value.isError
        : nested?.isError;
  const result = { ...compact, ...nested, ...(flag === undefined ? {} : { isError: flag }) };
  return Object.keys(result).length === 0 ? undefined : result;
}

const isFileChange = Schema.is(OrchestrationV2FileChangeDetail);
const isFileSearchResult = Schema.is(OrchestrationV2FileSearchResult);
const isWebSearchResult = Schema.is(OrchestrationV2WebSearchResult);
function boundedResults<A>(values: unknown, is: (value: unknown) => value is A): A[] {
  return Array.isArray(values) ? values.filter(is) : [];
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
      const { input, output } = item;
      let result =
        output === undefined
          ? undefined
          : boundToolResult(
              output,
              final ? PROVIDER_TOOL_RESULT_BYTES : PROVIDER_TOOL_RUNNING_OUTPUT_BYTES,
            );
      if (final && result?.truncated) {
        const critical = criticalToolResult(output);
        if (critical !== undefined)
          result = boundToolResult({ ...critical, preview: result.value });
      }
      return {
        ...item,
        title,
        toolName:
          item.toolName === null ? null : boundedString(item.toolName, PROVIDER_TOOL_DETAIL_BYTES),
        input: boundProviderToolResult(input, PROVIDER_TOOL_INPUT_BYTES) ?? null,
        ...(result === undefined ? {} : { output: result.value }),
      };
    }
    case "command_execution": {
      const { output } = item;
      return {
        ...item,
        title,
        input: boundedString(item.input, PROVIDER_TOOL_INPUT_BYTES),
        ...(output !== undefined
          ? {
              output: boundedString(
                output,
                final ? PROVIDER_TOOL_RESULT_BYTES : PROVIDER_TOOL_RUNNING_OUTPUT_BYTES,
                !final,
              ),
            }
          : {}),
      };
    }
    case "file_change": {
      const { diffStr, oldStr, newStr, changes } = item;
      const result = boundProviderToolResult(
        {
          ...(final && changes !== undefined ? { changes } : {}),
          ...(diffStr === undefined ? {} : { diffStr }),
          ...(oldStr === undefined ? {} : { oldStr }),
          ...(newStr === undefined ? {} : { newStr }),
        },
        final ? PROVIDER_TOOL_RESULT_BYTES : PROVIDER_TOOL_RUNNING_OUTPUT_BYTES,
      );
      const bounded = {
        ...item,
        title,
        fileName: boundedString(item.fileName, PROVIDER_TOOL_DETAIL_BYTES),
      };
      for (const key of ["diffStr", "oldStr", "newStr"] as const) {
        const text = Predicate.isObject(result) ? result[key] : undefined;
        if (Predicate.isString(text)) bounded[key] = text;
        else delete bounded[key];
      }
      const boundedChanges =
        final && Predicate.isObject(result)
          ? result.changes
          : changes === undefined
            ? undefined
            : boundProviderToolResult(changes, PROVIDER_TOOL_RUNNING_OUTPUT_BYTES);
      if (Array.isArray(boundedChanges))
        bounded.changes = boundedResults(boundedChanges, isFileChange);
      else delete bounded.changes;
      return bounded;
    }
    case "file_search": {
      const { results } = item;
      return {
        ...item,
        title,
        ...(item.pattern === undefined
          ? {}
          : { pattern: boundedString(item.pattern, PROVIDER_TOOL_INPUT_BYTES) }),
        ...(results !== undefined
          ? {
              results: boundedResults(
                boundProviderToolResult(
                  results,
                  final ? PROVIDER_TOOL_RESULT_BYTES : PROVIDER_TOOL_RUNNING_OUTPUT_BYTES,
                ),
                isFileSearchResult,
              ),
            }
          : {}),
      };
    }
    case "web_search": {
      const { results, patterns } = item;
      const queries: string[] = [];
      let remaining = PROVIDER_SEARCH_QUERY_BYTES - 2;
      for (const pattern of patterns ?? []) {
        const separator = queries.length > 0 ? 1 : 0;
        if (remaining - separator < 2) break;
        const query = boundedString(pattern, remaining - separator);
        queries.push(query);
        remaining -= Buffer.byteLength(JSON.stringify(query)) + separator;
      }
      return {
        ...item,
        title,
        ...(patterns === undefined ? {} : { patterns: queries }),
        ...(results !== undefined
          ? {
              results: boundedResults(
                boundProviderToolResult(
                  results,
                  final ? PROVIDER_TOOL_RESULT_BYTES : PROVIDER_TOOL_RUNNING_OUTPUT_BYTES,
                ),
                isWebSearchResult,
              ),
            }
          : {}),
      };
    }
    default:
      return item;
  }
}
/** Sanitize once in the runtime before fan-out to subscriber stages. */
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
  return { ...event, turnItem: sanitizeToolItem(event.turnItem) };
}
