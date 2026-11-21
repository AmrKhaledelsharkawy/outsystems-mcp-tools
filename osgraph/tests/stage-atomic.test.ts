/** writeStageEntry must write a `.tmp` sibling then rename it over the target (never write the target directly). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync), renameSync: vi.fn(actual.renameSync) };
});

import * as fs from "node:fs";
import { readStage, stagePath, writeStageEntry, type StageEntry } from "../src/rebuild/stage.js";

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(fs.writeFileSync).mockClear();
  vi.mocked(fs.renameSync).mockClear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function entry(extra: Partial<StageEntry> = {}): StageEntry {
  return {
    module: "m1",
    scope: "demo",
    moduleType: "Service",
    stagedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    referencedOnlyCount: 0,
    phaseDurationsMs: {},
    extracted: { module: "m1", nodes: [], edges: [], skipped: [] }
  } as unknown as StageEntry;
}

describe("writeStageEntry atomicity", () => {
  it("writes a .tmp sibling and renames it onto the target", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-atomic-"));
    dirs.push(dir);
    const target = stagePath(dir, "demo", "m1");
    writeStageEntry(dir, entry());
    const written = vi.mocked(fs.writeFileSync).mock.calls.map((c) => String(c[0]));
    expect(written).not.toContain(target);
    const tmpPath = written.find((p) => p.endsWith(".tmp"))!;
    expect(tmpPath.startsWith(`${target}.`)).toBe(true);
    expect(vi.mocked(fs.renameSync).mock.calls.map((c) => [String(c[0]), String(c[1])])).toContainEqual([tmpPath, target]);
    expect(readdirSync(join(dir, "demo", "stage")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readStage(dir, "demo").entries.map((e) => e.module)).toEqual(["m1"]);
  });

  it("failed temp write leaves the existing entry intact and no temp behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-atomic-"));
    dirs.push(dir);
    writeStageEntry(dir, entry());
    const target = stagePath(dir, "demo", "m1");
    const before = readFileSync(target, "utf8");
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => writeStageEntry(dir, entry({ durationMs: 999 }))).toThrow("disk full");
    expect(readFileSync(target, "utf8")).toBe(before);
    expect(readdirSync(join(dir, "demo", "stage")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(target)).toBe(true);
  });
});
