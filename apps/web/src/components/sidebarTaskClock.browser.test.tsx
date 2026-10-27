import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import { useSidebarTaskClock } from "./sidebarTaskClock";

it("uses current time in the first expanded commit after a long collapsed mount", async () => {
  const epoch = new Date("2026-09-29T00:00:00Z").getTime();
  using _now = vi.spyOn(Date, "now").mockReturnValue(epoch);
  const commits: number[] = [];
  function View({ expanded }: { expanded: boolean }) {
    const now = useSidebarTaskClock(expanded);
    useLayoutEffect(() => {
      if (expanded) commits.push(now);
    });
    return <span>{now}</span>;
  }
  await using screen = await render(<View expanded={false} />);
  using _timers = fakeTimers();
  vi.setSystemTime(epoch);
  expect(vi.getTimerCount()).toBe(0);
  await act(() => vi.advanceTimersByTime(180_000));
  _now.mockReturnValue(epoch + 180_000);
  await screen.rerender(<View expanded />);
  expect(commits[0]).toBe(epoch + 180_000);
  await screen.rerender(<View expanded={false} />);
  expect(vi.getTimerCount()).toBe(0);
});
