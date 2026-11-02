/**
 * The subset of `ServiceStudioClient` a scope rebuild reads through. Structural, so tests can
 * substitute a fixture-backed fake; the real client satisfies it without adapters.
 * Every method is read-only (goal.md hard safety rule: no edits, no publish, no save).
 */
import type {
  ActionObjectType,
  ServiceStudioApp,
  ServiceStudioElementName
} from "../servicestudio/types.js";

export interface ServiceStudioReader {
  listApps(): Promise<ServiceStudioApp[]>;
  getDataModel(eSpaceName: string): Promise<string>;
  getStructures(eSpaceName: string): Promise<string>;
  getScreenNames(eSpaceName: string): Promise<ServiceStudioElementName[]>;
  getWebBlockNames(eSpaceName: string): Promise<ServiceStudioElementName[]>;
  getActionNames(eSpaceName: string, objectType: ActionObjectType): Promise<ServiceStudioElementName[]>;
  getScreen(eSpaceName: string, objectName: string): Promise<string>;
  getWebBlock(eSpaceName: string, objectName: string): Promise<string>;
  getClientAction(eSpaceName: string, objectName: string): Promise<string>;
  getServerAction(eSpaceName: string, objectName: string): Promise<string>;
  getServiceAction(eSpaceName: string, objectName: string): Promise<string>;
  getScreenNamesTraditional(eSpaceName: string): Promise<ServiceStudioElementName[]>;
  getWebBlockNamesTraditional(eSpaceName: string): Promise<ServiceStudioElementName[]>;
  getScreenTraditional(eSpaceName: string, objectName: string): Promise<string>;
  getWebBlockTraditional(eSpaceName: string, objectName: string): Promise<string>;
  /**
   * OSG-016 §B / ADR-0013: resolves once no read is in flight **or queued** on this client.
   *
   * Optional, because a fixture-backed fake answers synchronously and has nothing to drain — but the
   * real client implements it, and a rebuild awaits it before it returns. That is the barrier that
   * makes the tool response itself safe to close a module behind: closing a module whose reads are
   * still queued is the one combination that reproduces the temp-OML failure (discovery doc §8.2-8.4),
   * and an ABORTING rebuild is where it bites — `mapPool` lets the siblings of a failed call settle,
   * but the session-level aborts above it would otherwise return while reads were still in flight.
   */
  drain?(): Promise<void>;
}

/** What the orchestration needs from the session layer: acquire once, release at the end. */
export interface ServiceStudioSession {
  reader: ServiceStudioReader;
  /** `TokenProvider.acquire()`: validate/obtain the token once per rebuild (ADR-0004 / OSG-004). */
  acquire(): Promise<unknown>;
  /** `TokenProvider.clear()`: drop the in-memory token when the rebuild ends (success or failure). */
  release(): void;
}
