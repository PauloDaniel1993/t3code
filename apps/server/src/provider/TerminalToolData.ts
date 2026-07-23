import type { TerminalToolDataTruncationEnvelope } from "@t3tools/contracts";

const TRUNCATION_ENVELOPE_RESERVE_BYTES = 256;
const TRUNCATION_SUFFIX = "…";

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) {
    return value;
  }

  const suffix = Buffer.from(TRUNCATION_SUFFIX, "utf8");
  const contentLimit = Math.max(0, maximumBytes - suffix.byteLength);
  let end = Math.min(contentLimit, encoded.byteLength);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${encoded.subarray(0, end).toString("utf8")}${TRUNCATION_SUFFIX}`;
}

export function boundTerminalToolData(data: unknown, maximumBytes: number): unknown {
  if (data === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(data);
    if (serialized === undefined) {
      throw new TypeError("Terminal tool data is not JSON serializable");
    }
    const originalBytes = Buffer.byteLength(serialized, "utf8");
    if (originalBytes <= maximumBytes) {
      return data;
    }

    const valueMaximumBytes = Math.max(0, maximumBytes - TRUNCATION_ENVELOPE_RESERVE_BYTES);
    return {
      _tag: "T3TerminalToolDataTruncated",
      encoding: "json",
      value: truncateUtf8(serialized, valueMaximumBytes),
      truncated: true,
      originalBytes,
    } satisfies TerminalToolDataTruncationEnvelope;
  } catch {
    return {
      _tag: "T3TerminalToolDataTruncated",
      encoding: "json",
      value: "[Unserializable terminal tool data omitted]",
      truncated: true,
      originalBytes: 0,
    } satisfies TerminalToolDataTruncationEnvelope;
  }
}
