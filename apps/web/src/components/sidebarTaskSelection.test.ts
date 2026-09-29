import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
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
      expect(
        buildMultiSelectThreadContextMenuItems({
          count: entries.length,
          hasRunningThread: false,
        }).find((item) => item.id === "delete")?.label,
      ).toBe("Delete (1)");
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
