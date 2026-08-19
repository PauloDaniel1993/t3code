import { describe, expect, it } from "vite-plus/test";

import {
  assertOpacitySubtreeTextContrast,
  assertTextContrast,
  compositeOpacitySubtree,
  compositeForeground,
  contrastRatio,
  effectiveOpacitySubtreeContrast,
  effectiveContrast,
  meetsOpacitySubtreeTextContrast,
  meetsTextContrast,
} from "./taskAgentContrast";
import {
  getTaskAgentTheme,
  TASK_AGENT_THEMES,
  type TaskAgentTextTheme,
  type TaskAgentThemeMode,
} from "./taskAgentTheme";
import { getMobileThemeVariables } from "../../../lib/mobileTheme";

const MODES = ["dark", "light"] as const satisfies readonly TaskAgentThemeMode[];
const SURFACES = ["background", "card"] as const;
type SurfaceName = (typeof SURFACES)[number];
type TextRole = keyof TaskAgentTextTheme;
type ExpectedRatios = Record<TaskAgentThemeMode, Record<SurfaceName, number>>;

const EXPECTED_RATIOS = {
  foreground: {
    dark: { background: 17.8216, card: 17.0987 },
    light: { background: 16.548, card: 17.7168 },
  },
  muted: {
    dark: { background: 7.8486, card: 7.5302 },
    light: { background: 7.2199, card: 7.7298 },
  },
  dim: {
    dark: { background: 4.8552, card: 4.6583 },
    light: { background: 4.9335, card: 5.282 },
  },
  statedReason: {
    dark: { background: 4.8552, card: 4.6583 },
    light: { background: 4.9335, card: 5.282 },
  },
  info: {
    dark: { background: 7.7871, card: 7.4712 },
    light: { background: 6.2595, card: 6.7016 },
  },
  success: {
    dark: { background: 10.2985, card: 9.8808 },
    light: { background: 5.1221, card: 5.4839 },
  },
  warn: {
    dark: { background: 11.8597, card: 11.3786 },
    light: { background: 5.536, card: 5.927 },
  },
  danger: {
    dark: { background: 7.1573, card: 6.867 },
    light: { background: 6.0432, card: 6.47 },
  },
  teal: {
    dark: { background: 10.6356, card: 10.2042 },
    light: { background: 5.1122, card: 5.4733 },
  },
  violet: {
    dark: { background: 7.4926, card: 7.1887 },
    light: { background: 6.5226, card: 6.9833 },
  },
  coral: {
    dark: { background: 6.4776, card: 6.2149 },
    light: { background: 4.6903, card: 5.0216 },
  },
} satisfies Record<TextRole, ExpectedRatios>;

describe("task-agent theme text contrast", () => {
  for (const mode of MODES) {
    const theme = getTaskAgentTheme(mode);
    const textEntries = Object.entries(theme.text) as Array<[TextRole, string]>;

    for (const [role, foreground] of textEntries) {
      for (const surface of SURFACES) {
        it(`${mode} ${role} meets 4.5:1 on the opaque ${surface} surface`, () => {
          const input = {
            foreground,
            background: theme[surface],
            opacities: [],
          };

          expect(effectiveContrast(input)).toBeCloseTo(EXPECTED_RATIOS[role][mode][surface], 3);
          expect(meetsTextContrast(input)).toBe(true);
          expect(() => assertTextContrast(input)).not.toThrow();
        });
      }
    }
  }
});

describe("stated reason contrast", () => {
  const sheetCases = {
    dark: { background: "rgb(15, 15, 18)", expected: 4.6921 },
    light: { background: "rgb(247, 247, 247)", expected: 4.9126 },
  } as const satisfies Record<TaskAgentThemeMode, { background: string; expected: number }>;

  for (const mode of MODES) {
    it(`${mode} statedReason keeps the unavailable-control explanation legible`, () => {
      const theme = getTaskAgentTheme(mode);
      const input = {
        foreground: theme.text.statedReason,
        background: sheetCases[mode].background,
        opacities: [],
      };

      expect(effectiveContrast(input)).toBeCloseTo(sheetCases[mode].expected, 1);
      expect(meetsTextContrast(input)).toBe(true);
      expect(() => assertTextContrast(input)).not.toThrow();
    });
  }
});

describe("effective compositing regressions", () => {
  it("catches the disabled-composer 0.65 ancestor opacity defect", () => {
    const tokenInput = {
      foreground: "#787e8a",
      background: "rgb(15, 15, 18)",
      opacities: [],
    } as const;
    const dimmedInput = { ...tokenInput, opacities: [0.65] };

    expect(effectiveContrast(tokenInput)).toBeCloseTo(4.6921, 2);
    expect(meetsTextContrast(tokenInput)).toBe(true);

    expect(effectiveContrast(dimmedInput)).toBeCloseTo(2.6492, 3);
    expect(meetsTextContrast(dimmedInput)).toBe(false);
    expect(() => assertTextContrast(dimmedInput)).toThrow();
  });

  it("multiplies more than one ancestor opacity and foreground alpha", () => {
    const singleAncestor = effectiveContrast({
      foreground: "#ffffff",
      background: "#000000",
      opacities: [0.65],
    });
    const nestedAncestors = effectiveContrast({
      foreground: "#ffffff",
      background: "#000000",
      opacities: [0.8, 0.8125],
    });
    const halfAlpha = compositeForeground({
      foreground: "rgba(255, 255, 255, 0.5)",
      background: "#000000",
      opacities: [],
    });

    expect(nestedAncestors).toBeCloseTo(singleAncestor, 10);
    expect(halfAlpha).toMatchObject({ red: 127.5, green: 127.5, blue: 127.5, alpha: 1 });
    expect(
      effectiveContrast({
        foreground: "rgba(255, 255, 255, 0.5)",
        background: "#000000",
        opacities: [],
      }),
    ).toBeLessThan(21);
  });

  it("catches the hue-dependent avatar failure at the effective color", () => {
    // mockup.css:420-423 uses hsl(var(--h) 65% 38%) with white initials;
    // CONTRAST.md:116-120 records these equivalent RGB outcomes.
    const allowedBlue = {
      foreground: "#ffffff",
      background: "hsl(215 65% 38%)",
      opacities: [],
    } as const;
    const excludedYellow = {
      foreground: "#ffffff",
      background: "hsl(60 65% 38%)",
      opacities: [],
    } as const;

    expect(effectiveContrast(allowedBlue)).toBeCloseTo(7.1954, 3);
    expect(meetsTextContrast(allowedBlue)).toBe(true);
    expect(effectiveContrast(excludedYellow)).toBeCloseTo(2.7867, 3);
    expect(meetsTextContrast(excludedYellow)).toBe(false);
  });
});

describe("opacity-carrying subtree compositing", () => {
  it("regresses the false pass from applying card opacity to white text only", () => {
    const input = {
      foreground: "#ffffff",
      surface: "#000000",
      backdrop: "#ffffff",
      opacities: [0.5],
    } as const;

    const rendered = compositeOpacitySubtree(input);
    const subtreeRatio = effectiveOpacitySubtreeContrast(input);
    const oldApiInput = {
      foreground: input.foreground,
      background: input.surface,
      opacities: input.opacities,
    } as const;

    expect(rendered.foreground).toMatchObject({ red: 255, green: 255, blue: 255, alpha: 1 });
    expect(rendered.surface).toMatchObject({ red: 127.5, green: 127.5, blue: 127.5, alpha: 1 });
    expect(subtreeRatio).toBeCloseTo(3.95, 1);
    expect(meetsOpacitySubtreeTextContrast(input)).toBe(false);
    expect(() => assertOpacitySubtreeTextContrast(input)).toThrow();

    expect(effectiveContrast(oldApiInput)).toBeCloseTo(5.3, 1);
    expect(meetsTextContrast(oldApiInput)).toBe(true);
  });

  it("multiplies a chain of two ancestor opacities for the whole subtree", () => {
    const input = {
      foreground: "#ffffff",
      surface: "#000000",
      backdrop: "#ffffff",
    } as const;

    const singleAncestor = effectiveOpacitySubtreeContrast({ ...input, opacities: [0.65] });
    const nestedAncestors = effectiveOpacitySubtreeContrast({
      ...input,
      opacities: [0.8, 0.8125],
    });

    expect(nestedAncestors).toBeCloseTo(singleAncestor, 10);
  });

  it("keeps opacity 1 equal to the unopacified subtree contrast", () => {
    const input = {
      foreground: "#ffffff",
      surface: "#000000",
      backdrop: "#ffffff",
    } as const;

    expect(effectiveOpacitySubtreeContrast({ ...input, opacities: [1] })).toBeCloseTo(
      effectiveOpacitySubtreeContrast({ ...input, opacities: [] }),
      10,
    );
    expect(effectiveOpacitySubtreeContrast({ ...input, opacities: [1] })).toBeCloseTo(21, 10);
  });
});

describe("WCAG reference pairs", () => {
  it("computes black on white as 21:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
  });

  it("computes the verified #767676 on white mid-grey pair", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.5422, 3);
  });
});

describe("theme surfaces", () => {
  for (const mode of MODES) {
    it(`${mode} keeps its task surfaces opaque`, () => {
      const theme = TASK_AGENT_THEMES[mode];

      expect(theme.background).toMatch(/^#[\da-f]{6}$/i);
      expect(theme.card).toMatch(/^#[\da-f]{6}$/i);
    });
  }
});

describe("selected mobile theme palette", () => {
  it("uses the selected built-in surfaces and neutral text in both appearances", () => {
    const themeId = "grove" as const;

    for (const mode of MODES) {
      const theme = getTaskAgentTheme(mode, themeId);
      const variables = getMobileThemeVariables(themeId, mode);

      expect(theme.background).toBe(variables["--color-screen"]);
      expect(theme.card).toBe(variables["--color-card"]);
      expect(theme.text.foreground).toBe(variables["--color-foreground"]);
      expect(theme.background).not.toBe(TASK_AGENT_THEMES[mode].background);
      expect(theme.text.info).toBe(TASK_AGENT_THEMES[mode].text.info);
      expect(theme.text.success).toBe(TASK_AGENT_THEMES[mode].text.success);
      expect(theme.text.warn).toBe(TASK_AGENT_THEMES[mode].text.warn);
      expect(theme.text.danger).toBe(TASK_AGENT_THEMES[mode].text.danger);
    }
  });

  it("keeps the existing task palette when the mobile default theme is selected", () => {
    expect(getTaskAgentTheme("light", "t3-code")).toBe(TASK_AGENT_THEMES.light);
    expect(getTaskAgentTheme("dark", "t3-code")).toBe(TASK_AGENT_THEMES.dark);
  });
});
