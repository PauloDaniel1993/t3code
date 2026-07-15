import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FileAttachmentCard } from "./PdfAttachmentCard";

const documentAttachment = {
  type: "document" as const,
  id: "document-1",
  name: "Architecture notes.pdf",
  mimeType: "application/pdf" as const,
  sizeBytes: 1_572_864,
};

const fileAttachment = {
  type: "file" as const,
  id: "file-1",
  name: "sales report.csv",
  mimeType: "text/csv",
  sizeBytes: 20_480,
};

describe("FileAttachmentCard (PDF)", () => {
  it("shows accessible draft metadata, open, and remove controls", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentCard
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
      <FileAttachmentCard
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
      <FileAttachmentCard attachment={documentAttachment} mode="history" />,
    );

    expect(markup).toContain("Architecture notes.pdf");
    expect(markup).toContain('aria-label="Open Architecture notes.pdf"');
    expect(markup).toContain('aria-label="Download Architecture notes.pdf"');
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
    expect(markup).not.toContain("href=");
  });
});

describe("FileAttachmentCard (generic file)", () => {
  it("shows an extension badge and remove control in draft mode without an open action", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentCard
        attachment={{ ...fileAttachment, assetUrl: "blob:sales" }}
        mode="draft"
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain("sales report.csv");
    expect(markup).toContain("CSV · 20 KB");
    expect(markup).toContain('aria-label="Remove sales report.csv"');
    expect(markup).not.toContain('aria-label="Open sales report.csv"');
    expect(markup).not.toContain('aria-label="Download sales report.csv"');
  });

  it("offers download with the original filename in history mode", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentCard
        attachment={{
          ...fileAttachment,
          assetUrl: "https://environment.test/api/assets/token/generated.csv",
        }}
        mode="history"
      />,
    );

    expect(markup).toContain(
      'href="https://environment.test/api/assets/token/sales%20report.csv?download=1"',
    );
    expect(markup).toContain('download="sales report.csv"');
    expect(markup).toContain('aria-label="Download sales report.csv"');
    expect(markup).not.toContain('aria-label="Open sales report.csv"');
  });

  it("falls back to a generic badge when the name has no extension", () => {
    const markup = renderToStaticMarkup(
      <FileAttachmentCard attachment={{ ...fileAttachment, name: "notes" }} mode="history" />,
    );

    expect(markup).toContain("FILE · 20 KB");
  });
});
