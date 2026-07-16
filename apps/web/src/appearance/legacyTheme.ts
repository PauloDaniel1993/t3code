export const THEME_STORAGE_KEY = "t3code:theme";

export type LegacyThemePreference = "light" | "dark" | "system";

/** The single parser for the legacy pre-React theme preference mirror. */
export function parseThemePreference(value: string | null): LegacyThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}
