import { act, useLayoutEffect } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useSidebarTaskClock } from "./sidebarTaskClock";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uses current time in the first expanded commit after a long collapsed mount", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
  const commits: number[] = [];
  function View({ expanded }: { expanded: boolean }) {
    const now = useSidebarTaskClock(expanded);
    useLayoutEffect(() => {
      if (expanded) commits.push(now);
    });
    return <span>{now}</span>;
  }
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<View expanded={false} />);
  });
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(180_000));
  const expandedAt = Date.now();
  act(() => tree!.update(<View expanded />));
  expect(commits[0]).toBe(expandedAt);
  act(() => tree!.update(<View expanded={false} />));
  expect(vi.getTimerCount()).toBe(0);
  act(() => tree!.unmount());
});
