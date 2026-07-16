import { describe, expect, it } from "vite-plus/test";

import { resolveDiffIndicators } from "./diffIndicators.ts";

describe("resolveDiffIndicators", () => {
  it("uses bars for color-only diffs", () => {
    expect(resolveDiffIndicators("color")).toBe("bars");
  });

  it("uses classic markers when markers are enabled", () => {
    expect(resolveDiffIndicators("color-and-markers")).toBe("classic");
  });
});
