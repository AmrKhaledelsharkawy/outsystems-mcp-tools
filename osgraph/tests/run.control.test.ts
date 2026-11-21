/**
 * `RunControl` (osgraph run: start gate, pause / resume, graceful cancel). The progress site, Enter and
 * Ctrl+C all act on this one object, so its transitions are pinned here.
 */
import { describe, expect, it } from "vitest";
import { RunControl } from "../src/run/control.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("RunControl", () => {
  it("starts running by default, and waiting with waitForStart", () => {
    expect(new RunControl().state).toBe("running");
    expect(new RunControl({ waitForStart: true }).state).toBe("waiting");
  });

  it("only valid transitions apply; invalid ones change nothing", () => {
    const c = new RunControl({ waitForStart: true });
    expect(c.pause()).toBe(false);
    expect(c.resume()).toBe(false);
    expect(c.start()).toBe(true);
    expect(c.start()).toBe(false);
    expect(c.pause()).toBe(true);
    expect(c.snapshot().can).toEqual({ start: false, pause: false, resume: true, cancel: true });
    expect(c.resume()).toBe(true);
    expect(c.cancel()).toBe(true);
    expect(c.cancel()).toBe(false);
    expect(c.signal.aborted).toBe(true);
    expect(c.snapshot().can).toEqual({ start: false, pause: false, resume: false, cancel: false });
  });

  it("waitForStart resolves on Start, or on Cancel while waiting", async () => {
    const a = new RunControl({ waitForStart: true });
    let started = false;
    const p = a.waitForStart().then(() => (started = true));
    await tick();
    expect(started).toBe(false);
    a.start();
    await p;
    expect(started).toBe(true);

    const b = new RunControl({ waitForStart: true });
    const q = b.waitForStart();
    b.cancel();
    await q;
    expect(b.signal.aborted).toBe(true);
  });

  it("waitUntilActive holds while paused and releases on Resume or Cancel", async () => {
    const c = new RunControl();
    c.pause();
    let released = false;
    const p = c.waitUntilActive().then(() => (released = true));
    await tick();
    expect(released).toBe(false);
    c.resume();
    await p;
    expect(released).toBe(true);

    c.pause();
    const q = c.waitUntilActive();
    c.cancel();
    await q;
    expect(c.state).toBe("cancelling");
  });

  it("reports every change to its listeners, and a throwing listener is ignored", () => {
    const c = new RunControl({ waitForStart: true });
    const seen: string[] = [];
    c.onChange(() => {
      throw new Error("boom");
    });
    c.onChange((s, prev) => seen.push(`${prev}->${s}`));
    c.start();
    c.pause();
    c.finish();
    expect(seen).toEqual(["waiting->running", "running->paused", "paused->done"]);
  });
});
