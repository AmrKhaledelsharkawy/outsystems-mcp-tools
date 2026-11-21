/**
 * Edge resolution must not depend on the order the Model API emits an action's nodes in.
 *
 * Live reads of an unchanged element return the same lines in different node orders. A shared
 * `References.Named(...)` var is declared inside the node group that first needs it, so a permutation
 * can put a later group's `<ref>.ServerActions.Named(...)` lookup ahead of that declaration.
 * Synthetic names only.
 */
import { describe, expect, it } from "vitest";
import { extractModule } from "../src/extract/extractor.js";
import { buildId } from "../src/extract/ids.js";
import type { ExtractedEdge, ModuleInput } from "../src/extract/types.js";

const sa = (name: string): string => buildId({ module: "MOD_DEMO_Auth_CS", kind: "ServerAction", name });
const N = "OutSystems.Model.Logic.Nodes";

/** One node "group": the lines the emitter prints for a node and the declarations it needs. */
const groups: string[][] = [
  [`var startNode = phoneLogin.CreateNode<${N}.IStartNode>();`],
  [
    `var mOD_DEMO_Auth_CS = eSpace.References.Named("MOD_DEMO_Auth_CS");`,
    `var getLoginUrl2 = mOD_DEMO_Auth_CS.ServerActions.Named("GetLoginUrl");`,
    `var getLoginUrl = phoneLogin.CreateNode<${N}.IExecuteServerActionNode>("GetLoginUrl");`,
    `getLoginUrl.Action = getLoginUrl2;`
  ],
  [
    `var checkSession2 = mOD_DEMO_Auth_CS.ServerActions.Named("CheckSession");`,
    `var checkSession = phoneLogin.CreateNode<${N}.IExecuteServerActionNode>("CheckSession");`,
    `checkSession.Action = checkSession2;`
  ],
  [`var endNode = phoneLogin.CreateNode<${N}.IEndNode>();`]
];

function blockText(order: number[]): string {
  const body = order.flatMap((i) => groups[i].map((l) => `    ${l}`));
  return [
    "```csharp",
    "(OutSystems.Model.UI.Mobile.IMobileFlow common) => {",
    "    /*** creating IMobileBlock 'LayoutMain' ***/",
    `    var layoutMain = common.CreateBlock("LayoutMain");`,
    "    var eSpace = common.GetESpace();",
    `    var phoneLogin = layoutMain.CreateScreenAction("PhoneLogin");`,
    ...body,
    "}",
    "```"
  ].join("\n");
}

function edgesFor(text: string): ExtractedEdge[] {
  const input: ModuleInput = {
    module: "demo_ui",
    moduleType: "Mobile",
    texts: {
      dataModel: "",
      structures: "",
      screens: [],
      blocks: [{ name: "LayoutMain", uiFlow: "Common", text }],
      clientActions: [],
      serverActions: []
    }
  };
  return extractModule(input).edges;
}

function permutations(n: number): number[][] {
  const out: number[][] = [];
  const rec = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) out.push(prefix);
    for (const r of rest) rec([...prefix, r], rest.filter((x) => x !== r));
  };
  rec([], Array.from({ length: n }, (_, i) => i));
  return out;
}

describe("edge resolution is invariant under node order", () => {
  const baseline = edgesFor(blockText([0, 1, 2, 3]));

  it("the canonical order resolves both server-action edges", () => {
    const targets = baseline.map((e) => e.target);
    expect(targets).toContain(sa("GetLoginUrl"));
    expect(targets).toContain(sa("CheckSession"));
  });

  it("regression: a lookup emitted before its reference declaration keeps its edge", () => {
    // group 2 (needs the reference var) before group 1 (declares it), start node after the call node
    const edges = edgesFor(blockText([2, 0, 1, 3]));
    expect(edges.map((e) => e.target)).toContain(sa("CheckSession"));
  });

  it.each(permutations(groups.length).map((p) => [p.join(",")] as const))("permutation %s yields identical edges", (key) => {
    const order = key.split(",").map(Number);
    expect(edgesFor(blockText(order))).toEqual(baseline);
  });
});
