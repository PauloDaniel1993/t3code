import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  CHAT_MARKDOWN_REHYPE_PLUGINS,
} from "@t3tools/shared/markdownPipeline";
import { describe, expect, it } from "vite-plus/test";
import { rewriteMarkdownFileHrefForRendering } from "./markdown-links";

describe("markdown file link rendering", () => {
  it("preserves an absolute windows file target through sanitization", () => {
    const path = "C:/work/reports/output/pdf/quarterly-report.pdf";
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={CHAT_MARKDOWN_REHYPE_PLUGINS}
        urlTransform={(href) =>
          rewriteMarkdownFileHrefForRendering(href) ?? defaultUrlTransform(href)
        }
        components={{
          a({ href, children }) {
            return <a href={href}>{children}</a>;
          },
        }}
      >
        {`[Download the PDF](${path})`}
      </ReactMarkdown>,
    );

    expect(html).toContain(`href="file:///C:/work/reports/output/pdf/`);
    expect(html).toContain(">Download the PDF</a>");
  });
});
