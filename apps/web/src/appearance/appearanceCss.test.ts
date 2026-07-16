// @effect-diagnostics nodeBuiltinImport:off - This node-only test verifies checked-in CSS fallbacks.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_APPEARANCE_APP_PROPERTY_VALUES } from "./applyAppearance.ts";

const indexCssPath = NodeURL.fileURLToPath(new URL("../index.css", import.meta.url));
const settingsLayoutPath = NodeURL.fileURLToPath(
  new URL("../components/settings/settingsLayout.tsx", import.meta.url),
);
const settingsRoutePath = NodeURL.fileURLToPath(new URL("../routes/settings.tsx", import.meta.url));
const indexCss = NodeFS.readFileSync(indexCssPath, "utf8");
const settingsLayout = NodeFS.readFileSync(settingsLayoutPath, "utf8");
const settingsRoute = NodeFS.readFileSync(settingsRoutePath, "utf8");
const rootDeclarations = indexCss.match(
  /:root \{\n  color-scheme: light;(?<declarations>[\s\S]*?)\n  --radius:/,
)?.groups?.declarations;

function parseAppDeclarations(declarations: string): Record<string, string> {
  return Object.fromEntries(
    [...declarations.matchAll(/^\s*(--app-[\w-]+):\s*([\s\S]*?);/gm)]
      .filter(([, property]) =>
        Object.hasOwn(DEFAULT_APPEARANCE_APP_PROPERTY_VALUES, property ?? ""),
      )
      .map(([, property, value]) => [property, value?.replace(/\s+/g, " ").trim() ?? ""]),
  );
}

describe("appearance CSS defaults", () => {
  it("binds root app fallback variables to the runtime Default values", () => {
    expect(rootDeclarations).toBeDefined();
    expect(parseAppDeclarations(rootDeclarations!)).toEqual(DEFAULT_APPEARANCE_APP_PROPERTY_VALUES);
  });

  it("binds Tailwind font tokens to the appearance font variables", () => {
    expect(indexCss).toMatch(/--font-sans:\s*var\(--app-ui-font-family\);/);
    expect(indexCss).toMatch(/--font-mono:\s*var\(--app-mono-font-family\);/);
  });

  it("binds chat and settings UI text to their runtime size variables", () => {
    expect(indexCss).toMatch(
      /\.chat-markdown\s*\{[\s\S]*?font-size:\s*var\(--app-chat-font-size\);/,
    );
    expect(indexCss).toMatch(/--app-ui-font-delta:\s*calc\(var\(--app-ui-font-size\) - 14px\);/);
    expect(indexCss).toMatch(
      /\.settings-ui-text-sm\s*\{\s*font-size:\s*calc\(14px \+ var\(--app-ui-font-delta\)\);/,
    );
    expect(indexCss).toMatch(
      /\.settings-ui-text-13\s*\{\s*font-size:\s*calc\(13px \+ var\(--app-ui-font-delta\)\);/,
    );
  });

  it("binds SettingsRow titles to the 13px UI-size delta", () => {
    expect(settingsLayout).toMatch(/<h3 className="settings-ui-text-13\s/);
    expect(settingsLayout).not.toMatch(/<h3 className="text-\[13px\]/);
  });

  it("does not scope the settings layout with a font-size root", () => {
    expect(indexCss).not.toMatch(/\[data-settings-ui\]/);
    expect(settingsRoute).not.toMatch(/data-settings-ui/);
  });
});
