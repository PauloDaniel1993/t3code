import { useEffect } from "react";
import { useClientSettings } from "~/clientSettingsStore";
import { syncBrowserChromeTheme, useTheme } from "~/hooks/useTheme";
import { applyAppearanceCssVariables } from "./appearanceCss";

export function AppearanceRuntime() {
  const appearance = useClientSettings((settings) => settings.appearance);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    applyAppearanceCssVariables(document.documentElement, appearance, resolvedTheme);
    syncBrowserChromeTheme();
  }, [appearance, resolvedTheme]);

  return null;
}
