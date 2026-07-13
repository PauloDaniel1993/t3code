import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("PanelLayoutControls", () => {
  it("renders the Project Browser toggle with count and activity state", () => {
    const html = renderToStaticMarkup(
      <PanelLayoutControls
        terminalAvailable
        terminalOpen={false}
        terminalShortcutLabel="Ctrl+J"
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel="Ctrl+Alt+B"
        projectBrowserAvailable
        projectBrowserOpen
        projectBrowserTabCount={3}
        projectBrowserActive
        projectBrowserShortcutLabel="Ctrl+Shift+B"
        onToggleTerminal={() => {}}
        onToggleRightPanel={() => {}}
        onToggleProjectBrowser={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Toggle Project Browser"');
    expect(html).toContain("3");
    expect(html).toContain("animate-pulse");
  });

  it("disables the Project Browser control without desktop capability", () => {
    const html = renderToStaticMarkup(
      <PanelLayoutControls
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        projectBrowserAvailable={false}
        projectBrowserOpen={false}
        projectBrowserTabCount={0}
        projectBrowserActive={false}
        projectBrowserShortcutLabel={null}
        onToggleTerminal={() => {}}
        onToggleRightPanel={() => {}}
        onToggleProjectBrowser={() => {}}
      />,
    );

    expect(html).toMatch(/aria-label="Toggle Project Browser"[^>]*disabled/);
  });
});
