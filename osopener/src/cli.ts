#!/usr/bin/env node
import { describeTokenResolution, loadConfig, OsopenerConfigError, type OsopenerConfig } from "./config.js";
import { startServer } from "./server.js";

const EXIT_CONFIG = 2;
const EXIT_FATAL = 1;

function fail(code: number, message: string): never {
  process.stderr.write(`osopener: ${message}\n`);
  process.exit(code);
}

if (process.platform !== "win32" && !process.env.OSOPENER_ALLOW_NON_WINDOWS) {
  fail(EXIT_CONFIG, "PLATFORM_UNSUPPORTED: osopener drives Windows UI Automation and only runs on win32.");
}

let config: OsopenerConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  fail(EXIT_CONFIG, err instanceof OsopenerConfigError ? `${err.code}: ${err.message}` : String(err));
}

// Paths only — the token itself is never written anywhere (ADR-0004).
process.stderr.write("osopener: " + describeTokenResolution(config.token) + "\n");

startServer(config).catch((err: unknown) => {
  fail(EXIT_FATAL, `fatal: ${err instanceof Error ? err.message : String(err)}`);
});
