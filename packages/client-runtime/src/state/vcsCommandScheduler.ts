import type { EnvironmentId } from "@t3tools/contracts";

import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";
import {
  createAtomCommandScheduler,
  scheduleAtomCommandEffect,
  type AtomCommandConcurrency,
} from "./runtime.ts";

export const vcsCommandScheduler = createAtomCommandScheduler();

export const vcsCommandConcurrency: AtomCommandConcurrency<{
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
}> = {
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
};

/** Acquire checkout lanes in one order so overlapping batches cannot deadlock. */
export function scheduleWorkspaceVcsCommand<A, E, R>(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  cwds: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
) {
  return [...new Set(cwds)]
    .sort()
    .reduceRight(
      (operation, cwd) =>
        scheduleAtomCommandEffect(
          registry,
          vcsCommandScheduler,
          vcsCommandConcurrency,
          { environmentId, input: { cwd } },
          operation,
        ),
      effect,
    );
}
