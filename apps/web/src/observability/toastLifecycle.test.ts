import { Toast, type ToastObject, type ToastManagerUpdateOptions } from "@base-ui/react/toast";
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

  it.each(["object", "function"])(
    "instruments %s updates without changing caller callbacks",
    (kind) => {
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
      const toast = managerEvents.find((event) => event.action === "add")!
        .options as ToastObject<ObservableToastData>;
      now = 10;
      const updater = vi.fn((previous: ToastObject<ObservableToastData>) => ({
        ...previous,
        title: `${previous.title} updated`,
        type: "success",
      }));
      manager.update(toastId, kind === "function" ? updater : { type: "success" });
      const updateEvent = managerEvents.find((event) => event.action === "update");
      const { updates } = updateEvent!.options as {
        updates:
          | ToastManagerUpdateOptions<ObservableToastData>
          | ((
              previous: ToastObject<ObservableToastData>,
            ) => ToastManagerUpdateOptions<ObservableToastData>);
      };
      const updateOptions = typeof updates === "function" ? updates(toast) : updates;
      if (kind === "function") {
        expect(updater).toHaveBeenCalledExactlyOnceWith({ ...toast, onClose, onRemove });
        expect(updateOptions.title).toBe("Observed updated");
      }
      expect(updateOptions.type).toBe("success");
      now = 25;
      manager.close(toastId);

      updateOptions.onClose?.();
      now = 30;
      updateOptions.onRemove?.();

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
      expect(records.find((record) => record.event === "updated")?.type).toBe("success");
    },
  );
});
