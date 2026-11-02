/**
 * Walk order and the compact text rendering of a flow (F5).
 *
 * `FlowAction.nodes` is in **creation** order, which is what makes ids stable but is not the order
 * anyone reads a flow in. `walkFlow` re-orders them the way the diagram reads: `Start` first, then
 * a depth-first walk along the connectors, then whatever the walk could not reach — an
 * `ExceptionHandler` (which by design has no incoming connector), a node left unwired, or a node
 * only a cycle reaches. Nothing is dropped and nothing is listed twice.
 *
 * The walk is deterministic: ports are followed in a fixed order, cycles are cut by a visited set,
 * and unreached nodes keep their creation order.
 */
import type { ConnectorPort, FlowAction, FlowNode } from "./types.js";

/** Fixed port precedence for the walk, so two runs produce the same order. */
function portRank(port: ConnectorPort): number {
  if (port === "Target") return 0;
  if (port === "True") return 1;
  if (port === "False") return 2;
  if (port === "Cycle") return 3;
  if (port.startsWith("Case[")) return 4 + Number(port.slice(5, -1));
  if (port === "Otherwise") return 1000;
  return 2000; // Comment
}

export interface WalkedNode {
  /** 1-based position in walk order — the number the text rendering prints. */
  index: number;
  node: FlowNode;
  /** True when no connector reaches it (an exception handler, or an unwired node). */
  unreached: boolean;
}

export function walkFlow(action: FlowAction): WalkedNode[] {
  const byId = new Map(action.nodes.map((n) => [n.id, n]));
  const out: WalkedNode[] = [];
  const seen = new Set<string>();
  const outgoing = new Map<string, Array<{ to: string; port: ConnectorPort }>>();
  for (const c of action.connectors) {
    const list = outgoing.get(c.from) ?? [];
    list.push({ to: c.to, port: c.port });
    outgoing.set(c.from, list);
  }
  for (const list of outgoing.values()) list.sort((a, b) => portRank(a.port) - portRank(b.port));

  const visit = (id: string, unreached: boolean): void => {
    if (seen.has(id)) return;
    const node = byId.get(id);
    if (node === undefined) return;
    seen.add(id);
    out.push({ index: out.length + 1, node, unreached });
    for (const next of outgoing.get(id) ?? []) visit(next.to, false);
  };

  // Roots in creation order: every Start first, then anything else nothing points at.
  const hasIncoming = new Set(action.connectors.map((c) => c.to));
  for (const node of action.nodes) if (node.type === "Start") visit(node.id, false);
  for (const node of action.nodes) if (!hasIncoming.has(node.id)) visit(node.id, true);
  // Whatever is left is reachable only through a cycle, or not reachable at all.
  for (const node of action.nodes) visit(node.id, !hasIncoming.has(node.id));
  return out;
}

const truncate = (value: string, max = 120): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** `Request = ST_Req, Page = 1` */
function renderArguments(node: FlowNode): string {
  if (node.arguments === undefined || node.arguments.length === 0) return "";
  return `(${node.arguments.map((a) => `${a.param} = ${truncate(a.expr, 60)}`).join(", ")})`;
}

/** What the node *does*, without its outgoing ports. */
export function renderNodeBody(node: FlowNode): string {
  const label = node.label !== undefined ? ` '${node.label}'` : "";
  switch (node.type) {
    case "Start":
      return "Start";
    case "End":
      return "End";
    case "Assign":
      return `Assign ${(node.assignments ?? []).map((a) => `${a.left} = ${truncate(a.right, 60)}`).join("; ")}`.trimEnd();
    case "If":
      return `If ${truncate(node.condition ?? "")}`;
    case "Switch":
      return `Switch${label} ${truncate(node.properties?.find((p) => p.name === "Cases")?.value ?? "")}`.trimEnd();
    case "ForEach":
      return `ForEach ${truncate(node.recordList ?? "")}`.trimEnd();
    case "ExecuteServerAction":
    case "ExecuteClientAction":
      return `Call ${node.callee?.text ?? node.label ?? "?"}${renderArguments(node)}`;
    case "Destination":
      return `Navigate ${node.destination?.text ?? "?"}${renderArguments(node)}`;
    case "RaiseException":
      return `Raise ${node.exception?.text ?? "(generic)"}${node.message !== undefined ? ` ${truncate(node.message, 60)}` : ""}`;
    case "ExceptionHandler": {
      // The label is Studio's name for the handler and is usually the exception's own name; printing
      // it twice (`OnException AllExceptions 'AllExceptions'`) reads as two different things.
      const name = node.exception?.text ?? "(all)";
      return `OnException ${name}${node.label !== undefined && node.label !== name ? label : ""}`;
    }
    case "Message":
      return `Message ${truncate(node.message ?? "")}`;
    case "Comment":
      return `Comment ${truncate(node.properties?.find((p) => p.name === "Text")?.value ?? "", 60)}`;
    case "Trigger":
    case "TriggerGlobal":
      // The event is the point of the node; its label merely repeats the event's name.
      return `Trigger ${node.callee?.text ?? node.label ?? "?"}${renderArguments(node)}`;
    case "Aggregate":
    case "RefreshData":
      return `${node.type}${label} ${node.callee?.text ?? ""}`.trimEnd();
    default:
      return `${node.type}${label}${renderArguments(node)}`;
  }
}

/** `→ 3`, `T→ 4  F→ 6`, `cycle→ 5  exit→ 7`, `case[0]→ 3  else→ 5`. */
function renderPorts(action: FlowAction, node: FlowNode, indexOf: Map<string, number>): string {
  const name = (port: ConnectorPort): string => {
    if (port === "Target") return node.type === "ForEach" ? "exit→" : "→";
    if (port === "True") return "T→";
    if (port === "False") return "F→";
    if (port === "Cycle") return "cycle→";
    if (port === "Otherwise") return "else→";
    if (port === "Comment") return "comment→";
    return `${port.toLowerCase()}→`;
  };
  // A ForEach reads body-then-continuation, so its `Target` (the exit) prints after its `Cycle`,
  // even though `Target` leads the walk order everywhere else.
  const displayRank = (port: ConnectorPort): number =>
    node.type === "ForEach" && port === "Target" ? portRank("Cycle") + 0.5 : portRank(port);
  return action.connectors
    .filter((c) => c.from === node.id)
    .sort((a, b) => displayRank(a.port) - displayRank(b.port))
    .map((c) => `${name(c.port)} ${indexOf.get(c.to) ?? "?"}`)
    .join("  ");
}

/**
 * The compact listing the goal asks `getFlow` for:
 *
 * ```
 * SubmitOnClick (ScreenAction)
 *   in: Request  out: Response
 *   1 Start  → 2
 *   2 Call SL_SubmitCatalogRequest(Request = ST_Req)  → 3
 *   3 If SubmitCatalogRequest.Response.IsSuccess  T→4  F→6
 * ```
 *
 * A node the walk could not reach is marked `*`, which is normal for an exception handler and a
 * signal for anything else; a node Studio has disabled is marked `[disabled]`, because it reads as
 * live logic otherwise.
 */
export function renderFlow(action: FlowAction, walked: WalkedNode[] = walkFlow(action)): string {
  const indexOf = new Map(walked.map((w) => [w.node.id, w.index]));
  const lines: string[] = [`${action.name} (${action.kind})`];
  const params = (kind: "input" | "output" | "local", prefix: string): void => {
    const names = action.parameters.filter((p) => p.kind === kind).map((p) => p.name);
    if (names.length > 0) lines.push(`  ${prefix}: ${names.join(", ")}`);
  };
  params("input", "in");
  params("output", "out");
  params("local", "local");
  for (const { index, node, unreached } of walked) {
    const ports = renderPorts(action, node, indexOf);
    // A node Studio has DISABLED does not run, and reads as ordinary logic unless it is marked.
    // Three such nodes sit in the live MOD_EX_Demo_Staffing_CW/RegisterOnClick flow.
    const disabled = node.properties?.some((p) => p.name === "IsDisabled" && p.value === "true") === true;
    lines.push(
      `  ${unreached ? "*" : " "}${index} ${disabled ? "[disabled] " : ""}${renderNodeBody(node)}${
        ports.length > 0 ? `  ${ports}` : ""
      }`
    );
  }
  return lines.join("\n");
}

/** One line per binding, for the UI-wiring half of an element's answer. */
export function renderBinding(binding: {
  kind: string;
  name?: string;
  expr?: string;
  handler?: { text: string };
  widgetType?: string;
  widgetLabel?: string;
  widgetPath?: string;
}): string {
  const where =
    binding.widgetType !== undefined
      ? `${binding.widgetType}${binding.widgetLabel !== undefined ? ` '${binding.widgetLabel}'` : ""}`
      : "screen";
  switch (binding.kind) {
    case "lifecycle":
      return `${binding.name} → ${binding.handler?.text ?? "?"}`;
    case "event":
      return `${where} ${binding.name} → ${binding.handler?.text ?? "?"}`;
    case "blockSource":
      return `${where} = ${binding.handler?.text ?? "?"}`;
    case "blockArgument":
      return `${where} ${binding.name} = ${truncate(binding.expr ?? "", 80)}`;
    case "blockEvent":
      return `${where} on ${binding.name} → ${binding.handler?.text ?? "?"}`;
    case "blockEventArgument":
      return `${where} on ${binding.name} = ${truncate(binding.expr ?? "", 80)}`;
    case "ifCondition":
      return `${where} shown when ${truncate(binding.expr ?? "", 80)}`;
    default:
      return `${where} ${binding.name ?? binding.kind} = ${truncate(binding.expr ?? "", 80)}`;
  }
}
