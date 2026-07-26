import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { buildTaskModelCatalog, resolveTaskModelSelection } from "./reasoning.ts";

const CODEX_INSTANCE = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

const codexModel: ServerProviderModel = {
  slug: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  isCustom: false,
  capabilities: createModelCapabilities({
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
        ],
        currentValue: "high",
      },
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [{ id: "standard", label: "Standard", isDefault: true }],
      },
    ],
  }),
};

const claudeModel: ServerProviderModel = {
  slug: "claude-opus-5",
  name: "Claude Opus 5",
  isCustom: false,
  capabilities: createModelCapabilities({
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "high", label: "High", isDefault: true },
          { id: "max", label: "Max" },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        promptInjectedValues: ["ultrathink"],
      },
    ],
  }),
};

const plainModel: ServerProviderModel = {
  slug: "grok-build",
  name: "Grok Build",
  isCustom: false,
  capabilities: null,
};

const makeProvider = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<ServerProviderModel>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-26T00:00:00.000Z",
  models,
  slashCommands: [],
  skills: [],
  ...overrides,
});

const providers: ReadonlyArray<ServerProvider> = [
  makeProvider(CODEX_INSTANCE, [codexModel, plainModel]),
  makeProvider(CLAUDE_INSTANCE, [claudeModel]),
];

const parentSelection: ModelSelection = createModelSelection(CODEX_INSTANCE, codexModel.slug, [
  { id: "reasoningEffort", value: "medium" },
  { id: "serviceTier", value: "standard" },
]);

const resolve = (input: {
  readonly override?: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly reasoning?: string;
  readonly parent?: ModelSelection;
}) =>
  resolveTaskModelSelection({
    providers,
    parentSelection: input.parent ?? parentSelection,
    override: input.override,
    reasoning: input.reasoning,
  });

describe("resolveTaskModelSelection", () => {
  it("inherits the parent's selection when neither model nor reasoning is given", () => {
    expect(resolve({})).toEqual({ ok: true });
  });

  it("carries a model override through untouched when no reasoning is given", () => {
    expect(resolve({ override: { instanceId: CLAUDE_INSTANCE, model: claudeModel.slug } })).toEqual(
      {
        ok: true,
        modelSelection: { instanceId: CLAUDE_INSTANCE, model: claudeModel.slug },
      },
    );
  });

  it("applies a reasoning level to the parent's model when only reasoning is given", () => {
    // The task still runs on the thread's model, so the parent's other
    // options survive and only the reasoning entry is rewritten.
    expect(resolve({ reasoning: "xhigh" })).toEqual({
      ok: true,
      modelSelection: {
        instanceId: CODEX_INSTANCE,
        model: codexModel.slug,
        options: [
          { id: "serviceTier", value: "standard" },
          { id: "reasoningEffort", value: "xhigh" },
        ],
      },
    });
  });

  it("applies a reasoning level to the overridden model under that model's own option id", () => {
    expect(
      resolve({
        override: { instanceId: CLAUDE_INSTANCE, model: claudeModel.slug },
        reasoning: "max",
      }),
    ).toEqual({
      ok: true,
      modelSelection: {
        instanceId: CLAUDE_INSTANCE,
        model: claudeModel.slug,
        options: [{ id: "effort", value: "max" }],
      },
    });
  });

  it("does not carry the parent's options onto a different model", () => {
    expect(
      resolve({
        override: { instanceId: CLAUDE_INSTANCE, model: claudeModel.slug },
        reasoning: "high",
      }),
    ).toEqual({
      ok: true,
      modelSelection: {
        instanceId: CLAUDE_INSTANCE,
        model: claudeModel.slug,
        options: [{ id: "effort", value: "high" }],
      },
    });
  });

  it("accepts a level written as its label", () => {
    expect(resolve({ reasoning: "Extra High" })).toMatchObject({
      ok: true,
      modelSelection: {
        options: expect.arrayContaining([{ id: "reasoningEffort", value: "xhigh" }]),
      },
    });
  });

  it("names the valid levels when the requested one does not exist", () => {
    const result = resolve({ reasoning: "ultramax" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("'ultramax' is not a reasoning level");
    expect(result.message).toContain("medium, high, xhigh");
  });

  it("rejects a reasoning level for a model that has none", () => {
    const result = resolve({
      override: { instanceId: CODEX_INSTANCE, model: plainModel.slug },
      reasoning: "high",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("has no reasoning level to set");
  });

  it("rejects an unknown instance and lists the configured ones", () => {
    const result = resolve({
      override: { instanceId: ProviderInstanceId.make("nope"), model: codexModel.slug },
      reasoning: "high",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("No provider instance 'nope' is configured");
    expect(result.message).toContain("codex, claudeAgent");
  });

  it("rejects an unknown model and lists the instance's models", () => {
    const result = resolve({
      override: { instanceId: CODEX_INSTANCE, model: "gpt-9" },
      reasoning: "high",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("has no model 'gpt-9'");
    expect(result.message).toContain("gpt-5.6-sol, grok-build");
  });

  it("treats a blank reasoning level as unset rather than invalid", () => {
    expect(resolve({ reasoning: "   " })).toEqual({ ok: true });
  });
});

describe("buildTaskModelCatalog", () => {
  const catalogOf = (input: {
    readonly providers?: ReadonlyArray<ServerProvider>;
    readonly current?: ModelSelection;
    readonly instanceId?: string;
  }) =>
    buildTaskModelCatalog({
      providers: input.providers ?? providers,
      current: input.current ?? parentSelection,
      instanceId: input.instanceId,
    });

  it("publishes each model's reasoning levels under that model's own vocabulary", () => {
    const result = catalogOf({ instanceId: CLAUDE_INSTANCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.catalog.instances).toEqual([
      {
        instanceId: CLAUDE_INSTANCE,
        provider: CLAUDE_INSTANCE,
        displayName: CLAUDE_INSTANCE,
        ready: true,
        models: [
          {
            model: claudeModel.slug,
            name: claudeModel.name,
            isDefault: false,
            reasoningLevels: [
              { id: "high", label: "High", isDefault: true, promptInjected: false },
              { id: "max", label: "Max", isDefault: false, promptInjected: false },
              // Selecting this one prefixes the task's prompt rather than
              // configuring the session, which is worth saying out loud.
              { id: "ultrathink", label: "Ultrathink", isDefault: false, promptInjected: true },
            ],
          },
        ],
      },
    ]);
  });

  it("reports no levels for a model that has none rather than inventing some", () => {
    const result = catalogOf({ instanceId: CODEX_INSTANCE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const models = result.catalog.instances[0]?.models ?? [];
    expect(models.find((model) => model.model === plainModel.slug)?.reasoningLevels).toEqual([]);
    expect(
      models.find((model) => model.model === codexModel.slug)?.reasoningLevels.map((l) => l.id),
    ).toEqual(["medium", "high", "xhigh"]);
  });

  it("answers what a task inherits when the agent names nothing", () => {
    const result = catalogOf({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The thread carries an explicit level, so that is what a task inherits.
    expect(result.catalog.current).toEqual({
      instanceId: CODEX_INSTANCE,
      model: codexModel.slug,
      reasoning: "medium",
    });

    // With no level of its own, the inherited level is the model's default.
    const bare = catalogOf({ current: createModelSelection(CLAUDE_INSTANCE, claudeModel.slug) });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.catalog.current.reasoning).toBe("high");

    // A model with no reasoning level reports none rather than a placeholder.
    const plain = catalogOf({ current: createModelSelection(CODEX_INSTANCE, plainModel.slug) });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.catalog.current.reasoning).toBe(null);
  });

  it("flags an instance a task would fail on instead of hiding it", () => {
    const signedOut = makeProvider(CLAUDE_INSTANCE, [claudeModel], {
      status: "error",
      displayName: "Claude",
    });
    const result = catalogOf({ providers: [signedOut] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.instances[0]).toMatchObject({ displayName: "Claude", ready: false });
  });

  it("omits instances whose driver this build cannot run", () => {
    // An unavailable instance is a leftover binding for a driver that is not
    // in this build. Listing it would only invite a task that cannot start.
    const missingDriver = makeProvider(ProviderInstanceId.make("ghost"), [], {
      availability: "unavailable",
    });
    const result = catalogOf({ providers: [...providers, missingDriver] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.instances.map((instance) => instance.instanceId)).toEqual([
      CODEX_INSTANCE,
      CLAUDE_INSTANCE,
    ]);
  });

  it("names the configured instances when asked to filter by an unknown one", () => {
    const result = catalogOf({ instanceId: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("No provider instance 'nope' is configured");
    expect(result.message).toContain("codex, claudeAgent");
  });
});
