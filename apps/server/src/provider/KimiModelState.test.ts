import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildKimiModels,
  findKimiModelConfigOption,
  makeKimiModelState,
} from "./KimiModelState.ts";

const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "kimi-k2.5",
    options: [
      { value: "kimi-k2.5", name: "Kimi K2.5" },
      { value: "kimi-k2-thinking", name: "Kimi K2 Thinking" },
    ],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "agent",
    options: [
      { value: "agent", name: "Agent" },
      { value: "plan", name: "Plan" },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

describe("KimiModelState", () => {
  it("seeds kimi-default and de-duplicated custom models", () => {
    const models = buildKimiModels([" kimi-custom ", "kimi-default", "kimi-custom"]);
    expect(models.map((model) => model.slug)).toEqual(["kimi-default", "kimi-custom"]);
    expect(models[0]?.name).toBe("Kimi default");
  });

  it("normalizes provider-reported models, thinking, and mode options", () => {
    const models = buildKimiModels(["kimi-custom"], configOptions);
    expect(models.map((model) => model.slug)).toEqual([
      "kimi-default",
      "kimi-k2.5",
      "kimi-k2-thinking",
      "kimi-custom",
    ]);
    expect(models[1]?.name).toBe("Kimi K2.5");
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([
      expect.objectContaining({ id: "thinking", currentValue: "medium" }),
      expect.objectContaining({ id: "mode", currentValue: "agent" }),
    ]);
    expect(findKimiModelConfigOption(configOptions)?.id).toBe("model");
  });

  it.effect("publishes instance-scoped model state changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = yield* makeKimiModelState(["kimi-custom"]);
        const updateFiber = yield* state.streamChanges.pipe(Stream.runHead, Effect.forkChild);
        yield* Effect.yieldNow;

        yield* state.publishConfigOptions(configOptions);
        const update = yield* Fiber.join(updateFiber);
        const current = yield* state.getSnapshot;

        expect(Option.getOrThrow(update).models.map((model) => model.slug)).toEqual(
          current.models.map((model) => model.slug),
        );
        expect(current.configOptions).toEqual(configOptions);
      }),
    ),
  );
});
