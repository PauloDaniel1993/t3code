import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useSidebarTaskVisibility } from "./sidebarTaskVisibility";
import { sidebarTaskLeaseClock } from "./sidebarTaskLeases";
import { SidebarTaskTestClock } from "./sidebarTaskTestClock";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("observes only expanded groups; dwell and grace do not change the viewport clock gate", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const clock = new SidebarTaskTestClock();
  vi.spyOn(sidebarTaskLeaseClock, "after").mockImplementation(clock.after);
  const scrollRoot = {};
  const parentWithTasks = {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const options: IntersectionObserverInit[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (typeof callbacks)[number], init: IntersectionObserverInit) {
        callbacks.push(callback);
        options.push(init);
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  function View({ enabled }: { enabled: boolean }) {
    const { visible, leased, rowRef } = useSidebarTaskVisibility(enabled, "test:parent");
    return <div ref={rowRef}>{`${visible}:${leased}`}</div>;
  }
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<View enabled={false} />, {
      createNodeMock: () => ({
        closest: (selector: string) => (selector === "li" ? parentWithTasks : scrollRoot),
      }),
    });
  });
  expect(observe).not.toHaveBeenCalled();
  act(() => tree!.update(<View enabled />));
  expect(options[0]?.root).toBe(scrollRoot);
  expect(options[0]?.rootMargin).toBeUndefined();
  expect(observe).toHaveBeenCalledWith(parentWithTasks);
  act(() => callbacks[0]!([{ isIntersecting: true }]));
  expect(tree!.root.findByType("div").children).toEqual(["true:false"]);
  act(() => clock.advance(250));
  expect(tree!.root.findByType("div").children).toEqual(["true:true"]);
  act(() => callbacks[0]!([{ isIntersecting: false }]));
  expect(tree!.root.findByType("div").children).toEqual(["false:true"]);
  act(() => clock.advance(4000));
  expect(tree!.root.findByType("div").children).toEqual(["false:false"]);
  act(() => tree!.update(<View enabled={false} />));
  expect(disconnect).toHaveBeenCalledOnce();
  act(() => tree!.unmount());
});
