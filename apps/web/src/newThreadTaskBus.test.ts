// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  onOpenNewThreadTaskDialog,
  openNewThreadTaskDialog,
  type OpenNewThreadTaskRequest,
} from "./newThreadTaskBus";

describe("app-level task requests", () => {
  it("delivers unopened parents and distinguishes the same thread id in two environments", () => {
    const received: OpenNewThreadTaskRequest[] = [];
    const stop = onOpenNewThreadTaskDialog((request) => received.push(request));
    try {
      const threadId = ThreadId.make("unopened-parent");
      const first = scopeThreadRef(EnvironmentId.make("local"), threadId);
      const second = scopeThreadRef(EnvironmentId.make("remote"), threadId);
      openNewThreadTaskDialog({ threadRef: first });
      openNewThreadTaskDialog({ threadRef: second });
      expect(received.map((request) => request.threadRef)).toEqual([first, second]);
    } finally {
      stop();
    }
  });

  it("carries a Wayfinder title and multiline prompt without truncation or rewriting", () => {
    const received: OpenNewThreadTaskRequest[] = [];
    const stop = onOpenNewThreadTaskDialog((request) => received.push(request));
    try {
      const request = {
        threadRef: scopeThreadRef(EnvironmentId.make("remote"), ThreadId.make("parent")),
        initialDraft: {
          title: "Map ticket 38",
          prompt: "Read .scratch\\map.md\nImplement this ticket.",
        },
      };
      openNewThreadTaskDialog(request);
      expect(received).toEqual([request]);
    } finally {
      stop();
    }
  });

  it("removes listeners when the host unmounts", () => {
    const received: OpenNewThreadTaskRequest[] = [];
    const stop = onOpenNewThreadTaskDialog((request) => received.push(request));
    stop();
    openNewThreadTaskDialog({
      threadRef: scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("parent")),
    });
    expect(received).toEqual([]);
  });
});
