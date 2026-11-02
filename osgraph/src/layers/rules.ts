/**
 * OSG-003: `layer-rules.json` loader. Fail-closed: unknown keys, allow keys not in `layers`,
 * and allowed targets not in `layers` are all rejected.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const LayerRulesSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: z.string().min(1),
    layers: z.array(z.string().min(1)).min(1),
    layerSuffixPattern: z.string().min(1),
    unknownLayerTag: z.string().min(1),
    notes: z.string(),
    allow: z.record(z.string(), z.array(z.string()))
  })
  .superRefine((rules, ctx) => {
    const layers = new Set(rules.layers);
    if (layers.size !== rules.layers.length) {
      ctx.addIssue({ code: "custom", path: ["layers"], message: "layers must be unique" });
    }
    if (layers.has(rules.unknownLayerTag)) {
      ctx.addIssue({
        code: "custom",
        path: ["unknownLayerTag"],
        message: `unknownLayerTag "${rules.unknownLayerTag}" must not be a declared layer`
      });
    }
    try {
      new RegExp(rules.layerSuffixPattern);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["layerSuffixPattern"],
        message: "layerSuffixPattern is not a valid regular expression"
      });
    }
    for (const [source, targets] of Object.entries(rules.allow)) {
      if (!layers.has(source)) {
        ctx.addIssue({
          code: "custom",
          path: ["allow", source],
          message: `allow key "${source}" is not a declared layer`
        });
      }
      for (const target of targets) {
        if (!layers.has(target)) {
          ctx.addIssue({
            code: "custom",
            path: ["allow", source],
            message: `allowed target "${target}" of "${source}" is not a declared layer`
          });
        }
      }
    }
    for (const layer of rules.layers) {
      if (!(layer in rules.allow)) {
        ctx.addIssue({
          code: "custom",
          path: ["allow"],
          message: `layer "${layer}" has no allow entry (fail-closed requires an explicit list)`
        });
      }
    }
  });

export type LayerRules = z.infer<typeof LayerRulesSchema>;

/** Thrown when the rules file is missing, unparsable, or fails schema validation. */
export class LayerRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayerRulesError";
  }
}

/** Absolute path of the `layer-rules.json` shipped with this package (works from src/ and dist/). */
export function defaultLayerRulesPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "layer-rules.json");
}

/** Validates an already-parsed JSON value against the OSG-003 schema. */
export function parseLayerRules(value: unknown, origin = "<inline>"): LayerRules {
  const parsed = LayerRulesSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.map(String).join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new LayerRulesError(`Invalid layer rules at ${origin}: ${issues}`);
  }
  return parsed.data;
}

/**
 * Loads and validates `layer-rules.json`. `path` defaults to the package's own copy; S6 may pass
 * an override (no env var is read here — see config.ts for the environment contract).
 */
export function loadLayerRules(path: string = defaultLayerRulesPath()): LayerRules {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new LayerRulesError(`Cannot read layer rules at ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new LayerRulesError(`Layer rules at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseLayerRules(json, path);
}
