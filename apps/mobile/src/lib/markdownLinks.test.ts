import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownLinkPresentation } from "./markdownLinks";

describe("resolveMarkdownLinkPresentation", () => {
  it("opens relative directory links as workspace paths", () => {
    expect(resolveMarkdownLinkPresentation("src/")).toMatchObject({
      kind: "file",
      path: "src/",
    });
    expect(resolveMarkdownLinkPresentation("docs/My Folder/")).toMatchObject({
      kind: "file",
      path: "docs/My Folder/",
    });
  });

  it("treats protocol-relative media as an external URL, not a filesystem path", () => {
    expect(resolveMarkdownLinkPresentation("//cdn.example.com/clip.mp4?sig=a%2fb#t=2")).toEqual({
      kind: "external",
      href: "https://cdn.example.com/clip.mp4?sig=a%2fb#t=2",
      host: "cdn.example.com",
    });
  });

  it("separates encoded filename characters from a video playback fragment", () => {
    expect(resolveMarkdownLinkPresentation("/tmp/clip%23one.mp4#t=2")).toMatchObject({
      path: "/tmp/clip#one.mp4",
      label: "clip#one.mp4",
      icon: "video",
    });
  });

  it.each([
    ["file:///Users/julius/project/src/main.ts#L42C7", "/Users/julius/project/src/main.ts"],
    ["file://server/share/src/main.ts#L42C7", "\\\\server\\share\\src\\main.ts"],
  ])("preserves the file URL path and position for %s", (href, path) => {
    expect(resolveMarkdownLinkPresentation(href)).toEqual({
      kind: "file",
      href,
      icon: "typescript",
      label: "main.ts · L42:C7",
      path,
      line: 42,
      column: 7,
    });
  });

  it("recognizes relative source paths and bare filenames", () => {
    expect(resolveMarkdownLinkPresentation("apps/mobile/src/index.ts:10")).toEqual({
      kind: "file",
      href: "apps/mobile/src/index.ts:10",
      icon: "typescript",
      label: "index.ts · L10",
      path: "apps/mobile/src/index.ts",
      line: 10,
    });
    expect(resolveMarkdownLinkPresentation("AGENTS.md")).toEqual({
      kind: "file",
      href: "AGENTS.md",
      icon: "agents",
      label: "AGENTS.md",
      path: "AGENTS.md",
    });
    expect(resolveMarkdownLinkPresentation("package.json")).toEqual({
      kind: "file",
      href: "package.json",
      icon: "npm",
      label: "package.json",
      path: "package.json",
    });
  });

  // regression: #8098 open agent file links in the file viewer
  it("recognizes spaced relative paths", () => {
    expect(resolveMarkdownLinkPresentation("docs/My%20Folder/checklist.xml")).toMatchObject({
      kind: "file",
      path: "docs/My Folder/checklist.xml",
      label: "checklist.xml",
    });
  });

  it("does not style app routes as file links", () => {
    expect(resolveMarkdownLinkPresentation("/chat/settings")).toEqual({
      kind: "link",
      href: null,
    });
  });
});

describe("resolveMarkdownLinkPresentation file URLs", () => {
  it.each([
    ["file:///C:/Users/dara/project/image.png", "C:/Users/dara/project/image.png"],
    ["file:///Users/dara/project/image.png", "/Users/dara/project/image.png"],
    ["file:///Users/dara/project/image%20one.png", "/Users/dara/project/image one.png"],
    ["file://server/share/image%20one.png", "\\\\server\\share\\image one.png"],
  ])("normalizes %s to %s", (href, path) => {
    expect(resolveMarkdownLinkPresentation(href)).toMatchObject({
      kind: "file",
      path,
    });
  });
});

describe("resolveMarkdownLinkPresentation blocked schemes", () => {
  it.each(["javascript:alert(1)", "content://media/image/1"])('does not open "%s"', (href) => {
    expect(resolveMarkdownLinkPresentation(href)).toEqual({
      kind: "link",
      href: null,
    });
  });
});
