/**
 * The "did this module change since it was captured?" decision behind `osgraph run --changed` (#65).
 *
 * The whole comparison lives in `decideChange` on purpose: Phase 1 uses Service Studio's listed module
 * version as the signal (gated on a live probe a person performs, see the README), and a stronger signal
 * (#10 / #17) may replace it later. That swap must stay local to this file.
 *
 * Rule that never bends: an unknown version is NEVER treated as unchanged. Unknown on either side (an
 * old-schema manifest, an empty or missing listed version) means "read it".
 *
 * "0" is unknown too: Service Studio lists a module's real server version only when it was opened through
 * Open from Environment; a module opened from the recent list is listed as version "0", so "0" == "0"
 * would wrongly read as unchanged.
 */
import { listRawModules, readRawModule } from "../rebuild/raw.js";

export type ChangeReason = "unchanged" | "changed" | "unknown" | "no capture";

export interface ChangeDecision {
  /** True when the module must be re-read. */
  read: boolean;
  reason: ChangeReason;
  /** Human-readable detail for the per-module output line. */
  detail: string;
}

/** What the capture manifest says about a module (no Studio involved). */
export interface CaptureVersion {
  /** False when there is no complete raw capture. */
  exists: boolean;
  /** The `moduleVersion` stored by the capture; `null` when unknown (schema 1, or not listed). */
  version: string | null;
}

const lower = (s: string): string => s.toLowerCase();

/** Reads the stored version of `module`'s capture, tolerant of case and of unreadable captures. */
export function readCaptureVersion(graphDir: string, scope: string, module: string): CaptureVersion {
  const canonical = listRawModules(graphDir, scope).find((m) => lower(m) === lower(module));
  if (canonical === undefined) return { exists: false, version: null };
  try {
    const { manifest } = readRawModule(graphDir, scope, canonical);
    const v = manifest.moduleVersion;
    return { exists: true, version: typeof v === "string" && v !== "" ? v : null };
  } catch {
    // A capture that cannot be read is as good as none: it has to be re-read.
    return { exists: false, version: null };
  }
}

/** A version that can be compared: a non-empty string other than "0" (see the file comment). */
export function isKnownVersion(version: string | null | undefined): boolean {
  return typeof version === "string" && version !== "" && version !== "0";
}

/** The single comparison. `listedVersion` is what Studio's open-module listing reports now. */
export function decideChange(capture: CaptureVersion, listedVersion: string | null | undefined): ChangeDecision {
  if (!capture.exists) return { read: true, reason: "no capture", detail: "no raw capture yet" };
  if (!isKnownVersion(capture.version)) {
    return {
      read: true,
      reason: "unknown",
      detail:
        capture.version === "0"
          ? 'the capture records version "0" (unknown: not an Open from Environment open)'
          : "the capture records no module version (old schema or not listed)"
    };
  }
  if (!isKnownVersion(listedVersion)) {
    return {
      read: true,
      reason: "unknown",
      detail:
        listedVersion === "0"
          ? 'Studio lists version "0" for the open module (unknown: not an Open from Environment open)'
          : "Studio reports no version for the open module"
    };
  }
  if (listedVersion === capture.version) {
    return { read: false, reason: "unchanged", detail: `version ${listedVersion} matches the capture` };
  }
  return { read: true, reason: "changed", detail: `version ${capture.version} -> ${listedVersion}` };
}
