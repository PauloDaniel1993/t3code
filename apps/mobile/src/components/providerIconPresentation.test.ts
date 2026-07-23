import { describe, expect, it } from "vite-plus/test";

import { resolveProviderIconKind } from "./providerIconPresentation";

describe("ProviderIcon presentation", () => {
  it("uses a dedicated Kimi icon instead of the OpenAI fallback", () => {
    expect(resolveProviderIconKind("kimi")).toBe("kimi");
  });

  it("preserves existing and unknown provider presentation", () => {
    expect(resolveProviderIconKind("claudeAgent")).toBe("claude");
    expect(resolveProviderIconKind("codex")).toBe("openai");
    expect(resolveProviderIconKind("future-provider")).toBe("openai");
  });
});
