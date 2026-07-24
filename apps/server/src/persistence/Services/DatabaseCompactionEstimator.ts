import { DatabaseMaintenanceEstimate } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface DatabaseCompactionEstimatorShape {
  readonly estimate: () => Effect.Effect<DatabaseMaintenanceEstimate, ProjectionRepositoryError>;
}

export class DatabaseCompactionEstimator extends Context.Service<
  DatabaseCompactionEstimator,
  DatabaseCompactionEstimatorShape
>()("t3/persistence/Services/DatabaseCompactionEstimator") {}
