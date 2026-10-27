import { expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../test/render";
import { useSidebarTaskVisibility } from "./sidebarTaskVisibility";
import { sidebarTaskLeaseClock } from "./sidebarTaskLeases";
import { SidebarTaskTestClock } from "./sidebarTaskTestClock";

it("observes only expanded groups; dwell and grace do not change the viewport clock gate", async () => {
  const clock = new SidebarTaskTestClock();
  using _clock = vi.spyOn(sidebarTaskLeaseClock, "after").mockImplementation(clock.after);
  const observe = vi.fn();
  const disconnect = vi.fn();
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  const options: IntersectionObserverInit[] = [];
  using _observer = stubGlobal(
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
    return (
      <div data-slot="scroll-area-viewport">
        <ul>
          <li>
            <div ref={rowRef}>{`${visible}:${leased}`}</div>
          </li>
        </ul>
      </div>
    );
  }
  await using screen = await render(<View enabled={false} />);
  expect(observe).not.toHaveBeenCalled();
  await screen.rerender(<View enabled />);
  expect(options[0]?.root).toBe(screen.container.firstElementChild);
  expect(options[0]?.rootMargin).toBeUndefined();
  expect(observe).toHaveBeenCalledWith(screen.container.querySelector("li"));
  await act(() => callbacks[0]!([{ isIntersecting: true }]));
  expect(screen.container.textContent).toBe("true:false");
  await act(() => clock.advance(250));
  expect(screen.container.textContent).toBe("true:true");
  await act(() => callbacks[0]!([{ isIntersecting: false }]));
  expect(screen.container.textContent).toBe("false:true");
  await act(() => clock.advance(4000));
  expect(screen.container.textContent).toBe("false:false");
  await screen.rerender(<View enabled={false} />);
  expect(disconnect).toHaveBeenCalledOnce();
});

it("shares one scroll listener and assigns streams to the current top three visible groups", async () => {
  const clock = new SidebarTaskTestClock();
  using _clock = vi.spyOn(sidebarTaskLeaseClock, "after").mockImplementation(clock.after);
  using _frames = stubGlobal("requestAnimationFrame", (callback: () => void) => {
    clock.after(16, callback);
    return 1;
  });
  using _cancelFrames = stubGlobal("cancelAnimationFrame", vi.fn());
  const viewport = document.createElement("div");
  viewport.dataset.slot = "scroll-area-viewport";
  using added = vi.spyOn(viewport, "addEventListener");
  using removed = vi.spyOn(viewport, "removeEventListener");
  const groups = ["a", "b", "c", "d", "e"];
  const positions = [10, 20, 30, 40, 50];
  const callbacks: Array<
    (entries: Array<{ isIntersecting: boolean; boundingClientRect: { top: number } }>) => void
  > = [];
  using _observer = stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (typeof callbacks)[number]) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  function View({ id }: { id: string }) {
    const { leased, rowRef } = useSidebarTaskVisibility(true, `scroll:${id}`);
    return (
      <div ref={rowRef} data-group={id}>
        {String(leased)}
      </div>
    );
  }
  await using screen = await render(
    <ul>
      {groups.map((id) => (
        <li key={id}>
          <View id={id} />
        </li>
      ))}
    </ul>,
    { container: viewport },
  );
  using measurements = new DisposableStack();
  screen.container.querySelectorAll("li").forEach((row, index) => {
    measurements.use(
      vi
        .spyOn(row, "getBoundingClientRect")
        .mockImplementation(() => new DOMRect(0, positions[index], 100, 30)),
    );
  });
  await act(() =>
    callbacks.forEach((callback, index) =>
      callback([{ isIntersecting: true, boundingClientRect: { top: positions[index]! } }]),
    ),
  );
  await act(() => clock.advance(250));
  const leased = () =>
    Array.from(screen.container.querySelectorAll("[data-group]"), (row) => row.textContent);
  expect(leased()).toEqual(["true", "true", "true", "false", "false"]);
  const listeners = added.mock.calls.filter(
    ([event, , options]) => event === "scroll" && typeof options === "object" && options.passive,
  );
  expect(listeners).toHaveLength(1);
  positions.reverse();
  await act(() => viewport.dispatchEvent(new Event("scroll")));
  await act(() => clock.advance(16));
  expect(leased()).toEqual(["false", "false", "true", "true", "true"]);
  await screen.unmount();
  expect(removed).toHaveBeenCalledExactlyOnceWith("scroll", listeners[0]![1]);
});
