import { describe, expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import {
  NodeId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeThreadFixture } from "../test-fixtures";

vi.mock("../state/threads", () => ({ environmentThreadDetails: {} }));
import {
  createSidebarTaskProjectionAtom,
  mergeSidebarTaskPresentation,
} from "./sidebarTaskPresentation";

const task: OrchestrationV2Subagent = {
  id: NodeId.make("task"),
  threadId: ThreadId.make("parent"),
  runId: null,
  parentNodeId: NodeId.make("parent-node"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerThreadId: null,
  childThreadId: ThreadId.make("child"),
  nativeTaskRef: null,
  prompt: "Work",
  title: "Task",
  model: null,
  status: "completed",
  result: "Done",
  startedAt: DateTime.makeUnsafe("2026-09-29T00:00:00Z"),
  completedAt: DateTime.makeUnsafe("2026-09-29T00:08:00Z"),
  updatedAt: DateTime.makeUnsafe("2026-09-29T00:08:00Z"),
  completionDelivery: {
    state: "delivered",
    observedByRunId: null,
    deliveredAt: "2026-09-29T00:08:00Z",
  },
};

describe("sidebar presentation retention", () => {
  it("retains delivery/timing when a replacement bounded snapshot omits the spawning turn", () => {
    const known = { runs: [], subagents: [task] };
    const replacement = mergeSidebarTaskPresentation(known, { runs: [], subagents: [] });
    expect(replacement).toBe(known);
    expect(replacement.subagents[0]?.completionDelivery?.deliveredAt).toBe("2026-09-29T00:08:00Z");
  });
  it("keeps the newest record when an older window arrives after acknowledgement", () => {
    const acknowledged = {
      ...task,
      updatedAt: DateTime.makeUnsafe("2026-09-29T00:09:00Z"),
      completionDelivery: { ...task.completionDelivery!, state: "acknowledged" as const },
    };
    const known = { runs: [], subagents: [acknowledged] };
    expect(mergeSidebarTaskPresentation(known, { runs: [], subagents: [task] })).toBe(known);
  });
  it("does not notify group consumers when parent transcript text changes", () => {
    const projection = {
      ...makeThreadFixture().source,
      runs: [],
      subagents: [task],
      messages: [] as string[],
    };
    const source = Atom.make({ projection });
    const selected = createSidebarTaskProjectionAtom(source);
    const registry = AtomRegistry.make();
    const changes = vi.fn();
    const cancel = registry.subscribe(selected, changes);
    const before = registry.get(selected);
    changes.mockClear();
    registry.set(source, { projection: { ...projection, messages: ["parent streamed text"] } });
    expect(registry.get(selected)).toBe(before);
    expect(changes).not.toHaveBeenCalled();
    registry.set(source, {
      projection: { ...projection, subagents: [{ ...task, title: "Changed" }] },
    });
    expect(changes).toHaveBeenCalledOnce();
    cancel();
    registry.dispose();
  });
});
