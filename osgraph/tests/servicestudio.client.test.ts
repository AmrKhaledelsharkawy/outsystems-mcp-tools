import { describe, expect, it } from "vitest";
import {
  isAuthFailure,
  isTransientOmlError,
  redactTokens,
  ServiceStudioClient
} from "../src/servicestudio/client.js";
import { OsgraphToolError, ServiceStudioCallError, type TokenProvider } from "../src/servicestudio/types.js";
import { FakeServiceStudio } from "./servicestudio.fake.js";

const URL = "http://127.0.0.1:41820/mcp";
const TOKEN = "tok-SECRET-0123456789abcdef";
const CODE = "(OutSystems.Model.IReference x) => { }";
const FENCED = "```csharp\n" + CODE + "\n```";

/** Provider that always holds the same token (client tests do not exercise provider logic). */
function staticProvider(token = TOKEN): TokenProvider & { recoveries: number } {
  const known = new Set([token]);
  return {
    mode: "file",
    recoveries: 0,
    acquire: async () => token,
    current: () => token,
    async recover() {
      this.recoveries++;
      return token;
    },
    knownTokens: () => known,
    clear: () => undefined
  };
}

function makeClient(fake: FakeServiceStudio, extra: Partial<ConstructorParameters<typeof ServiceStudioClient>[0]> = {}) {
  return new ServiceStudioClient({
    url: URL,
    fetchImpl: fake.fetch,
    tokenProvider: staticProvider(),
    transientRetryDelayMs: 0,
    ...extra
  });
}

async function catchError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

describe("ServiceStudioClient request shape", () => {
  it("POSTs JSON-RPC tools/call with sessionToken + input, JSON/SSE accept headers", async () => {
    let seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | undefined;
    const fake = new FakeServiceStudio(() => ({ text: FENCED }));
    const spyFetch: typeof fake.fetch = (url, init) => {
      seen = { url, init };
      return fake.fetch(url, init);
    };
    const client = makeClient(fake, { fetchImpl: spyFetch });
    const code = await client.getScreen("demoportal", "Login");
    expect(code).toBe(CODE);
    expect(seen?.url).toBe(URL);
    expect(seen?.init.method).toBe("POST");
    expect(seen?.init.headers["Content-Type"]).toBe("application/json");
    expect(seen?.init.headers.Accept).toBe("application/json, text/event-stream");
    const body = JSON.parse(seen!.init.body) as Record<string, unknown>;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("tools/call");
    expect(body.params).toEqual({
      name: "getScreen",
      arguments: {
        sessionToken: TOKEN,
        input: { eSpaceName: "demoportal", objectName: "Login", includeJson: "Never" }
      }
    });
  });

  it("accepts a plain JSON (non-SSE) response body", async () => {
    const fake = new FakeServiceStudio(() => ({ text: FENCED, sse: false }));
    expect(await makeClient(fake).getDataModel("m")).toBe(CODE);
  });
});

describe("ServiceStudioClient typed helpers + envelopes", () => {
  it("getStructures unwraps the {result: fenced} envelope; getScreen unwraps raw fenced code", async () => {
    const fake = new FakeServiceStudio((call) =>
      call.name === "getStructures" ? { text: JSON.stringify({ result: FENCED }) } : { text: FENCED }
    );
    const client = makeClient(fake);
    expect(await client.getStructures("m")).toBe(CODE);
    expect(await client.getScreen("m", "S")).toBe(CODE);
    expect(fake.toolCalls("getStructures")[0]?.input).toEqual({ eSpaceName: "m", includeJson: "Never" });
  });

  it("names tools parse the JSON-encoded array string inside result", async () => {
    const envelope =
      '{"result":"[{\\"Name\\":\\"Login\\",\\"Description\\":\\"\\",\\"UIFlow\\":\\"Login\\",\\"IsReferenced\\":false}]"}';
    const fake = new FakeServiceStudio(() => ({ text: envelope }));
    const client = makeClient(fake);
    const screens = await client.getScreenNames("m");
    expect(screens).toEqual([{ Name: "Login", Description: "", UIFlow: "Login", IsReferenced: false }]);
    const actions = await client.getActionNames("m", "server");
    expect(actions[0]?.Name).toBe("Login");
    expect(fake.toolCalls("getActionNames")[0]?.input).toEqual({ eSpaceName: "m", objectType: "server" });
    await client.getWebBlockNamesTraditional("m");
    expect(fake.toolCalls("getWebBlockNamesTraditional")[0]?.input).toEqual({ eSpaceName: "m" });
  });

  it("listApps returns the parsed apps array", async () => {
    const fake = new FakeServiceStudio(() => ({
      text: JSON.stringify({ apps: [{ key: "k", name: "x", isOpen: true }] })
    }));
    const apps = await makeClient(fake).listApps();
    expect(apps).toEqual([{ key: "k", name: "x", isOpen: true }]);
    expect(fake.toolCalls("listApps")[0]?.input).toEqual({});
  });

  it("unparseable tool text -> ServiceStudioCallError (element-level, not transient)", async () => {
    const fake = new FakeServiceStudio(() => ({ text: "not an array" }));
    const err = await catchError(makeClient(fake).getScreenNames("m"));
    expect(err).toBeInstanceOf(ServiceStudioCallError);
    expect((err as ServiceStudioCallError).transient).toBe(false);
    expect((err as ServiceStudioCallError).toolName).toBe("getScreenNames");
  });

  it("callTool is generic: any tool name/input is forwarded", async () => {
    const fake = new FakeServiceStudio(() => ({ text: "ok" }));
    expect(await makeClient(fake).callTool("getRoleNames", { eSpaceName: "m" })).toBe("ok");
    expect(fake.calls[0]?.name).toBe("getRoleNames");
  });
});

describe("ServiceStudioClient serialization (maxConcurrent: 1)", () => {
  it("the second call does not start until the first has settled", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const fake = new FakeServiceStudio(async (call) => {
      if (call.name === "getScreenNames") await firstGate;
      return { text: call.name === "getScreenNames" ? '{"result":"[]"}' : FENCED };
    });
    const client = makeClient(fake, { maxConcurrent: 1 });

    const p1 = client.getScreenNames("m");
    const p2 = client.getDataModel("m");
    // Let microtasks run: the first request is in flight and blocked on the gate.
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.calls.map((c) => c.name)).toEqual(["getScreenNames"]);

    releaseFirst!();
    await Promise.all([p1, p2]);
    expect(fake.calls.map((c) => c.name)).toEqual(["getScreenNames", "getDataModel"]);
    expect(fake.maxInFlight).toBe(1);
    expect(fake.calls[1]!.startedAt).toBeGreaterThan(fake.calls[0]!.finishedAt!);
  });

  it("a failing call does not block the queue for the next one", async () => {
    const fake = new FakeServiceStudio((call) =>
      call.name === "getScreen" ? { rpcError: { code: -32602, message: "bad input" } } : { text: FENCED }
    );
    const client = makeClient(fake, { maxConcurrent: 1 });
    const [r1, r2] = await Promise.allSettled([client.getScreen("m", "S"), client.getDataModel("m")]);
    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("fulfilled");
    expect(fake.maxInFlight).toBe(1);
  });
});

// Width 4 is the server's measured admission limit on build 11.55.94.65328: widths 1-4 all finish in
// ~11.5 s, a 5th caller waits a whole wave. Live evidence + sweep:
// docs/discovery/2026-10-31-mcp-read-concurrency.md sections 3.2 / 6.2.
describe("ServiceStudioClient bounded concurrency", () => {
  /** A fake whose calls all block until released, so in-flight counts are observable. */
  function gatedFake() {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = new FakeServiceStudio(async () => {
      await gate;
      return { text: FENCED };
    });
    return { fake, release: () => release!() };
  }

  it("defaults to 4 in flight and no more", async () => {
    const { fake, release } = gatedFake();
    const client = makeClient(fake);
    const all = Array.from({ length: 10 }, () => client.getDataModel("m"));
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.inFlight).toBe(4);
    release();
    await Promise.all(all);
    expect(fake.maxInFlight).toBe(4);
    expect(fake.calls).toHaveLength(10);
  });

  it("honours an explicit maxConcurrent", async () => {
    const { fake, release } = gatedFake();
    const client = makeClient(fake, { maxConcurrent: 2 });
    const all = Array.from({ length: 6 }, () => client.getDataModel("m"));
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.inFlight).toBe(2);
    release();
    await Promise.all(all);
    expect(fake.maxInFlight).toBe(2);
  });

  it("a rejected call frees its slot (no permit leak)", async () => {
    const fake = new FakeServiceStudio((call) =>
      call.name === "getScreen" ? { rpcError: { code: -32602, message: "bad input" } } : { text: FENCED }
    );
    const client = makeClient(fake);
    // More failures than the pool width: a leaked permit would deadlock the later calls.
    const failures = Array.from({ length: 8 }, () => client.getScreen("m", "S"));
    const results = await Promise.allSettled(failures);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(await client.getDataModel("m")).toBe(CODE);
    expect(fake.maxInFlight).toBeLessThanOrEqual(4);
  });

  it("admits waiters in FIFO order", async () => {
    const { fake, release } = gatedFake();
    const client = makeClient(fake, { maxConcurrent: 1 });
    const names = ["getDataModel", "getStructures", "getScreenNames"] as const;
    const all = [client.getDataModel("m"), client.getStructures("m"), client.getScreenNames("m")];
    release();
    await Promise.allSettled(all);
    expect(fake.calls.map((c) => c.name)).toEqual([...names]);
  });

  // The drain barrier exists for one reason: closing a module while reads for it are still QUEUED is
  // the only combination that reproduced the ADR-0007 temp-OML teardown error (section 8.2/8.3).
  // Callers must await drain() before driving osopener closeModule.
  describe("drain()", () => {
    it("resolves only after every in-flight and queued call has settled", async () => {
      const { fake, release } = gatedFake();
      const client = makeClient(fake);
      const all = Array.from({ length: 9 }, () => client.getDataModel("m"));
      let drained = false;
      const barrier = client.drain().then(() => (drained = true));
      await new Promise((r) => setTimeout(r, 5));
      expect(drained).toBe(false);
      expect(fake.calls.length).toBeLessThan(9);

      release();
      await barrier;
      expect(drained).toBe(true);
      expect(fake.calls).toHaveLength(9);
      expect(fake.inFlight).toBe(0);
      await Promise.all(all);
    });

    it("resolves immediately when the client is idle", async () => {
      const fake = new FakeServiceStudio(() => ({ text: FENCED }));
      await makeClient(fake).drain();
      expect(fake.calls).toHaveLength(0);
    });

    it("waits for rejected calls too, and does not reject itself", async () => {
      const fake = new FakeServiceStudio(() => ({ rpcError: { code: -32602, message: "bad input" } }));
      const client = makeClient(fake);
      const failures = Array.from({ length: 6 }, () => client.getScreen("m", "S"));
      await expect(client.drain()).resolves.toBeUndefined();
      expect(fake.inFlight).toBe(0);
      expect(fake.calls).toHaveLength(6);
      await Promise.allSettled(failures);
    });
  });
});

describe("ServiceStudioClient transient retry (ADR-0007)", () => {
  const OML = { code: -32000, message: "OML not found: C:\\Users\\x\\ServiceStudio.MCPServer\\abc-in.oml" };

  it("retries 'OML not found' exactly once, then fails with a transient ServiceStudioCallError", async () => {
    const fake = new FakeServiceStudio(() => ({ rpcError: OML }));
    const err = await catchError(makeClient(fake).getDataModel("m"));
    expect(err).toBeInstanceOf(ServiceStudioCallError);
    const e = err as ServiceStudioCallError;
    expect(e.transient).toBe(true);
    expect(e.rpcCode).toBe(-32000);
    expect(e.message).toMatch(/retried once/);
    expect(fake.toolCalls("getDataModel")).toHaveLength(2);
  });

  it("succeeds when the retry succeeds", async () => {
    const fake = new FakeServiceStudio((_call, attempt) => (attempt === 1 ? { rpcError: OML } : { text: FENCED }));
    expect(await makeClient(fake).getDataModel("m")).toBe(CODE);
    expect(fake.toolCalls("getDataModel")).toHaveLength(2);
  });

  it("does NOT retry other -32000 errors (OSG-011 is the caller's job)", async () => {
    const fake = new FakeServiceStudio(() => ({ rpcError: { code: -32000, message: "Object 'Nope' not found" } }));
    const err = await catchError(makeClient(fake).getScreen("m", "Nope"));
    expect(err).toBeInstanceOf(ServiceStudioCallError);
    expect((err as ServiceStudioCallError).transient).toBe(false);
    expect(fake.toolCalls("getScreen")).toHaveLength(1);
  });

  it("tool result with isError -> ServiceStudioCallError carrying the server text", async () => {
    const fake = new FakeServiceStudio(() => ({ text: "Screen 'Nope' does not exist", isError: true }));
    const err = await catchError(makeClient(fake).getScreen("m", "Nope"));
    expect(err).toBeInstanceOf(ServiceStudioCallError);
    expect((err as ServiceStudioCallError).serverText).toBe("Screen 'Nope' does not exist");
  });

  it("isTransientOmlError matches only the OML signature", () => {
    expect(isTransientOmlError(-32000, "OML not found: x.oml")).toBe(true);
    expect(isTransientOmlError(-32000, "something else")).toBe(false);
    expect(isTransientOmlError(-32601, "OML not found")).toBe(false);
  });

  // The message ADR-0007 recorded ("OML not found") is NOT what 11.55.94.65328 actually returns.
  // Captured live 2026-10-31 while a module was closed with reads still queued
  // (docs/discovery/2026-10-31-mcp-read-concurrency.md section 8.2). Before this, `isTransient` was
  // false for the one error it exists for, so the retry never fired and ADR-0011 aborted the rebuild.
  it("isTransientOmlError matches the live 'Could not find file' signature", () => {
    const live =
      "An error occurred invoking 'getDataModel': [-32000] Could not find file " +
      "'C:\\Users\\LENOVO\\AppData\\Local\\Temp\\ServiceStudio.MCPServer\\3ad971ac399b44aa8125e4c520d3f27e-in.oml'.";
    expect(isTransientOmlError(-32000, live)).toBe(true);
    expect(isTransientOmlError(undefined, live)).toBe(true);
    // Same teardown shape for any tool and any guid.
    expect(
      isTransientOmlError(-32000, "Could not find file 'C:\\T\\ServiceStudio.MCPServer\\abc-in.oml'.")
    ).toBe(true);
    // Not transient: a missing file that is not a ServiceStudio temp OML, and the wrong rpc code.
    expect(isTransientOmlError(-32000, "Could not find file 'C:\\data\\report.csv'.")).toBe(false);
    expect(isTransientOmlError(-32601, "Could not find file 'x-in.oml'")).toBe(false);
  });

  // The honest, non-racy answer when the module really is gone: fail fast, do NOT retry.
  it("isTransientOmlError does not match 'No module is currently open'", () => {
    expect(
      isTransientOmlError(-32000, "No module is currently open in Service Studio.")
    ).toBe(false);
  });
});

describe("ServiceStudioClient transport failures", () => {
  it("fetch rejection (ECONNREFUSED) -> OsgraphToolError SERVICESTUDIO_UNREACHABLE", async () => {
    const fake = new FakeServiceStudio(() => ({ throwError: new TypeError("fetch failed: ECONNREFUSED") }));
    const err = await catchError(makeClient(fake).listApps());
    expect(err).toBeInstanceOf(OsgraphToolError);
    expect((err as OsgraphToolError).code).toBe("SERVICESTUDIO_UNREACHABLE");
    expect((err as OsgraphToolError).message).toContain(URL);
  });

  it("timeout -> SERVICESTUDIO_UNREACHABLE with timedOut details", async () => {
    const fake = new FakeServiceStudio(() => ({ hang: true }));
    const client = makeClient(fake, { timeoutMs: 20 });
    const err = await catchError(client.listApps());
    expect((err as OsgraphToolError).code).toBe("SERVICESTUDIO_UNREACHABLE");
    expect(((err as OsgraphToolError).details as { timedOut: boolean }).timedOut).toBe(true);
  });

  it("HTTP 500 -> SERVICESTUDIO_UNREACHABLE (not an element-level error)", async () => {
    const fake = new FakeServiceStudio(() => ({ status: 500, rawBody: "oops" }));
    const err = await catchError(makeClient(fake).listApps());
    expect((err as OsgraphToolError).code).toBe("SERVICESTUDIO_UNREACHABLE");
  });

  it("unparseable body -> ServiceStudioCallError", async () => {
    const fake = new FakeServiceStudio(() => ({ rawBody: "<html>nope</html>" }));
    const err = await catchError(makeClient(fake).listApps());
    expect(err).toBeInstanceOf(ServiceStudioCallError);
  });
});

describe("ServiceStudioClient auth handling + redaction", () => {
  it("auth-class JSON-RPC error -> provider.recover() once, then retry; still failing -> TOKEN_EXPIRED", async () => {
    const fake = new FakeServiceStudio(() => ({
      rpcError: { code: -32000, message: `Unauthorized: session token ${TOKEN} was not issued by this server` }
    }));
    const provider = staticProvider();
    const client = makeClient(fake, { tokenProvider: provider });
    const err = await catchError(client.getDataModel("m"));
    expect(err).toBeInstanceOf(OsgraphToolError);
    const e = err as OsgraphToolError;
    expect(e.code).toBe("TOKEN_EXPIRED");
    expect(e.message).toBe("session token invalid; a human must approve a new one in Service Studio");
    expect(provider.recoveries).toBe(1);
    expect(fake.toolCalls("getDataModel")).toHaveLength(2);
    // Redaction: the token never appears anywhere on the thrown error.
    const dump = JSON.stringify({ message: e.message, details: e.details, stack: e.stack });
    expect(dump).not.toContain(TOKEN);
    expect(JSON.stringify(e.details)).toContain("[redacted]");
  });

  it("HTTP 401/403 count as auth failures", async () => {
    const fake = new FakeServiceStudio(() => ({ status: 401, rawBody: "" }));
    const provider = staticProvider();
    const err = await catchError(makeClient(fake, { tokenProvider: provider }).listApps());
    expect((err as OsgraphToolError).code).toBe("TOKEN_EXPIRED");
    expect((err as OsgraphToolError).message).toBe("session token invalid; a human must approve a new one in Service Studio");
    expect(provider.recoveries).toBe(1);
  });

  it("redacts the token in element-level errors too", async () => {
    const fake = new FakeServiceStudio(() => ({
      rpcError: { code: -32000, message: `OML not found for ${TOKEN}` }
    }));
    const err = (await catchError(makeClient(fake).getDataModel("m"))) as ServiceStudioCallError;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");
    expect(err.serverText).not.toContain(TOKEN);
  });

  it("redact()/redactTokens replace every occurrence and ignore empty tokens", () => {
    expect(redactTokens(`a ${TOKEN} b ${TOKEN}`, [TOKEN, ""])).toBe("a [redacted] b [redacted]");
    const client = makeClient(new FakeServiceStudio(() => ({ text: "" })));
    expect(client.redact(`x=${TOKEN}`)).toBe("x=[redacted]");
  });

  it("isAuthFailure matcher (single adjustable place)", () => {
    expect(isAuthFailure({ httpStatus: 403 })).toBe(true);
    expect(isAuthFailure({ message: "Invalid session token" })).toBe(true);
    expect(isAuthFailure({ message: "unauthorised" })).toBe(true);
    expect(isAuthFailure({ message: "OML not found" })).toBe(false);
    expect(isAuthFailure({ httpStatus: 200, message: "ok" })).toBe(false);
  });

  it("callTool without a provider -> TOKEN_EXPIRED, no network call", async () => {
    const fake = new FakeServiceStudio(() => ({ text: "" }));
    const client = new ServiceStudioClient({ url: URL, fetchImpl: fake.fetch });
    const err = await catchError(client.listApps());
    expect((err as OsgraphToolError).code).toBe("TOKEN_EXPIRED");
    expect((err as OsgraphToolError).message).toBe("session token invalid; a human must approve a new one in Service Studio");
    expect(fake.calls).toHaveLength(0);
  });
});
