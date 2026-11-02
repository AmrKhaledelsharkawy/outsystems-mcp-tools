/**
 * Spawns `scripts/studio-ui.ps1` once per step (OSG-014 §1): a hung UIA call dies with the step timeout
 * instead of taking the MCP server down. Each invocation prints one JSON line; the last line wins.
 */
import { spawn } from "node:child_process";
import type { OsopenerErrorCode } from "./types.js";

export interface HelperResult {
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export interface HelperRunner {
  run(command: string, args?: Record<string, string | number | boolean>, timeoutMs?: number): Promise<HelperResult>;
}

export class HelperError extends Error {
  readonly code: OsopenerErrorCode;
  readonly details?: unknown;
  constructor(code: OsopenerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "HelperError";
    this.code = code;
    this.details = details;
  }
}

/** Helper error codes that map 1:1 onto osopener error codes. */
const PASSTHROUGH: ReadonlySet<string> = new Set([
  "STUDIO_NOT_FOUND",
  "UIA_ELEMENT_NOT_FOUND",
  "UNSAVED_CHANGES_DIALOG",
  "OPEN_TIMEOUT"
]);

export function helperErrorCode(code: string): OsopenerErrorCode {
  return PASSTHROUGH.has(code) ? (code as OsopenerErrorCode) : "HELPER_FAILED";
}

/** Turns an `{ ok: false, error }` helper result into a thrown `HelperError`. */
export function assertHelperOk(result: HelperResult, step: string): HelperResult {
  if (result.ok) return result;
  const code = result.error?.code ?? "UNKNOWN";
  const message = result.error?.message ?? "helper reported failure";
  throw new HelperError(helperErrorCode(code), `${step}: ${message}`, { helperCode: code, ...stripError(result) });
}

function stripError(result: HelperResult): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...result };
  delete copy.ok;
  delete copy.error;
  return copy;
}

export function parseHelperStdout(stdout: string): HelperResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.startsWith("{")) return JSON.parse(line) as HelperResult;
  }
  throw new Error("helper printed no JSON line");
}

export interface PowerShellHelperOptions {
  powershellExe: string;
  scriptPath: string;
  defaultTimeoutMs?: number;
}

export class PowerShellHelper implements HelperRunner {
  private readonly exe: string;
  private readonly script: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: PowerShellHelperOptions) {
    this.exe = options.powershellExe;
    this.script = options.scriptPath;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  run(command: string, args: Record<string, string | number | boolean> = {}, timeoutMs?: number): Promise<HelperResult> {
    const argv = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.script,
      command
    ];
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "boolean") {
        if (v) argv.push(`-${k}`);
      } else {
        argv.push(`-${k}`, String(v));
      }
    }
    const limit = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const child = spawn(this.exe, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, limit);
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new HelperError("HELPER_FAILED", `cannot spawn ${this.exe}: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new HelperError("HELPER_FAILED", `helper '${command}' exceeded ${limit} ms and was killed`));
          return;
        }
        try {
          resolve(parseHelperStdout(stdout));
        } catch (err) {
          reject(
            new HelperError(
              "HELPER_FAILED",
              `helper '${command}' exited ${code} without a JSON result: ${err instanceof Error ? err.message : String(err)}`,
              { stderr: stderr.slice(0, 2000) }
            )
          );
        }
      });
    });
  }
}
