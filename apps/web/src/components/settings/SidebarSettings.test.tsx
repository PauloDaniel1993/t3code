import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarSettingsPanel } from "./SidebarSettings";

describe("SidebarSettingsPanel", () => {
  it("renders the first-class sidebar settings surface", () => {
    const html = renderToStaticMarkup(<SidebarSettingsPanel />);

    expect(html).toContain("Repository grouping");
    expect(html).toContain("New category");
    expect(html).toContain("Uncategorized");
    expect(html).toContain("Hidden categories");
    expect(html).toContain("Reset sidebar organization");
  });
});
