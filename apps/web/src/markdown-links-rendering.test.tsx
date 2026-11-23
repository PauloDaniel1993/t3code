import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { createMarkdownRenderer } from "./components/chat/markdownRenderer";
import { resolveMarkdownFileLinkMeta } from "./markdown-links";

const renderer = createMarkdownRenderer({
  markdown: { math: false, breaks: false, escapeHtml: false, insights: false, extensions: {} },
  components: {},
  urlTransform: (url) => url,
});

describe("markdown file link rendering", () => {
  it("preserves an absolute Windows file target through sanitization", () => {
    const path = "C:/work/reports/output/pdf/quarterly-report.pdf";
    const entry = renderer.parse(`[Download the PDF](${path})`);
    const html = renderToStaticMarkup(renderer.element(entry));

    expect(html).toContain(`href="file:///${path}"`);
    expect(html).toContain(">Download the PDF</a>");
  });

  it.each([
    ["docs/My Folder", "My Folder"],
    ...["md", "html", "xml"].map((extension) => {
      const filename = `Updated cutover checklist.${extension}`;
      return [filename, filename];
    }),
  ])("resolves a rendered destination containing spaces (%s)", (path, basename) => {
    const { tree } = renderer.parse(`[Open](<${path}>)`);
    const paragraph = tree.children[0];
    const link = paragraph?.type === "element" ? paragraph.children[0] : undefined;
    const href = link?.type === "element" ? link.properties.href : undefined;

    expect(href).toBe(path.replaceAll(" ", "%20"));
    expect(
      resolveMarkdownFileLinkMeta(typeof href === "string" ? href : undefined, "/repo/project"),
    ).toMatchObject({
      targetPath: `/repo/project/${path}`,
      workspaceRelativePath: path,
      basename,
    });
  });
});
