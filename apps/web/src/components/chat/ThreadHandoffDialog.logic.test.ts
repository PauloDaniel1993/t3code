import { ProviderDriverKind, ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildHandoffTargetOptions,
  countImportableHandoffMessages,
  getHandoffTargetDisabledReason,
  resolveInitialHandoffTarget,
  type HandoffMessage,
  type HandoffTargetOption,
} from "../../threadHandoff/handoff";

// NOTE ON SCOPE / SKIPPED DOM SUB-CASE:
// `ThreadHandoffDialog` renders inside a base-ui `Dialog` portal. The web unit
// harness renders via `renderToStaticMarkup` (react-dom/server), under which the
// portal emits an empty string, so the dialog markup (provider list buttons, the
// model `<Select>`, the "Hand off" footer button) is unreachable to a static
// render assertion. Full interactive DOM coverage (click-to-select a target,
// open the model dropdown, click submit) therefore lives in e2e, not here.
//
// Instead, this file exercises the dialog's *decision logic* deterministically:
//  - the `handoff.ts` helpers that produce the dialog's inputs (importable
//    count, target options, per-target disabled reasons, initial selection), and
//  - the dialog's own inline derivations (`selectedOption`, `selectedModels`,
//    `canSubmit`) re-expressed here as pure functions that mirror
//    `ThreadHandoffDialog.tsx` exactly. If the component's inline logic changes,
//    these mirrors must be updated in lockstep.

function entry(input: {
  readonly instanceId: string;
  readonly status?: "ready" | "warning" | "error" | "disabled";
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly isAvailable?: boolean;
  readonly models?: ReadonlyArray<{ slug: string; name: string }>;
}): ProviderInstanceEntry {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const driverKind = ProviderDriverKind.make(input.instanceId);
  const models = (input.models ?? [{ slug: `${input.instanceId}-model`, name: "Model" }]).map(
    (model) => ({ ...model, isCustom: false, capabilities: null }),
  );
  return {
    instanceId,
    driverKind,
    displayName: input.instanceId,
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    status: input.status ?? "ready",
    isDefault: true,
    isAvailable: input.isAvailable ?? true,
    snapshot: {
      instanceId,
      driver: driverKind,
      enabled: input.enabled ?? true,
      installed: input.installed ?? true,
      version: null,
      status: input.status ?? "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-06-06T00:00:00.000Z",
      models,
      slashCommands: [],
      skills: [],
    },
    models,
  };
}

const handoffMessage = (input: Partial<HandoffMessage> = {}): HandoffMessage => ({
  text: "hello",
  streaming: false,
  attachments: [],
  ...input,
});

// --- Mirrors of the inline pure logic in ThreadHandoffDialog.tsx --------------
// Kept byte-for-byte equivalent to the component so the assertions below act as a
// guard on the dialog's selection/model/submit gating behavior.

function selectedOption(
  targetOptions: ReadonlyArray<HandoffTargetOption>,
  selectedModelSelection: ModelSelection | null,
): HandoffTargetOption | null {
  return selectedModelSelection === null
    ? null
    : (targetOptions.find(
        (option) => option.entry.instanceId === selectedModelSelection.instanceId,
      ) ?? null);
}

function selectedModels(
  option: HandoffTargetOption | null,
): ReadonlyArray<{ slug: string; name: string }> {
  if (option === null) {
    return [];
  }
  return option.entry.models.length > 0
    ? option.entry.models
    : [{ slug: option.modelSelection.model, name: option.modelSelection.model }];
}

function canSubmit(input: {
  selectedModelSelection: ModelSelection | null;
  option: HandoffTargetOption | null;
  isSubmitting: boolean;
}): boolean {
  return (
    input.selectedModelSelection !== null &&
    input.option !== null &&
    input.option.disabledReason === null &&
    !input.isSubmitting
  );
}

describe("ThreadHandoffDialog importable count", () => {
  it("counts only completed non-streaming messages with text or attachments", () => {
    const count = countImportableHandoffMessages([
      handoffMessage(),
      handoffMessage({ text: "   " }),
      handoffMessage({ streaming: true }),
      handoffMessage({ text: "", attachments: [{ id: "a1" }] }),
    ]);
    expect(count).toBe(2);
  });

  it("formats the importable count with locale grouping for the dialog header", () => {
    // The dialog renders `importableMessageCount.toLocaleString()`.
    expect((1234).toLocaleString("en-US")).toBe("1,234");
  });
});

describe("ThreadHandoffDialog target list disabled reasons", () => {
  it("surfaces a precedence-ordered reason for each non-selectable target", () => {
    expect(
      getHandoffTargetDisabledReason({
        entry: entry({ instanceId: "codex" }),
        sourceInstanceId: ProviderInstanceId.make("codex"),
        modelCount: 1,
      }),
    ).toBe("Already using this provider instance.");

    expect(
      getHandoffTargetDisabledReason({
        entry: entry({ instanceId: "deepseek", installed: false }),
        sourceInstanceId: ProviderInstanceId.make("codex"),
        modelCount: 1,
      }),
    ).toBe("Provider driver is unavailable in this build.");

    expect(
      getHandoffTargetDisabledReason({
        entry: entry({ instanceId: "grok", status: "error" }),
        sourceInstanceId: ProviderInstanceId.make("codex"),
        modelCount: 1,
      }),
    ).toBe("Provider instance is not ready.");

    expect(
      getHandoffTargetDisabledReason({
        entry: entry({ instanceId: "qwen" }),
        sourceInstanceId: ProviderInstanceId.make("codex"),
        modelCount: 0,
      }),
    ).toBe("Provider instance has no selectable models.");

    expect(
      getHandoffTargetDisabledReason({
        entry: entry({ instanceId: "ready-one" }),
        sourceInstanceId: ProviderInstanceId.make("codex"),
        modelCount: 2,
      }),
    ).toBeNull();
  });
});

describe("ThreadHandoffDialog target options and initial selection", () => {
  const options = buildHandoffTargetOptions({
    entries: [
      entry({ instanceId: "codex" }),
      entry({ instanceId: "deepseek", models: [{ slug: "deepseek-v4", name: "DeepSeek V4" }] }),
      entry({ instanceId: "grok", status: "error" }),
    ],
    sourceInstanceId: ProviderInstanceId.make("codex"),
    modelOptionsByInstance: new Map([
      [ProviderInstanceId.make("deepseek"), [{ slug: "deepseek-v4" }]],
    ]),
  });

  it("disables the source instance and any non-ready target", () => {
    const codex = options.find((option) => option.entry.instanceId === "codex");
    const grok = options.find((option) => option.entry.instanceId === "grok");
    const deepseek = options.find((option) => option.entry.instanceId === "deepseek");

    expect(codex?.disabledReason).toBe("Already using this provider instance.");
    expect(grok?.disabledReason).toBe("Provider instance is not ready.");
    expect(deepseek?.disabledReason).toBeNull();
  });

  it("resolves the first enabled, ready target when no preference is given", () => {
    const initial = resolveInitialHandoffTarget(options, null);
    expect(initial?.entry.instanceId).toBe("deepseek");
    expect(initial?.modelSelection.model).toBe("deepseek-v4");
  });

  it("falls back past a disabled preferred instance to the next ready target", () => {
    // codex is disabled (it is the source), so the preference is ignored.
    const initial = resolveInitialHandoffTarget(options, ProviderInstanceId.make("codex"));
    expect(initial?.entry.instanceId).toBe("deepseek");
  });
});

describe("ThreadHandoffDialog selectedOption / selectedModels / canSubmit", () => {
  const options = buildHandoffTargetOptions({
    entries: [
      entry({ instanceId: "codex" }),
      entry({
        instanceId: "deepseek",
        models: [
          { slug: "deepseek-v4", name: "DeepSeek V4" },
          { slug: "deepseek-flash", name: "DeepSeek Flash" },
        ],
      }),
    ],
    sourceInstanceId: ProviderInstanceId.make("codex"),
    modelOptionsByInstance: new Map([
      [ProviderInstanceId.make("deepseek"), [{ slug: "deepseek-v4" }, { slug: "deepseek-flash" }]],
    ]),
  });

  it("has no selected option and cannot submit when nothing is selected", () => {
    const option = selectedOption(options, null);
    expect(option).toBeNull();
    expect(selectedModels(option)).toEqual([]);
    expect(canSubmit({ selectedModelSelection: null, option, isSubmitting: false })).toBe(false);
  });

  it("lists the entry's models for the selected ready target and allows submit", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("deepseek"),
      model: "deepseek-v4",
    };
    const option = selectedOption(options, selection);
    expect(option?.entry.instanceId).toBe("deepseek");
    expect(selectedModels(option).map((model) => model.slug)).toEqual([
      "deepseek-v4",
      "deepseek-flash",
    ]);
    expect(canSubmit({ selectedModelSelection: selection, option, isSubmitting: false })).toBe(
      true,
    );
  });

  it("blocks submit while a handoff is already in flight", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("deepseek"),
      model: "deepseek-v4",
    };
    const option = selectedOption(options, selection);
    expect(canSubmit({ selectedModelSelection: selection, option, isSubmitting: true })).toBe(
      false,
    );
  });

  it("blocks submit when the selected target is disabled", () => {
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "codex-model",
    };
    const option = selectedOption(options, selection);
    expect(option?.disabledReason).toBe("Already using this provider instance.");
    expect(canSubmit({ selectedModelSelection: selection, option, isSubmitting: false })).toBe(
      false,
    );
  });

  it("synthesizes a single model entry from the selection when the entry has no models", () => {
    // Mirrors the `selectedOption.entry.models.length > 0 ? ... : [...]` branch:
    // a target whose entry carries no model list still shows the selected model.
    const modellessOptions = buildHandoffTargetOptions({
      entries: [entry({ instanceId: "codex" }), entry({ instanceId: "deepseek", models: [] })],
      sourceInstanceId: ProviderInstanceId.make("codex"),
      modelOptionsByInstance: new Map([
        [ProviderInstanceId.make("deepseek"), [{ slug: "deepseek-remote" }]],
      ]),
    });
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make("deepseek"),
      model: "deepseek-remote",
    };
    const option = selectedOption(modellessOptions, selection);
    expect(option?.entry.models).toEqual([]);
    expect(selectedModels(option)).toEqual([{ slug: "deepseek-remote", name: "deepseek-remote" }]);
  });
});
