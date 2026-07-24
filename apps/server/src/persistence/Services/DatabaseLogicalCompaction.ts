import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";
import type { DatabaseCompactionJournal } from "./DatabaseCompactionJournal.ts";

export interface RunLogicalCompactionBatchOptions {
  readonly batchSize?: number;
}

export interface DatabaseLogicalCompactionShape {
  readonly runNextBatch: (
    options?: RunLogicalCompactionBatchOptions,
  ) => Effect.Effect<DatabaseCompactionJournal, ProjectionRepositoryError>;
  readonly run: () => Effect.Effect<DatabaseCompactionJournal, ProjectionRepositoryError>;
}

export class DatabaseLogicalCompaction extends Context.Service<
  DatabaseLogicalCompaction,
  DatabaseLogicalCompactionShape
>()("t3/persistence/Services/DatabaseLogicalCompaction") {}
