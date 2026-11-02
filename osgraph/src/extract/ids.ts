import { isFlowQualified } from "./kinds.js";
import type { ElementKind } from "./types.js";

export const ID_PREFIX = "osgraph://";
export const EXTERNAL_PREFIX = `${ID_PREFIX}external/`;

/** `(System)` → `System` (ADR-0006: module name verbatim minus surrounding parentheses). */
export function normalizeModuleName(raw: string): string {
  return raw.trim().replace(/^\((.*)\)$/, "$1");
}

export interface IdParts {
  module: string;
  kind: ElementKind;
  name: string;
  /** Required for Screen/Block when known; omitted → flow-less id (external ref form, ADR-0008). */
  uiFlow?: string;
}

/**
 * `osgraph://<Module>/<Kind>/<Name>`, or `osgraph://<Module>/<Kind>/<UIFlow>/<Name>` for screens and
 * blocks whose flow is known (ADR-0008).
 */
export function buildId(parts: IdParts): string {
  const module = normalizeModuleName(parts.module);
  if (isFlowQualified(parts.kind) && parts.uiFlow !== undefined && parts.uiFlow !== "") {
    return `${ID_PREFIX}${module}/${parts.kind}/${parts.uiFlow}/${parts.name}`;
  }
  return `${ID_PREFIX}${module}/${parts.kind}/${parts.name}`;
}

/** Opaque fallback id when an `AddDependency` has no module/name comment (ADR-0006). */
export function externalOpaqueId(globalKey: string): string {
  return `${EXTERNAL_PREFIX}${globalKey}`;
}

/** Layer-graph module node id (ADR-0006: kind `module`, no further segments). */
export function moduleId(module: string): string {
  return `${ID_PREFIX}${normalizeModuleName(module)}`;
}

export function isOpaqueExternalId(id: string): boolean {
  return id.startsWith(EXTERNAL_PREFIX);
}

export interface ParsedId {
  module: string;
  kind: ElementKind | "module";
  uiFlow?: string;
  name?: string;
}

/** Inverse of `buildId`/`moduleId`; undefined for opaque external ids and malformed ids. */
export function parseId(id: string): ParsedId | undefined {
  if (!id.startsWith(ID_PREFIX) || isOpaqueExternalId(id)) return undefined;
  const segments = id.slice(ID_PREFIX.length).split("/");
  if (segments.length === 1) return { module: segments[0], kind: "module" };
  const [module, kind, ...rest] = segments;
  if (!isElementKind(kind) || rest.length === 0) return undefined;
  if (rest.length === 2 && isFlowQualified(kind)) {
    return { module, kind, uiFlow: rest[0], name: rest[1] };
  }
  if (rest.length === 1) return { module, kind, name: rest[0] };
  return undefined;
}

function isElementKind(value: string): value is ElementKind {
  return (
    value === "Entity" ||
    value === "Structure" ||
    value === "ServerAction" ||
    value === "ClientAction" ||
    value === "Screen" ||
    value === "Block" ||
    value === "Role"
  );
}
