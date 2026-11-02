/**
 * Flow-node vocabulary (F2).
 *
 * The 32 `I*Node` interfaces of `OutSystems.Model.Logic.Nodes` are listed so that a node type the
 * platform grows later is reported as `Unknown:I…Node` instead of being quietly shaped into
 * something it is not. The per-type property tables are deliberately NOT here: a node's properties
 * are collected generically and only a short, named set is promoted to typed IR fields, so a new
 * node type still gets every expression it carries captured and searchable.
 */
import type { ConnectorPort } from "./types.js";

/** Source: `outsystems11-mcp/servicestudio-mcp-oml/docs/OutSystems.Model.Logic.Nodes.Generated.cs`. */
export const KNOWN_NODE_INTERFACES: readonly string[] = [
  "IActionNode",
  "IAggregateNode",
  "IAjaxRefreshNode",
  "IAssignNode",
  "IAttachFileNode",
  "ICallAgentCoreNode",
  "ICallAgentNode",
  "ICommentNode",
  "IDecisionOutcomeNode",
  "IDestinationNode",
  "IDownloadNode",
  "IEndNode",
  "IExcelToRecordListNode",
  "IExceptionHandlerNode",
  "IExecuteClientActionNode",
  "IExecuteServerActionNode",
  "IForEachNode",
  "IIfNode",
  "IJSONDeserializeNode",
  "IJSONSerializeNode",
  "IJavaScriptNode",
  "IMessageNode",
  "IRaiseExceptionNode",
  "IRecordListToExcelNode",
  "IRefreshDataNode",
  "ISQLNode",
  "ISemanticSearchNode",
  "ISendEmailNode",
  "IStartNode",
  "ISwitchNode",
  "ITriggerGlobalNode",
  "ITriggerNode"
];

const KNOWN = new Set(KNOWN_NODE_INTERFACES);

/** Last segment of a possibly qualified type name: `OutSystems.….IIfNode` → `IIfNode`. */
export function shortInterface(typeName: string): string {
  return typeName.trim().replace(/<.*$/, "").split(".").pop() ?? typeName.trim();
}

/**
 * `IIfNode` → `If`; an interface outside the known vocabulary → `Unknown:<Interface>` so it is
 * counted, kept and visibly not understood (DoD: "unknown node types are never dropped").
 */
export function nodeTypeFor(typeName: string): string {
  const short = shortInterface(typeName);
  if (!KNOWN.has(short)) return `Unknown:${short}`;
  return short.replace(/^I/, "").replace(/Node$/, "");
}

export function isUnknownNodeType(type: string): boolean {
  return type.startsWith("Unknown:");
}

/**
 * Property name → connector port. A property not listed here is an ordinary node property, never a
 * connector: `ForEach.CycleTarget` is the loop **body** and `ForEach.Target` the **exit**, which is
 * the one pairing in this table that is routinely assumed backwards (osmodel, live 2026-10-17).
 */
export function portForProperty(property: string): ConnectorPort | undefined {
  switch (property) {
    case "Target":
      return "Target";
    case "TrueTarget":
      return "True";
    case "FalseTarget":
      return "False";
    case "CycleTarget":
      return "Cycle";
    case "OtherwiseTarget":
      return "Otherwise";
    default:
      return undefined;
  }
}

/**
 * Node properties that say where a node sits on Studio's canvas and nothing about its logic. Dropped
 * so `flows.json` stays about behaviour; `graph.json`'s size budget is the reason the flow artifact
 * is separate at all (ADR-0012), and three coordinates per node across a 38-module scope is real.
 */
const LAYOUT_PROPERTIES: ReadonlySet<string> = new Set(["HorizontalPosition", "VerticalPosition"]);

export function isLayoutProperty(property: string): boolean {
  return LAYOUT_PROPERTIES.has(property);
}

/**
 * Properties whose value is a reference to another element rather than an expression — what the node
 * *invokes*. Promoted to `FlowNode.callee` (or `destination` / `exception`, which have their own
 * fields because they read differently in a flow listing).
 */
export function calleeProperty(property: string): "callee" | "destination" | "exception" | undefined {
  switch (property) {
    case "Action":
    case "Event":
    case "Agent":
    case "AIModel":
    case "DataSource":
    case "Source":
    case "WidgetOrWebBlock":
      return "callee";
    case "Destination":
      return "destination";
    case "Exception":
      return "exception";
    default:
      return undefined;
  }
}

/** `Set<X>(…)` setters promoted to a typed field instead of a generic property. */
export function promotedSetter(setter: string): "condition" | "recordList" | "message" | undefined {
  switch (setter) {
    case "SetCondition":
      return "condition";
    case "SetRecordList":
      return "recordList";
    case "SetExceptionMessage":
    case "SetMessage":
      return "message";
    default:
      return undefined;
  }
}
