import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ProviderInstanceId } from "@t3tools/contracts";

import { makeJsonTextGeneration } from "./TextGenerationShared.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("kimi"),
  model: "kimi-default",
};

const run = (responses: Array<string>) => {
  let calls = 0;
  const service = makeJsonTextGeneration({
    providerLabel: "Kimi",
    defaultTimeoutMs: 1_000,
    runRaw: () =>
      Effect.sync(() => {
        calls += 1;
        return responses.shift() ?? "";
      }),
  });
  return { service, calls: () => calls };
};

describe("makeJsonTextGeneration", () => {
  it.effect("generates and sanitizes commit content", () =>
    Effect.gen(function* () {
      const { service } = run([
        '{"subject":"Update the provider.","body":"  Details  ","branch":"feat/Kimi Provider"}',
      ]);
      const result = yield* service.generateCommitMessage({
        cwd: "/repo",
        branch: "dev",
        stagedSummary: "summary",
        stagedPatch: "patch",
        includeBranch: true,
        modelSelection,
      });
      expect(result).toEqual({
        subject: "Update the provider",
        body: "Details",
        branch: "feature/feat/kimi-provider",
      });
    }),
  );

  it.effect("generates pull request content", () =>
    Effect.gen(function* () {
      const { service } = run(['{"title":"  Add Kimi  ","body":"  Body  "}']);
      expect(
        yield* service.generatePrContent({
          cwd: "/repo",
          baseBranch: "dev",
          headBranch: "feat/kimi",
          commitSummary: "summary",
          diffSummary: "diff",
          diffPatch: "patch",
          modelSelection,
        }),
      ).toEqual({ title: "Add Kimi", body: "Body" });
    }),
  );

  it.effect("generates branch names and retries one malformed response", () =>
    Effect.gen(function* () {
      const harness = run(["not json", '{"branch":"Kimi Subscription"}']);
      expect(
        yield* harness.service.generateBranchName({
          cwd: "/repo",
          message: "add Kimi",
          modelSelection,
        }),
      ).toEqual({ branch: "kimi-subscription" });
      expect(harness.calls()).toBe(2);
    }),
  );

  it.effect("generates compact thread titles", () =>
    Effect.gen(function* () {
      const { service } = run(['{"title":"  Add   Kimi subscription  "}']);
      expect(
        yield* service.generateThreadTitle({
          cwd: "/repo",
          message: "add Kimi",
          modelSelection,
        }),
      ).toEqual({ title: "Add Kimi subscription" });
    }),
  );

  it.effect("rejects empty output without retrying a permanent failure", () =>
    Effect.gen(function* () {
      const harness = run([""]);
      const error = yield* harness.service
        .generateThreadTitle({ cwd: "/repo", message: "title", modelSelection })
        .pipe(Effect.flip);
      expect(error.detail).toContain("empty output");
      expect(harness.calls()).toBe(1);
    }),
  );

  it.effect("times out and retries one transient transport attempt", () => {
    let calls = 0;
    const service = makeJsonTextGeneration({
      providerLabel: "Kimi",
      defaultTimeoutMs: 10,
      runRaw: () =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(Effect.andThen(Effect.never)),
    });
    return Effect.gen(function* () {
      const error = yield* service
        .generateThreadTitle({ cwd: "/repo", message: "title", modelSelection })
        .pipe(Effect.flip);
      expect(error.detail).toContain("timed out");
      expect(calls).toBe(2);
    }).pipe(TestClock.withLive);
  });
});
