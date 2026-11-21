/**
 * Raw element-text persistence (goal-osgraph-flows.md Design 1 / slice F0).
 *
 * v1 threw every element text away the moment `extractModule` had walked it, so the only way to
 * change what osgraph understands about a module was to read that module live again — ≈11 minutes
 * per module, ≈4-8 hours for the 38-module live scope (ADR-0007's second sample). The flow IR in
 * `src/flows` needs a far more detailed parse of exactly those texts, and a parser cannot be
 * iterated on at that price.
 *
 * So the rebuild now also writes every text it fetched, verbatim, under
 * `<graphDir>/<scope>/raw/<module>/`:
 *
 * ```
 * raw/MOD_DEMO_Booking_CW/
 *   manifest.json                        what was captured, and under which file name
 *   module/dataModel.txt                 getDataModel
 *   module/structures.txt                getStructures
 *   Screen/<UIFlow>/<Name>.txt           getScreen
 *   Block/<UIFlow>/<Name>.txt            getWebBlock
 *   ClientAction/<Name>.txt              getClientAction
 *   ServerAction/<Name>.txt              getServerAction
 * ```
 *
 * The bytes written are the **unwrapped** text — exactly the string the extractor was handed, not
 * the MCP envelope around it. That is what makes flow extraction a pure function over `raw/`: the
 * offline `reextract` path can reproduce an extraction with no Service Studio running at all.
 *
 * Two deliberate properties:
 *
 *  - **Atomic per module (ADR-0015).** Texts are written as each one arrives, but into a sibling
 *    staging directory (`%tmp-<module>-<n>`), never into the live capture. Only when the manifest
 *    is written, and every text it lists has been re-read and size/hash checked, does the staging
 *    directory replace the previous capture by rename. An aborted read (exception, cancel, killed
 *    process) therefore leaves the previous capture byte-identical, and leftover staging
 *    directories are never read. The cost: an aborted run no longer keeps the partial texts it
 *    paid for; the previous complete capture is kept instead, which is what `reextract` can use.
 *  - **`manifest.json` is the source of truth for re-reading, not the directory layout.** File
 *    names are encoded for the filesystem's benefit and are lossy in principle (two UI flows can
 *    encode to one segment); the manifest carries the real `name` / `uiFlow` / `kind` beside the
 *    file it went to, and `claimPath` guarantees one file per captured text even when the encoded
 *    names collide.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveScopeArtifactPaths } from "../graph/io.js";
import { OsgraphToolError } from "../servicestudio/types.js";

/**
 * Staging / aside directory prefixes (ADR-0015). `%` is always followed by two hex digits in an
 * encoded module name, so `%t` / `%o` never collide with a real capture directory.
 */
const TMP_PREFIX = "%tmp-";
const OLD_PREFIX = "%old-";

/**
 * Bumped when `RawManifest`'s shape changes. 2 added `moduleKey` / `moduleVersion` (#61).
 * `readRawModule` reads every version in `RAW_READABLE_SCHEMA_VERSIONS`; anything else is refused.
 */
export const RAW_SCHEMA_VERSION = 2;

/** Manifest schemas this build can read. 1 predates the module identity fields. */
export const RAW_READABLE_SCHEMA_VERSIONS: readonly number[] = [1, 2];

/** Why `moduleKey` / `moduleVersion` are `null`: the capture predates schema 2. Never backfilled. */
export const IDENTITY_UNKNOWN_OLD_SCHEMA = "OLD_SCHEMA";
/** Why they are `null`: the open-module listing did not report them at capture time. */
export const IDENTITY_UNKNOWN_NOT_LISTED = "NOT_IN_LISTING";

/** The two whole-module texts, keyed by the `module/` file they are written to. */
export type RawModuleTextKind = "dataModel" | "structures";

/** Element kinds that get one file each. Mirrors the rebuild's four element phases. */
export type RawElementKind = "Screen" | "Block" | "ClientAction" | "ServerAction";

/** Element kinds whose id is flow-qualified (ADR-0008), so their files live under a flow segment. */
const FLOW_QUALIFIED: ReadonlySet<RawElementKind> = new Set<RawElementKind>(["Screen", "Block"]);

/** Directory segment standing in for an element listed with no UI flow at all. */
const NO_FLOW_SEGMENT = "_NOFLOW";

export interface RawManifestEntry {
  /** `"Entity"` / `"Structure"` for the module texts, else the element kind. */
  kind: string;
  /** The servicestudio call that produced the text, for provenance. */
  call: string;
  /** Element name; absent for the two whole-module texts. */
  name?: string;
  /** UI flow exactly as the names listing reported it (ADR-0008). Absent for non-flow kinds. */
  uiFlow?: string;
  /** Path relative to the module's raw directory, always with forward slashes. */
  file: string;
  /** Byte length of the file as written (UTF-8), so a truncated capture is visible. */
  bytes: number;
  /** SHA-256 (hex) of the file's bytes. Absent in captures written before ADR-0015, which are still read. */
  sha256?: string;
}

export interface RawManifestSkip {
  kind: string;
  name: string;
  reason: string;
}

export interface RawManifest {
  schemaVersion: number;
  scope: string;
  /** Canonical module name as `listApps` reports it. */
  module: string;
  /** Present only when the scope file spelled the module differently. */
  requestedAs?: string;
  moduleType: string;
  /** ISO-8601 clock at the moment the module's capture finished. */
  capturedAt: string;
  /**
   * `key` / `version` exactly as the open-module listing reported them at capture time, or `null`
   * when it did not (see `moduleIdentityReason`). Schema 2+; `readRawModule` returns `null` for a
   * schema-1 manifest (reason `OLD_SCHEMA`) rather than guessing.
   */
  moduleKey: string | null;
  moduleVersion: string | null;
  /** `null` when both identity fields are known, else why they are not. */
  moduleIdentityReason: string | null;
  /** Listing entries never fetched because `IsReferenced === true` (S6 audit F3). Never a skip. */
  referencedOnlyCount: number;
  /** Element reads that failed twice and were skipped (OSG-011). Their texts are not on disk. */
  skipped: RawManifestSkip[];
  /**
   * Kinds deliberately not read (#69; OSGRAPH_SKIP_KINDS). Absent when everything was read, so a
   * default capture's manifest is unchanged. `reextract` copies it into `meta.json`.
   */
  skippedKinds?: string[];
  /** One entry per file actually written, in capture order. */
  texts: RawManifestEntry[];
}

export function rawDir(graphDir: string, scope: string): string {
  return join(resolveScopeArtifactPaths(graphDir, scope).dir, "raw");
}

export function rawModuleDir(graphDir: string, scope: string, module: string): string {
  return join(rawDir(graphDir, scope), encodeURIComponent(module));
}

export function rawManifestPath(graphDir: string, scope: string, module: string): string {
  return join(rawModuleDir(graphDir, scope, module), "manifest.json");
}

/**
 * One path segment, safe for every filesystem and reversible by `decodeURIComponent`.
 *
 * `encodeURIComponent` already removes `/`, `\` and `:`, but leaves `*` and `?` — legal in an
 * OutSystems name, rejected by Windows — and leaves `.`, so a name of `..` would still traverse.
 * Both are escaped here on top of it. The result is only ever a display/location choice; the
 * manifest, not the file name, is what `readRawModule` trusts.
 */
export function encodeSegment(value: string): string {
  const encoded = encodeURIComponent(value).replace(/[*?.!~'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return encoded.length === 0 ? "_" : encoded;
}

/** The relative file a text goes to, before collision handling. Forward slashes, as in the manifest. */
export function rawRelativeFile(
  kind: RawElementKind | RawModuleTextKind,
  name: string,
  uiFlow: string | undefined
): string {
  if (kind === "dataModel" || kind === "structures") return `module/${kind}.txt`;
  const leaf = `${encodeSegment(name)}.txt`;
  if (!FLOW_QUALIFIED.has(kind)) return `${kind}/${leaf}`;
  const flow = uiFlow !== undefined && uiFlow.length > 0 ? encodeSegment(uiFlow) : NO_FLOW_SEGMENT;
  return `${kind}/${flow}/${leaf}`;
}

/**
 * Accumulates one module's raw capture and writes each text as it arrives.
 *
 * Created per module by the rebuild walker and finished with `writeManifest`. A module whose
 * capture aborts therefore has files but no manifest, which is precisely how `readRawModule`
 * reports it: an incomplete capture must not look like a complete one.
 */
export class RawModuleWriter {
  private readonly entries: RawManifestEntry[] = [];
  /** Relative file → the `kind name flow` that claimed it, for the collision guard. */
  private readonly claimed = new Map<string, string>();
  /** The live capture directory this writer replaces on a successful `writeManifest`. */
  private readonly dir: string;
  /** Sibling staging directory every text is written into. */
  private readonly stagingDir: string;
  private static counter = 0;

  constructor(
    private readonly graphDir: string,
    private readonly scope: string,
    private readonly module: string
  ) {
    // One unfinished writer per canonical module per process: a second one would race the first
    // for the same live directory and its staging cleanup. Fail closed instead of guessing.
    const active = activeWriterFor(dirname(rawModuleDir(graphDir, scope, module)), module);
    if (active !== undefined) {
      throw new OsgraphToolError(
        "RAW_CAPTURE_ACTIVE",
        `a raw capture of module '${module}' is already in progress in this process (${active}); ` +
          `a module is captured by one writer at a time`,
        { module, stagingDir: active }
      );
    }
    this.dir = rawModuleDir(graphDir, scope, module);
    const parent = dirname(this.dir);
    mkdirSync(parent, { recursive: true });
    // Finish or undo any swap a killed process left half-done, then drop stale staging directories
    // of this module before starting a fresh one.
    recoverRawDir(graphDir, scope);
    removeStagingFor(parent, module);
    this.stagingDir = join(parent, `${TMP_PREFIX}${encodeURIComponent(module)}-${process.pid}-${++RawModuleWriter.counter}`);
    mkdirSync(this.stagingDir, { recursive: true });
    ACTIVE_STAGING.set(this.stagingDir, module);
  }

  /** The live capture directory (the staging directory is an implementation detail). */
  get moduleDir(): string {
    return this.dir;
  }

  /** Discards the staging directory without touching the live capture (an explicit abort). */
  abort(): void {
    ACTIVE_STAGING.delete(this.stagingDir);
    rmSync(this.stagingDir, { recursive: true, force: true });
  }

  /**
   * Resolves the encoded path to one no other text in this module has taken. Two distinct captures
   * can encode to the same segment only pathologically (a UI flow literally named `_NOFLOW`, say),
   * but a silent overwrite there would lose a real element text, so the loser gets a `~2` suffix
   * and the manifest records where it actually went.
   */
  private claimPath(relative: string, identity: string): string {
    const existing = this.claimed.get(relative);
    if (existing === undefined || existing === identity) {
      this.claimed.set(relative, identity);
      return relative;
    }
    const dot = relative.lastIndexOf(".");
    const stem = dot === -1 ? relative : relative.slice(0, dot);
    const ext = dot === -1 ? "" : relative.slice(dot);
    for (let n = 2; ; n++) {
      const candidate = `${stem}~${n}${ext}`;
      const owner = this.claimed.get(candidate);
      if (owner === undefined || owner === identity) {
        this.claimed.set(candidate, identity);
        return candidate;
      }
    }
  }

  /**
   * Writes one unwrapped text and records it. `text` is written byte-for-byte as given: no newline
   * normalization, no trailing newline, no re-indentation. The F0 test asserts exactly that, because
   * a flow parser that is a pure function over these files can only be trusted if the files are the
   * same bytes the live extractor saw.
   */
  add(options: {
    kind: RawElementKind | RawModuleTextKind;
    manifestKind: string;
    call: string;
    name?: string;
    uiFlow?: string;
    text: string;
  }): RawManifestEntry {
    const { kind, manifestKind, call, name, uiFlow, text } = options;
    const identity = `${kind} ${name ?? ""} ${uiFlow ?? ""}`;
    const file = this.claimPath(rawRelativeFile(kind, name ?? "", uiFlow), identity);
    const absolute = join(this.stagingDir, ...file.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
    const entry: RawManifestEntry = {
      kind: manifestKind,
      call,
      file,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: sha256Of(Buffer.from(text, "utf8"))
    };
    if (name !== undefined) entry.name = name;
    if (uiFlow !== undefined) entry.uiFlow = uiFlow;
    // Re-capturing the same identity (a retry that succeeded) replaces its entry rather than adding one.
    const at = this.entries.findIndex((e) => e.file === file);
    if (at === -1) this.entries.push(entry);
    else this.entries[at] = entry;
    return entry;
  }

  /**
   * Finishes the capture: writes the manifest into the staging directory (last), verifies every
   * listed text by size and hash, then swaps the staging directory in over the previous capture.
   * Returns the live manifest path. On a verification failure it throws (`RAW_FILE_CORRUPT` /
   * `RAW_FILE_MISSING`), removes the staging directory and leaves the previous capture untouched.
   */
  writeManifest(options: {
    requestedAs?: string;
    moduleType: string;
    capturedAt: string;
    /** From the listing row; undefined or empty is stored as `null` plus a reason, never an error. */
    moduleKey?: string | null;
    moduleVersion?: string | null;
    referencedOnlyCount: number;
    skipped: RawManifestSkip[];
    skippedKinds?: readonly string[];
  }): string {
    const key = typeof options.moduleKey === "string" && options.moduleKey !== "" ? options.moduleKey : null;
    const version =
      typeof options.moduleVersion === "string" && options.moduleVersion !== "" ? options.moduleVersion : null;
    const manifest: RawManifest = {
      schemaVersion: RAW_SCHEMA_VERSION,
      scope: this.scope,
      module: this.module,
      moduleType: options.moduleType,
      capturedAt: options.capturedAt,
      moduleKey: key,
      moduleVersion: version,
      moduleIdentityReason: key !== null && version !== null ? null : IDENTITY_UNKNOWN_NOT_LISTED,
      referencedOnlyCount: options.referencedOnlyCount,
      skipped: options.skipped,
      texts: this.entries
    };
    if (options.requestedAs !== undefined && options.requestedAs !== this.module) {
      manifest.requestedAs = options.requestedAs;
    }
    if (options.skippedKinds !== undefined && options.skippedKinds.length > 0) {
      manifest.skippedKinds = [...options.skippedKinds];
    }
    try {
      verifyTexts(this.stagingDir, this.scope, this.module, manifest.texts);
      writeFileSync(join(this.stagingDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      swapIn(this.stagingDir, this.dir, join(dirname(this.dir), `${OLD_PREFIX}${encodeURIComponent(this.module)}`));
    } catch (err) {
      this.abort();
      throw err;
    }
    ACTIVE_STAGING.delete(this.stagingDir);
    return rawManifestPath(this.graphDir, this.scope, this.module);
  }
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Re-reads every listed text from `dir` and checks its size and (when recorded) hash. */
function verifyTexts(dir: string, scope: string, module: string, texts: RawManifestEntry[]): void {
  for (const entry of texts) {
    const absolute = join(dir, ...entry.file.split("/"));
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolute);
    } catch (err) {
      throw new RawCaptureError(
        "RAW_FILE_MISSING",
        `scope '${scope}': raw capture of '${module}' lists '${entry.file}' but it cannot be read: ` +
          `${err instanceof Error ? err.message : String(err)}.`,
        { scope, module, file: entry.file, absolute }
      );
    }
    if (bytes.length !== entry.bytes || (entry.sha256 !== undefined && sha256Of(bytes) !== entry.sha256)) {
      throw new RawCaptureError(
        "RAW_FILE_CORRUPT",
        `scope '${scope}': raw capture of '${module}': '${entry.file}' does not match its manifest ` +
          `(size ${bytes.length} vs ${entry.bytes}, or hash).`,
        { scope, module, file: entry.file, absolute }
      );
    }
  }
}

/**
 * Replaces `live` by `staged`. rename-over-an-existing-directory fails on Windows, so the old
 * capture is moved aside first, the new one renamed in, then the old one removed. A process killed
 * between the two renames leaves `aside` and no `live`; `recoverRawDir` puts it back.
 */
function swapIn(staged: string, live: string, aside: string): void {
  rmSync(aside, { recursive: true, force: true });
  const hadOld = existsSync(live);
  if (hadOld) renameSync(live, aside);
  try {
    renameSync(staged, live);
  } catch (err) {
    if (hadOld) renameSync(aside, live);
    throw err;
  }
  if (hadOld) rmSync(aside, { recursive: true, force: true });
}

/**
 * Staging directories owned by a not-yet-finished `RawModuleWriter` in this process (dir -> module).
 * Cleanup never deletes one of these, whichever module it belongs to: an entry leaves the map only
 * through `abort()` or a successful `writeManifest()`. A second writer for a module that already has
 * an entry is refused (`RAW_CAPTURE_ACTIVE`), so a stale entry is always another process's leftover.
 */
const ACTIVE_STAGING = new Map<string, string>();

/**
 * The staging dir of this process's unfinished writer for `module` (case-insensitive) under the
 * same `raw/` parent, if any. Keyed by parent so one module captured into two scopes is not blocked.
 */
function activeWriterFor(parent: string, module: string): string | undefined {
  const key = module.toLowerCase();
  for (const [dir, owner] of ACTIVE_STAGING) if (dirname(dir) === parent && owner.toLowerCase() === key) return dir;
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes stale staging directories of exactly `module`: names matching
 * `%tmp-<encoded module>-<pid>-<n>`. A bare prefix match would also hit module `X-Y` when starting
 * `X`, deleting a sibling writer's live staging directory.
 */
function removeStagingFor(parent: string, module: string): void {
  const grammar = new RegExp(`^${escapeRegExp(`${TMP_PREFIX}${encodeURIComponent(module)}-`)}[0-9]+-[0-9]+$`);
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!grammar.test(name)) continue;
    const dir = join(parent, name);
    // Never an active writer's directory (any module): only leftovers of finished or dead writers.
    if (ACTIVE_STAGING.has(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Recovers interrupted swaps under `<scope>/raw/`: an aside directory with no live capture is
 * renamed back (the previous capture was complete); one beside a live capture is the leftover of a
 * finished swap and is removed. Staging directories are never promoted; they are only removed when
 * the same module is next captured.
 */
export function recoverRawDir(graphDir: string, scope: string): void {
  const parent = rawDir(graphDir, scope);
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(OLD_PREFIX)) continue;
    const aside = join(parent, name);
    const live = join(parent, name.slice(OLD_PREFIX.length));
    try {
      if (existsSync(live)) rmSync(aside, { recursive: true, force: true });
      else renameSync(aside, live);
    } catch {
      /* best effort: a locked directory is retried on the next start */
    }
  }
}

export interface RawText extends RawManifestEntry {
  /** The file's bytes, decoded as UTF-8. */
  text: string;
}

export interface RawModuleCapture {
  manifest: RawManifest;
  texts: RawText[];
}

/** Thrown by `readRawModule` when a capture is absent, incomplete or of another schema version. */
export class RawCaptureError extends Error {
  readonly code: "RAW_NOT_CAPTURED" | "RAW_SCHEMA_MISMATCH" | "RAW_FILE_MISSING" | "RAW_FILE_CORRUPT";
  readonly details: Record<string, unknown>;
  constructor(code: RawCaptureError["code"], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RawCaptureError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Reads one module's capture back. Pure filesystem work — no token, no Studio, no network: this is
 * the entry point the offline `reextract` path and every flow-parser test go through.
 */
export function readRawModule(graphDir: string, scope: string, module: string): RawModuleCapture {
  recoverRawDir(graphDir, scope);
  const manifestPath = rawManifestPath(graphDir, scope, module);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new RawCaptureError(
      "RAW_NOT_CAPTURED",
      `scope '${scope}': no complete raw capture for module '${module}' (${manifestPath} is missing or unreadable). ` +
        `A manifest is written last, so files without one are an aborted capture; rebuild the module to capture it.`,
      { scope, module, manifestPath, cause: err instanceof Error ? err.message : String(err) }
    );
  }
  const manifest = parsed as RawManifest;
  if (typeof manifest !== "object" || manifest === null || !Array.isArray(manifest.texts)) {
    throw new RawCaptureError("RAW_NOT_CAPTURED", `scope '${scope}': raw manifest for '${module}' is malformed.`, {
      scope,
      module,
      manifestPath
    });
  }
  if (!RAW_READABLE_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    throw new RawCaptureError(
      "RAW_SCHEMA_MISMATCH",
      `scope '${scope}': raw capture of '${module}' is schema ${String(manifest.schemaVersion)}, this build reads ` +
        `${RAW_READABLE_SCHEMA_VERSIONS.join(", ")}. Re-capture the module (a mismatched manifest is never guessed at).`,
      { scope, module, manifestPath, found: manifest.schemaVersion, expected: RAW_SCHEMA_VERSION }
    );
  }
  if (manifest.schemaVersion < 2) {
    // Explicit "unknown", never inferred or backfilled. The file on disk is left untouched.
    manifest.moduleKey = null;
    manifest.moduleVersion = null;
    manifest.moduleIdentityReason = IDENTITY_UNKNOWN_OLD_SCHEMA;
  }
  const dir = rawModuleDir(graphDir, scope, module);
  verifyTexts(dir, scope, module, manifest.texts);
  const texts: RawText[] = manifest.texts.map((entry) => {
    const absolute = join(dir, ...entry.file.split("/"));
    try {
      return { ...entry, text: readFileSync(absolute, "utf8") };
    } catch (err) {
      throw new RawCaptureError(
        "RAW_FILE_MISSING",
        `scope '${scope}': raw capture of '${module}' lists '${entry.file}' but it cannot be read: ` +
          `${err instanceof Error ? err.message : String(err)}.`,
        { scope, module, file: entry.file, absolute }
      );
    }
  });
  return { manifest, texts };
}

/**
 * Canonical module names that have a complete raw capture in this scope, sorted. Directories with
 * no readable manifest are left out: an aborted capture is not a module `reextract` can rebuild.
 */
export function listRawModules(graphDir: string, scope: string): string[] {
  recoverRawDir(graphDir, scope);
  let dirs: string[];
  try {
    dirs = readdirSync(rawDir(graphDir, scope), { withFileTypes: true })
      // Staging / aside directories (ADR-0015) are never captures.
      .filter((d) => d.isDirectory() && !d.name.startsWith(TMP_PREFIX) && !d.name.startsWith(OLD_PREFIX))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const modules: string[] = [];
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(readFileSync(join(rawDir(graphDir, scope), dir, "manifest.json"), "utf8")) as RawManifest;
      if (typeof manifest.module === "string" && manifest.module.length > 0) modules.push(manifest.module);
    } catch {
      /* no manifest: an aborted capture, not a usable module */
    }
  }
  return modules.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
