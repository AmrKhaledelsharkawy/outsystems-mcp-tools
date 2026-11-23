/**
 * #90: `API` / `IS` / `ST` layers and REST (exposed + consumed) capture, graph and flows.
 *
 * Synthetic module names only (this file is published). The `getIntegrations` text is MODELLED on the
 * Model API creation recipes: nothing here proves the live Studio text has this shape, which is why the
 * ticket's live acceptance criteria stay unverified until a Studio run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignLayer, isAllowed } from "../src/layers/assign.js";
import { loadLayerRules } from "../src/layers/rules.js";
import { listViolations } from "../src/layers/violations.js";
import { parseId } from "../src/extract/ids.js";
import { restModeOf, splitIntegrations } from "../src/rest/split.js";
import { rebuildScope } from "../src/rebuild/rebuild.js";
import { listRawModules, readRawModule, rawManifestPath } from "../src/rebuild/raw.js";
import { buildGetFlowResult } from "../src/tools/getFlow.js";
import { computeImpact } from "../src/tools/queryImpact.js";
import { flowsPath, type FlowsArtifact } from "../src/flows/index.js";
import { reextractScope } from "../src/reextract.js";
import { app, fakeSession, type FakeModule } from "./rebuild.fake.js";

const rules = loadLayerRules();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("layers: API, IS and ST (#90)", () => {
  it.each([
    ["MOD_DEMO_Orders_API", "API"],
    ["MOD_DEMO_Payments_IS", "IS"],
    ["MOD_DEMO_Orders_ST", "ST"],
    ["MOD_DEMO_Orders_BL", "BL"],
    ["MOD_DEMO_Orders_Unknown", "UNKNOWN"]
  ])("%s is %s", (name, layer) => {
    expect(assignLayer(name, rules)).toBe(layer);
  });

  it.each([
    ["IS", "IS", true],
    ["IS", "LKP", true],
    ["IS", "ST", true],
    ["IS", "CS", false],
    ["IS", "BL", false],
    ["API", "API", true],
    ["API", "BL", true],
    ["API", "ST", true],
    ["API", "LKP", true],
    ["API", "CS", false],
    ["API", "IS", false],
    ["BL", "IS", true],
    ["BL", "ST", true],
    ["BL", "API", false],
    ["SL", "ST", true],
    ["CW", "ST", true],
    ["ST", "LKP", true],
    ["ST", "BL", false]
  ] as const)("%s -> %s allowed=%s", (source, target, allowed) => {
    expect(isAllowed(source, target, rules)).toBe(allowed);
  });
});

const EXPOSED = `(OutSystems.Model.IESpace eSpace) => {
    var mOD_DEMO_Orders_BL = eSpace.References.Named("MOD_DEMO_Orders_BL");
    var mOD_DEMO_Orders_CS = eSpace.References.Named("MOD_DEMO_Orders_CS");

    /*** creating IRestService 'OrdersAPI' ***/
    var ordersAPI = eSpace.CreateIntegration<ServiceStudio.Plugin.RESTService.IRestService>("OrdersAPI");
    ordersAPI.BaseURL = "/rest/OrdersAPI";

    var getOrder = ordersAPI.CreateAction("GetOrder");
    getOrder.HTTPMethod = ServiceStudio.Plugin.RESTService.Enumerations.HTTPMethod.GET;
    var id = getOrder.CreateInputParameter("Id");
    var startNode = getOrder.CreateNode<OutSystems.Model.Logic.Nodes.IStartNode>();
    var bL_GetOrder2 = mOD_DEMO_Orders_BL.ServerActions.Named("BL_GetOrder");
    var bL_GetOrder = getOrder.CreateNode<OutSystems.Model.Logic.Nodes.IExecuteServerActionNode>("BL_GetOrder").ConnectedBelow(startNode);
    bL_GetOrder.Action = bL_GetOrder2;
    var endNode = getOrder.CreateNode<OutSystems.Model.Logic.Nodes.IEndNode>().ConnectedBelow(bL_GetOrder);

    var createOrder = ordersAPI.CreateAction("CreateOrder");
    createOrder.HTTPMethod = ServiceStudio.Plugin.RESTService.Enumerations.HTTPMethod.POST;
    var startNode2 = createOrder.CreateNode<OutSystems.Model.Logic.Nodes.IStartNode>();
    var cS_GetTypeId2 = mOD_DEMO_Orders_CS.ServerActions.Named("CS_GetTypeId");
    var cS_GetTypeId = createOrder.CreateNode<OutSystems.Model.Logic.Nodes.IExecuteServerActionNode>("CS_GetTypeId").ConnectedBelow(startNode2);
    cS_GetTypeId.Action = cS_GetTypeId2;
    var endNode2 = createOrder.CreateNode<OutSystems.Model.Logic.Nodes.IEndNode>().ConnectedBelow(cS_GetTypeId);
}`;

const CONSUMED = `(OutSystems.Model.IESpace eSpace) => {
    /*** creating IRestClient 'PaymentsApi' ***/
    var paymentsApi = eSpace.CreateIntegration<ServiceStudio.Plugin.REST.IRestClient>("PaymentsApi");
    paymentsApi.BaseURL = "https://payments.example.test/v1";

    var charge = paymentsApi.CreateAction("Charge");
    charge.HTTPMethod = ServiceStudio.Plugin.REST.Enumerations.HTTPMethod.POST;
    charge.URLPath = "/charges";
    var amount = charge.CreateInputParameter("Amount");
}`;

const BL_TEXT = `(OutSystems.Model.IESpace eSpace) => {
    // IRestClientMethodSignature MOD_DEMO_Payments_IS/PaymentsApi/Charge
    var charge = (ServiceStudio.Plugin.REST.IRestClientMethodSignature)eSpace.AddDependency(Services.ModelServices.ParseGlobalKey("k-charge"));

    /*** creating IServerAction 'BL_GetOrder' ***/
    var bL_GetOrder = eSpace.CreateServerAction("BL_GetOrder");
    var startNode = bL_GetOrder.CreateNode<OutSystems.Model.Logic.Nodes.IStartNode>();
    var pay = bL_GetOrder.CreateNode<OutSystems.Model.Logic.Nodes.IExecuteServerActionNode>("Pay");
    pay.Action = charge;
}`;

const CS_TEXT = `(OutSystems.Model.IESpace eSpace) => {
    /*** creating IServerAction 'CS_GetTypeId' ***/
    var cS_GetTypeId = eSpace.CreateServerAction("CS_GetTypeId");
    var startNode = cS_GetTypeId.CreateNode<OutSystems.Model.Logic.Nodes.IStartNode>();
}`;

function mod(name: string, extra: Partial<FakeModule>): FakeModule {
  return { app: app(name), dataModel: "", structures: "", screens: [], blocks: [], clientActions: [], serverActions: [], texts: {}, ...extra };
}

function modules(): FakeModule[] {
  return [
    mod("MOD_DEMO_Orders_API", { integrations: EXPOSED }),
    mod("MOD_DEMO_Orders_BL", {
      serverActions: [{ Name: "BL_GetOrder", IsReferenced: false }],
      texts: { "ServerAction/BL_GetOrder": BL_TEXT },
      integrations: "SHOULD NEVER BE READ"
    }),
    mod("MOD_DEMO_Orders_CS", {
      serverActions: [{ Name: "CS_GetTypeId", IsReferenced: false }],
      texts: { "ServerAction/CS_GetTypeId": CS_TEXT }
    }),
    mod("MOD_DEMO_Payments_IS", { integrations: CONSUMED })
  ];
}

const scope = { name: "demo", modules: modules().map((m) => m.app.name) };

describe("splitIntegrations", () => {
  it("gates on the module suffix only", () => {
    expect(restModeOf("MOD_X_API")).toBe("exposed");
    expect(restModeOf("MOD_X_IS")).toBe("consumed");
    for (const n of ["MOD_X_BL", "MOD_X_CS", "MOD_X_SL", "MOD_X_CW", "MOD_X_UI", "MOD_X_LKP", "MOD_X_ST", "MOD_X_APIv2"]) {
      expect(restModeOf(n)).toBeUndefined();
    }
  });

  it("returns one text per method, API order then method order, each with the API preamble", () => {
    const methods = splitIntegrations(EXPOSED, "exposed");
    expect(methods.map((m) => `${m.api}/${m.method}`)).toEqual(["OrdersAPI/GetOrder", "OrdersAPI/CreateOrder"]);
    expect(methods.every((m) => !m.consumed)).toBe(true);
    expect(methods[0].text).toContain('eSpace.References.Named("MOD_DEMO_Orders_BL")');
    expect(methods[0].text).toContain("BL_GetOrder");
    expect(methods[0].text).not.toContain("CS_GetTypeId");
    expect(methods[1].text).toContain("CS_GetTypeId");
    expect(methods[1].text).not.toContain("GetOrder");
  });

  it("yields nothing for text with no REST API", () => {
    expect(splitIntegrations("", "exposed")).toEqual([]);
    expect(splitIntegrations("(OutSystems.Model.IESpace eSpace) => {\n}", "consumed")).toEqual([]);
  });
});

describe("rest ids", () => {
  it("round-trips a two-segment method name", () => {
    expect(parseId("osgraph://M/RestMethod/Api/Get")).toEqual({ module: "M", kind: "RestMethod", name: "Api/Get" });
    expect(parseId("osgraph://M/ConsumedRestMethod/Api/Get")).toEqual({
      module: "M",
      kind: "ConsumedRestMethod",
      name: "Api/Get"
    });
  });
});

describe("rebuild with REST (#90)", () => {
  async function run() {
    const dir = mkdtempSync(join(tmpdir(), "osgraph-rest-"));
    dirs.push(dir);
    const snapshotPath = join(dir, "demo", "graph.json");
    const session = fakeSession(modules());
    const outcome = await rebuildScope({ scope, snapshotPath, session, rules, retryDelayMs: 0, rawGraphDir: dir });
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      nodes: Array<{ id: string; kind?: string; layer?: string; label?: string; module?: string }>;
      links: Array<{ source: string; target: string; relation?: string }>;
    };
    const flows = JSON.parse(readFileSync(flowsPath(snapshotPath), "utf8")) as FlowsArtifact;
    return { dir, session, outcome, snapshot, flows, snapshotPath };
  }

  it("reads integrations for _API and _IS modules only", async () => {
    const { session } = await run();
    const reads = session.reader.calls.filter((c) => c.tool === "getIntegrations").map((c) => c.module).sort();
    expect(reads).toEqual(["MOD_DEMO_Orders_API", "MOD_DEMO_Payments_IS"]);
  });

  it("captures raw/<module>/RestAPI/<Api>/<Method>.txt and lists them in the manifest", async () => {
    const { dir } = await run();
    const api = readRawModule(dir, "demo", "MOD_DEMO_Orders_API");
    const rest = api.manifest.texts.filter((t) => t.kind === "RestMethod");
    expect(rest.map((t) => t.file)).toEqual(["RestAPI/OrdersAPI/GetOrder.txt", "RestAPI/OrdersAPI/CreateOrder.txt"]);
    expect(rest.map((t) => t.name)).toEqual(["OrdersAPI/GetOrder", "OrdersAPI/CreateOrder"]);
    const is = readRawModule(dir, "demo", "MOD_DEMO_Payments_IS");
    expect(is.manifest.texts.map((t) => `${t.kind}:${t.file}`)).toContain("ConsumedRestMethod:RestAPI/PaymentsApi/Charge.txt");
    // No other layer's manifest carries a REST entry (manifest check).
    for (const other of ["MOD_DEMO_Orders_BL", "MOD_DEMO_Orders_CS"]) {
      const m = readRawModule(dir, "demo", other).manifest;
      expect(m.texts.some((t) => /Rest/.test(t.kind) || t.file.startsWith("RestAPI/"))).toBe(false);
    }
    expect(listRawModules(dir, "demo")).toHaveLength(4);
    expect(rawManifestPath(dir, "demo", "MOD_DEMO_Orders_API")).toContain("manifest.json");
  });

  it("makes each REST method a node, with edges to what it calls", async () => {
    const { snapshot } = await run();
    const ids = new Set(snapshot.nodes.map((n) => n.id));
    expect(ids.has("osgraph://MOD_DEMO_Orders_API/RestMethod/OrdersAPI/GetOrder")).toBe(true);
    expect(ids.has("osgraph://MOD_DEMO_Orders_API/RestMethod/OrdersAPI/CreateOrder")).toBe(true);
    expect(ids.has("osgraph://MOD_DEMO_Payments_IS/ConsumedRestMethod/PaymentsApi/Charge")).toBe(true);
    const has = (s: string, t: string) => snapshot.links.some((l) => l.source === s && l.target === t);
    expect(
      has(
        "osgraph://MOD_DEMO_Orders_API/RestMethod/OrdersAPI/GetOrder",
        "osgraph://MOD_DEMO_Orders_BL/ServerAction/BL_GetOrder"
      )
    ).toBe(true);
  });

  it("queryImpact(dependents) from a consumed method reaches its BL caller and the exposed endpoint above it", async () => {
    const { snapshot } = await run();
    const impact = computeImpact(
      snapshot as never,
      "osgraph://MOD_DEMO_Payments_IS/ConsumedRestMethod/PaymentsApi/Charge",
      "dependents"
    );
    const reached = impact.nodes.map((n) => n.id);
    expect(reached).toContain("osgraph://MOD_DEMO_Orders_BL/ServerAction/BL_GetOrder");
    expect(reached).toContain("osgraph://MOD_DEMO_Orders_API/RestMethod/OrdersAPI/GetOrder");
  });

  it("flags API -> CS and no other REST edge as a violation", async () => {
    const { snapshot } = await run();
    const report = listViolations(snapshot as never, rules);
    const pairs = report.violations.map((v) => `${v.sourceLayer}->${v.targetLayer}`);
    expect(pairs).toContain("API->CS");
    expect(pairs).not.toContain("API->BL");
    expect(pairs).not.toContain("BL->IS");
  });

  it("builds method flows that getFlow walks", async () => {
    const { flows } = await run();
    expect(flows.parseErrorCount).toBe(0);
    const out = buildGetFlowResult(flows, { scope: "demo", element: "osgraph://MOD_DEMO_Orders_API/RestMethod/OrdersAPI/GetOrder" });
    expect(out.element.kind).toBe("RestMethod");
    expect(out.actions[0].kind).toBe("RestMethod");
    expect(out.actions[0].nodeCount).toBe(3);
    const consumed = buildGetFlowResult(flows, { scope: "demo", element: "osgraph://MOD_DEMO_Payments_IS/ConsumedRestMethod/PaymentsApi/Charge" });
    expect(consumed.actions[0].kind).toBe("ConsumedRestMethod");
  });

  it("reextract reproduces the live graph and flows byte for byte", async () => {
    const { dir, snapshotPath } = await run();
    const liveGraph = readFileSync(snapshotPath, "utf8");
    const liveFlows = JSON.parse(readFileSync(flowsPath(snapshotPath), "utf8")) as FlowsArtifact;
    reextractScope({ scope, graphDir: dir, snapshotPath, rules, now: () => new Date("2026-10-30T12:00:00.000Z") });
    const again = JSON.parse(readFileSync(snapshotPath, "utf8")) as { nodes: unknown[]; links: unknown[] };
    expect(again.nodes).toEqual(JSON.parse(liveGraph).nodes);
    expect(again.links).toEqual(JSON.parse(liveGraph).links);
    const flows2 = JSON.parse(readFileSync(flowsPath(snapshotPath), "utf8")) as FlowsArtifact;
    expect(flows2.modules).toEqual(liveFlows.modules);
  });
});
