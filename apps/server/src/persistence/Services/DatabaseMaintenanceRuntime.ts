import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { DatabasePhysicalMaintenanceError } from "../DatabasePhysicalMaintenance.ts";
import type { ProjectionRepositoryError } from "../Errors.ts";

export interface DatabaseMaintenanceRuntimeShape {
  readonly finalizeStartup: Effect.Effect<
    void,
    ProjectionRepositoryError | DatabasePhysicalMaintenanceError
  >;
}

export class DatabaseMaintenanceRuntime extends Context.Service<
  DatabaseMaintenanceRuntime,
  DatabaseMaintenanceRuntimeShape
>()("t3/persistence/Services/DatabaseMaintenanceRuntime") {}
