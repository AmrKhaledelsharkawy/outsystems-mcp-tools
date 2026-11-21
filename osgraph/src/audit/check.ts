/**
 * Automatic check for the accuracy audit (#67): is the producer referenced in the consumer's raw
 * text? Edges should say yes, absent pairs no; every disagreement is kept with its reason.
 *
 * A reference shows up in an element text in two ways (the same two the extractor reads):
 *  - a dependency comment `// I<Kind>Signature <Module>/[<Flow>/]<Name>` above an `AddDependency`;
 *  - a name lookup `.Named("<Name>")`, which for a producer in another module is only a reference
 *    when the text also opens that module with `eSpace.References.Named("<Module>")`.
 * Studio renames a clashing import `Name2`, `Name3`...; a trailing number on the lookup is accepted.
 */
import { parseId, normalizeModuleName } from "../extract/ids.js";
import { normalizeKind } from "../extract/kinds.js";
import type { AbsentPair, AbsentResult, AuditPair, AuditSample, EdgeResult } from "./types.js";

/** Returns the raw text of a consumer element id, or undefined when it was never captured. */
export type TextSource = (consumerId: string) => string | undefined;

const SIGNATURE_RE = /^\s*\/\/\s*(I\w+Signature)\s+(\S+)\s*$/;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameMatches(candidate: string, name: string): boolean {
  if (candidate === name) return true;
  return candidate.startsWith(name) && /^\d+$/.test(candidate.slice(name.length));
}

export type ReferenceHow = "signature" | "named";

/** Does `text` reference the producer element? `how` says which form matched. */
export function textReferences(text: string, pair: AuditPair): { found: false } | { found: true; how: ReferenceHow } {
  const parsed = parseId(pair.producer);
  if (parsed === undefined || parsed.kind === "module" || parsed.name === undefined) return { found: false };
  const producerModule = normalizeModuleName(parsed.module);
  const name = parsed.name;

  for (const line of text.split(/\r?\n/)) {
    const sig = SIGNATURE_RE.exec(line);
    if (sig === null) continue;
    if (normalizeKind(sig[1]) !== parsed.kind) continue;
    const segments = sig[2].split("/");
    if (segments.length < 2) continue;
    if (normalizeModuleName(segments[0]) !== producerModule) continue;
    if (nameMatches(segments[segments.length - 1], name)) return { found: true, how: "signature" };
  }

  const named = new RegExp(`\\.Named\\("${escapeRegex(name)}\\d*"\\)`);
  if (!named.test(text)) return { found: false };
  if (producerModule === normalizeModuleName(pair.consumerModule)) return { found: true, how: "named" };
  const opensModule = new RegExp(`References\\.Named\\("${escapeRegex(producerModule)}"\\)`);
  return opensModule.test(text) ? { found: true, how: "named" } : { found: false };
}

export function checkEdge(pair: AuditPair, textOf: TextSource): EdgeResult {
  const text = textOf(pair.consumer);
  if (text === undefined) {
    return { pair, verdict: "unverifiable", reason: "no raw text captured for the consumer element" };
  }
  if (textReferences(text, pair).found) return { pair, verdict: "confirmed" };
  return {
    pair,
    verdict: "disagreement",
    type: "edge-not-in-text",
    reason: "the graph has this edge but the consumer's raw text holds no reference to the producer (false edge)"
  };
}

export function checkAbsent(pair: AbsentPair, textOf: TextSource): AbsentResult {
  const text = textOf(pair.consumer);
  if (text === undefined) {
    return { pair, verdict: "unverifiable", reason: "no raw text captured for the consumer element" };
  }
  const hit = textReferences(text, pair);
  if (!hit.found) return { pair, verdict: "confirmed" };
  return {
    pair,
    verdict: "disagreement",
    type: "absent-in-text",
    reason: `the graph has no edge but the consumer's raw text references the producer (${hit.how}; missing edge)`
  };
}

export interface CheckedStratum {
  layer: AuditSample["strata"][number]["layer"];
  kind: AuditSample["strata"][number]["kind"];
  edgePopulation: number;
  edges: EdgeResult[];
  absent: AbsentResult[];
}

export function checkSample(sample: AuditSample, textOf: TextSource): CheckedStratum[] {
  return sample.strata.map((s) => ({
    layer: s.layer,
    kind: s.kind,
    edgePopulation: s.edgePopulation,
    edges: s.edges.map((p) => checkEdge(p, textOf)),
    absent: s.absent.map((p) => checkAbsent(p, textOf))
  }));
}
