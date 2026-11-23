/**
 * Run control for `osgraph run`: a start gate, pause / resume, and graceful cancel.
 *
 * The progress site's buttons (loopback only), Enter in the terminal and Ctrl+C all drive the same
 * object, and `runScope` consults it before every GUI action. What each state means for Service Studio:
 *
 *  - `waiting`    nothing has touched Studio yet (`--wait`): the site is up, the run waits for Start.
 *  - `running`    normal operation.
 *  - `paused`     no new GUI action (open or close) starts, so nothing takes the foreground; reads of
 *                 modules that are already open keep going, and a GUI action already under way finishes.
 *  - `cancelling` no new module is opened; modules already started finish, drain and close.
 *  - `done`       the run returned.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type RunControlState = "waiting" | "running" | "paused" | "cancelling" | "done";

/** The `control` part of `/api/status`. */
export interface RunControlSnapshot {
  state: RunControlState;
  /** ISO time of the transition into the current state. */
  since: string;
  /** Which actions are valid right now (what the page enables). */
  can: { start: boolean; pause: boolean; resume: boolean; cancel: boolean };
}

export type RunControlAction = "start" | "pause" | "resume" | "cancel";

/** Outcome of a remote (non-loopback) control request's password check. */
export type RemoteAuth = "ok" | "denied" | "locked" | "disabled";

/** Wrong passwords tolerated inside `LOCKOUT_WINDOW_MS` before remote control locks for that long. */
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 60_000;

export class RunControl {
  private readonly now: () => Date;
  private current: RunControlState;
  private since: Date;
  private readonly abort = new AbortController();
  /** Resolved whenever the state changes; waiters re-check. */
  private waiters: Array<() => void> = [];
  private readonly listeners: Array<(state: RunControlState, previous: RunControlState) => void> = [];

  constructor(options: { waitForStart?: boolean; now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    this.current = options.waitForStart === true ? "waiting" : "running";
    this.since = this.now();
  }

  /** scrypt hash of the remote-control password; undefined = control from this PC only. */
  private passwordHash: Buffer | undefined;
  private passwordSalt: Buffer | undefined;
  /** Times of recent wrong passwords (lockout window). */
  private failures: number[] = [];

  /**
   * Lets other devices (a phone) Start / Pause / Resume / Cancel with this password. Set by the person
   * at the laptop when the run starts; only a salted scrypt hash is kept in memory, never the text.
   * `undefined` or empty turns remote control off (loopback only, the default).
   */
  setRemotePassword(password: string | undefined): void {
    if (password === undefined || password.length === 0) {
      this.passwordHash = undefined;
      this.passwordSalt = undefined;
      return;
    }
    this.passwordSalt = randomBytes(16);
    this.passwordHash = scryptSync(password, this.passwordSalt, 32);
  }

  /** True when a remote-control password is set. */
  get remoteEnabled(): boolean {
    return this.passwordHash !== undefined;
  }

  /**
   * Checks a remote request's password (constant-time). After `LOCKOUT_FAILURES` wrong ones within
   * `LOCKOUT_WINDOW_MS` every remote attempt is refused until the window has passed, so a device on
   * the network cannot guess it.
   */
  authorize(password: string | undefined, nowMs: number = Date.now()): RemoteAuth {
    if (this.passwordHash === undefined || this.passwordSalt === undefined) return "disabled";
    this.failures = this.failures.filter((t) => nowMs - t < LOCKOUT_WINDOW_MS);
    if (this.failures.length >= LOCKOUT_FAILURES) return "locked";
    const given = scryptSync(password ?? "", this.passwordSalt, 32);
    if (timingSafeEqual(given, this.passwordHash)) return "ok";
    this.failures.push(nowMs);
    return this.failures.length >= LOCKOUT_FAILURES ? "locked" : "denied";
  }

  /** Called after every state change (the CLI logs them, so the run log shows who paused when). */
  onChange(listener: (state: RunControlState, previous: RunControlState) => void): void {
    this.listeners.push(listener);
  }

  get state(): RunControlState {
    return this.current;
  }

  /** Aborted by `cancel()`: `runScope`'s `signal`. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  snapshot(): RunControlSnapshot {
    const s = this.current;
    return {
      state: s,
      since: this.since.toISOString(),
      can: {
        start: s === "waiting",
        pause: s === "running",
        resume: s === "paused",
        cancel: s === "waiting" || s === "running" || s === "paused"
      }
    };
  }

  /**
   * Applies an action. Returns false (and changes nothing) when it is not valid in the current state,
   * so a double click or a stale page is harmless.
   */
  act(action: RunControlAction): boolean {
    const s = this.current;
    switch (action) {
      case "start":
        if (s !== "waiting") return false;
        this.set("running");
        return true;
      case "pause":
        if (s !== "running") return false;
        this.set("paused");
        return true;
      case "resume":
        if (s !== "paused") return false;
        this.set("running");
        return true;
      case "cancel":
        if (s === "cancelling" || s === "done") return false;
        this.set("cancelling");
        this.abort.abort();
        return true;
    }
  }

  start(): boolean {
    return this.act("start");
  }
  pause(): boolean {
    return this.act("pause");
  }
  resume(): boolean {
    return this.act("resume");
  }
  cancel(): boolean {
    return this.act("cancel");
  }

  /** Marks the run finished; every waiter is released. */
  finish(): void {
    this.set("done");
  }

  /** Resolves once the run may begin: Start was pressed, or the run was cancelled while waiting. */
  async waitForStart(): Promise<void> {
    while (this.current === "waiting") await this.changed();
  }

  /**
   * Resolves once a GUI action may start: not waiting and not paused. Cancelling and done also
   * release it; the caller checks for cancellation itself (a close during a cancel must still run).
   */
  async waitUntilActive(): Promise<void> {
    while (this.current === "waiting" || this.current === "paused") await this.changed();
  }

  private changed(): Promise<void> {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private set(next: RunControlState): void {
    const previous = this.current;
    this.current = next;
    this.since = this.now();
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
    for (const l of this.listeners) {
      try {
        l(next, previous);
      } catch {
        /* a listener must never break the run */
      }
    }
  }
}
