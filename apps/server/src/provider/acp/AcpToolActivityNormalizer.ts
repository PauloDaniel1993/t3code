/**
 * Split field names at camelCase/acronym boundaries and separators, ignore case,
 * and redact values whose words contain authorization, cookie/cookies,
 * credential/credentials, password, passwd, secret, token, or the adjacent words
 * api key or private key. In name/value or key/value objects, redact the value
 * when the name or key follows the same rule. Replace sensitive values with
 * [REDACTED] idempotently and never search or rewrite free text.
 *
 * Inputs retain 16 KiB of encoded JSON at every status; oversized inputs keep
 * label fields (256 bytes each) beside a preview of the remaining redacted data.
 * Running output keeps 16 KiB, including JSON escaping, with the latest command
 * text at the tail. Final results retain upstream's shape and output bounds.
 */
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export const ACP_SENSITIVE_FIELD_WORDS =
  /(?:^|_)(?:authorization|cookies?|credentials?|password|passwd|secret|token|api_key|private_key)(?:_|$)/;
export const ACP_TOOL_INPUT_BYTES = 16 * 1024;
export const ACP_TOOL_OUTPUT_BYTES = 16 * 1024;
export const ACP_TOOL_LABEL_BYTES = 256;
const REDACTED = "[REDACTED]";
const LABEL_FIELDS = new Set([
  "path",
  "filePath",
  "file_path",
  "relativePath",
  "filename",
  "fileName",
  "newPath",
  "oldPath",
  "command",
  "cmd",
  "executable",
  "args",
  "query",
  "pattern",
  "searchTerm",
  "regex",
  "grep",
  "needle",
  "glob",
  "globPattern",
  "glob_pattern",
  "include",
  "filePattern",
  "file_pattern",
  "target_directory",
  "targetDirectory",
  "directory",
  "cwd",
  "root",
]);

export function isSensitiveAcpField(key: string): boolean {
  return ACP_SENSITIVE_FIELD_WORDS.test(
    key
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase(),
  );
}

export function secretSafeAcpActivity(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (!Predicate.isObjectOrArray(value)) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const entries = Array.isArray(value) ? [] : Object.entries(value);
  const sensitivePair =
    !Array.isArray(value) &&
    entries.some(
      ([key, entry]) =>
        /^(?:name|key)$/i.test(key) && typeof entry === "string" && isSensitiveAcpField(entry),
    );
  const result = Array.isArray(value)
    ? value.map((entry) => secretSafeAcpActivity(entry, seen))
    : Object.fromEntries(
        entries.map(([key, entry]) => [
          key,
          isSensitiveAcpField(key) || (sensitivePair && /^value$/i.test(key))
            ? REDACTED
            : secretSafeAcpActivity(entry, seen),
        ]),
      );
  seen.delete(value);
  return result;
}

/** Truncation may omit a mark, but never leave a partial mark or split a surrogate pair. */
function safeCut(value: string, index: number, tail = false): number {
  const marker = value.lastIndexOf(REDACTED, index);
  if (marker >= 0 && index > marker && index < marker + REDACTED.length)
    index = tail ? marker + REDACTED.length : marker;
  if (tail && /[\uDC00-\uDFFF]/u.test(value[index] ?? "")) index += 1;
  if (!tail && /[\uD800-\uDBFF]/u.test(value[index - 1] ?? "")) index -= 1;
  return index;
}

function boundedText(value: string, bytes: number, tail = false): string {
  if (Buffer.byteLength(JSON.stringify(value)) <= bytes) return value;
  const slice = (length: number) =>
    tail ? `…${value.slice(value.length - length)}` : `${value.slice(0, length)}…`;
  let low = 0;
  let high = Math.min(value.length, bytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(slice(middle))) <= bytes) low = middle;
    else high = middle - 1;
  }
  return tail
    ? `…${value.slice(safeCut(value, value.length - low, true))}`
    : `${value.slice(0, safeCut(value, low))}…`;
}

function boundedValue(value: unknown, bytes: number, labels = false, tail = false): unknown {
  if (typeof value === "string") return boundedText(value, bytes, tail);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) <= bytes) return value;
  const kept: Record<string, string> = {};
  const rest = Predicate.isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter(([key, entry]) => {
          if (!labels || !LABEL_FIELDS.has(key)) return true;
          const text =
            typeof entry === "string"
              ? entry
              : Array.isArray(entry) && entry.every((part) => typeof part === "string")
                ? entry.join(" ")
                : undefined;
          if (text === undefined) return true;
          kept[key] = boundedText(text, ACP_TOOL_LABEL_BYTES);
          return false;
        }),
      )
    : value;
  const remaining = JSON.stringify(rest);
  const preview = (length: number) => ({
    ...kept,
    truncated: true,
    limitBytes: bytes,
    preview: tail
      ? `…${remaining.slice(remaining.length - length)}`
      : `${remaining.slice(0, length)}…`,
  });
  let low = 0;
  let high = Math.min(remaining.length, bytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(preview(middle))) <= bytes) low = middle;
    else high = middle - 1;
  }
  low = tail
    ? remaining.length - safeCut(remaining, remaining.length - low, true)
    : safeCut(remaining, low);
  return preview(low);
}

function boundedResults<A>(results: ReadonlyArray<A>, bound: (entry: A) => A): ReadonlyArray<A> {
  if (Buffer.byteLength(JSON.stringify(results)) <= ACP_TOOL_OUTPUT_BYTES) return results;
  const kept: Array<A> = [];
  let bytes = 2;
  for (const entry of results) {
    const next = bound(entry);
    const size = Buffer.byteLength(JSON.stringify(next)) + (kept.length === 0 ? 0 : 1);
    if (bytes + size > ACP_TOOL_OUTPUT_BYTES) break;
    kept.push(next);
    bytes += size;
  }
  return kept;
}

export function normalizeAcpToolActivity(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  const terminal = ["completed", "failed", "interrupted", "cancelled"].includes(item.status);
  switch (item.type) {
    case "dynamic_tool": {
      const { output, ...presentation } = item;
      return {
        ...presentation,
        input: boundedValue(secretSafeAcpActivity(item.input), ACP_TOOL_INPUT_BYTES, true),
        ...(output === undefined
          ? {}
          : {
              output: terminal
                ? secretSafeAcpActivity(output)
                : boundedValue(secretSafeAcpActivity(output), ACP_TOOL_OUTPUT_BYTES, false, true),
            }),
      };
    }
    case "command_execution": {
      const { output, ...presentation } = item;
      return {
        ...presentation,
        ...(output === undefined
          ? {}
          : {
              output: terminal ? output : boundedText(output, ACP_TOOL_OUTPUT_BYTES, true),
            }),
      };
    }
    case "file_change": {
      if (terminal) return item;
      const { diffStr, oldStr, newStr } = item;
      if (Buffer.byteLength(JSON.stringify({ diffStr, oldStr, newStr })) <= ACP_TOOL_OUTPUT_BYTES)
        return item;
      const bytes = Math.floor(
        (ACP_TOOL_OUTPUT_BYTES - 128) /
          [diffStr, oldStr, newStr].filter((text) => text !== undefined).length,
      );
      return {
        ...item,
        ...(diffStr === undefined ? {} : { diffStr: boundedText(diffStr, bytes) }),
        ...(oldStr === undefined ? {} : { oldStr: boundedText(oldStr, bytes) }),
        ...(newStr === undefined ? {} : { newStr: boundedText(newStr, bytes) }),
      };
    }
    case "file_search": {
      if (terminal || item.results === undefined) return item;
      return {
        ...item,
        results: boundedResults(item.results, (entry) => ({
          ...entry,
          fileName: boundedText(entry.fileName, ACP_TOOL_LABEL_BYTES),
          ...(entry.preview === undefined ? {} : { preview: boundedText(entry.preview, 4 * 1024) }),
        })),
      };
    }
    case "web_search": {
      if (terminal || item.results === undefined) return item;
      return {
        ...item,
        results: boundedResults(item.results, (entry) => ({
          ...(entry.url === undefined ? {} : { url: boundedText(entry.url, ACP_TOOL_LABEL_BYTES) }),
          ...(entry.title === undefined
            ? {}
            : { title: boundedText(entry.title, ACP_TOOL_LABEL_BYTES) }),
          ...(entry.snippet === undefined ? {} : { snippet: boundedText(entry.snippet, 4 * 1024) }),
        })),
      };
    }
    default:
      return item;
  }
}
