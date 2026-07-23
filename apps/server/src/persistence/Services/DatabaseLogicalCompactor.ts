import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface CompactEventBatchInput {
  readonly safetyWatermark: number;
  readonly cursor: number;
  readonly batchSize?: number;
}

export interface CompactEventBatchResult {
  readonly cursor: number;
  readonly scannedRows: number;
  readonly rewrittenRows: number;
  readonly skippedRows: number;
  readonly reclaimedBytes: number;
  readonly done: boolean;
}

export interface CompactProjectionBatchInput {
  readonly safetyWatermark: number;
  readonly cursor: number;
  readonly batchSize?: number;
}

export interface CompactProjectionBatchResult {
  readonly cursor: number;
  readonly scannedRows: number;
  readonly deletedRows: number;
  readonly skippedRows: number;
  readonly reclaimedBytes: number;
  readonly done: boolean;
}

export interface DatabaseLogicalCompactorShape {
  readonly compactEventBatch: (
    input: CompactEventBatchInput,
  ) => Effect.Effect<CompactEventBatchResult, ProjectionRepositoryError>;
  readonly compactProjectionBatch: (
    input: CompactProjectionBatchInput,
  ) => Effect.Effect<CompactProjectionBatchResult, ProjectionRepositoryError>;
}

export class DatabaseLogicalCompactor extends Context.Service<
  DatabaseLogicalCompactor,
  DatabaseLogicalCompactorShape
>()("t3/persistence/Services/DatabaseLogicalCompactor") {}
