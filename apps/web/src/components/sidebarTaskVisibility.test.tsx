import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useSidebarTaskVisibility } from "./sidebarTaskVisibility";

afterEach(() => vi.unstubAllGlobals());

it("uses the scroll viewport without overscan and invalidates a renewed lease", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scrollRoot = {};
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
    const { visible, rowRef } = useSidebarTaskVisibility(enabled);
    return <div ref={rowRef}>{visible ? "leased" : "released"}</div>;
  }
  let tree: ReturnType<typeof create>;
  act(() => {
    tree = create(<View enabled />, { createNodeMock: () => ({ closest: () => scrollRoot }) });
  });
  expect(options[0]?.root).toBe(scrollRoot);
  expect(options[0]?.rootMargin).toBeUndefined();
  expect(tree!.root.findByType("div").children).toEqual(["released"]);
  act(() => callbacks[0]!([{ isIntersecting: true }]));
  expect(tree!.root.findByType("div").children).toEqual(["leased"]);
  act(() => callbacks[0]!([{ isIntersecting: false }]));
  expect(tree!.root.findByType("div").children).toEqual(["released"]);
  act(() => tree!.update(<View enabled={false} />));
  act(() => tree!.update(<View enabled />));
  expect(tree!.root.findByType("div").children).toEqual(["released"]);
  act(() => tree!.unmount());
  expect(disconnect).toHaveBeenCalledTimes(2);
});
