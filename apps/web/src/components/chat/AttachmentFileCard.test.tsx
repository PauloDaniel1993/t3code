import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { AttachmentFileCard } from "./AttachmentFileCard";

const pdf = {
  type: "document" as const,
  id: "pdf-1",
  name: "manual.pdf",
  mimeType: "application/pdf" as const,
  sizeBytes: 2048,
};
const source = {
  type: "file" as const,
  id: "file-1",
  name: "Program.cs",
  mimeType: "text/plain",
  sizeBytes: 512,
};

describe("AttachmentFileCard", () => {
  it("renders draft metadata and a labeled keyboard-operable remove button", () => {
    const markup = renderToStaticMarkup(
      <AttachmentFileCard
        attachment={{ ...pdf, file: new File(["pdf"], pdf.name) }}
        variant="draft"
        onRemove={vi.fn()}
      />,
    );
    expect(markup).toContain("manual.pdf");
    expect(markup).toContain("2.0 KiB");
    expect(markup).toContain("PDF");
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('aria-label="Remove manual.pdf"');
  });

  it("renders separate PDF open and download actions", () => {
    const markup = renderToStaticMarkup(
      <AttachmentFileCard
        attachment={pdf}
        variant="persisted"
        openUrl="https://assets/open"
        downloadUrl="https://assets/download"
      />,
    );
    expect(markup).toContain('aria-label="Open manual.pdf"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('aria-label="Download manual.pdf"');
    expect(markup).toContain('download="manual.pdf"');
  });

  it("renders generic download only and metadata-only state without broken actions", () => {
    const downloadable = renderToStaticMarkup(
      <AttachmentFileCard
        attachment={source}
        variant="persisted"
        downloadUrl="https://assets/download"
      />,
    );
    expect(downloadable).toContain('aria-label="Download Program.cs"');
    expect(downloadable).not.toContain('aria-label="Open Program.cs"');

    const metadataOnly = renderToStaticMarkup(
      <AttachmentFileCard attachment={source} variant="persisted" />,
    );
    expect(metadataOnly).toContain("Program.cs");
    expect(metadataOnly).not.toContain("href=");
    expect(metadataOnly).not.toContain("<img");
    expect(metadataOnly).not.toContain("<iframe");
  });
});
