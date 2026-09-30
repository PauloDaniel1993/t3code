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
  const scrollRoot = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
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

it("shares one scroll listener and assigns streams to the current top three visible groups", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const clock = new SidebarTaskTestClock();
  vi.spyOn(sidebarTaskLeaseClock, "after").mockImplementation(clock.after);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    clock.after(16, callback);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  let scroll: (() => void) | undefined;
  const root = {
    addEventListener: vi.fn((_event, callback) => {
      scroll = callback;
    }),
    removeEventListener: vi.fn(),
  };
  const positions = [10, 20, 30, 40, 50];
  const callbacks: Array<
    (entries: Array<{ isIntersecting: boolean; boundingClientRect: { top: number } }>) => void
  > = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (typeof callbacks)[number]) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  function View({ index }: { index: number }) {
    const { leased, rowRef } = useSidebarTaskVisibility(true, `scroll:${index}`);
    return (
      <div ref={rowRef} data-index={index}>
        {String(leased)}
      </div>
    );
  }
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(
      <>
        {positions.map((_, index) => (
          <View key={index} index={index} />
        ))}
      </>,
      {
        createNodeMock: (element) => {
          const props = element.props;
          if (
            props === null ||
            typeof props !== "object" ||
            !("data-index" in props) ||
            typeof props["data-index"] !== "number"
          )
            throw new Error("Expected a group row");
          const index = props["data-index"];
          const target = { getBoundingClientRect: () => ({ top: positions[index] }) };
          return { closest: (selector: string) => (selector === "li" ? target : root) };
        },
      },
    );
  });
  act(() =>
    callbacks.forEach((callback, index) =>
      callback([{ isIntersecting: true, boundingClientRect: { top: positions[index]! } }]),
    ),
  );
  act(() => clock.advance(250));
  const leased = () => tree!.root.findAllByType("div").map((row) => row.children[0]);
  expect(leased()).toEqual(["true", "true", "true", "false", "false"]);
  expect(root.addEventListener).toHaveBeenCalledOnce();
  positions.reverse();
  act(() => scroll!());
  act(() => clock.advance(16));
  expect(leased()).toEqual(["false", "false", "true", "true", "true"]);
  act(() => tree!.unmount());
  expect(root.removeEventListener).toHaveBeenCalledOnce();
});
