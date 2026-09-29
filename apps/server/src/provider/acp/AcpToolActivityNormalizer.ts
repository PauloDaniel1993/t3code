/**
 * Redacts credential values only by structured field name, never by searching
 * text or replacing a secret's value elsewhere. Source, commands, diffs, JSON
 * strings and other free text pass through unchanged. Redaction is idempotent.
 * Receives extracted tool arguments/results; preserves their non-secret fields.
 * Running results are omitted; terminal results keep their typed V2 shape.
 * Dynamic inputs retain redacted arguments at every status, up to 16 KiB of
 * encoded JSON. Larger inputs show a marked preview of that redacted JSON.
 */
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

const sensitiveField =
  /(?:^|[_-])(?:authorization|cookies?|credentials?|password|passwd|secret|token|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|private[_-]?key|secret[_-]access[_-]key)$/i;
export const ACP_TOOL_INPUT_BYTES = 16 * 1024;

export function secretSafeAcpActivity(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (!Predicate.isObjectOrArray(value)) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => secretSafeAcpActivity(entry, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          sensitiveField.test(key) ? "[REDACTED]" : secretSafeAcpActivity(entry, seen),
        ]),
      );
  seen.delete(value);
  return result;
}

function toolInput(value: unknown): unknown {
  const redacted = secretSafeAcpActivity(value);
  const serialized = JSON.stringify(redacted);
  if (serialized === undefined || Buffer.byteLength(serialized) <= ACP_TOOL_INPUT_BYTES)
    return redacted;
  const preview = (length: number) => ({
    truncated: true,
    limitBytes: ACP_TOOL_INPUT_BYTES,
    preview: `${serialized.slice(0, length)}…`,
  });
  let low = 0;
  let high = Math.min(serialized.length, ACP_TOOL_INPUT_BYTES);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(preview(middle))) <= ACP_TOOL_INPUT_BYTES) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/u.test(serialized[low - 1]!)) low -= 1;
  return preview(low);
}

export function normalizeAcpToolActivity(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  const terminal = ["completed", "failed", "interrupted", "cancelled"].includes(item.status);
  switch (item.type) {
    case "dynamic_tool": {
      const { output, ...presentation } = item;
      return {
        ...presentation,
        input: toolInput(item.input),
        ...(terminal && output !== undefined ? { output: secretSafeAcpActivity(output) } : {}),
      };
    }
    case "command_execution": {
      const { output, ...presentation } = item;
      return { ...presentation, ...(terminal && output !== undefined ? { output } : {}) };
    }
    case "file_change": {
      const { diffStr, oldStr, newStr, ...presentation } = item;
      return {
        ...presentation,
        ...(terminal && diffStr !== undefined ? { diffStr } : {}),
        ...(terminal && oldStr !== undefined ? { oldStr } : {}),
        ...(terminal && newStr !== undefined ? { newStr } : {}),
      };
    }
    case "file_search": {
      const { results, ...presentation } = item;
      return { ...presentation, ...(terminal && results !== undefined ? { results } : {}) };
    }
    case "web_search": {
      const { results, ...presentation } = item;
      return { ...presentation, ...(terminal && results !== undefined ? { results } : {}) };
    }
    default:
      return item;
  }
}
