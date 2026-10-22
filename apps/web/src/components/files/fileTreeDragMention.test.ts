import { describe, expect, it } from "@effect/vitest";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { createFileTreeDragMentionController } from "./fileTreeDragMention.ts";

const makeTransfer = (plainText = "") => {
  const data = new Map<string, string>([["text/plain", plainText]]);
  return {
    setData: (format: string, value: string) => void data.set(format, value),
    getData: (format: string) => data.get(format) ?? "",
    data,
  };
};

const rowNode = (path: string) => ({
  getAttribute: (name: string) => (name === "data-item-path" ? path : null),
});

describe("createFileTreeDragMentionController", () => {
  it("tags a row drag with the mention payload and flags the drag", () => {
    const controller = createFileTreeDragMentionController({});
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [{}, rowNode("docs/index.md"), {}],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[index.md](docs/index.md)");
    expect(controller.isDragInProgress()).toBe(true);
  });

  it("uses a scoped mention encoder and deselects the dragged tree path on drag end", () => {
    const controller = createFileTreeDragMentionController({
      mention: (path) => (path === "ui/read me.md" ? "[read me.md](/ui/read%20me.md)" : null),
    });
    const transfer = makeTransfer();
    const deselected: string[] = [];
    controller.handleSelectionChange(["ui/read me.md", "unavailable/file.md"]);
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("ui/read me.md")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[read me.md](/ui/read%20me.md)");
    controller.handleDragEnd((path) => deselected.push(path));
    expect(deselected).toEqual(["ui/read me.md", "unavailable/file.md"]);
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("keeps host-folder mentions on the upstream mentionPath API", () => {
    const controller = createFileTreeDragMentionController({
      mentionPath: (path) => `/host/${path}`,
    });
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("docs/readme.md")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe("[readme.md](/host/docs/readme.md)");
  });

  it("does not tag drags of selected text from the panel chrome", () => {
    const controller = createFileTreeDragMentionController({});
    const transfer = makeTransfer("selected text");
    controller.handleDragStart({ dataTransfer: transfer, composedPath: () => [{}] });
    expect(transfer.data.has(COMPOSER_MENTION_DRAG_TYPE)).toBe(false);
    expect(controller.isDragInProgress()).toBe(false);
  });

  it("drags the whole selection when the dragged row is part of it", () => {
    const deselected: Array<string> = [];
    const controller = createFileTreeDragMentionController({});
    const deselect = (path: string) => void deselected.push(path);
    controller.handleSelectionChange(["docs/index.md", "docs/api.md", "src/app.ts"]);
    const transfer = makeTransfer();
    controller.handleDragStart({
      dataTransfer: transfer,
      composedPath: () => [rowNode("docs/api.md")],
    });
    expect(transfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toBe(
      "[index.md](docs/index.md) [api.md](docs/api.md) [app.ts](src/app.ts)",
    );
    controller.handleDragEnd(deselect);
    expect(deselected).toEqual(["docs/index.md", "docs/api.md", "src/app.ts"]);
  });
});
