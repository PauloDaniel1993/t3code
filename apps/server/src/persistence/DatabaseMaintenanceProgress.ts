export interface MaintenanceProgress {
  readonly phase: string;
  readonly state: "started" | "completed" | "failed";
  readonly elapsedMs: number;
  readonly remainingPhases: readonly string[];
  readonly estimatedMs?: number;
}

/** Report synchronous work before it blocks, with measured timings for comparable checks. */
export function maintenanceProgress(
  phases: readonly string[],
  notify?: (progress: MaintenanceProgress) => void,
) {
  const durations = new Map<string, number>();
  return {
    validationEstimate: () => {
      const integrity = durations.get("Checking source integrity");
      const fingerprint = durations.get("Fingerprinting source");
      return integrity === undefined || fingerprint === undefined
        ? undefined
        : integrity + fingerprint;
    },
    run<A>(phase: string, operation: () => A, estimatedMs?: number): A {
      const start = performance.now();
      const details = {
        phase,
        remainingPhases: phases.slice(phases.indexOf(phase) + 1),
        ...(estimatedMs === undefined ? {} : { estimatedMs }),
      };
      notify?.({ ...details, state: "started", elapsedMs: 0 });
      try {
        const result = operation();
        const elapsedMs = performance.now() - start;
        durations.set(phase, elapsedMs);
        notify?.({ ...details, state: "completed", elapsedMs });
        return result;
      } catch (cause) {
        notify?.({ ...details, state: "failed", elapsedMs: performance.now() - start });
        throw cause;
      }
    },
  };
}
