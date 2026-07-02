import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  FONT_SIZE_ROWS,
  MONO_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  clampInt,
  createDebouncedCommit,
  fontOptionLabel,
  getFontSizeDefaults,
  validateHexColorInput,
  type FontSizeField,
} from "./AppearanceSettings.logic";

afterEach(() => {
  vi.useRealTimers();
});

describe("AppearanceSettings logic", () => {
  it("clamps numeric drafts to rounded integer bounds", () => {
    expect(clampInt(null, 12, 20)).toBe(12);
    expect(clampInt(Number.NaN, 12, 20)).toBe(12);
    expect(clampInt(11, 12, 20)).toBe(12);
    expect(clampInt(20.8, 12, 20)).toBe(20);
    expect(clampInt(16.4, 12, 20)).toBe(16);
    expect(clampInt(16.5, 12, 20)).toBe(17);
  });

  it("resolves font labels from known options and falls back to Custom", () => {
    expect(fontOptionLabel(UI_FONT_OPTIONS[0]!.value, UI_FONT_OPTIONS)).toBe("DM Sans");
    expect(fontOptionLabel(MONO_FONT_OPTIONS[0]!.value, MONO_FONT_OPTIONS)).toBe("System Mono");
    expect(fontOptionLabel('"Commit Mono", monospace', MONO_FONT_OPTIONS)).toBe("Custom");
  });

  it("keeps font-size defaults aligned to the planned ranges", () => {
    const expected: Record<FontSizeField, { defaultValue: number; min: number; max: number }> = {
      uiFontSizePx: { defaultValue: 14, min: 12, max: 20 },
      chatFontSizePx: { defaultValue: 14, min: 13, max: 24 },
      codeFontSizePx: { defaultValue: 12, min: 11, max: 22 },
      terminalFontSizePx: { defaultValue: 12, min: 11, max: 22 },
    };

    for (const row of FONT_SIZE_ROWS) {
      expect({ defaultValue: getFontSizeDefaults(row.field), min: row.min, max: row.max }).toEqual(
        expected[row.field],
      );
    }
  });

  it("flushes the latest debounced value in set order", () => {
    const committed: number[] = [];
    const debounced = createDebouncedCommit((value: number) => committed.push(value), 180);

    debounced.set(1);
    debounced.set(2);
    expect(committed).toEqual([]);

    debounced.flush();
    expect(committed).toEqual([2]);

    debounced.flush();
    expect(committed).toEqual([2]);
  });

  it("cancels pending debounced commits", () => {
    vi.useFakeTimers();
    const committed: string[] = [];
    const debounced = createDebouncedCommit((value: string) => committed.push(value), 250);

    debounced.set("pending");
    debounced.cancel();
    vi.runAllTimers();
    debounced.flush();

    expect(committed).toEqual([]);
  });

  it("normalizes hex validation and exposes the rejection message", () => {
    expect(validateHexColorInput("  #aabbcc  ")).toEqual({ isValid: true, error: null });
    expect(validateHexColorInput("blue")).toEqual({
      isValid: false,
      error: "Use a #RRGGBB color.",
    });
  });
});
