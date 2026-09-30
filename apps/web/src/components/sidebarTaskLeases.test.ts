import { expect, it } from "vite-plus/test";
import { createSidebarTaskLeases } from "./sidebarTaskLeases";
import { SidebarTaskTestClock } from "./sidebarTaskTestClock";

it("opens after dwell, holds exits for four seconds, and caps at upstream's three nearest groups", () => {
  const clock = new SidebarTaskTestClock();
  const leases = createSidebarTaskLeases(clock);
  const open = new Set<string>();
  let peak = 0;
  const removals: Array<() => void> = [];
  for (let index = 0; index < 10; index++) {
    const key = `parent-${index}`;
    removals.push(
      leases.register(key, (leased) => {
        if (leased) open.add(key);
        else open.delete(key);
        peak = Math.max(peak, open.size);
      }),
    );
    leases.update(key, true, 10 - index);
  }
  clock.advance(249);
  expect(open.size).toBe(0);
  clock.advance(1);
  expect([...open].sort()).toEqual(["parent-7", "parent-8", "parent-9"]);
  expect(peak).toBe(3);
  removals[9]!();
  expect(open.size).toBe(3);
  expect(open.has("parent-9")).toBe(false);
  expect(peak).toBe(3);
  for (let index = 0; index < 10; index++) leases.update(`parent-${index}`, false);
  clock.advance(3999);
  expect(open.size).toBe(3);
  clock.advance(1);
  expect(open.size).toBe(0);
});

it("a flick across expanded groups and a brief return cause no open/cancel churn", () => {
  const clock = new SidebarTaskTestClock();
  const leases = createSidebarTaskLeases(clock);
  const changes: boolean[] = [];
  const remove = leases.register("parent", (open) => changes.push(open));
  for (let index = 0; index < 45; index++) {
    leases.update("parent", true);
    clock.advance(100);
    leases.update("parent", false);
  }
  clock.advance(4000);
  expect(changes).toEqual([]);
  leases.update("parent", true);
  clock.advance(250);
  leases.update("parent", false);
  clock.advance(3000);
  leases.update("parent", true);
  expect(changes).toEqual([true]);
  remove();
  clock.advance(4000);
});
