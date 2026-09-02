/**
 * OrchestrationProjectionPipeline - Event projection pipeline service interface.
 *
 * Coordinates projection bootstrap/replay and per-event projection updates for
 * orchestration read models.
 *
 * @module OrchestrationProjectionPipeline
 */
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

/**
 * OrchestrationProjectionPipelineShape - Service API for projection execution.
 */
export interface OrchestrationProjectionPipelineShape {
  /**
   * Bootstrap projections by replaying persisted events.
   *
   * Resumes each projector from its stored projection-state cursor.
   */
  readonly bootstrap: Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project a single orchestration event into projection repositories.
   *
   * Projectors run sequentially in one transaction. Attachment cleanup is
   * durably queued in that transaction for a post-commit drain.
   */
  readonly projectEvent: (
    event: OrchestrationEvent,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Project an event inside a caller's transaction and enqueue any attachment
   * cleanup atomically. The returned compatibility effect is a no-op; callers
   * drain the durable queue only after the outer transaction commits.
   */
  readonly projectEventDeferred: (
    event: OrchestrationEvent,
  ) => Effect.Effect<Effect.Effect<void>, ProjectionRepositoryError>;
}

/**
 * OrchestrationProjectionPipeline - Service tag for orchestration projections.
 */
export class OrchestrationProjectionPipeline extends Context.Service<
  OrchestrationProjectionPipeline,
  OrchestrationProjectionPipelineShape
>()("t3/orchestration/Services/ProjectionPipeline/OrchestrationProjectionPipeline") {}
