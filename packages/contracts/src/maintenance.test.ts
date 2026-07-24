import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DatabaseMaintenanceEstimate,
  DatabaseMaintenanceFailure,
  DatabaseMaintenanceProgress,
} from "./maintenance.ts";

const decodeEstimate = Schema.decodeUnknownSync(DatabaseMaintenanceEstimate);
const decodeFailure = Schema.decodeUnknownSync(DatabaseMaintenanceFailure);
const decodeProgress = Schema.decodeUnknownSync(DatabaseMaintenanceProgress);

describe("database maintenance contracts", () => {
  it("decodes aggregate estimates without provider payload content", () => {
    const estimate = decodeEstimate({
      databaseBytes: 1_000,
      freePageBytes: 100,
      reclaimableEventPayloadBytes: 250,
      supersededProjectionBytes: 300,
      estimatedReclaimableBytes: 650,
      temporaryDiskRequiredBytes: 1_200,
      safetyWatermark: 42,
      eligibleEventCount: 12,
      eligibleProjectionCount: 30,
      recommended: true,
      activeWorkBlockers: [],
    });

    expect(estimate.estimatedReclaimableBytes).toBe(650);
    expect(Object.keys(estimate)).not.toContain("payload");
  });

  it("decodes progress and typed disk failures", () => {
    const progress = decodeProgress({
      phase: "logical-compaction",
      processedRows: 10,
      totalRows: 20,
      logicalBytesReclaimed: 500,
      startedAt: "2026-07-23T10:00:00.000Z",
      updatedAt: "2026-07-23T10:00:01.000Z",
    });
    const failure = decodeFailure({
      code: "insufficient-disk",
      phase: "preflight",
      message: "Not enough temporary disk space.",
      requiredBytes: 2_000,
      availableBytes: 1_000,
      recoverable: true,
      failedAt: "2026-07-23T10:00:02.000Z",
    });

    expect(progress.processedRows).toBe(10);
    expect(failure.code).toBe("insufficient-disk");
  });
});
