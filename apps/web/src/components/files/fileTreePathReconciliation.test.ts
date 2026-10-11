import { describe, expect, it } from "vite-plus/test";

import { buildFileTreePathUpdates, fileTreeSearchEntries } from "./fileTreePathReconciliation";

it("shows only scoped search matches and their ancestors, replacing previously loaded rows", () => {
  const previous = fileTreeSearchEntries([
    { path: "api/readme.md", kind: "file" },
    { path: "ui/readme.md", kind: "file" },
  ]);
  const narrowed = fileTreeSearchEntries([{ path: "api/docs/readme.md", kind: "file" }]);
  expect(narrowed).toEqual([
    { path: "api/docs/readme.md", kind: "file" },
    { path: "api", kind: "directory" },
    { path: "api/docs", kind: "directory" },
  ]);
  expect(
    buildFileTreePathUpdates(
      previous.map((entry) => entry.path),
      narrowed.map((entry) => entry.path),
    ),
  ).toContainEqual({ type: "remove", path: "ui/readme.md" });
});

describe("buildFileTreePathUpdates", () => {
  it("updates only paths that changed", () => {
    expect(
      buildFileTreePathUpdates(
        ["src/", "src/kept.ts", "src/removed.ts"],
        ["src/", "src/kept.ts", "src/added.ts"],
      ),
    ).toEqual([
      { type: "remove", path: "src/removed.ts" },
      { type: "add", path: "src/added.ts" },
    ]);
  });

  it("removes a missing subtree with one recursive update", () => {
    expect(
      buildFileTreePathUpdates(
        ["src/", "src/feature/", "src/feature/index.ts", "src/kept.ts"],
        ["src/", "src/kept.ts"],
      ),
    ).toEqual([{ type: "remove", path: "src/feature/", recursive: true }]);
  });

  it("does nothing when a refresh returns the same tree", () => {
    const paths = ["src/", "src/index.ts"];
    expect(buildFileTreePathUpdates(paths, [...paths])).toEqual([]);
  });
});
