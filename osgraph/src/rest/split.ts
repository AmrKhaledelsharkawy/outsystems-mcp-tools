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
 * UNVERIFIED against a live Studio build: the shape of the `getIntegrations` text is modelled on the
 * Model API creation recipes (`eSpace.CreateIntegration<...>("Api")` + `api.CreateAction("Method")`)
 * and on the anchor comments the other `get*` tools emit. A text with no recognisable API or method
 * yields no methods, never a guess.
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

interface ApiBlock {
  api: string;
  lines: string[];
}

function apiBlocks(lines: string[]): ApiBlock[] {
  const blocks: ApiBlock[] = [];
  let current: ApiBlock | undefined;
  const header: string[] = [];
  for (const line of lines) {
    const anchor = ANCHOR_RE.exec(line);
    if (anchor) {
      current = REST_INTERFACE_RE.test(anchor[1]) ? { api: anchor[2], lines: [...header] } : undefined;
      if (current) blocks.push(current);
      continue;
    }
    const create = CREATE_INTEGRATION_RE.exec(line);
    if (create && current === undefined) {
      // No anchors in the text: a CreateIntegration declaration starts the block.
      current = { api: create[1], lines: [...header] };
      blocks.push(current);
    }
    if (current) current.lines.push(line);
    else if (blocks.length === 0) header.push(line);
  }
  return blocks;
}

/**
 * Splits one `getIntegrations` text into per-method texts. Order is text order (API, then method), so
 * the raw manifest order is deterministic. Duplicate `<Api>/<Method>` pairs keep the first.
 */
export function splitIntegrations(text: string, mode: RestMode): RestMethodText[] {
  const out: RestMethodText[] = [];
  const seen = new Set<string>();
  for (const block of apiBlocks(text.split(/\r?\n/))) {
    const starts: Array<{ at: number; method: string }> = [];
    block.lines.forEach((line, at) => {
      const m = CREATE_ACTION_RE.exec(line);
      if (m) starts.push({ at, method: m[1] });
    });
    if (starts.length === 0) continue;
    const preamble = block.lines.slice(0, starts[0].at);
    starts.forEach((s, i) => {
      const end = i + 1 < starts.length ? starts[i + 1].at : block.lines.length;
      const key = restMethodName(block.api, s.method);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        api: block.api,
        method: s.method,
        consumed: mode === "consumed",
        text: [...preamble, ...block.lines.slice(s.at, end)].join("\n")
      });
    });
  }
  return out;
}

/**
 * The text an extractor / flow parser is handed for one method: every anchor comment of the raw text is
 * replaced by ONE anchor naming the method's own kind and `<Api>/<Method>`. The raw file stays verbatim;
 * this is applied in memory on both the live and the offline (`reextract`) path, so they cannot differ.
 */
export function anchoredRestText(kind: "RestMethod" | "ConsumedRestMethod", name: string, text: string): string {
  const kept = text.split(/\r?\n/).filter((l) => !ANCHOR_RE.test(l));
  return [`/*** creating I${kind} '${name}' ***/`, ...kept].join("\n");
}
