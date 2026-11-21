/**
 * Service Action flows. Studio declares a service action with `eSpace.CreateServiceAction("…")`
 * (server actions use `CreateServerAction`), deletes the default nodes with
 * `<var>.Nodes.ToList().ForEach(x => x.Delete());` and usually adds a comment node. All texts here
 * are hand-written with synthetic names; no capture, no Service Studio.
 */
import { describe, expect, it } from "vitest";
import { buildId } from "../src/extract/ids.js";
import { parseElementFlows } from "../src/flows/parse.js";

const MODULE = "DemoSvc";

/** Same shape as a captured service action: default-node delete line, defaults, a comment node. */
const SERVICE_ACTION = `(OutSystems.Model.IESpace eSpace) => {

    /*** creating IServiceAction 'SvcDoThing' ***/
    var svcDoThing = eSpace.CreateServiceAction("SvcDoThing");
    /*** Deleting Nodes that are created by default when instantiating an IServiceAction ***/
    svcDoThing.Nodes.ToList().ForEach(x => x.Delete());
    svcDoThing.Description = null; // default value
    svcDoThing.Folder = null; // default value
    svcDoThing.Icon = null; // default value

    var startNode = svcDoThing.CreateNode<OutSystems.Model.Logic.Nodes.IStartNode>();
    startNode.IsDisabled = false; // default value

    var endNode = svcDoThing.CreateNode<OutSystems.Model.Logic.Nodes.IEndNode>().ConnectedBelow(startNode);
    endNode.IsDisabled = false; // default value

    var commentNode = svcDoThing.CreateNode<OutSystems.Model.Logic.Nodes.ICommentNode>();
    commentNode.HorizontalPosition = 5000;
    commentNode.IsDisabled = false; // default value
    commentNode.IsReminder = false; // default value
    commentNode.Text = "A synthetic comment.\\n   - line two.";
    commentNode.VerticalPosition = 1000; // default value
}`;

/** A service action that calls a server action of the same module. */
const SERVICE_ACTION_CALLING = `(OutSystems.Model.IESpace eSpace) => {
    /*** creating IServiceAction 'SvcCallsHelper' ***/
    var svcCallsHelper = eSpace.CreateServiceAction("SvcCallsHelper");
    /*** Deleting Nodes that are created by default when instantiating an IServiceAction ***/
    svcCallsHelper.Nodes.ToList().ForEach(x => x.Delete());
    var startNode = svcCallsHelper.CreateNode<OutSystems.Model.Logic.Nodes.IStartNode>();
    var helper2 = eSpace.ServerActions.Named("DoHelper");
    var doHelper = svcCallsHelper.CreateNode<OutSystems.Model.Logic.Nodes.IExecuteServerActionNode>("DoHelper");
    doHelper.Action = helper2;
    startNode.Target = doHelper;
    var endNode = svcCallsHelper.CreateNode<OutSystems.Model.Logic.Nodes.IEndNode>();
    doHelper.Target = endNode;
}`;

const SERVER_ACTION = `(OutSystems.Model.IESpace eSpace) => {
    /*** creating IServerAction 'SrvDoThing' ***/
    var srvDoThing = eSpace.CreateServerAction("SrvDoThing");
    var startNode = srvDoThing.CreateNode<OutSystems.Model.Logic.Nodes.IStartNode>();
    var endNode = srvDoThing.CreateNode<OutSystems.Model.Logic.Nodes.IEndNode>().ConnectedBelow(startNode);
}`;

describe("flow parser: service actions", () => {
  it("a CreateServiceAction text parses with 0 errors and every CreateNode becomes a node", () => {
    const r = parseElementFlows(SERVICE_ACTION, { module: MODULE, kind: "ServerAction", name: "SvcDoThing" });
    expect(r.parseErrors).toEqual([]);
    expect(r.createNodeCount).toBe(3);
    expect(r.actions).toHaveLength(1);
    const action = r.actions[0];
    // The element keeps the kind/id it has in graph.json today (service actions are ServerAction).
    const id = buildId({ module: MODULE, kind: "ServerAction", name: "SvcDoThing" });
    expect(r.element.id).toBe(id);
    expect(action.id).toBe(id);
    expect(action.kind).toBe("ServerAction");
    expect(action.name).toBe("SvcDoThing");
    expect(action.nodes.map((n) => n.type)).toEqual(["Start", "End", "Comment"]);
    expect(action.connectors).toEqual([{ from: `${id}/n1`, to: `${id}/n2`, port: "Target", via: "connectedBelow" }]);
  });

  it("a service action that calls another action records the callee with its graph id", () => {
    const r = parseElementFlows(SERVICE_ACTION_CALLING, { module: MODULE, kind: "ServerAction", name: "SvcCallsHelper" });
    expect(r.parseErrors).toEqual([]);
    const call = r.actions[0].nodes.find((n) => n.label === "DoHelper");
    expect(call?.callee?.id).toBe(buildId({ module: MODULE, kind: "ServerAction", name: "DoHelper" }));
    expect(r.actions[0].connectors).toHaveLength(2);
  });

  it("server-action parsing is unchanged", () => {
    const r = parseElementFlows(SERVER_ACTION, { module: MODULE, kind: "ServerAction", name: "SrvDoThing" });
    expect(r.parseErrors).toEqual([]);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].kind).toBe("ServerAction");
    expect(r.actions[0].nodes.map((n) => n.type)).toEqual(["Start", "End"]);
  });
});
