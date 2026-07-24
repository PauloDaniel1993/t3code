import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import {
  rehypeRewriteMarkdownFileHrefs,
  resolvePreservedMarkdownFileHref,
  rewriteMarkdownFileHrefForRendering,
} from "./markdown-links";

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    a: [...(defaultSchema.attributes?.a ?? []), "dataT3MarkdownFileHref"],
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

describe("markdown file link rendering", () => {
  it("preserves an absolute windows file target through sanitization", () => {
    const path =
      "I:/projects/Personal/jobs/output/pdf/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf";
    const html = renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeRaw,
          rehypeRewriteMarkdownFileHrefs,
          [rehypeSanitize, SANITIZE_SCHEMA],
        ]}
        urlTransform={(href) =>
          rewriteMarkdownFileHrefForRendering(href) ?? defaultUrlTransform(href)
        }
        components={{
          a({ node, href, children }) {
            return (
              <a data-preserved-href={resolvePreservedMarkdownFileHref(node, href)}>{children}</a>
            );
          },
        }}
      >
        {`[Download the PDF](${path})`}
      </ReactMarkdown>,
    );

    expect(html).toContain(`data-preserved-href="file:///I:/projects/Personal/jobs/output/pdf/`);
    expect(html).toContain(">Download the PDF</a>");
  });
});
