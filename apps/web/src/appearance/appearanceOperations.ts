import type {
  AppearanceColorScheme,
  AppearanceSettings,
  AppearanceTheme,
  AppearanceThemeVariant,
} from "@t3tools/contracts";

import {
  BUILT_IN_APPEARANCE_THEMES,
  collidesWithBuiltInId,
  isBuiltInThemeId,
  type AppearanceThemeDefinition,
} from "./appearanceThemes.ts";
import { validateAppearanceTheme } from "./appearanceValidation.ts";

export type AppearanceThemeIdGenerator = (slug: string, attempt: number) => string;

export interface AppearanceThemeUpdate extends Partial<Omit<AppearanceTheme, "id" | "variants">> {
  readonly variants?: {
    readonly light?: Partial<AppearanceThemeVariant>;
    readonly dark?: Partial<AppearanceThemeVariant>;
  };
}

const CUSTOM_THEME_ID_PATTERN = /^custom-[a-z0-9][a-z0-9-]{2,63}$/;
const MAX_APPEARANCE_THEME_NAME_LENGTH = 64;

function slugifyThemeName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length >= 3 ? slug : "theme";
}

export const defaultAppearanceThemeIdGenerator: AppearanceThemeIdGenerator = (slug) => {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `custom-${slug}-${suffix}`;
};

function requireCustomTheme(state: AppearanceSettings, id: string): AppearanceTheme {
  if (isBuiltInThemeId(id) || collidesWithBuiltInId(id)) {
    throw new Error(`Built-in appearance theme "${id}" cannot be modified.`);
  }
  const theme = state.customThemes[id];
  if (theme === undefined) {
    throw new Error(`Unknown custom appearance theme "${id}".`);
  }
  return theme;
}

function nextCopyName(state: AppearanceSettings, sourceName: string): string {
  const usedNames = new Set(
    Object.values(state.customThemes).map((theme) => theme.name.trim().toLowerCase()),
  );
  const trimmedSourceName = sourceName.trim();
  const candidateForSuffix = (suffix: string): string =>
    `${trimmedSourceName.slice(0, MAX_APPEARANCE_THEME_NAME_LENGTH - suffix.length).trim()}${suffix}`;
  const first = candidateForSuffix(" copy");
  if (!usedNames.has(first.toLowerCase())) {
    return first;
  }

  for (let copyNumber = 2; copyNumber < 10_000; copyNumber += 1) {
    const candidate = candidateForSuffix(` copy ${copyNumber}`);
    if (!usedNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  throw new Error(`Unable to generate a copy name for appearance theme "${sourceName}".`);
}

function generateThemeId(
  state: AppearanceSettings,
  sourceName: string,
  generator: AppearanceThemeIdGenerator,
): string {
  const slug = slugifyThemeName(sourceName);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = generator(slug, attempt);
    if (
      CUSTOM_THEME_ID_PATTERN.test(candidate) &&
      !collidesWithBuiltInId(candidate) &&
      state.customThemes[candidate] === undefined
    ) {
      return candidate;
    }
  }
  throw new Error("Unable to generate a unique valid custom appearance theme id.");
}

function sourceTheme(state: AppearanceSettings, sourceId: string): AppearanceThemeDefinition {
  if (isBuiltInThemeId(sourceId)) {
    return BUILT_IN_APPEARANCE_THEMES[sourceId];
  }
  const custom = state.customThemes[sourceId];
  if (custom === undefined) {
    throw new Error(`Unknown appearance theme "${sourceId}".`);
  }
  return custom;
}

/** Built-in update, rename, and delete attempts throw as programmer errors. */
export function duplicateAppearanceTheme(
  state: AppearanceSettings,
  sourceId: string,
  generator: AppearanceThemeIdGenerator = defaultAppearanceThemeIdGenerator,
): AppearanceSettings {
  const source = sourceTheme(state, sourceId);
  const id = generateThemeId(state, source.name, generator);
  const duplicate = validateAppearanceTheme({
    ...source,
    id,
    name: nextCopyName(state, source.name),
    variants: {
      light: { ...source.variants.light },
      dark: { ...source.variants.dark },
    },
  });

  return {
    ...state,
    activeThemeId: id,
    customThemeOrder: [...state.customThemeOrder, id],
    customThemes: { ...state.customThemes, [id]: duplicate },
  };
}

export function renameAppearanceTheme(
  state: AppearanceSettings,
  id: string,
  name: string,
): AppearanceSettings {
  if (name.trim().length === 0) {
    throw new Error("Appearance theme name must not be empty.");
  }
  return updateAppearanceTheme(state, id, { name: name.trim() });
}

export function deleteAppearanceTheme(state: AppearanceSettings, id: string): AppearanceSettings {
  requireCustomTheme(state, id);
  const customThemes = { ...state.customThemes };
  delete customThemes[id];
  return {
    ...state,
    activeThemeId: state.activeThemeId === id ? "default" : state.activeThemeId,
    customThemeOrder: state.customThemeOrder.filter((themeId) => themeId !== id),
    customThemes,
  };
}

export function updateAppearanceTheme(
  state: AppearanceSettings,
  id: string,
  partial: AppearanceThemeUpdate,
): AppearanceSettings {
  const current = requireCustomTheme(state, id);
  const updated = validateAppearanceTheme({
    ...current,
    ...partial,
    id,
    variants: {
      light: { ...current.variants.light, ...partial.variants?.light },
      dark: { ...current.variants.dark, ...partial.variants?.dark },
    },
  });
  return {
    ...state,
    customThemes: { ...state.customThemes, [id]: updated },
  };
}

export function setColorScheme(
  state: AppearanceSettings,
  colorScheme: AppearanceColorScheme,
): AppearanceSettings {
  if (colorScheme !== "system" && colorScheme !== "light" && colorScheme !== "dark") {
    throw new Error(`Invalid appearance color scheme "${String(colorScheme)}".`);
  }
  return { ...state, colorScheme };
}

export function setActiveTheme(state: AppearanceSettings, id: string): AppearanceSettings {
  if (!isBuiltInThemeId(id) && state.customThemes[id] === undefined) {
    return state;
  }
  return { ...state, activeThemeId: id };
}

export function resetAppearance(state: AppearanceSettings): AppearanceSettings {
  return { ...state, activeThemeId: "default", colorScheme: "system" };
}
