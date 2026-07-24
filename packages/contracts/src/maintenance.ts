import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DatabaseMaintenancePhase = Schema.Literals([
  "idle",
  "estimating",
  "logical-compaction",
  "awaiting-restart",
  "preflight",
  "checkpointing",
  "vacuuming",
  "validating",
  "swapping",
  "starting",
  "rolling-back",
  "completed",
  "failed",
]);
export type DatabaseMaintenancePhase = typeof DatabaseMaintenancePhase.Type;

export const DatabaseMaintenanceEstimate = Schema.Struct({
  databaseBytes: NonNegativeInt,
  freePageBytes: NonNegativeInt,
  reclaimableEventPayloadBytes: NonNegativeInt,
  supersededProjectionBytes: NonNegativeInt,
  estimatedReclaimableBytes: NonNegativeInt,
  temporaryDiskRequiredBytes: NonNegativeInt,
  availableDiskBytes: Schema.optionalKey(NonNegativeInt),
  safetyWatermark: NonNegativeInt,
  eligibleEventCount: NonNegativeInt,
  eligibleProjectionCount: NonNegativeInt,
  recommended: Schema.Boolean,
  activeWorkBlockers: Schema.Array(TrimmedNonEmptyString),
});
export type DatabaseMaintenanceEstimate = typeof DatabaseMaintenanceEstimate.Type;

export const DatabaseMaintenanceProgress = Schema.Struct({
  phase: DatabaseMaintenancePhase,
  processedRows: NonNegativeInt,
  totalRows: NonNegativeInt,
  logicalBytesReclaimed: NonNegativeInt,
  physicalBytesBefore: Schema.optionalKey(NonNegativeInt),
  physicalBytesAfter: Schema.optionalKey(NonNegativeInt),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DatabaseMaintenanceProgress = typeof DatabaseMaintenanceProgress.Type;

export const DatabaseMaintenanceCompletion = Schema.Struct({
  beforeBytes: NonNegativeInt,
  afterBytes: NonNegativeInt,
  reclaimedBytes: NonNegativeInt,
  completedAt: IsoDateTime,
  rollbackRetained: Schema.Boolean,
});
export type DatabaseMaintenanceCompletion = typeof DatabaseMaintenanceCompletion.Type;

export const DatabaseMaintenanceFailureCode = Schema.Literals([
  "active-work",
  "active-writer",
  "insufficient-disk",
  "checkpoint-failed",
  "candidate-create-failed",
  "candidate-corrupt",
  "invariant-mismatch",
  "swap-failed",
  "rollback-failed",
  "startup-validation-failed",
  "unknown",
]);
export type DatabaseMaintenanceFailureCode = typeof DatabaseMaintenanceFailureCode.Type;

export const DatabaseMaintenanceFailure = Schema.Struct({
  code: DatabaseMaintenanceFailureCode,
  phase: DatabaseMaintenancePhase,
  message: TrimmedNonEmptyString,
  requiredBytes: Schema.optionalKey(NonNegativeInt),
  availableBytes: Schema.optionalKey(NonNegativeInt),
  recoverable: Schema.Boolean,
  failedAt: IsoDateTime,
});
export type DatabaseMaintenanceFailure = typeof DatabaseMaintenanceFailure.Type;
