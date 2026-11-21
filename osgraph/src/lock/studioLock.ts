/**
 * Cross-process Service Studio lock (#64).
 *
 * `osgraph run`, the MCP `rebuild` tool and the discovery job are separate processes that all open
 * and close module tabs in the SAME Service Studio. Closing a tab while another process still has
 * reads queued on it is the one reproducible failure mode (ADR-0013), and nothing in-process can
 * stop it. This is a small file-based lock: whoever holds it owns every Studio call.
 *
 * Contract (the whole surface a successor needs to replace):
 *   - `StudioLock.acquire(command)` returns a `StudioLockHandle` or throws `OsgraphToolError("BUSY")`
 *     naming the holder. It never waits: a contender fails closed, fast.
 *   - `StudioLockHandle.release()` is idempotent and safe on every exit path.
 *
 * The issue #14 machine-wide fenced lease will replace `createFileStudioLock` behind this same
 * interface; callers only ever see `StudioLock`.
 *
 * Mechanics: the lockfile is created exclusively (`wx`), so exactly one contender wins, and holds
 * `{ pid, command, startedAt }`. A holder whose pid is no longer alive is stale and is recovered. A
 * live holder is never stolen from. Recovery itself is serialised by a second exclusive file so two
 * contenders cannot both delete the stale lock and one of them then delete the other's fresh one.
 * Known limit: a recycled pid makes a dead holder look alive (fail closed, never a false steal); the
 * operator then removes the file named in the BUSY message.
 */
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OsgraphToolError } from "../servicestudio/types.js";

/** `OSGRAPH_STUDIO_LOCK`: override the lockfile path. Every osgraph process on a machine must agree on it. */
export const ENV_STUDIO_LOCK = "OSGRAPH_STUDIO_LOCK";

/** Who owns the lock. Written verbatim into the lockfile. */
export interface StudioLockHolder {
  pid: number;
  /** What the owner is doing, e.g. `osgraph run --scope x` or `mcp rebuild x`. */
  command: string;
  /** ISO-8601. */
  startedAt: string;
}

export interface StudioLockHandle {
  readonly holder: StudioLockHolder;
  /** Idempotent. Only removes the lockfile while it still names this handle. */
  release(): void;
}

export interface StudioLock {
  /** Takes the lock or throws `OsgraphToolError("BUSY")` with `details.holder`. Never waits. */
  acquire(command: string): StudioLockHandle;
}

export interface FileStudioLockOptions {
  path: string;
  /** Liveness probe; default `process.kill(pid, 0)`. Injectable so tests can fake a dead holder. */
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  pid?: number;
  /** A lockfile that cannot be parsed and is younger than this may be a half-write in progress; default 10 s. */
  unreadableGraceMs?: number;
  /** A recovery guard older than this is abandoned; default 30 s. */
  recoverGuardMs?: number;
}

export function defaultStudioLockPath(env: Record<string, string | undefined>): string {
  const override = env[ENV_STUDIO_LOCK]?.trim();
  return override ? override : join(tmpdir(), "osgraph-studio.lock");
}

export function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

type ReadResult =
  | { kind: "gone" }
  | { kind: "holder"; holder: StudioLockHolder }
  | { kind: "unreadable"; ageMs: number };

function parseHolder(text: string): StudioLockHolder | null {
  try {
    const v = JSON.parse(text) as Partial<StudioLockHolder> | null;
    if (v && typeof v.pid === "number" && typeof v.command === "string" && typeof v.startedAt === "string") {
      return { pid: v.pid, command: v.command, startedAt: v.startedAt };
    }
  } catch {
    /* falls through */
  }
  return null;
}

export function createFileStudioLock(options: FileStudioLockOptions): StudioLock {
  const { path } = options;
  const guardPath = `${path}.recover`;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const now = options.now ?? (() => new Date());
  const ownPid = options.pid ?? process.pid;
  const unreadableGraceMs = options.unreadableGraceMs ?? 10_000;
  const recoverGuardMs = options.recoverGuardMs ?? 30_000;

  const readLock = (): ReadResult => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "gone" };
      throw err;
    }
    const holder = parseHolder(text);
    if (holder) return { kind: "holder", holder };
    try {
      return { kind: "unreadable", ageMs: Date.now() - statSync(path).mtimeMs };
    } catch {
      return { kind: "gone" };
    }
  };

  /** Exclusive create. True when this call made the file. */
  const tryCreate = (file: string, body: string): boolean => {
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return true;
  };

  const busy = (holder: StudioLockHolder | null, note?: string): OsgraphToolError => {
    const who = holder
      ? `pid ${holder.pid} running '${holder.command}' since ${holder.startedAt}`
      : "an unidentified holder (unreadable lockfile)";
    return new OsgraphToolError(
      "BUSY",
      `Service Studio is in use by another osgraph process: ${who}. Only one process may open or close module ` +
        `tabs at a time (closing a tab under another process's queued reads fails them, ADR-0013). Wait for it to ` +
        `finish, then retry.${note ? ` ${note}` : ""} Lockfile: ${path}`,
      { holder, lockFile: path }
    );
  };

  /** Removes the stale lock under the recovery guard. True when the lock is now free for the taking. */
  const recoverStale = (seen: ReadResult): boolean => {
    if (!tryCreate(guardPath, JSON.stringify({ pid: ownPid }))) {
      try {
        if (Date.now() - statSync(guardPath).mtimeMs > recoverGuardMs) rmSync(guardPath, { force: true });
      } catch {
        /* the guard vanished: someone else finished recovering */
      }
      return false;
    }
    try {
      // Re-read under the guard: it may have been recovered and re-acquired since `seen`.
      const again = readLock();
      if (again.kind === "gone") return true;
      const same =
        seen.kind === "holder" && again.kind === "holder"
          ? again.holder.pid === seen.holder.pid && again.holder.startedAt === seen.holder.startedAt
          : seen.kind === "unreadable" && again.kind === "unreadable";
      if (!same) return false;
      if (again.kind === "holder" && isAlive(again.holder.pid)) return false;
      rmSync(path, { force: true });
      return true;
    } finally {
      rmSync(guardPath, { force: true });
    }
  };

  return {
    acquire(command: string): StudioLockHandle {
      const holder: StudioLockHolder = { pid: ownPid, command, startedAt: now().toISOString() };
      const body = `${JSON.stringify(holder)}\n`;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (tryCreate(path, body)) {
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            // Only delete a lockfile that still names us; never remove a successor's.
            const cur = readLock();
            if (cur.kind === "holder" && cur.holder.pid === holder.pid && cur.holder.startedAt === holder.startedAt) {
              rmSync(path, { force: true });
            }
          };
          return { holder, release };
        }
        const seen = readLock();
        if (seen.kind === "gone") continue;
        if (seen.kind === "holder") {
          if (isAlive(seen.holder.pid)) throw busy(seen.holder);
          if (recoverStale(seen)) continue;
          throw busy(seen.holder, "(stale-lock recovery lost to another contender)");
        }
        if (seen.ageMs < unreadableGraceMs) throw busy(null);
        if (recoverStale(seen)) continue;
        throw busy(null);
      }
      throw busy(null, "(lock kept changing hands)");
    }
  };
}
