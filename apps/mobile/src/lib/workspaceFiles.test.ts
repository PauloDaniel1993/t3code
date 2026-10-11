import { EnvironmentId, ProjectId, ThreadId, type WorkspaceScopeFolder } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pinWorkspaceFileScope,
  scopedWorkspaceFileResource,
  workspaceFileCacheKey,
  workspaceFileReadInput,
  workspaceFileScope,
  workspaceFolderErrors,
} from "./workspaceFiles";
import { workspaceMarkdownResource } from "./workspaceMarkdownResource";
import { mediaVideoThumbnailKey } from "./videoPreviewSource";

const project = { id: ProjectId.make("project-1"), workspaceFile: "/workspace/app.code-workspace" };
const thread = { id: ThreadId.make("thread-1"), workspaceFolderCount: 2 };
const scope = { projectId: project.id, threadId: thread.id };
const folders = [
  { folderPath: "/workspace/web", label: "web", status: "ok" },
  { folderPath: "/workspace/api", label: "api", status: "ok" },
] as const satisfies ReadonlyArray<WorkspaceScopeFolder>;

describe("mobile workspace file addressing", () => {
  it("keeps plain projects and incapable peers on cwd inputs", () => {
    expect(workspaceFileScope({ enabled: false, project, thread })).toBeNull();
    expect(workspaceFileScope({ enabled: true, project: { id: project.id } })).toBeNull();
    expect(workspaceFileReadInput("/workspace/web", "src/index.ts", null)).toEqual({
      cwd: "/workspace/web",
      relativePath: "src/index.ts",
    });
  });

  it("uses thread identity even after its project unlinks", () => {
    expect(workspaceFileScope({ enabled: true, project: { id: project.id }, thread })).toEqual(
      scope,
    );
    expect(workspaceFileScope({ enabled: true, project, thread: null })).toEqual({
      projectId: project.id,
    });
  });

  it("opens a secondary result by its owner rather than the search folder", () => {
    const pinned = pinWorkspaceFileScope(
      { ...scope, folderPath: folders[0].folderPath },
      "api/src/index.ts",
      folders,
    );
    expect(pinned).toEqual({ ...scope, folderPath: "/workspace/api" });
    expect(workspaceFileReadInput("/workspace/web", "api/src/index.ts", pinned)).toEqual({
      scope: pinned,
      path: "api/src/index.ts",
    });
    expect(pinWorkspaceFileScope(scope, "old-api/src/index.ts", folders)).toBeNull();
  });

  it("never strips a label-shaped subdirectory from a one-folder workspace", () => {
    const pinned = pinWorkspaceFileScope(scope, "web/src/index.ts", [folders[0]]);
    expect(workspaceFileReadInput("/workspace/web", "web/src/index.ts", pinned)).toEqual({
      scope: { ...scope, folderPath: "/workspace/web" },
      path: "web/src/index.ts",
    });
  });

  it("retains absolute host reads without converting them into canonical paths", () => {
    expect(workspaceFileReadInput("/workspace/web", "/tmp/report.md", scope)).toEqual({
      cwd: "/workspace/web",
      relativePath: "/tmp/report.md",
    });
    expect(scopedWorkspaceFileResource(scope, "api/image.png")).toBeNull();
    expect(
      scopedWorkspaceFileResource({ ...scope, folderPath: "/workspace/api" }, "/tmp/image.png"),
    ).toBeNull();
  });

  it("isolates identical relative paths by environment, project, thread and original folder identity", () => {
    const input = {
      environmentId: EnvironmentId.make("environment-1"),
      cwd: "/session/web",
      scope: { ...scope, folderPath: "/workspace/api" },
      relativePath: "api/src/index.ts",
    };
    const keys = [
      input,
      { ...input, environmentId: EnvironmentId.make("environment-2") },
      { ...input, scope: { ...input.scope, projectId: ProjectId.make("project-2") } },
      { ...input, scope: { ...input.scope, threadId: ThreadId.make("thread-2") } },
      { ...input, scope: { ...input.scope, folderPath: "/other/api" } },
      { ...input, relativePath: "api/src/other.ts" },
    ].map(workspaceFileCacheKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(workspaceFileCacheKey({ ...input, cwd: "/another/session/web" })).toBe(keys[0]);
  });

  it("keeps unavailable and failed indexes visible when other folders have results", () => {
    expect(
      workspaceFolderErrors([
        folders[0],
        { ...folders[1], status: "index-error" },
        { folderPath: "vscode-remote://ssh/data", label: "data", status: "unavailable" },
      ]),
    ).toBe("api: file index unavailable. data: folder unavailable");
    expect(workspaceFolderErrors(folders)).toBeNull();
  });

  it("scopes video resources and thumbnail identity to the original folder", () => {
    const resource = scopedWorkspaceFileResource(
      { ...scope, folderPath: "/workspace/api" },
      "api/clip.mp4",
    );
    if (!resource) throw new Error("Expected a scoped video resource");
    const source = {
      type: "media" as const,
      environmentId: EnvironmentId.make("environment-1"),
      resource,
      name: "clip.mp4",
      mimeType: "video/mp4",
    };
    expect(resource).toEqual({
      _tag: "workspace-scope-file",
      scope: { ...scope, folderPath: "/workspace/api" },
      path: "api/clip.mp4",
    });
    expect(mediaVideoThumbnailKey(source)).not.toBe(
      mediaVideoThumbnailKey({
        ...source,
        resource: { ...resource, scope: { ...resource.scope, folderPath: "/other/api" } },
      }),
    );
  });
});

describe("workspace markdown references", () => {
  it("resolves labeled media directly and ordinary links relative to their document", () => {
    const documentScope = { ...scope, folderPath: "/workspace/api" };
    expect(
      workspaceMarkdownResource(documentScope, folders, "web/image.png", "api/docs/README.md"),
    ).toMatchObject({
      scope: { folderPath: "/workspace/web" },
      path: "web/image.png",
    });
    expect(
      workspaceMarkdownResource(
        documentScope,
        folders,
        "./images/one%23two.png#image",
        "api/docs/README.md",
      ),
    ).toMatchObject({
      scope: { folderPath: "/workspace/api" },
      path: "api/docs/images/one#two.png",
    });
    expect(
      workspaceMarkdownResource(documentScope, folders, "../README.md", "api/docs/README.md"),
    ).toMatchObject({ path: "api/README.md" });
  });

  it("keeps bare work-log links at the primary and single-folder document links unprefixed", () => {
    expect(workspaceMarkdownResource(scope, folders, "images/result.png")).toMatchObject({
      path: "web/images/result.png",
    });
    expect(
      workspaceMarkdownResource(scope, [folders[0]], "./images/result.png", "docs/README.md"),
    ).toMatchObject({ path: "docs/images/result.png" });
  });

  it.each([
    "../../../outside.png",
    "https://cdn.example/image.png",
    "//cdn.example/image.png",
    "/tmp/image.png",
    "C:\\tmp\\image.png",
    "#anchor",
    "javascript:alert(1)",
  ])("does not convert %s into a workspace resource", (href) => {
    expect(workspaceMarkdownResource(scope, folders, href, "api/docs/README.md")).toBeNull();
  });
});
