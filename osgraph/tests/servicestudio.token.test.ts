import { describe, expect, it } from "vitest";
import { ServiceStudioClient } from "../src/servicestudio/client.js";
import {
  createServiceStudioClient,
  createTokenProvider,
  FileTokenProvider,
  InteractiveTokenProvider,
  parseCreateSessionTokenText
} from "../src/servicestudio/token.js";
import { OsgraphToolError } from "../src/servicestudio/types.js";
import { FakeServiceStudio, listAppsReply, type FakeReply, type RecordedCall } from "./servicestudio.fake.js";

const URL = "http://127.0.0.1:41820/mcp";
const TOKEN_FILE = "C:\\work\\proj\\token.txt";
const OLD = "tok-OLD-aaaaaaaaaaaaaaaa";
const NEW = "tok-NEW-bbbbbbbbbbbbbbbb";
const FENCED = "```csharp\n(x) => { }\n```";
const MSG = "session token invalid; a human must approve a new one in Service Studio";

/** A mutable fake token file. */
function fakeFile(initial: string | undefined) {
  const state = { content: initial, reads: 0 };
  const readFile = async (path: string): Promise<string> => {
    state.reads++;
    expect(path).toBe(TOKEN_FILE);
    if (state.content === undefined) {
      const err = new Error("ENOENT: no such file") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    }
    return state.content;
  };
  return { state, readFile };
}

function authError(): FakeReply {
  return { rpcError: { code: -32000, message: "Invalid session token" } };
}

/** Handler: listApps + read tools accept `valid` tokens; everything else is an auth error. */
function serverAccepting(valid: () => string) {
  return (call: RecordedCall): FakeReply => {
    const la = listAppsReply(call, valid());
    if (la) return la;
    if (call.name === "createSessionToken") return { text: JSON.stringify({ sessionToken: NEW }) };
    return call.sessionToken === valid() ? { text: FENCED } : authError();
  };
}

async function catchError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function setup(tokenFile: string | undefined, fileContent: string | undefined, handler: (c: RecordedCall) => FakeReply) {
  const fake = new FakeServiceStudio(handler);
  const file = fakeFile(fileContent);
  const client = new ServiceStudioClient({ url: URL, fetchImpl: fake.fetch, transientRetryDelayMs: 0 });
  const provider = createTokenProvider({ tokenFile }, client, { readFile: file.readFile });
  return { fake, file, client, provider };
}

describe("createTokenProvider mode selection", () => {
  it("tokenFile set -> file mode; unset -> interactive mode; provider is wired into the client", () => {
    const a = setup(TOKEN_FILE, OLD, () => ({ text: "" }));
    expect(a.provider).toBeInstanceOf(FileTokenProvider);
    expect(a.provider.mode).toBe("file");
    expect(a.client.getTokenProvider()).toBe(a.provider);
    const b = setup(undefined, undefined, () => ({ text: "" }));
    expect(b.provider).toBeInstanceOf(InteractiveTokenProvider);
    expect(b.provider.mode).toBe("interactive");
  });

  it("createServiceStudioClient builds both from config", () => {
    const fake = new FakeServiceStudio(() => ({ text: "" }));
    const { client, tokenProvider } = createServiceStudioClient(
      { serviceStudioUrl: URL, tokenFile: undefined },
      { fetchImpl: fake.fetch }
    );
    expect(client.url).toBe(URL);
    expect(tokenProvider.mode).toBe("interactive");
  });
});

describe("file mode (ADR-0004 / OSG-015)", () => {
  it("acquire() reads + trims the file, validates with listApps, NEVER calls createSessionToken", async () => {
    const { fake, file, provider } = setup(TOKEN_FILE, `  ${OLD}\r\n`, serverAccepting(() => OLD));
    const token = await provider.acquire();
    expect(token).toBe(OLD);
    expect(file.state.reads).toBe(1);
    expect(fake.calls.map((c) => c.name)).toEqual(["listApps"]);
    expect(fake.calls[0]?.sessionToken).toBe(OLD);
    expect(fake.toolCalls("createSessionToken")).toHaveLength(0);
    expect(provider.current()).toBe(OLD);
  });

  it("missing file -> TOKEN_EXPIRED with the mandated message, no network call", async () => {
    const { fake, provider } = setup(TOKEN_FILE, undefined, serverAccepting(() => OLD));
    const err = (await catchError(provider.acquire())) as OsgraphToolError;
    expect(err).toBeInstanceOf(OsgraphToolError);
    expect(err.code).toBe("TOKEN_EXPIRED");
    expect(err.message).toBe(MSG);
    expect(fake.calls).toHaveLength(0);
  });

  it("empty/whitespace file -> TOKEN_EXPIRED, no network call", async () => {
    const { fake, provider } = setup(TOKEN_FILE, "  \n", serverAccepting(() => OLD));
    const err = (await catchError(provider.acquire())) as OsgraphToolError;
    expect(err.code).toBe("TOKEN_EXPIRED");
    expect(err.message).toBe(MSG);
    expect(fake.calls).toHaveLength(0);
  });

  it("listApps rejects the token -> TOKEN_EXPIRED; still no createSessionToken", async () => {
    const { fake, provider } = setup(TOKEN_FILE, OLD, serverAccepting(() => NEW));
    const err = (await catchError(provider.acquire())) as OsgraphToolError;
    expect(err.code).toBe("TOKEN_EXPIRED");
    expect(err.message).toBe(MSG);
    expect((err.details as { reason: string }).reason).toMatch(/listApps rejected/);
    expect(fake.toolCalls("listApps")).toHaveLength(1);
    expect(fake.toolCalls("createSessionToken")).toHaveLength(0);
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(OLD);
    expect(provider.current()).toBeUndefined();
  });

  it("unreachable server during validation -> SERVICESTUDIO_UNREACHABLE (not TOKEN_EXPIRED)", async () => {
    const { provider } = setup(TOKEN_FILE, OLD, () => ({ throwError: new TypeError("ECONNREFUSED") }));
    const err = (await catchError(provider.acquire())) as OsgraphToolError;
    expect(err.code).toBe("SERVICESTUDIO_UNREACHABLE");
  });

  it("mid-run auth failure: re-reads the file ONCE and retries that call with the refreshed token", async () => {
    let valid = OLD;
    const { fake, file, client, provider } = setup(TOKEN_FILE, OLD, serverAccepting(() => valid));
    await provider.acquire();
    expect(file.state.reads).toBe(1);

    // Studio restarted + orchestrator re-approved: server now only accepts NEW, file now holds NEW.
    valid = NEW;
    file.state.content = NEW;

    const code = await client.getDataModel("m");
    expect(code).toBe("(x) => { }");
    expect(file.state.reads).toBe(2);
    const dm = fake.toolCalls("getDataModel");
    expect(dm).toHaveLength(2);
    expect(dm[0]?.sessionToken).toBe(OLD);
    expect(dm[1]?.sessionToken).toBe(NEW);
    expect(provider.current()).toBe(NEW);
    expect(fake.toolCalls("createSessionToken")).toHaveLength(0);
  });

  it("mid-run auth failure with an unchanged file -> one re-read, one retry, then TOKEN_EXPIRED", async () => {
    let valid = OLD;
    const { fake, file, client } = setup(TOKEN_FILE, OLD, serverAccepting(() => valid));
    await client.getTokenProvider()!.acquire();
    valid = NEW; // Studio restarted; nobody refreshed the file.

    const err = (await catchError(client.getScreen("m", "Login"))) as OsgraphToolError;
    expect(err).toBeInstanceOf(OsgraphToolError);
    expect(err.code).toBe("TOKEN_EXPIRED");
    expect(err.message).toBe(MSG);
    expect(file.state.reads).toBe(2);
    expect(fake.toolCalls("getScreen")).toHaveLength(2);
    expect(fake.toolCalls("createSessionToken")).toHaveLength(0);
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(OLD);
  });

  it("mid-run: file became empty -> TOKEN_EXPIRED without a retry call", async () => {
    let valid = OLD;
    const { fake, file, client } = setup(TOKEN_FILE, OLD, serverAccepting(() => valid));
    await client.getTokenProvider()!.acquire();
    valid = NEW;
    file.state.content = "";
    const err = (await catchError(client.getScreen("m", "Login"))) as OsgraphToolError;
    expect(err.code).toBe("TOKEN_EXPIRED");
    expect(err.message).toBe(MSG);
    expect(fake.toolCalls("getScreen")).toHaveLength(1);
  });

  it("clear() drops the in-memory token; next call re-acquires (validates again)", async () => {
    const { fake, client, provider } = setup(TOKEN_FILE, OLD, serverAccepting(() => OLD));
    await provider.acquire();
    provider.clear();
    expect(provider.current()).toBeUndefined();
    await client.getDataModel("m");
    expect(fake.calls.map((c) => c.name)).toEqual(["listApps", "listApps", "getDataModel"]);
  });
});

describe("interactive mode (OSG-004)", () => {
  it("acquire() calls createSessionToken without a sessionToken and keeps the token in memory", async () => {
    const { fake, provider } = setup(undefined, undefined, serverAccepting(() => NEW));
    const token = await provider.acquire();
    expect(token).toBe(NEW);
    expect(fake.calls.map((c) => c.name)).toEqual(["createSessionToken"]);
    expect(fake.calls[0]?.sessionToken).toBeUndefined();
    expect(fake.calls[0]?.input).toEqual({});
    expect(provider.current()).toBe(NEW);
  });

  it("every acquire() is a fresh createSessionToken (per rebuild)", async () => {
    const { fake, provider } = setup(undefined, undefined, serverAccepting(() => NEW));
    await provider.acquire();
    await provider.acquire();
    expect(fake.toolCalls("createSessionToken")).toHaveLength(2);
  });

  it("mid-run auth failure -> one re-acquire then retry; success", async () => {
    let issued = 0;
    const fake = new FakeServiceStudio((call) => {
      if (call.name === "createSessionToken") {
        issued++;
        return { text: issued === 1 ? OLD : NEW };
      }
      return call.sessionToken === NEW ? { text: FENCED } : authError();
    });
    const client = new ServiceStudioClient({ url: URL, fetchImpl: fake.fetch, transientRetryDelayMs: 0 });
    const provider = createTokenProvider({ tokenFile: undefined }, client);
    await provider.acquire(); // -> OLD
    expect(await client.getDataModel("m")).toBe("(x) => { }");
    expect(fake.toolCalls("createSessionToken")).toHaveLength(2);
    expect(fake.toolCalls("getDataModel").map((c) => c.sessionToken)).toEqual([OLD, NEW]);
  });

  it("mid-run auth failure -> one re-acquire then abort with TOKEN_EXPIRED", async () => {
    const fake = new FakeServiceStudio((call) =>
      call.name === "createSessionToken" ? { text: OLD } : authError()
    );
    const client = new ServiceStudioClient({ url: URL, fetchImpl: fake.fetch, transientRetryDelayMs: 0 });
    createTokenProvider({ tokenFile: undefined }, client);
    const err = (await catchError(client.getDataModel("m"))) as OsgraphToolError;
    expect(err.code).toBe("TOKEN_EXPIRED");
    expect(err.message).toBe(MSG);
    expect(fake.toolCalls("createSessionToken")).toHaveLength(2);
    expect(fake.toolCalls("getDataModel")).toHaveLength(2);
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(OLD);
  });

  it("createSessionToken returning no token -> TOKEN_EXPIRED", async () => {
    const { provider } = setup(undefined, undefined, () => ({ text: "" }));
    const err = (await catchError(provider.acquire())) as OsgraphToolError;
    expect(err.code).toBe("TOKEN_EXPIRED");
    expect(err.message).toBe(MSG);
  });

  it("parseCreateSessionTokenText accepts bare, {sessionToken}, {token} and {result:...} shapes", () => {
    expect(parseCreateSessionTokenText(" abc ")).toBe("abc");
    expect(parseCreateSessionTokenText('{"sessionToken":"abc"}')).toBe("abc");
    expect(parseCreateSessionTokenText('{"token":"abc"}')).toBe("abc");
    expect(parseCreateSessionTokenText('{"result":"abc"}')).toBe("abc");
    expect(parseCreateSessionTokenText('{"result":{"sessionToken":"abc"}}')).toBe("abc");
    expect(parseCreateSessionTokenText("")).toBeUndefined();
    expect(parseCreateSessionTokenText('{"other":1}')).toBeUndefined();
  });
});

describe("concurrent acquisition is deduplicated", () => {
  it("interactive: 3 concurrent callTool() with no held token -> exactly 1 createSessionToken", async () => {
    const fake = new FakeServiceStudio((call) =>
      call.name === "createSessionToken" ? { text: NEW } : call.sessionToken === NEW ? { text: FENCED } : authError()
    );
    const client = new ServiceStudioClient({ url: URL, fetchImpl: fake.fetch, transientRetryDelayMs: 0 });
    createTokenProvider({ tokenFile: undefined }, client);
    const results = await Promise.all([client.getDataModel("a"), client.getDataModel("b"), client.getDataModel("c")]);
    expect(results).toEqual(["(x) => { }", "(x) => { }", "(x) => { }"]);
    expect(fake.toolCalls("createSessionToken")).toHaveLength(1);
    expect(fake.toolCalls("getDataModel")).toHaveLength(3);
  });

  it("file mode: 3 concurrent callTool() with no held token -> exactly 1 listApps validation", async () => {
    const { fake, file, client } = setup(TOKEN_FILE, OLD, serverAccepting(() => OLD));
    await Promise.all([client.getDataModel("a"), client.getDataModel("b"), client.getDataModel("c")]);
    expect(fake.toolCalls("listApps")).toHaveLength(1);
    expect(file.state.reads).toBe(1);
    expect(fake.toolCalls("getDataModel")).toHaveLength(3);
  });

  it("file mode: concurrent recover() calls share one re-read", async () => {
    let valid = OLD;
    const { fake, file, client: _client, provider } = setup(TOKEN_FILE, OLD, serverAccepting(() => valid));
    await provider.acquire();
    valid = NEW;
    file.state.content = NEW;
    await Promise.all([provider.recover(), provider.recover()]);
    expect(file.state.reads).toBe(2);
    expect(provider.current()).toBe(NEW);
    expect(fake.toolCalls("createSessionToken")).toHaveLength(0);
  });

  it("createServiceStudioClient passes timeoutMs / transientRetryDelayMs through (OML retry runs with 0 ms delay)", async () => {
    const fake = new FakeServiceStudio((call, attempt) => {
      if (call.name === "createSessionToken") return { text: NEW };
      return attempt === 1
        ? { rpcError: { code: -32000, message: "OML not found: x-in.oml" } }
        : { text: FENCED };
    });
    const { client } = createServiceStudioClient(
      { serviceStudioUrl: URL, tokenFile: undefined },
      { fetchImpl: fake.fetch, transientRetryDelayMs: 0, timeoutMs: 5000 }
    );
    const started = Date.now();
    expect(await client.getDataModel("m")).toBe("(x) => { }");
    expect(Date.now() - started).toBeLessThan(200);
    expect(fake.toolCalls("getDataModel")).toHaveLength(2);
  });
});
