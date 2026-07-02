import * as Schema from "effect/Schema";

export const ThemePreference = Schema.Literals(["light", "dark", "system"]);
export type Theme = typeof ThemePreference.Type;
export const THEME_STORAGE_KEY = "t3code:theme";

export class ThemeStorageError extends Schema.TaggedErrorClass<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError);

export function readThemePreference(): Theme | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: THEME_STORAGE_KEY,
      cause,
    });
  }
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return null;
}

export function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: THEME_STORAGE_KEY,
      theme,
      cause,
    });
  }
}
