/**
 * #90: REST capture for `_API` (exposed) and `_IS` (consumed) modules.
 *
 * ONE read per such module (`getIntegrations`, Model API code text) is split here into one text per
 * REST method, so the raw capture, the graph and the flows can treat a method as the unit (the REST
 * API is the grouping folder: `raw/<module>/RestAPI/<Api>/<Method>.txt`).
 *
 * The read is gated on the module-name suffix ONLY (ADR-0016 read-cost rule): `restModeOf` is the single
 * gate, and no other layer ever pays for the call.
 *
 * Shape of the live `getIntegrations` text (Studio 11.55, confirmed on an `_API` and an `_IS` module):
 * one lambda; per API a creating-anchor comment (IRestService or IRestClient, then the API name), a
 * `var a = eSpace.CreateIntegration<...>("Api")` line, then per method `var m = a.CreateAction("Method")`
 * with its parameters and (exposed) its whole flow, then the API-level callbacks
 * (`a.CreateOnAuthenticationCallback()`, `a.CreateOnAfterResponseCallback()`, ...). Element lookups
 * (`var x = ...Named("...")`) are declared ONCE per text, in whichever method first used them, and
 * reused by later methods and APIs, so a method cannot be read from its own slice alone: each method
 * text carries the lookup declarations of the whole text as context (before its anchor, so they never
 * create edges by themselves). A text with no recognisable API or method yields no methods.
 */

export type RestMode = "exposed" | "consumed";

/** `_API` -> exposed REST, `_IS` -> consumed REST, anything else -> no REST read at all. */
export function restModeOf(moduleName: string): RestMode | undefined {
  if (/_API$/.test(moduleName)) return "exposed";
  if (/_IS$/.test(moduleName)) return "consumed";
  return undefined;
}

export interface RestMethodText {
  api: string;
  method: string;
  consumed: boolean;
  /** Verbatim slice of the integrations text: this API's preamble + this method's statements. */
  text: string;
}

/** `<Api>/<Method>`: the element name of a REST method. */
export function restMethodName(api: string, method: string): string {
  return `${api}/${method}`;
}

const ANCHOR_RE = /^\s*\/\*\*\* creating (I\w+) '([^']+)' \*\*\*\//;
const REST_INTERFACE_RE = /rest|integration/i;
const CREATE_INTEGRATION_RE = /\.CreateIntegration<[^>]*>\(\s*"([^"]+)"\s*\)/;
const CREATE_ACTION_RE = /\.CreateAction\(\s*"([^"]+)"\s*\)/;
/** `var x = a.CreateOnAfterResponseCallback();` - an API-level callback flow (OnRequest, OnAuthentication, ...). */
const CREATE_CALLBACK_RE = /\.Create(On\w+)Callback\(\s*\)/;
const VAR_RE = /^\s*var (\w+) = /;
const LOOKUP_RE = /\.Named\(|\.AddDependency\(|\.GetESpace\(\)/;
const SIGNATURE_RE = /^\s*\/\/\s*I\w+Signature\s/;

interface ApiBlock {
  api: string;
  lines: string[];
}

function apiBlocks(lines: string[]): ApiBlock[] {
  const blocks: ApiBlock[] = [];
  let current: ApiBlock | undefined;
  for (const line of lines) {
    const anchor = ANCHOR_RE.exec(line);
    if (anchor) {
      current = REST_INTERFACE_RE.test(anchor[1]) ? { api: anchor[2], lines: [] } : undefined;
      if (current) blocks.push(current);
      continue;
    }
    const create = CREATE_INTEGRATION_RE.exec(line);
    if (create && current === undefined) {
      // No anchors in the text: a CreateIntegration declaration starts the block.
      current = { api: create[1], lines: [] };
      blocks.push(current);
    }
    if (current) current.lines.push(line);
  }
  return blocks;
}

function kindFor(consumed: boolean): "RestMethod" | "ConsumedRestMethod" {
  return consumed ? "ConsumedRestMethod" : "RestMethod";
}

/**
 * Splits one `getIntegrations` text into per-method texts (a callback is a method named `On...`).
 * Order is text order (API, then method/callback), so the raw manifest order is deterministic.
 * Duplicate `<Api>/<Method>` pairs keep the first.
 *
 * Each text is: the lambda header, the lookup declarations of the WHOLE text that this method does not
 * declare itself (with their `// I...Signature` comments), its API's `CreateIntegration` line, the
 * method's own anchor, and its own statements - all verbatim slices of the original.
 */
export function splitIntegrations(text: string, mode: RestMode): RestMethodText[] {
  const all = text.split(/\r?\n/);
  const header = all.filter((l) => /^\s*\(.*\)\s*=>\s*\{?\s*$/.test(l)).slice(0, 1);
  const consumed = mode === "consumed";

  interface Seg {
    api: string;
    method: string;
    integration: string;
    lines: string[];
  }
  const segs: Seg[] = [];
  const seen = new Set<string>();
  // Lookup declarations, in text order, with their owning signature comment lines.
  const lookups: Array<{ name: string; lines: string[]; seg: number }> = [];

  for (const block of apiBlocks(all)) {
    const integration = block.lines.find((l) => CREATE_INTEGRATION_RE.test(l)) ?? "";
    let seg: Seg | undefined;
    let pendingComments: string[] = [];
    for (const line of block.lines) {
      const action = CREATE_ACTION_RE.exec(line);
      const callback = action ? null : CREATE_CALLBACK_RE.exec(line);
      const method = action ? action[1] : callback ? callback[1] : undefined;
      if (method !== undefined) {
        const key = restMethodName(block.api, method);
        seg = seen.has(key) ? undefined : { api: block.api, method, integration, lines: [] };
        seen.add(key);
        if (seg) segs.push(seg);
      }
      const v = VAR_RE.exec(line);
      if (SIGNATURE_RE.test(line)) {
        pendingComments.push(line);
      } else if (v && LOOKUP_RE.test(line) && !CREATE_INTEGRATION_RE.test(line)) {
        lookups.push({ name: v[1], lines: [...pendingComments, line], seg: seg ? segs.length - 1 : -1 });
        pendingComments = [];
      } else if (line.trim() !== "") {
        pendingComments = [];
      }
      if (seg) seg.lines.push(line);
    }
  }

  return segs.map((seg, index) => {
    const own = new Set<string>();
    for (const l of seg.lines) {
      const v = VAR_RE.exec(l);
      if (v) own.add(v[1]);
    }
    const context = lookups.filter((l) => l.seg !== index && !own.has(l.name)).flatMap((l) => l.lines);
    const name = restMethodName(seg.api, seg.method);
    return {
      api: seg.api,
      method: seg.method,
      consumed,
      text: [
        ...header,
        ...context,
        ...(seg.integration !== "" ? [seg.integration] : []),
        `/*** creating I${kindFor(consumed)} '${name}' ***/`,
        ...seg.lines
      ].join("\n")
    };
  });
}
