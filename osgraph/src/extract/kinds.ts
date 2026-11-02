import type { ElementKind, Relation } from "./types.js";

/**
 * ADR-0006 kind normalization. Accepts the anchor form (`IServerEntity`), the signature form
 * (`IServerEntitySignature`) and a fully qualified type (`OutSystems.Model.UI.Mobile.IMobileBlockSignature`).
 * Returns undefined for every interface outside the v1 element set (themes, images, sites, timers, …).
 */
export function normalizeKind(interfaceName: string): ElementKind | undefined {
  const short = interfaceName.trim().split(".").pop() ?? "";
  const bare = short.replace(/^I/, "").replace(/Signature$/, "");
  switch (bare) {
    case "Entity":
    case "ServerEntity":
    case "StaticEntity":
      return "Entity";
    case "Structure":
      return "Structure";
    case "ServerAction":
    case "ServiceAction":
      return "ServerAction";
    case "ClientAction":
      return "ClientAction";
    case "Screen":
    case "MobileScreen":
    case "WebScreen":
      return "Screen";
    case "Block":
    case "MobileBlock":
    case "WebBlock":
      return "Block";
    case "Role":
    case "SystemRole":
      return "Role";
    default:
      return undefined;
  }
}

/** Collection property on an `eSpace`/reference var → element kind (`<ref>.ServerActions.Named("X")`). */
export function collectionKind(collection: string): ElementKind | undefined {
  switch (collection) {
    case "ServerActions":
    case "ServiceActions":
      return "ServerAction";
    case "ClientActions":
      return "ClientAction";
    case "Entities":
    case "StaticEntities":
      return "Entity";
    case "Structures":
      return "Structure";
    case "Roles":
    case "SystemRoles":
      return "Role";
    default:
      return undefined;
  }
}

/** True for the kinds whose id carries a `/<UIFlow>` segment (ADR-0008). */
export function isFlowQualified(kind: ElementKind): boolean {
  return kind === "Screen" || kind === "Block";
}

/** Relation implied by the kind of the element a source element's text names (OSG-006 vocabulary). */
export function relationForTargetKind(kind: ElementKind): Relation {
  switch (kind) {
    case "Entity":
    case "Structure":
    case "Screen":
      return "references";
    case "ServerAction":
    case "ClientAction":
      return "calls";
    case "Block":
      return "embeds";
    case "Role":
      return "requires_role";
  }
}
