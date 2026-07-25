import { Toast } from "@base-ui/react/toast";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createObservedToastManager,
  createToastLifecycleObserver,
  type ObservableToastData,
  type ToastLifecycleRecord,
} from "./toastLifecycle";

describe("toast lifecycle observability", () => {
  it("records a sub-second visibility interval and its filtering reason", () => {
    let now = 0;
    const records: ToastLifecycleRecord[] = [];
    const observer = createToastLifecycleObserver({
      now: () => now,
      record: (record) => records.push(record),
    });

    observer.added("viewport", "toast-1", {
      type: "info",
      title: "Background activity",
      data: {
        threadRef: {
          environmentId: "environment-1",
          threadId: "thread-1",
        },
      },
    });
    now = 10;
    observer.visibilityChanged("viewport", "toast-1", true, "thread-scope-visible", {
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    now = 410;
    observer.visibilityChanged("viewport", "toast-1", false, "thread-scope-filtered", {
      environmentId: "environment-1",
      threadId: "thread-2",
    });

    expect(records.map((record) => record.event)).toEqual(["added", "rendered", "hidden"]);
    expect(records.at(-1)).toEqual(
      expect.objectContaining({
        event: "hidden",
        visibilityReason: "thread-scope-filtered",
        visibleDurationMs: 400,
        elapsedSinceAddedMs: 410,
        threadId: "thread-1",
        activeThreadId: "thread-2",
      }),
    );
  });

  it("retains the explicit close reason when the observed manager closes the toast", () => {
    let now = 0;
    const records: ToastLifecycleRecord[] = [];
    const observer = createToastLifecycleObserver({
      now: () => now,
      record: (record) => records.push(record),
    });

    observer.added("viewport", "toast-1", {
      type: "success",
      title: "Finished",
    });
    now = 5;
    observer.visibilityChanged("viewport", "toast-1", true, "unscoped-visible", null);
    now = 105;
    observer.requestClose("viewport", "toast-1", "visible-timeout");
    observer.requestClose("viewport", "toast-1", "programmatic-close");
    now = 110;
    observer.closed("viewport", "toast-1");
    now = 600;
    observer.removed("viewport", "toast-1");

    expect(records.filter((record) => record.event === "close-requested")).toHaveLength(1);
    expect(records.find((record) => record.event === "closed")).toEqual(
      expect.objectContaining({
        closeReason: "visible-timeout",
        visibleDurationMs: 105,
      }),
    );
    expect(records.find((record) => record.event === "removed")).toEqual(
      expect.objectContaining({
        closeReason: "visible-timeout",
        visibleDurationMs: 105,
      }),
    );
  });

  it("instruments manager callbacks without changing caller callback behavior", () => {
    let now = 0;
    const records: ToastLifecycleRecord[] = [];
    const observer = createToastLifecycleObserver({
      now: () => now,
      record: (record) => records.push(record),
    });
    const manager = createObservedToastManager<ObservableToastData>(
      Toast.createToastManager<ObservableToastData>(),
      "viewport",
      observer,
    );
    const onClose = vi.fn();
    const onRemove = vi.fn();
    const managerEvents: Array<{ action: string; options: unknown }> = [];
    manager[" subscribe"]((event) => managerEvents.push(event));

    const toastId = manager.add({
      id: "toast-observed",
      title: "Observed",
      onClose,
      onRemove,
    });
    now = 10;
    manager.update(toastId, { type: "success" });
    now = 25;
    manager.close(toastId);

    const updateEvent = managerEvents.find((event) => event.action === "update");
    const updateOptions = updateEvent?.options as
      | { readonly onClose?: () => void; readonly onRemove?: () => void }
      | undefined;
    updateOptions?.onClose?.();
    now = 30;
    updateOptions?.onRemove?.();

    expect(onClose).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledOnce();
    expect(records.map((record) => record.event)).toEqual([
      "added",
      "updated",
      "close-requested",
      "closed",
      "removed",
    ]);
    expect(records.at(-1)?.closeReason).toBe("programmatic-close");
  });
});
