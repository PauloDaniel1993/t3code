import type { ProjectReadFileResult } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  resolveProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    vi.unstubAllGlobals();
  });

  it("isolates optimistic edits and confirmations between folder and thread scopes", () => {
    const scope = {
      projectId: ProjectId.make("project"),
      threadId: ThreadId.make("thread"),
      folderPath: "/ui",
    };
    const other = { ...scope, folderPath: "/api" };
    setProjectFileQueryData(environmentId, "/repo", "ui/file.ts", "draft", scope);
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "ui/file.ts", scope)?.contents,
    ).toBe("draft");
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "ui/file.ts", other),
    ).toBeNull();
    expect(
      getOptimisticProjectFileQueryData(environmentId, "/repo", "ui/file.ts", {
        ...scope,
        threadId: ThreadId.make("other"),
      }),
    ).toBeNull();
    expect(confirmProjectFileQueryData(environmentId, "/repo", "ui/file.ts", "draft", other)).toBe(
      false,
    );
    clearProjectFileQueryData(environmentId, "/repo", "ui/file.ts", scope);
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });
});
