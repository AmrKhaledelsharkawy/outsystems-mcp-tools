/**
 * Flow IR (goal-osgraph-flows.md Design 3 / slice F2).
 *
 * osgraph v1 recorded only *which* elements an action touched. This records the logic inside it: the
 * flow nodes, the connectors between them, and every expression as text. Expressions are opaque
 * strings on purpose — there is no expression parser and no data-flow analysis (osmodel's "no
 * semantic parsing of expressions" rule), and `searchFlows`' regex is the query over them.
 *
 * Two invariants the parser is tested against:
 *
 *  - **Creation order is the node order.** `FlowNode.id` ends in `/n<k>` where `k` is the 1-based
 *    position of the node's `CreateNode<…>` in the text. Studio's text keeps node creation order
 *    stable (it does NOT keep call-argument order stable — see the sort in `parse.ts`); the live `IAction.Nodes` order is **not** (osmodel OSM-013 found it returning
 *    Assign, Start, End), so node order is never read from anywhere else.
 *  - **Nothing is dropped.** Every `CreateNode<…>` becomes a node, and one whose interface is not in
 *    the known vocabulary becomes `type: "Unknown:I…Node"` carrying its statements in `raw`. A
 *    parse that cannot account for every `CreateNode` it saw is a parser bug, not a silent gap.
 */
import type { ElementKind } from "../extract/types.js";

/** What an action is attached to, which also decides its id shape. */
export type FlowActionKind =
  | "ScreenAction"
  | "BlockAction"
  | "ClientAction"
  | "ServerAction"
  | "DataAction"
  | "Aggregate";

/**
 * A reference to another element, as a flow node or binding names it.
 *
 * `text` is always present and is what `searchFlows` matches and `getFlow` renders. `id` is the
 * osgraph node id (`buildId`) when the reference resolved to a module, kind and name, which is what
 * lets a flow be joined to `graph.json`; it is absent for a reference the text left unresolvable
 * (an opaque `AddDependency`, or a lookup on a variable whose own declaration was not understood).
 */
export interface FlowRef {
  /** Display form: `Name`, `Module.Name`, or `Module.Flow/Name`. */
  text: string;
  id?: string;
  module?: string;
  kind?: ElementKind;
  uiFlow?: string;
  name: string;
}

export interface FlowAssignment {
  left: string;
  right: string;
}

export interface FlowArgument {
  /** Parameter name, or the raw variable when its declaration was not understood. */
  param: string;
  /** Expression text exactly as the call passed it; `null` in the text becomes `"null"`. */
  expr: string;
}

/** One `ISwitchCondition` of an `ISwitchNode`: its value expression and optional label. */
export interface FlowSwitchCase {
  /** 0-based, matching the `Case[i]` connector port. */
  index: number;
  value?: string;
  label?: string;
}

/** A named property of a node that is not promoted to a typed field. Expressions stay strings. */
export interface FlowProperty {
  name: string;
  value: string;
}

export interface FlowNode {
  /** `<action id>/n<k>`, `k` = 1-based creation order in the action. */
  id: string;
  /**
   * Short node type: the `CreateNode<…>` interface with `I` and `Node` trimmed (`If`, `ForEach`,
   * `ExecuteServerAction`). An interface outside the known vocabulary becomes `Unknown:<Interface>`.
   */
  type: string;
  /** The `CreateNode<…>("Label")` argument, or a `.Label` / `.Name` assignment. */
  label?: string;
  /** `.Action` / `.Event` / `.DataSource` / `.Agent` — what this node invokes. */
  callee?: FlowRef;
  /** `.SetCondition(…)` on an If; absent on every other type. */
  condition?: string;
  /** `.SetRecordList(…)` on a ForEach. */
  recordList?: string;
  /** `.CreateAssignment(left, right)`, in creation order. */
  assignments?: FlowAssignment[];
  /** `.SetArgumentValue(param, expr)`, in call order. */
  arguments?: FlowArgument[];
  /** `.Destination = …` on an IDestinationNode. */
  destination?: FlowRef;
  /** `.Exception = …` on a Raise / ExceptionHandler node. Absent means the generic handler. */
  exception?: FlowRef;
  /** `.SetExceptionMessage(…)` / `.SetMessage(…)` — the authored message expression. */
  message?: string;
  /** Everything else the node set that was not `// default value` and not pure layout. */
  properties?: FlowProperty[];
  /**
   * The node's own statements, verbatim, for a type the parser has no typed fields for — always
   * present on `Unknown:*`, absent otherwise. This is what makes an unknown node inspectable
   * rather than merely counted.
   */
  raw?: string[];
}

/**
 * Where a connector leaves its source node.
 *
 * On an `IForEachNode`, `Cycle` is the **loop body** entry and `Target` is the **exit**
 * continuation — live-confirmed by osmodel on 2026-10-17 and easy to get backwards.
 */
export type ConnectorPort = "Target" | "True" | "False" | "Cycle" | "Otherwise" | "Comment" | `Case[${number}]`;

export interface Connector {
  from: string;
  to: string;
  port: ConnectorPort;
  /**
   * How the text expressed it: an explicit `a.Target = b;`, or a `.ConnectedBelow(a)` chained onto
   * the new node's creation. Kept because the two are not interchangeable evidence — only the
   * explicit form names the port, and a `ConnectedBelow` off a branching node would be a parser
   * question rather than a fact.
   */
  via: "explicit" | "connectedBelow";
}

export type BindingKind =
  | "event"
  | "lifecycle"
  | "blockSource"
  | "blockArgument"
  | "blockEvent"
  | "blockEventArgument"
  | "ifCondition"
  | "widgetExpression";

/** UI-to-logic wiring: the half of the answer that lives outside any action's flow. */
export interface Binding {
  /** Element id of the screen or block whose text declared it. */
  owner: string;
  /** `<owner>/w<k>`, `k` = 1-based widget creation order; absent for screen/block lifecycle. */
  widget?: string;
  /** Short widget interface name (`IIfWidget` → `If`), for display. */
  widgetType?: string;
  /** `CreateWidget<…>("Name")` argument when the widget had one. */
  widgetLabel?: string;
  /** Readable ancestry, e.g. `BlockInstance/If 'ShowErrorMsg'/Container`. */
  widgetPath?: string;
  kind: BindingKind;
  /** Event name (`onclick`), parameter name, lifecycle handler (`OnReady`), or setter (`Visible`). */
  name?: string;
  /** Expression text, for the kinds that carry one. */
  expr?: string;
  /** The action or block the wiring points at. */
  handler?: FlowRef;
}

export interface FlowParameter {
  name: string;
  /** Resolved data type text when the text named one (`eSpace.TextType` → `Text`). */
  dataType?: string;
  kind: "input" | "output" | "local";
}

export interface FlowAction {
  /** `<owner element id>#<ActionName>` for a local action, the element id for a module-level one. */
  id: string;
  /** Element id of the screen, block or module-level action that owns the flow. */
  owner: string;
  name: string;
  kind: FlowActionKind;
  description?: string;
  parameters: FlowParameter[];
  nodes: FlowNode[];
  connectors: Connector[];
}

export interface FlowParseError {
  /** 1-based line of the statement in the element text. */
  line: number;
  /** The statement, truncated, so the message is actionable without the fixture at hand. */
  statement: string;
  reason: string;
}

/** One element text's flows. The parse of a module is the concatenation of these. */
export interface ParsedElementFlows {
  element: {
    id: string;
    module: string;
    kind: ElementKind;
    name: string;
    uiFlow?: string;
  };
  actions: FlowAction[];
  bindings: Binding[];
  /**
   * Every `CreateNode<…>` the text contained. Equal to the total node count across `actions` by
   * construction; the F2 tests assert it, which is how "nothing is dropped" stays true.
   */
  createNodeCount: number;
  /** Distinct `Unknown:*` node types, sorted — the DoD's `unknownNodeCount` denominator. */
  unknownNodeTypes: string[];
  parseErrors: FlowParseError[];
}

/** One module's flows, as `flows.json` stores them. */
export interface ModuleFlows {
  module: string;
  actions: FlowAction[];
  bindings: Binding[];
  flowActionCount: number;
  flowNodeCount: number;
  unknownNodeCount: number;
  unknownNodeTypes: string[];
  parseErrors: Array<FlowParseError & { element: string }>;
}
