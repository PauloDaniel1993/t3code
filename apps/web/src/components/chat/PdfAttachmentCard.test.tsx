import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PdfAttachmentCard } from "./PdfAttachmentCard";

const documentAttachment = {
  type: "document" as const,
  id: "document-1",
  name: "Architecture notes.pdf",
  mimeType: "application/pdf" as const,
  sizeBytes: 1_572_864,
};

describe("PdfAttachmentCard", () => {
  it("shows accessible draft metadata, open, and remove controls", () => {
    const markup = renderToStaticMarkup(
      <PdfAttachmentCard
        attachment={{ ...documentAttachment, assetUrl: "blob:architecture" }}
        mode="draft"
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain("Architecture notes.pdf");
    expect(markup).toContain("PDF · 1.5 MB");
    expect(markup).toContain('aria-label="Open Architecture notes.pdf"');
    expect(markup).toContain('href="blob:architecture"');
    expect(markup).toContain('aria-label="Remove Architecture notes.pdf"');
    expect(markup).not.toContain('aria-label="Download Architecture notes.pdf"');
  });

  it("uses keyboard-focusable links and preserves the original download filename", () => {
    const markup = renderToStaticMarkup(
      <PdfAttachmentCard
        attachment={{
          ...documentAttachment,
          assetUrl: "https://environment.test/api/assets/token/generated.pdf",
        }}
        mode="history"
      />,
    );

    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noreferrer noopener"');
    expect(markup).toContain(
      'href="https://environment.test/api/assets/token/Architecture%20notes.pdf?download=1"',
    );
    expect(markup).toContain('download="Architecture notes.pdf"');
    expect(markup).toContain('aria-label="Download Architecture notes.pdf"');
  });

  it("keeps metadata visible and disables unavailable open/download controls", () => {
    const markup = renderToStaticMarkup(
      <PdfAttachmentCard attachment={documentAttachment} mode="history" />,
    );

    expect(markup).toContain("Architecture notes.pdf");
    expect(markup).toContain('aria-label="Open Architecture notes.pdf"');
    expect(markup).toContain('aria-label="Download Architecture notes.pdf"');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).not.toContain("href=");
  });
});
