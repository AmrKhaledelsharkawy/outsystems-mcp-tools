/**
 * Scope-name validation (ADR-0005). Kept dependency-free so both the scope store and the
 * scope-artifact path resolver in `graph/io.ts` can use it without an import cycle.
 */
import { OsgraphToolError } from "../servicestudio/types.js";

export const SCOPE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** Validates `name`; throws `SCOPE_INVALID` for anything that is not a safe single path segment. */
export function assertScopeName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new OsgraphToolError("SCOPE_INVALID", "scope name must be a non-empty string");
  }
  if (!SCOPE_NAME_RE.test(name) || name === "." || name === "..") {
    throw new OsgraphToolError(
      "SCOPE_INVALID",
      `scope name '${name}' is invalid: use only letters, digits, '_', '.', '-' (not '.' or '..')`,
      { name }
    );
  }
}
