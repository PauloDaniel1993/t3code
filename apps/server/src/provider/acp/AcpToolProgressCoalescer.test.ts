import { assert, describe, it } from "@effect/vitest";
import { makeAcpToolProgressCoalescer } from "./AcpToolProgressCoalescer.ts";

describe("ACP tool progress", () => {
  it("reduces 50,000 updates to at most 52 states and emits the final result immediately", () => {
    const progress = makeAcpToolProgressCoalescer<number>();
    const emitted: Array<number> = [];
    for (let update = 0; update < 50_000; update++) {
      if (progress.offer("tool", update, "running", update / 10)) emitted.push(update);
    }
    assert.isTrue(progress.offer("tool", 50_000, "completed", 5_000));
    emitted.push(50_000);
    assert.isAtMost(emitted.length, 52);
    assert.equal(emitted[0], 0);
    assert.equal(emitted.at(-1), 50_000);
    assert.deepEqual(progress.flush(5_001), []);
    assert.isFalse(progress.offer("tool", 50_001, "running", 5_002));
  });

  it("flushes the latest quiet progress when due and all pending progress on drain", () => {
    const progress = makeAcpToolProgressCoalescer<number>();
    assert.isTrue(progress.offer("a", 1, "running", 0));
    assert.isFalse(progress.offer("a", 2, "running", 1));
    assert.isFalse(progress.offer("a", 3, "running", 2));
    assert.deepEqual(progress.flush(99), []);
    assert.deepEqual(progress.flush(100), [3]);
    assert.isFalse(progress.offer("a", 4, "running", 101));
    assert.deepEqual(progress.flush(102, true), [4]);
    assert.deepEqual(progress.flush(200), []);
    assert.isTrue(progress.offer("a", 5, "running", 202));
  });

  it("keeps tools independent and sends waiting, failure and cancellation immediately", () => {
    const progress = makeAcpToolProgressCoalescer<number>();
    assert.isTrue(progress.offer("a", 1, "running", 0));
    assert.isTrue(progress.offer("b", 2, "running", 0));
    assert.isFalse(progress.offer("a", 3, "running", 1));
    assert.isTrue(progress.offer("a", 4, "waiting", 2));
    assert.isTrue(progress.offer("a", 5, "failed", 3));
    assert.isTrue(progress.offer("b", 6, "cancelled", 3));
    assert.deepEqual(progress.flush(100), []);
  });

  it("keeps each tool's last held state when more than 256 tools are active", () => {
    const progress = makeAcpToolProgressCoalescer<number>();
    for (let id = 0; id < 600; id++) {
      progress.offer(String(id), id, "running", 0);
      progress.offer(String(id), id + 1, "running", 1);
    }
    assert.deepEqual(
      progress.flush(100),
      Array.from({ length: 600 }, (_, id) => id + 1),
    );
    assert.isTrue(progress.offer("0", 101, "completed", 101));
  });

  it("keeps terminal tombstones through saturation and settlement flushes", () => {
    const progress = makeAcpToolProgressCoalescer<number>();
    assert.isTrue(progress.offer("finished", 1, "completed", 0));
    for (let id = 0; id < 600; id++) progress.offer(String(id), id, "running", 1);
    progress.flush(100, true);
    assert.isFalse(progress.offer("finished", 2, "running", 101));
    assert.deepEqual(progress.flush(200), []);
  });
});
