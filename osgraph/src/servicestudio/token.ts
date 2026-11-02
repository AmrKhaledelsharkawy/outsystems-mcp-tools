/**
 * Session-token providers (S10). ADR-0004 / OSG-015 / OSG-004.
 *
 *  - File mode (`config.tokenFile` set): the hook-saved `token.txt` is the single source; osgraph only
 *    READS it, validates with `listApps`, and NEVER calls `createSessionToken`. Invalid / missing /
 *    empty -> `OsgraphToolError("TOKEN_EXPIRED")`. Mid-run auth failure -> re-read the file once.
 *  - Interactive mode (no token file): OSG-004 — one fresh `createSessionToken` per `acquire()`
 *    (= per rebuild), in memory only; mid-run auth failure -> one re-acquire.
 *
 * The token is never logged and never placed in an error message; `knownTokens()` exists only so the
 * client can redact.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import type { OsgraphConfig } from "../config.js";
import { ServiceStudioClient, TOKEN_EXPIRED_MESSAGE } from "./client.js";
import { unwrapJson } from "./unwrap.js";
import { OsgraphToolError, type ServiceStudioClientOptions, type TokenProvider } from "./types.js";

export interface TokenProviderOptions {
  /** Injectable file reader (tests). Defaults to `fs/promises.readFile(path, "utf8")`. */
  readFile?: (path: string) => Promise<string>;
}

/** ADR-0004: the message is always exactly `TOKEN_EXPIRED_MESSAGE`; the reason goes into `details`. */
function tokenExpired(reason: string, details?: Record<string, unknown>): OsgraphToolError {
  return new OsgraphToolError("TOKEN_EXPIRED", TOKEN_EXPIRED_MESSAGE, { reason, ...details });
}

/**
 * Shares one in-flight promise between concurrent callers so N parallel `callTool()`s with no held
 * token trigger exactly one `createSessionToken` / one `listApps` validation.
 */
class InFlight<T> {
  private pending: Promise<T> | undefined;
  run(start: () => Promise<T>): Promise<T> {
    if (this.pending) return this.pending;
    const p = start().finally(() => {
      if (this.pending === p) this.pending = undefined;
    });
    this.pending = p;
    return p;
  }
}

/** File mode. */
export class FileTokenProvider implements TokenProvider {
  readonly mode = "file" as const;
  private readonly known = new Set<string>();
  private token: string | undefined;
  private readonly inFlight = new InFlight<string>();

  constructor(
    private readonly tokenFile: string,
    private readonly client: ServiceStudioClient,
    private readonly readFile: (path: string) => Promise<string>
  ) {}

  private async readToken(): Promise<string> {
    let raw: string;
    try {
      raw = await this.readFile(this.tokenFile);
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw tokenExpired(`token file not readable: ${this.tokenFile}`, { tokenFile: this.tokenFile, code });
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw tokenExpired(`token file is empty: ${this.tokenFile}`, { tokenFile: this.tokenFile });
    }
    this.known.add(trimmed);
    return trimmed;
  }

  /** Read + validate with `listApps`. Never calls `createSessionToken`. */
  acquire(): Promise<string> {
    return this.inFlight.run(async () => {
      const token = await this.readToken();
      await this.validate(token);
      this.token = token;
      return token;
    });
  }

  private async validate(token: string): Promise<void> {
    try {
      await this.client.listAppsWithToken(token);
    } catch (err) {
      if (err instanceof OsgraphToolError && err.code === "TOKEN_EXPIRED") {
        throw tokenExpired("listApps rejected the token from the token file", {
          tokenFile: this.tokenFile
        });
      }
      throw err; // SERVICESTUDIO_UNREACHABLE etc. propagate unchanged
    }
  }

  current(): string | undefined {
    return this.token;
  }

  /** Re-read the file once (the orchestrator may have refreshed it); no validation call here —
   *  the client's retry of the failed call is the validation. */
  recover(): Promise<string> {
    return this.inFlight.run(async () => {
      this.token = undefined;
      const token = await this.readToken();
      this.token = token;
      return token;
    });
  }

  knownTokens(): ReadonlySet<string> {
    return this.known;
  }

  clear(): void {
    this.token = undefined;
  }
}

/** Interactive mode (OSG-004 original bullets). */
export class InteractiveTokenProvider implements TokenProvider {
  readonly mode = "interactive" as const;
  private readonly known = new Set<string>();
  private token: string | undefined;
  private readonly inFlight = new InFlight<string>();

  constructor(private readonly client: ServiceStudioClient) {}

  acquire(): Promise<string> {
    return this.inFlight.run(async () => {
      this.token = undefined;
      const text = await this.client.callToolRaw(undefined, "createSessionToken", {});
      const token = parseCreateSessionTokenText(text);
      if (token === undefined) {
        throw tokenExpired("createSessionToken returned no token");
      }
      this.known.add(token);
      this.token = token;
      return token;
    });
  }

  current(): string | undefined {
    return this.token;
  }

  recover(): Promise<string> {
    return this.acquire();
  }

  knownTokens(): ReadonlySet<string> {
    return this.known;
  }

  clear(): void {
    this.token = undefined;
  }
}

/**
 * `createSessionToken` text -> token. Live shape unconfirmed; accepts a bare string, or an object with
 * `sessionToken` / `token` / `result` (unwrapped by `unwrapJson`).
 */
export function parseCreateSessionTokenText(text: string): string | undefined {
  const inner = unwrapJson(text);
  if (typeof inner === "string") {
    const t = inner.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof inner === "object" && inner !== null) {
    const obj = inner as Record<string, unknown>;
    for (const key of ["sessionToken", "token"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  return undefined;
}

/**
 * Builds the provider matching the configuration and wires it into `client`.
 * `config.tokenFile` set -> file mode (ADR-0004); otherwise interactive mode (OSG-004).
 */
export function createTokenProvider(
  config: Pick<OsgraphConfig, "tokenFile">,
  client: ServiceStudioClient,
  options: TokenProviderOptions = {}
): TokenProvider {
  const readFile = options.readFile ?? ((p: string) => fsReadFile(p, "utf8"));
  const provider: TokenProvider =
    config.tokenFile !== undefined
      ? new FileTokenProvider(config.tokenFile, client, readFile)
      : new InteractiveTokenProvider(client);
  client.setTokenProvider(provider);
  return provider;
}

/** Convenience: client + provider from the loaded config. */
export function createServiceStudioClient(
  config: Pick<OsgraphConfig, "serviceStudioUrl" | "tokenFile"> & Partial<Pick<OsgraphConfig, "fetchConcurrency">>,
  options: TokenProviderOptions & Omit<ServiceStudioClientOptions, "url" | "tokenProvider"> = {}
): { client: ServiceStudioClient; tokenProvider: TokenProvider } {
  const client = new ServiceStudioClient({
    url: config.serviceStudioUrl,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    transientRetryDelayMs: options.transientRetryDelayMs,
    // OSG-016 / ADR-0013: one gate per process, width `fetchConcurrency`. Undefined keeps the
    // client's own default (4), so a caller that knows nothing about the config is still correct.
    maxConcurrent: options.maxConcurrent ?? config.fetchConcurrency
  });
  const tokenProvider = createTokenProvider(config, client, { readFile: options.readFile });
  return { client, tokenProvider };
}
