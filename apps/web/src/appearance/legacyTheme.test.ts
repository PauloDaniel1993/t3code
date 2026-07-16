import { describe, expect, it } from "vite-plus/test";

import { parseThemePreference, THEME_STORAGE_KEY } from "./legacyTheme.ts";

describe("legacy theme preference", () => {
  it("exports the bootstrap mirror key", () => {
    expect(THEME_STORAGE_KEY).toBe("t3code:theme");
  });

  it.each([
    ["light", "light"],
    ["dark", "dark"],
    ["system", "system"],
    ["invalid", "system"],
    ["", "system"],
    [null, "system"],
  ] as const)("parses %s as %s", (input, expected) => {
    expect(parseThemePreference(input)).toBe(expected);
  });
});
