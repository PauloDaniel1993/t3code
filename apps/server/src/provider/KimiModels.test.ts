import { describe, expect, it } from "@effect/vitest";
import type * as AcpSchema from "effect-acp/compat";

import { buildKimiModels } from "./KimiModels.ts";

describe("Kimi models", () => {
  it("bounds and deduplicates discovered slugs without dropping saved custom models", () => {
    const options: ReadonlyArray<AcpSchema.SessionConfigOption> = [
      {
        id: "llm",
        name: "Models",
        type: "select",
        currentValue: "model-0",
        options: [
          { value: "kimi-default", name: "Duplicate default" },
          { value: " model-0 ", name: "Whitespace" },
          { value: "x".repeat(257), name: "Oversized" },
          ...Array.from({ length: 100 }, (_, i) => ({ value: `model-${i}`, name: `Model ${i}` })),
          { value: "model-0", name: "Duplicate" },
        ],
      },
    ];
    const models = buildKimiModels(["saved-custom", "model-0"], options);
    expect(models).toHaveLength(66);
    expect(models[0]?.slug).toBe("kimi-default");
    expect(models.at(-1)).toMatchObject({ slug: "saved-custom", isCustom: true });
    expect(models.filter((model) => model.slug === "model-0")).toHaveLength(1);
  });

  it("removes saved mode descriptors while preserving custom feature options", () => {
    const models = buildKimiModels([
      {
        slug: "saved-custom",
        name: "Saved custom",
        capabilities: {
          optionDescriptors: [
            { type: "boolean", id: "mode", label: "Mode", currentValue: false },
            { type: "boolean", id: "_t3/session-mode", label: "Session mode", currentValue: false },
            { type: "boolean", id: "thinking", label: "Thinking", currentValue: true },
          ],
        },
      },
    ]);
    expect(models.at(-1)?.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual([
      "thinking",
    ]);
  });
});
