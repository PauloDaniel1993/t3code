import { describe, expect, it } from "vite-plus/test";
import type { ProjectEntry } from "@t3tools/contracts";

import { collectFileTreeEntries } from "./fileTree";

describe("workspace folder file tree reachability", () => {
  it("expands a secondary-folder search result without eagerly including other folders", () => {
    const loaded = new Map<string, ReadonlyArray<ProjectEntry>>([
      ["api/src", [{ kind: "file", path: "api/src/index.ts" }]],
      ["web/src", [{ kind: "file", path: "web/src/index.ts" }]],
    ]);
    const snapshot = collectFileTreeEntries([], loaded, [{ kind: "directory", path: "api/src" }]);
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(["api/src", "api/src/index.ts"]);
    expect([...snapshot.reachableDirectories]).toEqual(["api/src"]);
    expect(collectFileTreeEntries([], loaded).entries).toEqual([]);
  });
});
