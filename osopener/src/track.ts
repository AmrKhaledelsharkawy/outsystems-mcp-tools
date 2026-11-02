/**
 * Recorded replay tracks: `tracks/<studioFileVersion>.json` (OSG-014 §7). Data, committed; never secrets.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Track } from "./types.js";

/** File-system-safe file name for a Studio FileVersion such as `11.55.93.65333`. */
export function trackFileName(studioVersion: string): string {
  const safe = studioVersion.replace(/[^0-9A-Za-z._-]/g, "_");
  return `${safe}.json`;
}

export function trackPath(dataDir: string, studioVersion: string): string {
  return join(dataDir, "tracks", trackFileName(studioVersion));
}

/** Returns the track for this exact version, or undefined when absent/unreadable/mismatched. */
export async function readTrack(dataDir: string, studioVersion: string): Promise<Track | undefined> {
  try {
    const raw = await readFile(trackPath(dataDir, studioVersion), "utf8");
    const parsed = JSON.parse(raw) as Track;
    if (parsed.studioVersion !== studioVersion) return undefined;
    if (!parsed.openDialog || !parsed.search || !parsed.timings) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Atomic write (temp + rename) so a crash never leaves a half-written track. */
export async function writeTrack(dataDir: string, track: Track): Promise<string> {
  const path = trackPath(dataDir, track.studioVersion);
  await mkdir(join(dataDir, "tracks"), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(track, null, 2) + "\n", "utf8");
  await rename(tmp, path);
  return path;
}
