import { describe, expect, it } from "vite-plus/test";

import {
  isMarkdownFileExternalOpenModifier,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileHrefForRendering,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

describe("isMarkdownFileExternalOpenModifier", () => {
  it("recognizes Ctrl+click and Cmd+click", () => {
    expect(isMarkdownFileExternalOpenModifier({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isMarkdownFileExternalOpenModifier({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(isMarkdownFileExternalOpenModifier({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe("rewriteMarkdownFileHrefForRendering", () => {
  it("wraps absolute windows paths in an allowed file URL for markdown rendering", () => {
    expect(
      rewriteMarkdownFileHrefForRendering(
        "I:/projects/Personal/jobs/output/pdf/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
      ),
    ).toBe(
      "file:///I:/projects/Personal/jobs/output/pdf/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
    );
  });

  it("preserves file URLs so the markdown sanitizer can allow them", () => {
    expect(
      rewriteMarkdownFileHrefForRendering(
        "file:///D:/Programme/t3code/apps/web/src/markdown-links.ts#L42",
      ),
    ).toBe("file:///D:/Programme/t3code/apps/web/src/markdown-links.ts#L42");
  });

  it("leaves non-file links to the default markdown URL transform", () => {
    expect(rewriteMarkdownFileHrefForRendering("https://example.com/docs")).toBeNull();
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });

  it("unwraps angle-bracketed file uri hrefs", () => {
    expect(
      rewriteMarkdownFileUriHref(" <file:///D:/Programme/t3code/apps/web/src/markdown-links.ts> "),
    ).toBe("D:/Programme/t3code/apps/web/src/markdown-links.ts");
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "t3code/apps/web/src/session-logic.ts:501",
      workspaceRelativePath: "apps/web/src/session-logic.ts",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath:
        "t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
      workspaceRelativePath:
        "apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("does not create a preview path for files outside the workspace", () => {
    expect(resolveMarkdownFileLinkMeta("/tmp/report.ts", "/repo/project")).toMatchObject({
      workspaceRelativePath: null,
    });
  });

  it("creates a workspace-relative preview path for the generated PDF link", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "I:/projects/Personal/jobs/output/pdf/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
        "I:/projects/Personal/jobs",
      ),
    ).toMatchObject({
      filePath:
        "I:/projects/Personal/jobs/output/pdf/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
      workspaceRelativePath: "output/pdf/PauloDaniel_Senior_Staff_TypeScript_Engineer.pdf",
    });
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
  });
});
