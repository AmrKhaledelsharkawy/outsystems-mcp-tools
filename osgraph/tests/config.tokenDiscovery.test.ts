/**
 * Token-file discovery in `loadConfig`: with `OSGRAPH_SERVICESTUDIO_TOKEN_FILE` unset, the config
 * finds `token.txt` by searching up from the working directory - the same rule `osgraph doctor`
 * uses - so `osgraph run` reads the saved token instead of asking a human for a new session.
 * Temp directories and synthetic token values only; no Service Studio, no network.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveTokenFile } from "../src/doctor/token.js";
import { ServiceStudioClient } from "../src/servicestudio/client.js";
import { createTokenProvider } from "../src/servicestudio/token.js";
import { FakeServiceStudio, listAppsReply, type RecordedCall } from "./servicestudio.fake.js";

const URL = "http://127.0.0.1:41820/mcp";
const TOKEN = "synthetic-token-value-0042";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `<root>/token.txt` plus a nested working directory `<root>/a/b/c`. */
function workspace(withToken: boolean): { root: string; work: string; tokenPath: string } {
  const root = mkdtempSync(join(tmpdir(), "osgraph-tokdisc-"));
  dirs.push(root);
  const work = join(root, "a", "b", "c");
  mkdirSync(work, { recursive: true });
  const tokenPath = join(root, "token.txt");
  if (withToken) writeFileSync(tokenPath, `${TOKEN}\n`);
  return { root, work, tokenPath };
}

/** Real fs, but nothing above the temp root counts - keeps the test independent of the machine. */
function existsUnder(root: string, real: (p: string) => boolean) {
  return (p: string): boolean => p.startsWith(root) && real(p);
}

describe("loadConfig: token file discovery", () => {
  it("finds token.txt above a nested working directory when the env var is unset", async () => {
    const { existsSync } = await import("node:fs");
    const ws = workspace(true);
    const cfg = loadConfig({ OSGRAPH_SERVICESTUDIO_URL: URL }, { cwd: ws.work, existsSync: existsUnder(ws.root, existsSync) });
    expect(cfg.tokenFile).toBe(ws.tokenPath);
  });

  it("an explicitly configured, existing file wins over a discovered one", async () => {
    const { existsSync } = await import("node:fs");
    const ws = workspace(true);
    const explicit = join(ws.root, "a", "explicit-token.txt");
    writeFileSync(explicit, TOKEN);
    const cfg = loadConfig(
      { OSGRAPH_SERVICESTUDIO_URL: URL, OSGRAPH_SERVICESTUDIO_TOKEN_FILE: explicit },
      { cwd: ws.work, existsSync: existsUnder(ws.root, existsSync) }
    );
    expect(cfg.tokenFile).toBe(explicit);
  });

  it("no token.txt anywhere -> tokenFile undefined (interactive mode)", async () => {
    const { existsSync } = await import("node:fs");
    const ws = workspace(false);
    const cfg = loadConfig({ OSGRAPH_SERVICESTUDIO_URL: URL }, { cwd: ws.work, existsSync: existsUnder(ws.root, existsSync) });
    expect(cfg.tokenFile).toBeUndefined();
    const client = new ServiceStudioClient({ url: URL, fetchImpl: new FakeServiceStudio(() => ({ text: "{}" })).fetch });
    expect(createTokenProvider(cfg, client, { log: () => {} }).mode).toBe("interactive");
  });

  it("doctor's resolver and the config pick the same file", async () => {
    const { existsSync } = await import("node:fs");
    const ws = workspace(true);
    const exists = existsUnder(ws.root, existsSync);
    const env = { OSGRAPH_SERVICESTUDIO_URL: URL };
    const cfg = loadConfig(env, { cwd: ws.work, existsSync: exists });
    expect(resolveTokenFile(env, { cwd: ws.work, exists }).path).toBe(cfg.tokenFile);
  });

  it("a discovered file means FILE mode: reads it, validates with listApps, never calls createSessionToken, logs the path only", async () => {
    const { existsSync } = await import("node:fs");
    const ws = workspace(true);
    const cfg = loadConfig({ OSGRAPH_SERVICESTUDIO_URL: URL }, { cwd: ws.work, existsSync: existsUnder(ws.root, existsSync) });
    const fake = new FakeServiceStudio((call: RecordedCall) => listAppsReply(call, TOKEN) ?? { text: "{}" });
    const client = new ServiceStudioClient({ url: URL, fetchImpl: fake.fetch });
    const lines: string[] = [];
    const provider = createTokenProvider(cfg, client, { log: (l) => lines.push(l) });
    expect(provider.mode).toBe("file");
    await expect(provider.acquire()).resolves.toBe(TOKEN);
    expect(fake.calls.map((c) => c.name)).not.toContain("createSessionToken");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ws.tokenPath);
    expect(lines[0]).not.toContain(TOKEN);
  });

  it("an invalid discovered file still fails TOKEN_EXPIRED - no silent interactive fallback", async () => {
    const { existsSync } = await import("node:fs");
    const ws = workspace(true);
    const cfg = loadConfig({ OSGRAPH_SERVICESTUDIO_URL: URL }, { cwd: ws.work, existsSync: existsUnder(ws.root, existsSync) });
    const fake = new FakeServiceStudio((call: RecordedCall) => listAppsReply(call, "some-other-token") ?? { text: "{}" });
    const client = new ServiceStudioClient({ url: URL, fetchImpl: fake.fetch });
    const provider = createTokenProvider(cfg, client, { log: () => {} });
    await expect(provider.acquire()).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
    expect(fake.calls.map((c) => c.name)).not.toContain("createSessionToken");
  });
});
