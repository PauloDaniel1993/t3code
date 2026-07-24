import * as NodeCrypto from "node:crypto";

import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

export const deriveLegacyToolIdentity = (
  payload: unknown,
):
  | {
      readonly _tag: "identity";
      readonly toolId: string;
      readonly providerIdentity: string | undefined;
    }
  | {
      readonly _tag: "skipped";
      readonly reason: "missing-tool-identity" | "ambiguous-tool-identity";
    } => {
  if (!isRecord(payload)) {
    return { _tag: "skipped", reason: "missing-tool-identity" };
  }
  const candidates = [
    nonEmptyString(payload.toolUseId),
    nonEmptyString(payload.itemId),
    nonEmptyString(payload.taskId),
  ].filter((candidate): candidate is string => candidate !== undefined);
  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) {
    return { _tag: "skipped", reason: "missing-tool-identity" };
  }
  if (uniqueCandidates.length > 1) {
    return { _tag: "skipped", reason: "ambiguous-tool-identity" };
  }
  return {
    _tag: "identity",
    toolId: uniqueCandidates[0]!,
    providerIdentity:
      nonEmptyString(payload.providerInstanceId) ?? nonEmptyString(payload.provider),
  };
};

export const stableLegacyToolActivityId = (
  threadId: string,
  turnId: string,
  toolId: string,
  providerIdentity?: string,
): EventId =>
  EventId.make(
    `tool-activity:legacy:${NodeCrypto.createHash("sha256")
      .update(
        [...(providerIdentity === undefined ? [] : [providerIdentity]), threadId, turnId, toolId]
          .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
          .join("|"),
      )
      .digest("hex")
      .slice(0, 32)}`,
  );

export const compactedLegacyToolActivityId = (
  threadId: string,
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload" | "turnId">,
): EventId | undefined => {
  if (activity.kind !== "tool.updated" || activity.turnId === null || !isRecord(activity.payload)) {
    return undefined;
  }
  const identity = deriveLegacyToolIdentity(activity.payload);
  if (identity._tag === "skipped") {
    return undefined;
  }
  const marker = activity.payload.compaction;
  if (!isRecord(marker) || marker.version !== 1) {
    return undefined;
  }
  const expected = stableLegacyToolActivityId(
    threadId,
    activity.turnId,
    identity.toolId,
    identity.providerIdentity,
  );
  return marker.stableActivityId === expected ? expected : undefined;
};

export const isTerminalLegacyToolStatus = (payload: unknown): boolean => {
  if (!isRecord(payload)) {
    return false;
  }
  const status = nonEmptyString(payload.status)?.toLowerCase();
  return (
    status === "completed" ||
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "aborted" ||
    status === "declined" ||
    status === "interrupted" ||
    status === "stopped"
  );
};

export const isTerminalToolActivity = (
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): boolean =>
  activity.kind === "tool.completed" ||
  activity.kind === "tool.failed" ||
  (activity.kind.startsWith("tool.") && isTerminalLegacyToolStatus(activity.payload));
