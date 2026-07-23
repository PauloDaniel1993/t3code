import { ThreadActivityAppendedPayload } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  deriveLegacyToolIdentity,
  stableLegacyToolActivityId,
} from "../orchestration/LegacyToolActivityIdentity.ts";
import { PROVIDER_EVENT_FLOW_CONTROL } from "../orchestration/ProviderEventFlowControl.ts";

export {
  deriveLegacyToolIdentity,
  isTerminalLegacyToolStatus,
  stableLegacyToolActivityId,
} from "../orchestration/LegacyToolActivityIdentity.ts";

const SUMMARY_MAX_BYTES = 1_024;
const decodeThreadActivityAppendedPayload = Schema.decodeUnknownSync(ThreadActivityAppendedPayload);

export type LegacyToolPayloadSkipReason =
  | "malformed-json"
  | "invalid-envelope"
  | "missing-turn"
  | "missing-tool-identity"
  | "ambiguous-tool-identity";

export type LegacyToolPayloadCompaction =
  | { readonly _tag: "ineligible" }
  | { readonly _tag: "skipped"; readonly reason: LegacyToolPayloadSkipReason }
  | {
      readonly _tag: "eligible";
      readonly compactedPayloadJson: string;
      readonly originalBytes: number;
      readonly compactedBytes: number;
      readonly reclaimedBytes: number;
      readonly stableActivityId: string;
      readonly logicalIdentity: string;
    };

const utf8ByteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (utf8ByteLength(value) <= maximumBytes) {
    return value;
  }
  const suffix = "\u2026";
  const suffixBytes = utf8ByteLength(suffix);
  let prefix = "";
  let prefixBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = utf8ByteLength(codePoint);
    if (prefixBytes + codePointBytes + suffixBytes > maximumBytes) {
      break;
    }
    prefix += codePoint;
    prefixBytes += codePointBytes;
  }
  return `${prefix}${suffix}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const optionalStringField = (
  payload: Record<string, unknown>,
  key: string,
): Record<string, string> => {
  const value = nonEmptyString(payload[key]);
  return value === undefined ? {} : { [key]: value };
};

const boundedLegacyToolPayload = (
  payload: Record<string, unknown>,
  toolId: string,
  stableActivityId: string,
) => {
  const detail = nonEmptyString(payload.detail);
  return {
    ...optionalStringField(payload, "itemType"),
    ...optionalStringField(payload, "provider"),
    ...optionalStringField(payload, "providerInstanceId"),
    toolUseId: toolId,
    ...optionalStringField(payload, "parentToolUseId"),
    ...optionalStringField(payload, "status"),
    ...(detail === undefined
      ? {}
      : {
          detail: truncateUtf8(detail, PROVIDER_EVENT_FLOW_CONTROL.intermediateToolDetailMaxBytes),
        }),
    compaction: {
      version: 1,
      stableActivityId,
    },
  };
};

export const compactLegacyToolSummary = (summary: string): string =>
  truncateUtf8(summary, SUMMARY_MAX_BYTES);

export const compactLegacyToolUpdateProjectionPayload = (input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly payloadJson: string;
}):
  | { readonly _tag: "skipped"; readonly reason: LegacyToolPayloadSkipReason }
  | {
      readonly _tag: "compacted";
      readonly payloadJson: string;
      readonly stableActivityId: string;
      readonly reclaimedBytes: number;
    } => {
  let unknownPayload: unknown;
  try {
    unknownPayload = JSON.parse(input.payloadJson);
  } catch {
    return { _tag: "skipped", reason: "malformed-json" };
  }
  const identity = deriveLegacyToolIdentity(unknownPayload);
  if (identity._tag === "skipped") {
    return identity;
  }
  if (!isRecord(unknownPayload)) {
    return { _tag: "skipped", reason: "missing-tool-identity" };
  }
  const stableActivityId = stableLegacyToolActivityId(
    input.threadId,
    input.turnId,
    identity.toolId,
    identity.providerIdentity,
  );
  const payloadJson = JSON.stringify(
    boundedLegacyToolPayload(unknownPayload, identity.toolId, stableActivityId),
  );
  return {
    _tag: "compacted",
    payloadJson,
    stableActivityId,
    reclaimedBytes: Math.max(
      0,
      Buffer.byteLength(input.payloadJson, "utf8") - Buffer.byteLength(payloadJson, "utf8"),
    ),
  };
};

export const compactLegacyToolUpdateEventPayload = (
  payloadJson: string,
): LegacyToolPayloadCompaction => {
  let unknownPayload: unknown;
  try {
    unknownPayload = JSON.parse(payloadJson);
  } catch {
    return { _tag: "skipped", reason: "malformed-json" };
  }

  let envelope: typeof ThreadActivityAppendedPayload.Type;
  try {
    envelope = decodeThreadActivityAppendedPayload(unknownPayload);
  } catch {
    return { _tag: "skipped", reason: "invalid-envelope" };
  }

  if (envelope.activity.kind !== "tool.updated") {
    return { _tag: "ineligible" };
  }
  if (envelope.activity.turnId === null) {
    return { _tag: "skipped", reason: "missing-turn" };
  }
  const payload = envelope.activity.payload;
  const identity = deriveLegacyToolIdentity(payload);
  if (identity._tag === "skipped") {
    return identity;
  }
  if (!isRecord(payload)) {
    return { _tag: "skipped", reason: "missing-tool-identity" };
  }

  const stableActivityId = stableLegacyToolActivityId(
    envelope.threadId,
    envelope.activity.turnId,
    identity.toolId,
    identity.providerIdentity,
  );
  const boundedPayload = boundedLegacyToolPayload(payload, identity.toolId, stableActivityId);
  const compactedPayloadJson = JSON.stringify({
    threadId: envelope.threadId,
    activity: {
      id: envelope.activity.id,
      tone: envelope.activity.tone,
      kind: envelope.activity.kind,
      summary: compactLegacyToolSummary(envelope.activity.summary),
      payload: boundedPayload,
      turnId: envelope.activity.turnId,
      ...(envelope.activity.sequence === undefined ? {} : { sequence: envelope.activity.sequence }),
      createdAt: envelope.activity.createdAt,
    },
  });
  const originalBytes = utf8ByteLength(payloadJson);
  const compactedBytes = utf8ByteLength(compactedPayloadJson);
  if (compactedBytes >= originalBytes) {
    return { _tag: "ineligible" };
  }

  return {
    _tag: "eligible",
    compactedPayloadJson,
    originalBytes,
    compactedBytes,
    reclaimedBytes: originalBytes - compactedBytes,
    stableActivityId,
    logicalIdentity: `${identity.providerIdentity ?? ""}\u0000${envelope.threadId}\u0000${envelope.activity.turnId}\u0000${identity.toolId}`,
  };
};
