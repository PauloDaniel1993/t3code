import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  archiveSelectedThreadEntries,
  deleteSelectedThreadEntries,
  selectRenderedSidebarThreads,
} from "./Sidebar.logic";

describe("rendered-only bulk actions", () => {
  it.each(["collapsed group", "filter"])(
    "does not count or act on selections hidden by a %s",
    async () => {
      const selected = [
        "local:visible",
        "local:hidden-task",
        "local:hidden-parent",
        "remote:visible",
      ];
      const rendered = new Map([["local:visible", { title: "Visible" }]]);
      const entries = selectRenderedSidebarThreads(selected, rendered);
      expect(entries).toEqual([{ threadKey: "local:visible", thread: { title: "Visible" } }]);
      const archive = vi.fn(async () => ({ _tag: "Success" as const }));
      const remove = vi.fn(async () => AsyncResult.success(undefined));
      expect((await archiveSelectedThreadEntries({ entries, archive })).archivedThreadKeys).toEqual(
        ["local:visible"],
      );
      expect([
        ...(await deleteSelectedThreadEntries({ entries, delete: remove })).deletedThreadKeys,
      ]).toEqual(["local:visible"]);
      expect(archive).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledOnce();
    },
  );
});
