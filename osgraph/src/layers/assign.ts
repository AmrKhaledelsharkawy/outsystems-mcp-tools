/**
 * OSG-003: module name → layer tag. Case-sensitive match of `layerSuffixPattern` against the
 * module name; anything that does not match is tagged `rules.unknownLayerTag` (`UNKNOWN`).
 */
import type { LayerRules } from "./rules.js";

const regexCache = new WeakMap<LayerRules, RegExp>();

function suffixRegex(rules: LayerRules): RegExp {
  let re = regexCache.get(rules);
  if (re === undefined) {
    re = new RegExp(rules.layerSuffixPattern);
    regexCache.set(rules, re);
  }
  return re;
}

/** Returns the layer name (a member of `rules.layers`) or `rules.unknownLayerTag`. */
export function assignLayer(moduleName: string, rules: LayerRules): string {
  const match = suffixRegex(rules).exec(moduleName);
  if (match === null) return rules.unknownLayerTag;
  // Prefer the first capture group (the layer token); fall back to the whole match minus `_`.
  const layer = match[1] ?? match[0].replace(/^_/, "");
  return rules.layers.includes(layer) ? layer : rules.unknownLayerTag;
}

export type Allowance = true | false | "exempt";

/**
 * `true` when `allow[sourceLayer]` lists `targetLayer`, `false` otherwise (fail-closed),
 * `"exempt"` when either side is the unknown tag (never evaluated, per OSG-003).
 */
export function isAllowed(sourceLayer: string, targetLayer: string, rules: LayerRules): Allowance {
  if (sourceLayer === rules.unknownLayerTag || targetLayer === rules.unknownLayerTag) {
    return "exempt";
  }
  if (sourceLayer === targetLayer) return true;
  const targets = rules.allow[sourceLayer];
  if (targets === undefined) return false;
  return targets.includes(targetLayer);
}
