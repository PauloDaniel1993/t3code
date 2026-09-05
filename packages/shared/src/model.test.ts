import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  findReasoningOptionDescriptor,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  toCustomModelSetting,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  resolveReasoningOptionChoiceId,
} from "./model.ts";

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });
});

describe("reasoning descriptor lookup", () => {
  const cursorCaps: ModelCapabilities = createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoning",
        label: "Thought Level",
        type: "select",
        options: [
          { id: "standard", label: "Standard", isDefault: true },
          { id: "max", label: "Max" },
        ],
      },
    ],
  });

  it("finds the reasoning option under each driver's own id", () => {
    for (const [caps, expected] of [
      [codexCaps, "reasoningEffort"],
      [claudeCaps, "effort"],
      [cursorCaps, "reasoning"],
    ] as const) {
      expect(findReasoningOptionDescriptor(getProviderOptionDescriptors({ caps }))?.id).toBe(
        expected,
      );
    }
  });

  it("finds a reasoning option named only by its label", () => {
    const caps = createModelCapabilities({
      optionDescriptors: [
        {
          id: "thought_level",
          label: "Thinking",
          type: "select",
          options: [{ id: "deep", label: "Deep" }],
        },
      ],
    });

    expect(findReasoningOptionDescriptor(getProviderOptionDescriptors({ caps }))?.id).toBe(
      "thought_level",
    );
  });

  it("reports no reasoning option rather than claiming an unrelated select", () => {
    // OpenCode publishes `variant` and `agent` selects and no reasoning level;
    // treating the first select as "the reasoning one" would silently reassign
    // the agent a task was meant to run under.
    const openCodeCaps: ModelCapabilities = createModelCapabilities({
      optionDescriptors: [
        {
          id: "variant",
          label: "Variant",
          type: "select",
          options: [{ id: "default", label: "Default" }],
        },
        {
          id: "agent",
          label: "Agent",
          type: "select",
          options: [{ id: "build", label: "Build" }],
        },
      ],
    });

    expect(
      findReasoningOptionDescriptor(getProviderOptionDescriptors({ caps: openCodeCaps })),
    ).toBe(null);
    expect(findReasoningOptionDescriptor([])).toBe(null);
  });

  it("matches a requested level by id or label, however it is punctuated", () => {
    const descriptor = findReasoningOptionDescriptor(
      getProviderOptionDescriptors({ caps: codexCaps }),
    );
    if (!descriptor) throw new Error("expected a reasoning descriptor");

    expect(resolveReasoningOptionChoiceId(descriptor, "xhigh")).toBe("xhigh");
    expect(resolveReasoningOptionChoiceId(descriptor, " HIGH ")).toBe("high");
    expect(resolveReasoningOptionChoiceId(descriptor, "extra high")).toBe("xhigh");
    expect(resolveReasoningOptionChoiceId(descriptor, "extra-high")).toBe("xhigh");
    expect(resolveReasoningOptionChoiceId(descriptor, "maximum")).toBe(null);
    expect(resolveReasoningOptionChoiceId(descriptor, "")).toBe(null);
    expect(resolveReasoningOptionChoiceId(descriptor, null)).toBe(null);
  });
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    const cursor = ProviderDriverKind.make("cursor");

    expect(normalizeModelSlug("opus-4.6", cursor)).toBe("claude-opus-4-6");
    expect(normalizeCustomModelSlug(" opus-4.6 ")).toBe("opus-4.6");
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });

  it("writes the compact stored shape back", () => {
    expect(toCustomModelSetting({ slug: "x", name: "x", capabilities: null })).toBe("x");
    expect(
      toCustomModelSetting({ slug: "x", name: "x", capabilities: { optionDescriptors: [] } }),
    ).toBe("x");
    expect(toCustomModelSetting({ slug: "x", name: "X", capabilities })).toEqual({
      slug: "x",
      name: "X",
      capabilities,
    });
  });
});
