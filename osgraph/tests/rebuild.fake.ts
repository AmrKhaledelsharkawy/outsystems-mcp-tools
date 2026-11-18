/**
 * Fixture-backed `ServiceStudioReader` double for rebuild tests (no network, no token).
 *
 * Serves **synthetic** modules only — `demoportal`, `demoservices`, `x` and the generated `wide` —
 * so this file and every test that drives it can be published (see `PROVENANCE.md`). The verbatim
 * captures of a real module that this fake used to serve now live in the local-only
 * `rebuild.capture.fake.ts`, beside the tests that still need them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unfence } from "../src/extract/index.js";
import type { ServiceStudioReader, ServiceStudioSession } from "../src/rebuild/reader.js";
import { OsgraphToolError, ServiceStudioCallError, type ServiceStudioApp, type ServiceStudioElementName } from "../src/servicestudio/types.js";
import { TOKEN_EXPIRED_MESSAGE } from "../src/servicestudio/client.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
/**
 * Reads a fixture text with its line endings normalised to LF first. A fixture checked out on a
 * Windows runner (`core.autocrlf=true`) arrives as CRLF and the same file on ubuntu as LF; without
 * this, the bytes the fake serves — and so every raw file and snapshot — would differ between the
 * two CI legs.
 */
const read = (rel: string): string => unfence(readFileSync(join(fixtures, rel), "utf8").replace(/\r\n/g, "\n"));
/** Service Studio answers with CRLF line endings; the `demoportal` texts are served that way on purpose. */
const crlf = (text: string): string => text.replace(/\n/g, "\r\n");

export interface NamesListing {
  screens: ServiceStudioElementName[];
  blocks: ServiceStudioElementName[];
  cacts: ServiceStudioElementName[];
  sacts: ServiceStudioElementName[];
  services?: ServiceStudioElementName[];
}
export const readNames = (rel: string): NamesListing => JSON.parse(readFileSync(join(fixtures, rel), "utf8")) as NamesListing;

export interface FakeModule {
  app: ServiceStudioApp;
  dataModel: string;
  structures: string;
  screens: ServiceStudioElementName[];
  blocks: ServiceStudioElementName[];
  clientActions: ServiceStudioElementName[];
  serverActions: ServiceStudioElementName[];
  /** `SL_*` actions a Service module publishes. Optional: absent means the module declares none. */
  serviceActions?: ServiceStudioElementName[];
  texts: Record<string, string>; // `<Kind>/<Name>` → text
}

export function app(name: string, overrides: Partial<ServiceStudioApp> = {}): ServiceStudioApp {
  return {
    key: `key-${name}`,
    name,
    kind: "eSpace",
    version: "1.0",
    description: "",
    isOpen: true,
    isReference: false,
    moduleType: "Reactive",
    ...overrides
  };
}

export interface ListingOptions {
  /**
   * Override every listing entry's `IsReferenced` to `false`, so the S6-audit-F3 filter fetches all
   * of them. The default is the listing as written, which carries the realistic mix; tests that need
   * the ADR-0008 duplicate-name path, or the text of a referenced-only entry, pass `false` here.
   */
  referencedOnly?: false;
}

export function withIsReferenced(entries: ServiceStudioElementName[], value: boolean): ServiceStudioElementName[] {
  return entries.map((e) => ({ ...e, IsReferenced: value }));
}

/**
 * The synthetic Reactive module `demoportal` (`fixtures/synthetic/demoportal/`). It is the published
 * stand-in for the real capture this fake used to serve, and is built to carry the same SHAPES, each
 * on purpose — the numbers are this fixture's own, not the real module's:
 *
 * | shape | where |
 * |---|---|
 * | more elements of every kind than the width-4 pool holds | 5 screens, 8 blocks (5 fetched), 5 client actions, 6 server actions (5 fetched) |
 * | a duplicate block name across two UI flows (ADR-0008) | `Card` in `Common` and in `DemoPatterns` |
 * | commented externals (ADR-0006) | 12 `// I…Signature` lines in `module/dataModel.txt`, the first behind `var eSpace = …` as Studio writes it |
 * | an uncommented, opaque `AddDependency` | `legacySource` in `DemoVisit` |
 * | a mixed `IsReferenced` listing | `Card` ×2, `OtpPanel` and `CNF_ExternalPage` are referenced-only; everything else is not |
 * | action flows and UI bindings | `screen/SignIn.txt`, mirroring a sign-in screen's wiring |
 * | an edge to a local element that is never read (placeholder, ADR-0009) | `SignIn` navigates to `MainFlow/Dashboard`, which the listing does not contain |
 *
 * Its texts are served with CRLF line endings, as Service Studio returns them.
 */
export const DEMO_PORTAL = "demoportal";
export function demoPortalModule(options: ListingOptions = {}): FakeModule {
  const names = readNames("synthetic/demoportal/names.json");
  const asListed = (entries: ServiceStudioElementName[]): ServiceStudioElementName[] =>
    options.referencedOnly === false ? withIsReferenced(entries, false) : entries;
  const texts: Record<string, string> = {};
  const load = (kind: string, dir: string, entries: ServiceStudioElementName[]): void => {
    for (const e of entries) texts[`${kind}/${String(e.Name)}`] = crlf(read(`synthetic/demoportal/${dir}/${String(e.Name)}.txt`));
  };
  load("Screen", "screen", names.screens);
  load("Block", "block", names.blocks);
  load("ClientAction", "clientAction", names.cacts);
  load("ServerAction", "serverAction", names.sacts);
  return {
    app: app(DEMO_PORTAL),
    dataModel: crlf(read("synthetic/demoportal/module/dataModel.txt")),
    structures: crlf(read("synthetic/demoportal/module/structures.txt")),
    screens: asListed(names.screens),
    blocks: asListed(names.blocks),
    clientActions: asListed(names.cacts),
    serverActions: asListed(names.sacts),
    texts
  };
}

/**
 * The synthetic Service module `demoservices`: three `SL_*` service actions, every one of them
 * `IsReferenced: true`, and nothing else to list. Its service actions therefore cost zero element
 * fetches unless the F3 escape hatch is on, which is the case the published suite had no fixture for.
 */
export const DEMO_SERVICES = "demoservices";
export function demoServicesModule(): FakeModule {
  const names = readNames("synthetic/demoservices/names.json");
  const services = names.services ?? [];
  const texts: Record<string, string> = {};
  // Served only when the escape hatch fetches them anyway; derived from the one synthetic server action.
  const template = read("synthetic/serverAction-BL_IsCodePatternValid.txt");
  for (const s of services) texts[`ServerAction/${String(s.Name)}`] = template.split("BL_IsCodePatternValid").join(String(s.Name));
  return {
    app: app(DEMO_SERVICES, { moduleType: "Service" }),
    dataModel: read("synthetic/demoservices/module/dataModel.txt"),
    structures: read("synthetic/demoservices/module/structures.txt"),
    screens: names.screens,
    blocks: names.blocks,
    clientActions: names.cacts,
    serverActions: names.sacts,
    serviceActions: services,
    texts
  };
}

export function syntheticXModule(): FakeModule {
  return {
    app: app("x"),
    dataModel: read("synthetic/entities.txt"),
    structures: read("synthetic/structures.txt"),
    screens: [],
    blocks: [],
    clientActions: [{ Name: "OSM004ToggleFlag", IsReferenced: false }],
    serverActions: [{ Name: "BL_IsCodePatternValid", IsReferenced: false }],
    texts: {
      "ClientAction/OSM004ToggleFlag": read("synthetic/clientAction-OSM004ToggleFlag.txt"),
      "ServerAction/BL_IsCodePatternValid": read("synthetic/serverAction-BL_IsCodePatternValid.txt")
    }
  };
}

/**
 * A module with `count` client actions, all derived from the one synthetic capture (OSG-016 §A6).
 * The real fixtures top out at 3 elements of a kind, which is below the default pool width and so
 * cannot show a pool at full stretch; this one can. Names are zero-padded so a test can make the
 * fake answer in reverse by deriving a delay from the name.
 */
export function syntheticWideModule(count: number, name = "wide"): FakeModule {
  const template = read("synthetic/clientAction-OSM004ToggleFlag.txt");
  const names = Array.from({ length: count }, (_, i) => `A_Act${String(i).padStart(2, "0")}`);
  const texts: Record<string, string> = {};
  for (const n of names) texts[`ClientAction/${n}`] = template.split("OSM004ToggleFlag").join(n);
  return {
    app: app(name),
    dataModel: read("synthetic/entities.txt"),
    structures: read("synthetic/structures.txt"),
    screens: [],
    blocks: [],
    clientActions: names.map((n) => ({ Name: n, IsReferenced: false })),
    serverActions: [],
    texts
  };
}

export interface RecordedRead {
  tool: string;
  module: string;
  name?: string;
}

export interface FakeReaderOptions {
  /** `<tool>:<module>:<name>` → how many times to fail with a ServiceStudioCallError before succeeding (Infinity = always). */
  failures?: Record<string, number>;
  /** Apps returned by listApps; defaults to every module's app. */
  apps?: ServiceStudioApp[];
  /** Throw this from listApps (session-level failure). */
  listAppsError?: Error;
  /**
   * Milliseconds to hold a call before it answers (OSG-016 §A6). This is how a test makes the
   * fake answer in a deliberately different order from the one it was asked in: with a pool of
   * width 4 and a delay that grows as the name shrinks, completion order is a shuffle of dispatch
   * order, and every determinism assertion in `rebuild.test.ts` is a comparison against the serial
   * run's bytes. Default: no delay (dispatch order ≈ completion order).
   */
  delayMs?: (call: RecordedRead) => number;
}

export class FakeReader implements ServiceStudioReader {
  readonly calls: RecordedRead[] = [];
  /** The same calls in the order they ANSWERED. Differs from `calls` exactly when `delayMs` says so. */
  readonly completions: RecordedRead[] = [];
  private readonly modules = new Map<string, FakeModule>();
  private readonly failures: Map<string, number>;
  inFlight = 0;
  maxInFlight = 0;
  /** How many times `drain()` was awaited (OSG-016 §B1). */
  drainCalls = 0;
  /** `inFlight` at the moment `drain()` was last entered — must be 0 by the time it resolves. */
  inFlightAtDrain: number[] = [];

  constructor(modules: FakeModule[], private readonly options: FakeReaderOptions = {}) {
    for (const m of modules) this.modules.set(m.app.name, m);
    this.failures = new Map(Object.entries(options.failures ?? {}));
  }

  private async serve<T>(tool: string, module: string, name: string | undefined, produce: (m: FakeModule) => T): Promise<T> {
    this.calls.push({ tool, module, ...(name !== undefined ? { name } : {}) });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      const delay = this.options.delayMs?.({ tool, module, ...(name !== undefined ? { name } : {}) }) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const key = `${tool}:${module}:${name ?? ""}`;
      const remaining = this.failures.get(key) ?? 0;
      if (remaining > 0) {
        this.failures.set(key, remaining - 1);
        throw new ServiceStudioCallError({ toolName: tool, message: `${tool}: tool error: boom (${key})` });
      }
      const m = this.modules.get(module);
      if (!m) throw new ServiceStudioCallError({ toolName: tool, message: `${tool}: unknown module ${module}` });
      return produce(m);
    } finally {
      this.inFlight--;
      this.completions.push({ tool, module, ...(name !== undefined ? { name } : {}) });
    }
  }

  /**
   * The real client's `drain()` barrier (OSG-016 §B1), with the same contract: resolves only once
   * nothing is in flight. Implemented here so a test can prove the rebuild awaits it before handing
   * control back to a caller whose next move is `closeModule`.
   */
  async drain(): Promise<void> {
    this.drainCalls++;
    this.inFlightAtDrain.push(this.inFlight);
    while (this.inFlight > 0) await new Promise((r) => setTimeout(r, 0));
  }

  private text(tool: string, module: string, kind: string, name: string): Promise<string> {
    return this.serve(tool, module, name, (m) => {
      const t = m.texts[`${kind}/${name}`];
      if (t === undefined) throw new ServiceStudioCallError({ toolName: tool, message: `${tool}: no such ${kind} '${name}'` });
      return t;
    });
  }

  async listApps(): Promise<ServiceStudioApp[]> {
    this.calls.push({ tool: "listApps", module: "*" });
    await Promise.resolve();
    if (this.options.listAppsError) throw this.options.listAppsError;
    return this.options.apps ?? [...this.modules.values()].map((m) => m.app);
  }
  getDataModel(m: string) { return this.serve("getDataModel", m, undefined, (x) => x.dataModel); }
  getStructures(m: string) { return this.serve("getStructures", m, undefined, (x) => x.structures); }
  getScreenNames(m: string) { return this.serve("getScreenNames", m, undefined, (x) => x.screens); }
  getWebBlockNames(m: string) { return this.serve("getWebBlockNames", m, undefined, (x) => x.blocks); }
  getActionNames(m: string, objectType: "client" | "server" | "service") {
    // `serviceActions` is optional on a fixture: a module that declares none answers `[]`, which is
    // what every pre-existing fixture must keep doing so their captures stay byte-identical.
    return this.serve("getActionNames", m, objectType, (x) =>
      objectType === "client" ? x.clientActions : objectType === "service" ? (x.serviceActions ?? []) : x.serverActions
    );
  }
  getScreen(m: string, n: string) { return this.text("getScreen", m, "Screen", n); }
  getWebBlock(m: string, n: string) { return this.text("getWebBlock", m, "Block", n); }
  getClientAction(m: string, n: string) { return this.text("getClientAction", m, "ClientAction", n); }
  getServerAction(m: string, n: string) { return this.text("getServerAction", m, "ServerAction", n); }
  getServiceAction(m: string, n: string) { return this.text("getServiceAction", m, "ServerAction", n); }
  getScreenNamesTraditional(m: string) { return this.serve("getScreenNamesTraditional", m, undefined, (x) => x.screens); }
  getWebBlockNamesTraditional(m: string) { return this.serve("getWebBlockNamesTraditional", m, undefined, (x) => x.blocks); }
  getScreenTraditional(m: string, n: string) { return this.text("getScreenTraditional", m, "Screen", n); }
  getWebBlockTraditional(m: string, n: string) { return this.text("getWebBlockTraditional", m, "Block", n); }
}

export interface FakeSessionOptions extends FakeReaderOptions {
  /** Make `acquire()` throw (e.g. TOKEN_EXPIRED). */
  acquireError?: Error;
  /** Token `acquire()` hands out; a distinctive value lets a test grep for it (ADR-0004 secrecy). */
  token?: string;
}

export function fakeSession(
  modules: FakeModule[],
  options: FakeSessionOptions = {}
): ServiceStudioSession & { reader: FakeReader; acquired: number; released: number; handedOut: string | undefined } {
  const reader = new FakeReader(modules, options);
  const session = {
    reader,
    acquired: 0,
    released: 0,
    handedOut: undefined as string | undefined,
    async acquire() {
      session.acquired++;
      if (options.acquireError) throw options.acquireError;
      session.handedOut = options.token ?? "token";
      return session.handedOut;
    },
    release() {
      session.released++;
    }
  };
  return session;
}

export function tokenExpiredError(): OsgraphToolError {
  return new OsgraphToolError("TOKEN_EXPIRED", TOKEN_EXPIRED_MESSAGE, { reason: "test" });
}
