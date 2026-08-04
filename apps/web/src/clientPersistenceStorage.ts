import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { LocalStorageOperationError, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

const decodeRawClientSettingsJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeClientSettingsJson = Schema.decodeSync(Schema.fromJsonString(ClientSettingsSchema));

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export interface BrowserClientSettingsReadResult {
  readonly settings: ClientSettings | null;
  readonly appearanceWasPersisted: boolean;
}

function hasOwnAppearance(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "appearance");
}

export function readBrowserClientSettingsWithMeta(): BrowserClientSettingsReadResult {
  if (!hasWindow()) {
    return { settings: null, appearanceWasPersisted: false };
  }

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
  } catch (cause) {
    console.error(
      "Could not read persisted client settings.",
      new LocalStorageOperationError({
        operation: "read",
        storageKey: CLIENT_SETTINGS_STORAGE_KEY,
        cause,
      }),
    );
    return { settings: null, appearanceWasPersisted: false };
  }

  if (!raw) {
    return { settings: null, appearanceWasPersisted: false };
  }

  try {
    const rawValue = decodeRawClientSettingsJson(raw);
    const settings = decodeClientSettingsJson(raw);
    return { settings, appearanceWasPersisted: hasOwnAppearance(rawValue) };
  } catch (cause) {
    console.error(
      "Could not read persisted client settings.",
      new LocalStorageOperationError({
        operation: "decode",
        storageKey: CLIENT_SETTINGS_STORAGE_KEY,
        cause,
      }),
    );
    return { settings: null, appearanceWasPersisted: false };
  }
}

export function readBrowserClientSettings(): ClientSettings | null {
  return readBrowserClientSettingsWithMeta().settings;
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
