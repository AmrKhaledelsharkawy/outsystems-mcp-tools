/**
 * Flow parser (F2): one element text → its actions, flow nodes, connectors and UI bindings.
 *
 * Pure. Given the same text and context it returns a deep-equal result every time, with no clock,
 * no filesystem and no Service Studio — which is the whole point of F0's `raw/`: the parser can be
 * iterated on offline instead of at ≈11 minutes per module live.
 *
 * ## How it reads the text
 *
 * Studio emits a flat sequence of statements that build the element with local C# variables, so the
 * parse is a single pass that keeps a **symbol table** of what each variable is — an element, a
 * reference module, a UI flow, an action being defined, a flow node, a parameter, a widget, an event
 * handler — and then interprets each statement against it. Nothing is positional: a node is attached
 * to the action whose variable received its `CreateNode`, never to "the action most recently seen".
 *
 * ## Why properties are collected generically
 *
 * There are 32 node interfaces and they will grow. Rather than a handler per type, every
 * `node.<Prop> = <rhs>` and `node.Set<Prop>(<args>)` is recorded, and a short named set is promoted
 * to typed fields (`condition`, `recordList`, `callee`, `destination`, `exception`, `message`,
 * `assignments`, `arguments`). The consequence is the property the DoD asks for: a node type this
 * build has never seen still arrives with all of its expressions captured and searchable, as
 * `Unknown:I…Node` with its statements in `raw`.
 *
 * ## Two traps this encodes
 *
 *  - `.ConnectedBelow(prev)` **is** a connector (`prev.Target = new`); `.Below(prev)`,
 *    `.ToTheRightOf(prev)` and friends are layout only. The live fixtures prove it: a ForEach
 *    created `.ToTheRightOf(ifNode)` is wired by a separate `ifNode.FalseTarget = forEachNode`, so
 *    treating the positioning call as a connector would invent an edge and double the real one.
 *  - On `IForEachNode`, `CycleTarget` is the loop **body** and `Target` is the **exit**
 *    (osmodel, live-confirmed 2026-10-17). `portForProperty` is the single place that mapping lives.
 */
import { buildId, normalizeModuleName } from "../extract/ids.js";
import { collectionKind, isFlowQualified, normalizeKind } from "../extract/kinds.js";
import type { ElementKind } from "../extract/types.js";
import {
  calleeProperty,
  isLayoutProperty,
  isUnknownNodeType,
  nodeTypeFor,
  portForProperty,
  promotedSetter,
  shortInterface
} from "./nodeKinds.js";
import {
  balancedSlice,
  callArguments,
  isStringLiteral,
  literalValue,
  splitArguments,
  tokenize,
  type CodeStatement
} from "./statements.js";
import type {
  Binding,
  BindingKind,
  Connector,
  ConnectorPort,
  FlowAction,
  FlowActionKind,
  FlowNode,
  FlowParameter,
  FlowParseError,
  FlowRef,
  FlowSwitchCase,
  ParsedElementFlows
} from "./types.js";

export interface FlowParseContext {
  module: string;
  /** Kind the caller fetched this text as, used for the element id and the action kind. */
  kind: ElementKind;
  /** Element name from the names listing. */
  name: string;
  /** UI flow from the names listing (ADR-0008); required for Screen/Block ids. */
  uiFlow?: string;
}

const ANCHOR_RE = /^creating (I\w+) '(.+)'$/;
const SIGNATURE_COMMENT_RE = /^(I\w+Signature)\s+(\S+)$/;

/** `var x = ` prefix of a declaration. */
const DECL_RE = /^var ([A-Za-z_]\w*) = (.*)$/s;
/** `<recv>.<Member>` where `<recv>` is a plain variable. */
const MEMBER_ASSIGN_RE = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*=\s*(.*)$/s;
/** `<recv>.On<Event>.Destination = <rhs>` — a screen/block lifecycle handler. */
const LIFECYCLE_RE = /^([A-Za-z_]\w*)\.(On[A-Za-z_]\w*)\.Destination\s*=\s*(.*)$/s;
/** `<recv>.Set<Prop>(` call, possibly the only thing in the statement. */
const SETTER_RE = /^([A-Za-z_]\w*)\.(Set[A-Za-z_]\w*)\(/;
/** `<recv>.Create<Thing>` / `<recv>.Create<Thing><T>(…)`. */
const CREATE_RE = /^([A-Za-z_]\w*)(?:\.(TrueBranch|FalseBranch))?\.(Create[A-Za-z_]\w*)(?:<([^>]*)>)?\((.*)$/s;
/** `<recv>.Nodes.OfType<T>().Named("N")`. */
const FLOW_NODE_RE = /^([A-Za-z_]\w*)\.Nodes\.OfType<([\w.]+)>\(\)\.Named\("((?:[^"\\]|\\.)*)"\)$/;
/** `<recv>.<Collection>.Named("N")`. */
const NAMED_RE = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\.Named\("((?:[^"\\]|\\.)*)"\)$/;
/** `eSpace.SystemRoles.OfType<…ISystemRole>().Named("N")`. */
const SYSTEM_ROLE_RE = /^([A-Za-z_]\w*)\.SystemRoles\.OfType<[\w.]*ISystemRole>\(\)\.Named\("((?:[^"\\]|\\.)*)"\)$/;
/** `(Cast)eSpace.AddDependency(Services.ModelServices.ParseGlobalKey("key"))`. */
const ADD_DEPENDENCY_RE = /^\(([\w.]+)\)\s*[A-Za-z_]\w*\.AddDependency\(Services\.ModelServices\.ParseGlobalKey\("([^"]+)"\)\)$/;
/** `<recv>.EventHandlers.FirstOrDefault(e => e.Event.Name == "X")`. */
const EVENT_HANDLER_RE = /^([A-Za-z_]\w*)\.EventHandlers\.FirstOrDefault\(\s*\w+\s*=>\s*\w+\.Event\.Name\s*==\s*"((?:[^"\\]|\\.)*)"\s*\)$/;
/** `<recv>.PlaceholdersContent.FirstOrDefault(p => p.Placeholder?.Name == "X")`. */
const PLACEHOLDER_RE = /^([A-Za-z_]\w*)\.PlaceholdersContent\.FirstOrDefault\(\s*\w+\s*=>\s*\w+\.Placeholder\?\.Name\s*==\s*"((?:[^"\\]|\\.)*)"\s*\)$/;
/** `<recv>.GetESpace()`. */
const GET_ESPACE_RE = /^[A-Za-z_]\w*\.GetESpace\(\)$/;
/** The lambda header, e.g. `(OutSystems.Model.UI.Mobile.IMobileFlow login) =>`. */
const LAMBDA_RE = /^\(([\w.]+)\s+([A-Za-z_]\w*)\)\s*=>/;

/**
 * Chained calls on a freshly created node that create a connector from an existing node to it.
 * Everything else chained (`Below`, `Above`, `ToTheRightOf`, `ToTheLeftOf`, `At`) only positions the
 * node on the canvas and must never become an edge.
 */
const CONNECTING_CHAIN: ReadonlySet<string> = new Set([
  "ConnectedBelow",
  "ConnectedAbove",
  "ConnectedToTheRightOf",
  "ConnectedToTheLeftOf"
]);

/**
 * Widget setters that carry presentation and no logic. Everything else a widget sets — `SetVisible`,
 * `SetValue`, `SetShowPopup`, `SetEnabled`, whatever the platform adds next — becomes a
 * `widgetExpression` binding, because an expression that gates what the user sees is exactly what
 * the flow data exists to make findable.
 */
const WIDGET_SETTERS_IGNORED: ReadonlySet<string> = new Set([
  "SetStyle",
  "SetStyleClasses",
  "SetArgumentValue", // handled as blockArgument / blockEventArgument above
  "SetCondition" // handled as ifCondition above
]);

/** Which `Create<Thing>` on an element starts an action flow, and what kind of action it is. */
function actionKindFor(method: string, ownerKind: ElementKind | "module"): FlowActionKind | undefined {
  switch (method) {
    case "CreateScreenAction":
      return ownerKind === "Block" ? "BlockAction" : "ScreenAction";
    case "CreateBlockAction":
      return "BlockAction";
    case "CreateClientAction":
      return ownerKind === "module" ? "ClientAction" : "ScreenAction";
    case "CreateServerAction":
      return "ServerAction";
    case "CreateDataAction":
      return "DataAction";
    case "CreateAggregate":
      return "Aggregate";
    default:
      return undefined;
  }
}

type Sym =
  | { t: "espace" }
  | { t: "ref"; module: string }
  | { t: "flow"; module: string; flow: string }
  /** An element in some module: screen, block, action signature, structure, entity, role. */
  | { t: "element"; ref: FlowRef }
  /** The screen/block/action this text is defining, so its members can be attributed. */
  | { t: "self" }
  /** An action whose flow is being built in this text. */
  | { t: "action"; actionId: string }
  | { t: "node"; actionId: string; nodeId: string }
  | { t: "switchCase"; actionId: string; nodeId: string; index: number }
  | { t: "param"; name: string }
  | { t: "widget"; widgetId: string }
  | { t: "event"; widgetId: string }
  | { t: "eventHandler"; widgetId: string; event: string }
  | { t: "placeholder"; widgetId: string }
  | { t: "unknown" };

interface WidgetRecord {
  id: string;
  type: string;
  label?: string;
  parent?: string;
  branch?: string;
}

interface ActionBuild {
  action: FlowAction;
  nodes: Map<string, FlowNode>;
  /** `Case[i]` ports already created per switch node, so a second `CreateCondition` gets index 1. */
  switchCases: Map<string, FlowSwitchCase[]>;
  /** Raw statements per node, kept only for `Unknown:*` types. */
  raw: Map<string, string[]>;
  nodeCount: number;
}

/**
 * Parses one element text. `createNodeCount` is the text's own count of `CreateNode<…>` occurrences
 * and is compared against the nodes actually emitted by the F2 tests — the accounting that makes
 * "nothing is dropped" checkable rather than asserted.
 */
export function parseElementFlows(text: string, ctx: FlowParseContext): ParsedElementFlows {
  const uiFlow = isFlowQualified(ctx.kind) ? ctx.uiFlow : undefined;
  const elementId = buildId({ module: ctx.module, kind: ctx.kind, name: ctx.name, uiFlow });
  const element = {
    id: elementId,
    module: ctx.module,
    kind: ctx.kind,
    name: ctx.name,
    ...(uiFlow !== undefined && uiFlow !== "" ? { uiFlow } : {})
  };

  const syms = new Map<string, Sym>();
  // `eSpace` always means this module's eSpace. Seeded rather than waited for, because a
  // `getServerAction` text is a *fragment* of the enclosing lambda and never declares it: without
  // this, `eSpace.ServerActions.Named("X")` went unresolved and every call in a server action lost
  // its callee (live-fixture `osm013scratchcallraise`).
  syms.set("eSpace", { t: "espace" });
  const builds = new Map<string, ActionBuild>();
  const actionOrder: string[] = [];
  const widgets = new Map<string, WidgetRecord>();
  const bindings: Binding[] = [];
  const parseErrors: FlowParseError[] = [];
  const unknownNodeTypes = new Set<string>();
  let widgetCount = 0;
  let createNodeCount = 0;
  let pendingSignature: { kind: ElementKind | undefined; path: string } | undefined;

  const fail = (statement: CodeStatement, reason: string): void => {
    parseErrors.push({
      line: statement.line,
      statement: statement.code.length > 160 ? `${statement.code.slice(0, 157)}...` : statement.code,
      reason
    });
  };

  const moduleOf = (receiver: string): string | undefined => {
    const sym = syms.get(receiver);
    if (sym?.t === "espace") return ctx.module;
    if (sym?.t === "ref") return sym.module;
    return undefined;
  };

  const makeRef = (parts: { module?: string; kind?: ElementKind; uiFlow?: string; name: string }): FlowRef => {
    const ref: FlowRef = { text: "", name: parts.name };
    if (parts.module !== undefined) ref.module = parts.module;
    if (parts.kind !== undefined) ref.kind = parts.kind;
    if (parts.uiFlow !== undefined && parts.uiFlow !== "") ref.uiFlow = parts.uiFlow;
    if (parts.module !== undefined && parts.kind !== undefined) {
      ref.id = buildId({ module: parts.module, kind: parts.kind, name: parts.name, uiFlow: ref.uiFlow });
    }
    const local = parts.module === undefined || parts.module === ctx.module;
    const flowPart = ref.uiFlow !== undefined ? `${ref.uiFlow}/` : "";
    ref.text = local ? `${flowPart}${parts.name}` : `${parts.module}.${flowPart}${parts.name}`;
    return ref;
  };

  /** The reference a right-hand side denotes: a table element, a local action, or nothing. */
  const refForValue = (rhs: string): FlowRef | undefined => {
    const token = rhs.trim().replace(/;$/, "");
    if (token === "null" || token === "") return undefined;
    const sym = syms.get(token);
    if (sym === undefined) return undefined;
    if (sym.t === "element") return sym.ref;
    if (sym.t === "self") {
      return makeRef({ module: ctx.module, kind: ctx.kind, uiFlow, name: ctx.name });
    }
    if (sym.t === "action") {
      const build = builds.get(sym.actionId);
      if (build === undefined) return undefined;
      return { text: build.action.name, id: sym.actionId, name: build.action.name };
    }
    return undefined;
  };

  /**
   * A reference written as a property path rather than a variable — `eSpace.AllExceptions` on an
   * exception handler (live-confirmed in MOD_EX_Demo_Catalog_CW/Login). Only consulted for the few
   * properties that hold a reference at all, so an ordinary expression can never land here.
   */
  const refForPath = (rhs: string): FlowRef | undefined => {
    const dotted = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(rhs.trim().replace(/;$/, ""));
    if (dotted === null) return undefined;
    const refModule = moduleOf(dotted[1]);
    if (refModule === undefined) return undefined;
    return makeRef({ module: refModule, name: dotted[2] });
  };

  const widgetPathOf = (widgetId: string | undefined): string | undefined => {
    const parts: string[] = [];
    let cursor = widgetId;
    const guard = new Set<string>();
    while (cursor !== undefined && !guard.has(cursor)) {
      guard.add(cursor);
      const w = widgets.get(cursor);
      if (w === undefined) break;
      const label = w.label !== undefined ? ` '${w.label}'` : "";
      // The branch belongs to the edge from the parent, so it reads as a prefix on this segment:
      // `IIfWidget 'ShowErrorMsg'/TrueBranch:IContainer`.
      const branch = w.branch !== undefined ? `${w.branch}:` : "";
      parts.unshift(`${branch}${w.type}${label}`);
      cursor = w.parent;
    }
    return parts.length > 0 ? parts.join("/") : undefined;
  };

  const addBinding = (
    kind: BindingKind,
    widgetId: string | undefined,
    extra: { name?: string; expr?: string; handler?: FlowRef }
  ): void => {
    const widget = widgetId !== undefined ? widgets.get(widgetId) : undefined;
    const binding: Binding = { owner: elementId, kind };
    if (widget !== undefined) {
      binding.widget = widget.id;
      binding.widgetType = widget.type.replace(/^I/, "").replace(/Widget$/, "");
      if (widget.label !== undefined) binding.widgetLabel = widget.label;
      const path = widgetPathOf(widget.id);
      if (path !== undefined) binding.widgetPath = path;
    }
    if (extra.name !== undefined) binding.name = extra.name;
    if (extra.expr !== undefined) binding.expr = extra.expr;
    if (extra.handler !== undefined) binding.handler = extra.handler;
    bindings.push(binding);
  };

  /** Resolves the widget a symbol ultimately hangs off (event, handler and placeholder included). */
  const widgetOf = (receiver: string): string | undefined => {
    const sym = syms.get(receiver);
    if (sym === undefined) return undefined;
    if (sym.t === "widget") return sym.widgetId;
    if (sym.t === "event" || sym.t === "eventHandler" || sym.t === "placeholder") return sym.widgetId;
    return undefined;
  };

  const startAction = (name: string, kind: FlowActionKind, varName: string): string => {
    const moduleLevel = kind === "ServerAction" || kind === "ClientAction";
    const actionId = moduleLevel ? elementId : `${elementId}#${name}`;
    if (!builds.has(actionId)) {
      builds.set(actionId, {
        action: { id: actionId, owner: elementId, name, kind, parameters: [], nodes: [], connectors: [] },
        nodes: new Map(),
        switchCases: new Map(),
        raw: new Map(),
        nodeCount: 0
      });
      actionOrder.push(actionId);
    }
    syms.set(varName, { t: "action", actionId });
    return actionId;
  };

  /** Appends a connector, keeping an explicit statement in preference to a `ConnectedBelow`. */
  const addConnector = (build: ActionBuild, from: string, to: string, port: ConnectorPort, via: Connector["via"]): void => {
    const at = build.action.connectors.findIndex((c) => c.from === from && c.port === port);
    if (at === -1) {
      build.action.connectors.push({ from, to, port, via });
      return;
    }
    if (via === "explicit") build.action.connectors[at] = { from, to, port, via };
  };

  const setProperty = (node: FlowNode, name: string, value: string): void => {
    const list = node.properties ?? [];
    const at = list.findIndex((p) => p.name === name);
    if (at === -1) list.push({ name, value });
    else list[at] = { name, value };
    node.properties = list;
  };

  const items = tokenize(text);

  for (const item of items) {
    if (item.kind === "comment") {
      const anchor = ANCHOR_RE.exec(item.text);
      if (anchor) {
        // The anchor only confirms what the caller already told us; the id comes from the listing,
        // which is the sole authority on the UI flow (ADR-0008).
        pendingSignature = undefined;
        continue;
      }
      const signature = SIGNATURE_COMMENT_RE.exec(item.text);
      if (signature) pendingSignature = { kind: normalizeKind(signature[1]), path: signature[2] };
      continue;
    }

    const stmt = item;
    const code = stmt.code;

    const lambda = LAMBDA_RE.exec(code);
    if (lambda) {
      // `(IMobileFlow login) =>`: the parameter is this element's own UI flow. Its *name* here is a
      // camelCase proxy for the flow, so the flow taken is the one the names listing reported
      // (ADR-0008), never the variable's spelling.
      if (/Flow/.test(lambda[1])) syms.set(lambda[2], { t: "flow", module: ctx.module, flow: ctx.uiFlow ?? "" });
      continue;
    }

    const decl = DECL_RE.exec(code);
    const rhs = decl ? decl[2].trim() : code;
    const target = decl?.[1];

    // ---- declarations that introduce a symbol -------------------------------------------------

    if (target !== undefined) {
      if (GET_ESPACE_RE.test(rhs)) {
        syms.set(target, { t: "espace" });
        continue;
      }

      const dependency = ADD_DEPENDENCY_RE.exec(rhs);
      if (dependency) {
        const kind = pendingSignature?.kind ?? normalizeKind(dependency[1]);
        const path = pendingSignature?.path;
        pendingSignature = undefined;
        if (kind !== undefined && path !== undefined && path.includes("/")) {
          const segments = path.split("/");
          const depModule = normalizeModuleName(segments[0]);
          const depName = segments[segments.length - 1];
          const depFlow = segments.length >= 3 && isFlowQualified(kind) ? segments[1] : undefined;
          syms.set(target, { t: "element", ref: makeRef({ module: depModule, kind, uiFlow: depFlow, name: depName }) });
        } else {
          // ADR-0006's opaque fallback: the key names it, nothing else does.
          syms.set(target, { t: "element", ref: { text: dependency[2], name: dependency[2] } });
        }
        continue;
      }
      if (!/^[A-Za-z_]\w*\.GetESpace\(\)$/.test(rhs)) pendingSignature = undefined;

      const create = CREATE_RE.exec(rhs);
      if (create) {
        const [, receiver, branch, method, generic, rest] = create;
        // `rest` starts after the create call's OPEN paren and may be followed by chained calls, so
        // the argument list has to be balanced out of it rather than cut at the last `)`.
        const args = splitArguments(balancedSlice(rest));
        // A name is only a name when it is a string literal: `CreateNode<…>()` chained with
        // `.ConnectedBelow(startNode)` has no arguments of its own, and reading one there is how
        // `").ConnectedBelow(startNode"` ended up as a node label.
        const firstLiteral = args.length > 0 && isStringLiteral(args[0]) ? literalValue(args[0]) : undefined;

        // --- an action flow on this element, or on the module ---
        const receiverSym = syms.get(receiver);
        const ownerKind: ElementKind | "module" = receiverSym?.t === "espace" ? "module" : ctx.kind;
        const actionKind = actionKindFor(method, ownerKind);
        if (actionKind !== undefined && firstLiteral !== undefined && firstLiteral.length > 0) {
          startAction(firstLiteral, actionKind, target);
          continue;
        }

        // --- the element itself (`flow.CreateScreen("Login")`) ---
        if (method === "CreateScreen" || method === "CreateBlock" || method === "CreateWebBlock" || method === "CreateWebScreen") {
          syms.set(target, { t: "self" });
          continue;
        }

        // --- a flow node ---
        if (method === "CreateNode") {
          createNodeCount++;
          const owner = syms.get(receiver);
          if (owner?.t !== "action") {
            fail(stmt, `CreateNode on '${receiver}', which is not an action declared in this text`);
            syms.set(target, { t: "unknown" });
            continue;
          }
          const build = builds.get(owner.actionId);
          if (build === undefined) {
            fail(stmt, `CreateNode for unknown action '${owner.actionId}'`);
            syms.set(target, { t: "unknown" });
            continue;
          }
          const type = nodeTypeFor(generic ?? "");
          if (isUnknownNodeType(type)) unknownNodeTypes.add(type);
          build.nodeCount++;
          const nodeId = `${owner.actionId}/n${build.nodeCount}`;
          const node: FlowNode = { id: nodeId, type };
          if (firstLiteral !== undefined && firstLiteral.length > 0) node.label = firstLiteral;
          build.nodes.set(nodeId, node);
          build.action.nodes.push(node);
          if (isUnknownNodeType(type)) build.raw.set(nodeId, [stmt.raw]);
          syms.set(target, { t: "node", actionId: owner.actionId, nodeId });

          // Chained calls after `CreateNode<…>(…)`: only the `Connected*` family is a connector.
          for (const chain of rhs.matchAll(/\.([A-Za-z_]\w*)\(([^()]*)\)/g)) {
            const method2 = chain[1];
            if (method2 === "CreateNode") continue;
            if (!CONNECTING_CHAIN.has(method2)) continue;
            const fromVar = splitArguments(chain[2])[0]?.trim();
            const fromSym = fromVar !== undefined ? syms.get(fromVar) : undefined;
            if (fromSym?.t !== "node" || fromSym.actionId !== owner.actionId) {
              fail(stmt, `${method2}(${fromVar ?? ""}) does not name a node of this action`);
              continue;
            }
            addConnector(build, fromSym.nodeId, nodeId, "Target", "connectedBelow");
          }
          continue;
        }

        // --- an assignment on an Assign node ---
        if (method === "CreateAssignment") {
          const owner = syms.get(receiver);
          if (owner?.t !== "node") {
            fail(stmt, `CreateAssignment on '${receiver}', which is not a flow node`);
            syms.set(target, { t: "unknown" });
            continue;
          }
          const build = builds.get(owner.actionId);
          const node = build?.nodes.get(owner.nodeId);
          if (build === undefined || node === undefined) {
            fail(stmt, `CreateAssignment on an unknown node '${owner.nodeId}'`);
            continue;
          }
          if (args.length < 2) {
            // `CreateAssignment()` with no arguments exists on the interface; an empty assignment
            // carries no expression, so it is recorded as such rather than guessed at.
            node.assignments = [...(node.assignments ?? []), { left: "", right: "" }];
          } else {
            node.assignments = [...(node.assignments ?? []), { left: literalValue(args[0]), right: literalValue(args[1]) }];
          }
          syms.set(target, { t: "unknown" });
          continue;
        }

        // --- a switch case ---
        if (method === "CreateCondition") {
          const owner = syms.get(receiver);
          if (owner?.t !== "node") {
            fail(stmt, `CreateCondition on '${receiver}', which is not a flow node`);
            syms.set(target, { t: "unknown" });
            continue;
          }
          const build = builds.get(owner.actionId);
          if (build === undefined) {
            fail(stmt, `CreateCondition on an unknown action`);
            continue;
          }
          const cases = build.switchCases.get(owner.nodeId) ?? [];
          const index = cases.length;
          cases.push({ index });
          build.switchCases.set(owner.nodeId, cases);
          syms.set(target, { t: "switchCase", actionId: owner.actionId, nodeId: owner.nodeId, index });
          continue;
        }

        // --- a comment node's connector ---
        if (method === "CreateConnector") {
          const owner = syms.get(receiver);
          const toVar = args[0];
          const toSym = toVar !== undefined ? syms.get(toVar) : undefined;
          if (owner?.t === "node" && toSym?.t === "node" && owner.actionId === toSym.actionId) {
            const build = builds.get(owner.actionId);
            if (build !== undefined) addConnector(build, owner.nodeId, toSym.nodeId, "Comment", "explicit");
          }
          syms.set(target, { t: "unknown" });
          continue;
        }

        // --- action parameters and local variables ---
        if (method === "CreateInputParameter" || method === "CreateOutputParameter" || method === "CreateLocalVariable") {
          const owner = syms.get(receiver);
          const name = firstLiteral ?? "";
          const kind: FlowParameter["kind"] =
            method === "CreateInputParameter" ? "input" : method === "CreateOutputParameter" ? "output" : "local";
          if (owner?.t === "action") {
            const build = builds.get(owner.actionId);
            if (build !== undefined && !build.action.parameters.some((p) => p.name === name && p.kind === kind)) {
              build.action.parameters.push({ name, kind });
            }
          }
          // A screen-level `CreateLocalVariable` has no action to attach to; it is still a named
          // symbol, which is what matters for reading the expressions that mention it.
          syms.set(target, { t: "param", name });
          continue;
        }

        // --- widgets and widget events ---
        if (method === "CreateWidget") {
          widgetCount++;
          const widgetId = `${elementId}/w${widgetCount}`;
          const parent = widgetOf(receiver);
          const record: WidgetRecord = { id: widgetId, type: shortInterface(generic ?? "IWidget") };
          if (firstLiteral !== undefined && firstLiteral.length > 0) record.label = firstLiteral;
          if (parent !== undefined) record.parent = parent;
          if (branch !== undefined) record.branch = branch;
          widgets.set(widgetId, record);
          syms.set(target, { t: "widget", widgetId });
          continue;
        }
        if (method === "CreateEvent") {
          const widgetId = widgetOf(receiver);
          if (widgetId !== undefined) {
            // `widget.CreateEvent()` — a DOM event, named by the `.Event = "onclick"` that follows.
            syms.set(target, { t: "event", widgetId });
            continue;
          }
          // `<screen|block>.CreateEvent("NavigateToDashBoard")` declares an event the element can
          // RAISE, and an `ITriggerNode.Event` points at that variable. Live-confirmed in
          // MOD_EX_Demo_Catalog_CW/CatalogRequestEditMode. Without this the trigger kept only its
          // label, which happens to equal the event name — luck, not data.
          if (firstLiteral !== undefined && firstLiteral.length > 0) {
            syms.set(target, { t: "element", ref: makeRef({ name: firstLiteral }) });
            continue;
          }
          syms.set(target, { t: "unknown" });
          continue;
        }

        syms.set(target, { t: "unknown" });
        continue;
      }

      const eventHandler = EVENT_HANDLER_RE.exec(rhs);
      if (eventHandler) {
        const widgetId = widgetOf(eventHandler[1]);
        syms.set(
          target,
          widgetId !== undefined
            ? { t: "eventHandler", widgetId, event: literalValue(`"${eventHandler[2]}"`) }
            : { t: "unknown" }
        );
        continue;
      }

      const placeholder = PLACEHOLDER_RE.exec(rhs);
      if (placeholder) {
        const widgetId = widgetOf(placeholder[1]);
        syms.set(target, widgetId !== undefined ? { t: "placeholder", widgetId } : { t: "unknown" });
        continue;
      }

      const systemRole = SYSTEM_ROLE_RE.exec(rhs);
      if (systemRole) {
        syms.set(target, {
          t: "element",
          ref: makeRef({ module: "System", kind: "Role", name: literalValue(`"${systemRole[2]}"`) })
        });
        continue;
      }

      const flowNode = FLOW_NODE_RE.exec(rhs);
      if (flowNode) {
        const [, flowVar, typeName, rawName] = flowNode;
        const kind = normalizeKind(typeName);
        const flowSym = syms.get(flowVar);
        if (flowSym?.t === "flow") {
          // A flow node whose interface is OUTSIDE the v1 element set — an `IExternalSite`, say —
          // still has a name, and a navigate to it must say where it goes. It gets a ref with no
          // `kind` and therefore no graph `id`, exactly like an exception. Live-confirmed: the
          // MOD_EX_Demo_Catalog_CW/Login screen navigates to the external site `RedirectToURL`, and
          // requiring a known kind here silently emptied its `Destination`.
          syms.set(target, {
            t: "element",
            ref: makeRef({
              module: flowSym.module,
              ...(kind !== undefined ? { kind } : {}),
              uiFlow: kind !== undefined && isFlowQualified(kind) ? flowSym.flow : undefined,
              name: literalValue(`"${rawName}"`)
            })
          });
        } else {
          syms.set(target, { t: "unknown" });
        }
        continue;
      }

      const named = NAMED_RE.exec(rhs);
      if (named) {
        const [, receiver, collection, rawName] = named;
        const name = literalValue(`"${rawName}"`);
        if (collection === "References") {
          syms.set(target, { t: "ref", module: normalizeModuleName(name) });
          continue;
        }
        if (/^(MobileFlows|WebFlows|UIFlows|Flows)$/.test(collection)) {
          const refModule = moduleOf(receiver);
          syms.set(target, refModule !== undefined ? { t: "flow", module: refModule, flow: name } : { t: "unknown" });
          continue;
        }
        if (collection === "Exceptions") {
          // Exceptions are not a v1 graph element kind, so there is no node id to point at — but a
          // raise or handler that names one must still say WHICH, or "named exception" and "generic
          // exception" become indistinguishable in a flow listing.
          const refModule = moduleOf(receiver);
          syms.set(target, {
            t: "element",
            ref: {
              text: refModule !== undefined && refModule !== ctx.module ? `${refModule}.${name}` : name,
              name,
              ...(refModule !== undefined ? { module: refModule } : {})
            }
          });
          continue;
        }
        if (/^(InputParameters|OutputParameters|Parameters|LocalVariables|Attributes|Placeholders|Events)$/.test(collection)) {
          // A parameter/attribute lookup: what matters is its NAME, so an argument can be reported
          // as `Request = …` instead of as the variable Studio happened to call it.
          syms.set(target, { t: "param", name });
          continue;
        }
        const kind = collectionKind(collection);
        const refModule = moduleOf(receiver);
        if (kind !== undefined && refModule !== undefined) {
          syms.set(target, { t: "element", ref: makeRef({ module: refModule, kind, name }) });
          continue;
        }
        syms.set(target, { t: "unknown" });
        continue;
      }

      // A declaration whose right-hand side is just another variable aliases that variable.
      const alias = syms.get(rhs.replace(/;$/, "").trim());
      syms.set(target, alias ?? { t: "unknown" });
      continue;
    }

    // ---- statements that mutate an existing symbol --------------------------------------------

    const lifecycle = LIFECYCLE_RE.exec(code);
    if (lifecycle) {
      const [, receiver, handlerName, value] = lifecycle;
      const receiverSym = syms.get(receiver);
      const handler = refForValue(value);
      if (handler !== undefined) {
        if (receiverSym?.t === "self" || receiverSym === undefined) {
          // The element's own lifecycle: `block.OnReady.Destination = <action>`.
          addBinding("lifecycle", undefined, { name: handlerName, handler });
        } else if (receiverSym.t === "action") {
          // A data action's or aggregate's own hook:
          // `getRequestDetails.OnAfterFetch.Destination = onAfterFetch_GetRequestDetails`
          // (live-confirmed in MOD_EX_Demo_Catalog_CW/CatalogRequestMain). Qualified by the source's
          // name, because an element can have several and `OnAfterFetch` alone would not say which.
          const source = builds.get(receiverSym.actionId)?.action.name ?? receiver;
          addBinding("lifecycle", undefined, { name: `${source}.${handlerName}`, handler });
        }
      }
      continue;
    }

    const setter = SETTER_RE.exec(code);
    if (setter) {
      const [, receiver, method] = setter;
      const args = callArguments(code, method) ?? [];
      const receiverSym = syms.get(receiver);

      if (method === "SetArgumentValue") {
        const paramSym = args[0] !== undefined ? syms.get(args[0]) : undefined;
        const paramName = paramSym?.t === "param" ? paramSym.name : (args[0] ?? "");
        const expr = args[1] !== undefined ? literalValue(args[1]) : "";
        if (receiverSym?.t === "node") {
          const node = builds.get(receiverSym.actionId)?.nodes.get(receiverSym.nodeId);
          if (node !== undefined) node.arguments = [...(node.arguments ?? []), { param: paramName, expr }];
          continue;
        }
        if (receiverSym?.t === "widget") {
          if (!stmt.isDefault) addBinding("blockArgument", receiverSym.widgetId, { name: paramName, expr });
          continue;
        }
        if (receiverSym?.t === "eventHandler") {
          if (!stmt.isDefault) {
            addBinding("blockEventArgument", receiverSym.widgetId, {
              name: `${receiverSym.event}.${paramName}`,
              expr
            });
          }
          continue;
        }
        continue;
      }

      if (receiverSym?.t === "node") {
        const build = builds.get(receiverSym.actionId);
        const node = build?.nodes.get(receiverSym.nodeId);
        if (node === undefined) continue;
        if (stmt.isDefault) continue;
        const value = args.length > 0 ? literalValue(args[0]) : "";
        const promoted = promotedSetter(method);
        if (promoted !== undefined) node[promoted] = value;
        else setProperty(node, method.replace(/^Set/, ""), value);
        if (isUnknownNodeType(node.type) && build !== undefined) {
          build.raw.set(node.id, [...(build.raw.get(node.id) ?? []), stmt.raw]);
        }
        continue;
      }

      if (receiverSym?.t === "switchCase") {
        const build = builds.get(receiverSym.actionId);
        const cases = build?.switchCases.get(receiverSym.nodeId);
        const entry = cases?.[receiverSym.index];
        if (entry !== undefined && method === "SetValue" && !stmt.isDefault) {
          entry.value = args.length > 0 ? literalValue(args[0]) : "";
        }
        continue;
      }

      if (receiverSym?.t === "widget" && !stmt.isDefault) {
        const expr = args.length > 0 ? literalValue(args[0]) : "";
        if (method === "SetCondition") {
          addBinding("ifCondition", receiverSym.widgetId, { expr });
          continue;
        }
        // Every other non-default setter is captured, with only the presentational ones excluded.
        // An allow-list was tried first and silently dropped `popup.SetShowPopup(…)` — the one
        // expression that answers "under which conditions is the popup shown?" on the live
        // MOD_EX_Demo_Catalog_CW/CatalogRequestEditMode block. Excluding is safe to get wrong (one
        // noisy binding); allow-listing is not (a missing one looks like "no condition").
        if (!WIDGET_SETTERS_IGNORED.has(method)) {
          addBinding("widgetExpression", receiverSym.widgetId, { name: method.replace(/^Set/, ""), expr });
        }
        continue;
      }
      continue;
    }

    const member = MEMBER_ASSIGN_RE.exec(code);
    if (member) {
      const [, receiver, property, rawValue] = member;
      const value = rawValue.trim();
      const receiverSym = syms.get(receiver);

      if (receiverSym?.t === "node") {
        const build = builds.get(receiverSym.actionId);
        const node = build?.nodes.get(receiverSym.nodeId);
        if (build === undefined || node === undefined) continue;
        if (isUnknownNodeType(node.type)) build.raw.set(node.id, [...(build.raw.get(node.id) ?? []), stmt.raw]);

        const port = portForProperty(property);
        if (port !== undefined) {
          if (value === "null") continue; // an unwired port is simply absent
          const toSym = syms.get(value);
          if (toSym?.t !== "node" || toSym.actionId !== receiverSym.actionId) {
            fail(stmt, `${property} = '${value}' does not name a node of this action`);
            continue;
          }
          addConnector(build, receiverSym.nodeId, toSym.nodeId, port, "explicit");
          continue;
        }

        const promoted = calleeProperty(property);
        if (promoted !== undefined) {
          const ref = refForValue(value) ?? refForPath(value);
          if (ref !== undefined) node[promoted] = ref;
          continue;
        }

        if (isLayoutProperty(property) || stmt.isDefault) continue;
        if (property === "Label" || property === "Name") {
          const label = literalValue(value);
          if (label !== "null" && label.length > 0) node.label = label;
          continue;
        }
        setProperty(node, property, literalValue(value));
        continue;
      }

      if (receiverSym?.t === "switchCase") {
        const build = builds.get(receiverSym.actionId);
        const entry = build?.switchCases.get(receiverSym.nodeId)?.[receiverSym.index];
        if (entry === undefined || build === undefined) continue;
        if (property === "Target") {
          const toSym = syms.get(value);
          if (value !== "null" && toSym?.t === "node" && toSym.actionId === receiverSym.actionId) {
            addConnector(build, receiverSym.nodeId, toSym.nodeId, `Case[${receiverSym.index}]`, "explicit");
          }
          continue;
        }
        if (property === "Label" && !stmt.isDefault) {
          const label = literalValue(value);
          if (label !== "null" && label.length > 0) entry.label = label;
        }
        continue;
      }

      if (receiverSym?.t === "event") {
        // `event.Event = "onclick";` then `event.Handler = <action>;` — one binding, filled in two
        // statements, so the Event name is remembered on the symbol until the Handler arrives.
        if (property === "Event") {
          syms.set(receiver, { t: "eventHandler", widgetId: receiverSym.widgetId, event: literalValue(value) });
          continue;
        }
        if (property === "Handler") {
          const handler = refForValue(value);
          if (handler !== undefined) addBinding("event", receiverSym.widgetId, { handler });
        }
        continue;
      }

      if (receiverSym?.t === "eventHandler") {
        if (property === "Handler") {
          const handler = refForValue(value);
          if (handler !== undefined) {
            // A widget event (`onclick`) and a block-instance event (`ScrollToEvent`) are different
            // wiring with the same syntax; the name's origin is what tells them apart.
            addBinding(receiverSym.event.startsWith("on") ? "event" : "blockEvent", receiverSym.widgetId, {
              name: receiverSym.event,
              handler
            });
          }
          continue;
        }
        if (property === "Event") {
          syms.set(receiver, { t: "eventHandler", widgetId: receiverSym.widgetId, event: literalValue(value) });
        }
        continue;
      }

      if (receiverSym?.t === "widget") {
        if (property === "SourceBlock") {
          const handler = refForValue(value);
          if (handler !== undefined) addBinding("blockSource", receiverSym.widgetId, { handler });
        }
        continue;
      }

      if (receiverSym?.t === "action") {
        if (property === "Description" && !stmt.isDefault) {
          const description = literalValue(value);
          const build = builds.get(receiverSym.actionId);
          if (build !== undefined && description !== "null" && description.length > 0) {
            build.action.description = description;
          }
        }
        continue;
      }
      continue;
    }
  }

  // Attach the collected extras that live outside the node objects.
  for (const actionId of actionOrder) {
    const build = builds.get(actionId);
    if (build === undefined) continue;

    // A `Connected*` chain and an explicit port statement can describe the SAME edge, and Studio
    // emits both when the chain hangs off a branching node:
    //
    //   ifNode8.TrueTarget = null;                        // default value
    //   var next = act.CreateNode<…>("X").ConnectedToTheRightOf(ifNode8, 2058);
    //   ifNode8.FalseTarget = next;                       // the authoritative one
    //
    // Keeping both yields a duplicate edge out of the If — one `False`, one vague `Target`. The
    // explicit statement names its port and wins; the chain's `Target` is dropped when the same
    // (from, to) pair is already covered explicitly. Live-confirmed in
    // MOD_EX_Demo_Staffing_CW/StaffingJob_CreateNewRequest, which is also the answer to the
    // question ADR-0012 left open about what a `ConnectedBelow` off a branching node means.
    const explicitPairs = new Set(
      build.action.connectors.filter((c) => c.via === "explicit").map((c) => `${c.from}\u0000${c.to}`)
    );
    build.action.connectors = build.action.connectors.filter(
      (c) => c.via === "explicit" || !explicitPairs.has(`${c.from}\u0000${c.to}`)
    );
    for (const node of build.action.nodes) {
      const raw = build.raw.get(node.id);
      if (raw !== undefined && raw.length > 0) node.raw = raw;
      const cases = build.switchCases.get(node.id);
      if (cases !== undefined && cases.length > 0) {
        setProperty(
          node,
          "Cases",
          cases.map((c) => `${c.index}:${c.label !== undefined ? `${c.label}=` : ""}${c.value ?? ""}`).join(" | ")
        );
      }
    }
  }

  // Studio's text is NOT deterministic for its unordered collections. Two live reads of an
  // unchanged MOD_EX_Demo_Staffing_CW/StaffingJob_MainBlock differed only in the order of
  // two event handlers' `SetArgumentValue` calls (same byte length, different bytes) — so an IR
  // that preserved text order could not be byte-stable across rebuilds however correct it was.
  //
  // Everything whose order Studio does not guarantee is therefore sorted, and everything whose
  // order is SEMANTIC is left exactly as the text had it:
  //   sorted   — a node's `arguments` (named parameters) and the `bindings` array;
  //   NOT sorted — `assignments` (they run in sequence) and switch cases (numbered by position).
  // This is the same choice `finalizeModule` already makes for `graph.json`'s nodes and edges.
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const widgetIndex = (id: string | undefined): number =>
    id === undefined ? -1 : Number(id.slice(id.lastIndexOf("/w") + 2));
  for (const build of builds.values()) {
    for (const node of build.action.nodes) {
      if (node.arguments !== undefined) {
        node.arguments = [...node.arguments].sort((a, b) => compare(a.param, b.param) || compare(a.expr, b.expr));
      }
    }
  }
  // Widget creation index first, so the list still reads in document order.
  bindings.sort(
    (a, b) =>
      widgetIndex(a.widget) - widgetIndex(b.widget) ||
      compare(a.kind, b.kind) ||
      compare(a.name ?? "", b.name ?? "") ||
      compare(a.expr ?? "", b.expr ?? "") ||
      compare(a.handler?.text ?? "", b.handler?.text ?? "")
  );

  return {
    element,
    actions: actionOrder.map((id) => builds.get(id)?.action).filter((a): a is FlowAction => a !== undefined),
    bindings,
    createNodeCount,
    unknownNodeTypes: [...unknownNodeTypes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    parseErrors
  };
}
