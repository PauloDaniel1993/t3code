import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownLinkPresentation } from "./markdownLinks";

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
