import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import * as Predicate from "effect/Predicate";

const sensitiveField =
  /^(authorization|cookies?|credentials?|password|passwd|secret|token|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key)$/i;
const protocolFields = new Set(["rawInput", "rawOutput", "_meta", "meta"]);

function redactText(text: string, secrets: ReadonlyArray<string> = []): string {
  for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
  return text
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;]+)/gi,
      "$1[REDACTED]",
    );
}

/** Redacts ACP protocol wrappers only after command, path, and MCP identity extraction. */
export function secretSafeAcpActivity(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  secrets: ReadonlyArray<string> = [],
): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (!Predicate.isObjectOrArray(value)) return value;
  if (depth >= 12 || seen.has(value)) return "[REDACTED]";
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => secretSafeAcpActivity(entry, seen, depth + 1, secrets))
    : Object.fromEntries(
        Object.entries(value).flatMap(([key, entry]) =>
          protocolFields.has(key)
            ? []
            : [
                [
                  key,
                  sensitiveField.test(key)
                    ? "[REDACTED]"
                    : secretSafeAcpActivity(entry, seen, depth + 1, secrets),
                ],
              ],
        ),
      );
  seen.delete(value);
  return result;
}

function activitySecrets(value: unknown, seen = new WeakSet<object>(), depth = 0): Array<string> {
  if (!Predicate.isObjectOrArray(value) || depth >= 12 || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, entry]) =>
    sensitiveField.test(key) && typeof entry === "string" && entry.length > 0
      ? [entry]
      : activitySecrets(entry, seen, depth + 1),
  );
}

/** In-progress items carry presentation only; final results retain their typed V2 shape. */
export function normalizeAcpToolActivity(
  item: OrchestrationV2TurnItem,
  toolCall?: AcpToolCallState,
): OrchestrationV2TurnItem {
  const secrets = [...new Set(activitySecrets(toolCall?.data))];
  const text = (value: string) => redactText(value, secrets);
  const terminal =
    item.status === "completed" ||
    item.status === "failed" ||
    item.status === "interrupted" ||
    item.status === "cancelled";
  const title = item.title === null ? null : text(item.title);
  switch (item.type) {
    case "dynamic_tool": {
      const { output, ...presentation } = item;
      return {
        ...presentation,
        title,
        toolName: item.toolName === null ? null : text(item.toolName),
        input: {},
        ...(terminal && output !== undefined
          ? { output: secretSafeAcpActivity(output, new WeakSet(), 0, secrets) }
          : {}),
      };
    }
    case "command_execution": {
      const { output, ...presentation } = item;
      return {
        ...presentation,
        title,
        input: text(item.input),
        ...(terminal && output !== undefined ? { output: text(output) } : {}),
      };
    }
    case "file_change": {
      const { diffStr, oldStr, newStr, ...presentation } = item;
      return {
        ...presentation,
        title,
        fileName: text(item.fileName),
        ...(item.changes === undefined
          ? {}
          : {
              changes: item.changes.map((change) => ({
                ...change,
                path: text(change.path),
                ...(change.oldPath === undefined ? {} : { oldPath: text(change.oldPath) }),
              })),
            }),
        ...(terminal && diffStr !== undefined ? { diffStr: text(diffStr) } : {}),
        ...(terminal && oldStr !== undefined ? { oldStr: text(oldStr) } : {}),
        ...(terminal && newStr !== undefined ? { newStr: text(newStr) } : {}),
      };
    }
    case "file_search": {
      const { results, ...presentation } = item;
      return {
        ...presentation,
        title,
        ...(item.pattern === undefined ? {} : { pattern: text(item.pattern) }),
        ...(terminal && results !== undefined
          ? {
              results: results.map(({ preview, ...result }) => ({
                ...result,
                fileName: text(result.fileName),
                ...(preview === undefined ? {} : { preview: text(preview) }),
              })),
            }
          : {}),
      };
    }
    case "web_search": {
      const { results, ...presentation } = item;
      return {
        ...presentation,
        title,
        ...(item.patterns === undefined ? {} : { patterns: item.patterns.map(text) }),
        ...(terminal && results !== undefined
          ? {
              results: results.map(({ snippet, ...result }) => ({
                ...result,
                ...(result.url === undefined ? {} : { url: text(result.url) }),
                ...(result.title === undefined ? {} : { title: text(result.title) }),
                ...(snippet === undefined ? {} : { snippet: text(snippet) }),
              })),
            }
          : {}),
      };
    }
    case "compaction":
      return {
        ...item,
        title,
        ...(item.summary === undefined ? {} : { summary: text(item.summary) }),
      };
    default:
      return item;
  }
}
