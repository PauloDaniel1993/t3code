import { AppearanceTheme, type AppearanceThemeVariant } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { contrastRatio } from "./appearanceContrast.ts";
import { chooseContrastingForeground } from "./appearanceDerived.ts";

const decodeAppearanceTheme = Schema.decodeUnknownSync(AppearanceTheme);

function validateVariantContrast(
  variantName: "light" | "dark",
  variant: AppearanceThemeVariant,
): void {
  const textContrast = contrastRatio(variant.foreground, variant.background);
  if (textContrast < 4.5) {
    throw new Error(
      `Invalid ${variantName} variant: foreground/background contrast ${textContrast.toFixed(2)}:1 is below 4.5:1.`,
    );
  }

  const primaryForeground = chooseContrastingForeground(variant.accent);
  const accentContrast = contrastRatio(primaryForeground, variant.accent);
  if (accentContrast < 3) {
    throw new Error(
      `Invalid ${variantName} variant: accent/primary-foreground contrast ${accentContrast.toFixed(2)}:1 is below 3.0:1.`,
    );
  }
}

/**
 * Decodes and validates a complete custom appearance theme, returning its
 * normalized typed value or throwing a descriptive Error. Body text requires
 * WCAG AA 4.5:1 foreground/background contrast. Accent controls use the WCAG
 * UI-component minimum of 3.0:1 against the better of #ffffff and #111111;
 * this preserves the exact built-in Default dark accent while keeping copied
 * built-ins valid and editable.
 */
export function validateAppearanceTheme(theme: unknown): AppearanceTheme {
  let decoded: AppearanceTheme;
  try {
    decoded = decodeAppearanceTheme(theme);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid appearance theme shape: ${detail}`, { cause: cause });
  }

  validateVariantContrast("light", decoded.variants.light);
  validateVariantContrast("dark", decoded.variants.dark);
  return decoded;
}
