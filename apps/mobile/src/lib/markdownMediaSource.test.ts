import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveMobileMarkdownMediaSource } from "./markdownMediaSource";

describe("mobile Markdown draft media", () => {
  it("authorizes relative images and videos against the draft directory", () => {
    for (const name of ["diagram.svg", "clip.mp4"]) {
      expect(
        resolveMobileMarkdownMediaSource(`./${name}`, {
          threadId: undefined,
          workspaceRoot: "/project/docs",
          imageEmbed: true,
        }),
      ).toMatchObject({
        access: "environment",
        resource: {
          _tag: "draft-workspace-file",
          cwd: "/project/docs",
          path: `/project/docs/./${name}`,
        },
      });
    }
  });

  it("keeps thread authorization when a thread exists", () => {
    const threadId = ThreadId.make("markdown-thread");
    expect(
      resolveMobileMarkdownMediaSource("image.png", { threadId, workspaceRoot: "/project" }),
    ).toMatchObject({ resource: { _tag: "media-file", threadId, path: "/project/image.png" } });
  });

  it("keeps direct URLs direct and rejects unresolvable or blocked references", () => {
    const input = { threadId: undefined, workspaceRoot: "/project" };
    expect(resolveMobileMarkdownMediaSource("https://example.com/image.png", input)).toMatchObject({
      access: "direct",
      uri: "https://example.com/image.png",
    });
    expect(resolveMobileMarkdownMediaSource("javascript:alert(1)", input)).toBeNull();
    expect(resolveMobileMarkdownMediaSource("image.png", { threadId: undefined })).toBeNull();
  });
});

describe("mobile Markdown workspace folders", () => {
  const threadId = ThreadId.make("scoped-markdown-thread");
  const scope = { projectId: ProjectId.make("scoped-project"), threadId };
  const folders = [
    { folderPath: "/web", label: "web", status: "ok" as const },
    { folderPath: "/api", label: "api", status: "ok" as const },
  ];
  const input = {
    threadId,
    workspaceRoot: "/web",
    scope,
    folders,
    documentPath: "api/docs/readme.md",
  };
  it("pins nested images and videos to the document's secondary folder", () => {
    for (const name of ["image.svg", "clip.mp4"]) {
      expect(resolveMobileMarkdownMediaSource(`../${name}`, input)).toMatchObject({
        access: "environment",
        resource: {
          _tag: "workspace-scope-file",
          scope: { ...scope, folderPath: "/api" },
          path: `api/${name}`,
        },
      });
    }
  });
  it("keeps primary links primary and refuses missing metadata or folder escapes", () => {
    expect(
      resolveMobileMarkdownMediaSource("api/image.png", { ...input, documentPath: undefined }),
    ).toMatchObject({
      resource: { scope: { folderPath: "/web" }, path: "web/api/image.png" },
    });
    expect(resolveMobileMarkdownMediaSource("image.png", { ...input, folders: [] })).toBeNull();
    expect(resolveMobileMarkdownMediaSource("../../image.png", input)).toBeNull();
    expect(resolveMobileMarkdownMediaSource("https://host.test/image.png", input)).toMatchObject({
      access: "direct",
    });
  });
});
