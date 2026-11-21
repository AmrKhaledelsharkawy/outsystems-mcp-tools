/**
 * #64 cross-process Studio lock. Two contenders are simulated with two lock objects over one file
 * (distinct fake pids and an injected liveness probe), plus one genuinely separate process so the
 * exclusive-create and pid-liveness paths are exercised for real. No Service Studio, synthetic names.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFileStudioLock, defaultStudioLockPath, ENV_STUDIO_LOCK } from "../src/lock/studioLock.js";
import { OsgraphToolError } from "../src/servicestudio/types.js";
import { call, makeCtx } from "./tools.helpers.js";
import { demoPortalModule, fakeSession, syntheticXModule } from "./rebuild.fake.js";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function lockPath(): string {
  const d = mkdtempSync(join(tmpdir(), "osgraph-lock-"));
  dirs.push(d);
  return join(d, "studio.lock");
}
function busyOf(fn: () => unknown): OsgraphToolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OsgraphToolError);
    return err as OsgraphToolError;
  }
  throw new Error("expected BUSY");
}
const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

describe("file studio lock", () => {
  it("writes pid, command and start time, and removes the file on release", () => {
    const path = lockPath();
    const lock = createFileStudioLock({ path, pid: 111, now: () => new Date("2026-11-21T10:00:00.000Z") });
    const h = lock.acquire("osgraph run --scope demo");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      pid: 111,
      command: "osgraph run --scope demo",
      startedAt: "2026-11-21T10:00:00.000Z"
    });
    h.release();
    expect(existsSync(path)).toBe(false);
    h.release(); // idempotent
  });

  it("a second contender fails closed with BUSY naming the live holder", () => {
    const path = lockPath();
    const isAlive = alive([111, 222]);
    createFileStudioLock({ path, pid: 111, isAlive }).acquire("osgraph run --scope demo");
    const err = busyOf(() => createFileStudioLock({ path, pid: 222, isAlive }).acquire("mcp rebuild demo"));
    expect(err.code).toBe("BUSY");
    expect(err.message).toContain("pid 111");
    expect(err.message).toContain("osgraph run --scope demo");
    expect((err.details as { holder: { pid: number } }).holder.pid).toBe(111);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(111);
  });

  it("is free again after the holder releases", () => {
    const path = lockPath();
    const isAlive = alive([111, 222]);
    createFileStudioLock({ path, pid: 111, isAlive }).acquire("a").release();
    expect(createFileStudioLock({ path, pid: 222, isAlive }).acquire("b").holder.pid).toBe(222);
  });

  it("recovers a stale lock whose holder pid is dead, and never steals from a live one", () => {
    const path = lockPath();
    createFileStudioLock({ path, pid: 111 }).acquire("crashed run"); // never released
    const h = createFileStudioLock({ path, pid: 222, isAlive: alive([222]) }).acquire("mcp rebuild demo");
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(222);
    expect(existsSync(`${path}.recover`)).toBe(false);
    const err = busyOf(() => createFileStudioLock({ path, pid: 333, isAlive: alive([222, 333]) }).acquire("x"));
    expect(err.code).toBe("BUSY");
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(222);
    h.release();
  });

  it("a stale holder releasing late never removes its successor lock", () => {
    const path = lockPath();
    const stale = createFileStudioLock({ path, pid: 111 }).acquire("old");
    const fresh = createFileStudioLock({ path, pid: 222, isAlive: alive([222]) }).acquire("new");
    stale.release();
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(222);
    fresh.release();
    expect(existsSync(path)).toBe(false);
  });

  it("two contenders racing for one stale lock: exactly one wins", () => {
    const path = lockPath();
    createFileStudioLock({ path, pid: 111 }).acquire("crashed");
    const isAlive = alive([222, 333]);
    const outcomes = [222, 333].map((pid) => {
      try {
        return createFileStudioLock({ path, pid, isAlive }).acquire(`c${pid}`).holder.pid;
      } catch (err) {
        return (err as OsgraphToolError).code;
      }
    });
    expect(outcomes.filter((o) => typeof o === "number")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "BUSY")).toHaveLength(1);
  });

  it("an abandoned recovery guard is cleared and does not wedge the lock forever", () => {
    const path = lockPath();
    createFileStudioLock({ path, pid: 111 }).acquire("crashed");
    writeFileSync(`${path}.recover`, "{}");
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${path}.recover`, old, old);
    const isAlive = alive([222]);
    // the first attempt may lose to the guard (fail closed) but clears it; the next one recovers
    try {
      createFileStudioLock({ path, pid: 222, isAlive }).acquire("a");
    } catch (err) {
      expect((err as OsgraphToolError).code).toBe("BUSY");
    }
    expect(createFileStudioLock({ path, pid: 222, isAlive }).acquire("b").holder.pid).toBe(222);
  });

  it("an unreadable lockfile is BUSY while fresh and recovered once old", () => {
    const path = lockPath();
    writeFileSync(path, "{half");
    const isAlive = alive([222]);
    const err = busyOf(() => createFileStudioLock({ path, pid: 222, isAlive }).acquire("x"));
    expect(err.code).toBe("BUSY");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(createFileStudioLock({ path, pid: 222, isAlive }).acquire("x").holder.pid).toBe(222);
  });

  it("OSGRAPH_STUDIO_LOCK overrides the default path", () => {
    expect(defaultStudioLockPath({ [ENV_STUDIO_LOCK]: "/x/y.lock" })).toBe("/x/y.lock");
    expect(defaultStudioLockPath({})).toMatch(/osgraph-studio\.lock$/);
  });
});

describe("file studio lock across real processes", () => {
  const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "lock", "studioLock.js");
  it("a live other process blocks; once it dies its lock is recovered", async () => {
    const path = lockPath();
    mkdirSync(dirname(path), { recursive: true });
    const script =
      `import { createFileStudioLock } from ${JSON.stringify(pathToFileURL(dist).href)};\n` +
      `createFileStudioLock({ path: ${JSON.stringify(path)} }).acquire("child holder");\n` +
      `process.stdout.write("held\\n"); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("child exited early")));
    });
    const err = busyOf(() => createFileStudioLock({ path }).acquire("parent"));
    expect(err.code).toBe("BUSY");
    expect((err.details as { holder: { pid: number; command: string } }).holder).toMatchObject({
      pid: child.pid,
      command: "child holder"
    });
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
    expect(createFileStudioLock({ path }).acquire("parent").holder.pid).toBe(process.pid);
  }, 30_000);
});

describe("rebuild tool and the Studio lock", () => {
  it("another process holding the lock: BUSY naming the holder, no Studio read, in-process gate freed", async () => {
    const lock = lockPath();
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    const isAlive = () => true;
    createFileStudioLock({ path: lock, pid: 4242, isAlive }).acquire("osgraph run --scope portal");
    const { ctx } = makeCtx({ createSession: () => session, studioLock: createFileStudioLock({ path: lock, isAlive }) });
    await call("defineScope", { name: "portal", modules: ["demoportal", "x"] }, ctx);
    const r = await call("rebuild", { scope: "portal" }, ctx);
    expect(r.error?.code).toBe("BUSY");
    expect(r.error?.message).toContain("pid 4242");
    expect(r.error?.message).toContain("osgraph run --scope portal");
    expect(session.acquired).toBe(0);
    expect(ctx.rebuildGate.busy).toBe(false);
  });

  it("holds the lock during the rebuild and releases it on success", async () => {
    const lock = lockPath();
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    const { ctx } = makeCtx({ createSession: () => session, studioLock: createFileStudioLock({ path: lock }) });
    await call("defineScope", { name: "portal", modules: ["demoportal", "x"] }, ctx);
    const pending = call("rebuild", { scope: "portal" }, ctx);
    expect(JSON.parse(readFileSync(lock, "utf8")).command).toBe("mcp rebuild portal");
    expect((await pending).error).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
  });

  it("releases the lock when the rebuild fails", async () => {
    const lock = lockPath();
    const { ctx } = makeCtx({
      studioLock: createFileStudioLock({ path: lock }),
      createSession: () => {
        throw new Error("kaboom");
      }
    });
    ctx.scopeStore.define({ name: "portal", modules: ["demoportal"] });
    const r = await call("rebuild", { scope: "portal" }, ctx);
    expect(r.error?.code).toBe("INTERNAL_ERROR");
    expect(existsSync(lock)).toBe(false);
  });

  it("an in-process second rebuild keeps its REBUILD_IN_PROGRESS reply", async () => {
    const lock = lockPath();
    const session = fakeSession([demoPortalModule(), syntheticXModule()]);
    const { ctx } = makeCtx({ createSession: () => session, studioLock: createFileStudioLock({ path: lock }) });
    await call("defineScope", { name: "portal", modules: ["demoportal", "x"] }, ctx);
    const first = call("rebuild", { scope: "portal" }, ctx);
    const second = await call("rebuild", { scope: "portal" }, ctx);
    expect(second.error?.code).toBe("REBUILD_IN_PROGRESS");
    await first;
    expect(existsSync(lock)).toBe(false);
  });

  it("offline tools never take the lock", async () => {
    const takes: string[] = [];
    const { ctx } = makeCtx({
      studioLock: {
        acquire: (c) => {
          takes.push(c);
          throw new Error("offline tools must not lock");
        }
      }
    });
    await call("defineScope", { name: "portal", modules: ["demoportal"] }, ctx);
    await call("listScopes", {}, ctx);
    await call("getFlow", { scope: "portal", action: "x" }, ctx);
    await call("searchFlows", { scope: "portal", query: "x" }, ctx);
    await call("listViolations", { scope: "portal" }, ctx);
    expect(takes).toEqual([]);
  });
});
