import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { DatabaseType } from './db.js';
import { nowIso } from './config.js';
import { setSetting } from './settings.js';
import { HEARTBEAT_KEY, STATUS_KEY, applyHelperMessage, nextOverlayMessage, parseHelperLine } from './overlay.js';

/** The slice of a child process the supervisor uses; a test passes a fake. */
export interface HelperProcess {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): boolean;
}

export const CRASH_LOOP_LIMIT = 5;
export const CRASH_LOOP_WINDOW_MS = 60_000;
export const MAX_BACKOFF_MS = 30_000;
const POLL_MS = 1000;
const HEARTBEAT_MS = 10_000;

export interface SupervisorOptions {
  spawnHelper: () => HelperProcess;
  onLine: (line: string) => void;
  onStopped: (reason: string) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * Keeps the Swift helper alive: restarts it with a doubling backoff, and gives up after
 * `CRASH_LOOP_LIMIT` exits inside `CRASH_LOOP_WINDOW_MS` so a broken binary cannot spin.
 */
export class HelperSupervisor {
  private child: HelperProcess | null = null;
  private exits: number[] = [];
  private stopped = false;

  constructor(private readonly options: SupervisorOptions) {}

  get isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (!this.stopped) this.launch();
  }

  send(message: object): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  shutdown(): void {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
  }

  private launch(): void {
    let child: HelperProcess;
    try {
      child = this.options.spawnHelper();
    } catch (error) {
      this.handleExit(error instanceof Error ? error.message : String(error));
      return;
    }
    this.child = child;
    let settled = false;
    // `error` and `exit` can both fire for one process; it is one exit.
    const done = (reason: string) => {
      if (settled) return;
      settled = true;
      if (this.child === child) this.child = null;
      this.handleExit(reason);
    };
    child.on('error', (error) => done(error.message));
    child.on('exit', (code) => done(`exit ${code}`));
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', this.options.onLine);
  }

  private handleExit(reason: string): void {
    if (this.stopped) return;
    const now = (this.options.now ?? Date.now)();
    this.exits = [...this.exits.filter((t) => now - t < CRASH_LOOP_WINDOW_MS), now];
    if (this.exits.length >= CRASH_LOOP_LIMIT) {
      this.stopped = true;
      this.options.onStopped(reason);
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.exits.length - 1));
    const schedule = this.options.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    schedule(() => {
      if (!this.stopped) this.launch();
    }, delay);
  }
}

export function spawnHelperProcess(binaryPath: string): HelperProcess {
  const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  // A write racing the helper's exit raises EPIPE on stdin; the exit is handled above.
  child.stdin.on('error', () => undefined);
  return child;
}

/** One poll. A busy or closed database skips the tick; the loop must never throw. */
export function overlayTick(db: DatabaseType, sink: { send(message: object): void }, now: Date = new Date()): void {
  try {
    const message = nextOverlayMessage(db, now);
    if (message) sink.send(message);
  } catch {
    // Skip this tick; the next one retries.
  }
}

function safeSet(db: DatabaseType, key: string, value: string): void {
  try {
    setSetting(db, key, value);
  } catch {
    // Status is advisory; a busy database must not stop the overlay.
  }
}

/** The long-lived process behind the LaunchAgent. Resolves 0 on SIGTERM or crash loop. */
export function runOverlay(db: DatabaseType, binaryPath: string, log: (line: string) => void): Promise<number> {
  return new Promise((resolve) => {
    let lastBeat = 0;
    const beat = () => {
      lastBeat = Date.now();
      safeSet(db, HEARTBEAT_KEY, nowIso());
    };
    const supervisor = new HelperSupervisor({
      spawnHelper: () => spawnHelperProcess(binaryPath),
      onLine: (line) => {
        const message = parseHelperLine(line);
        if (!message) return;
        try {
          applyHelperMessage(db, message);
        } catch {
          // A lost position is not worth crashing over.
        }
      },
      onStopped: (reason) => {
        log(`${nowIso()} overlay helper stopped after repeated exits: ${reason}`);
        safeSet(db, STATUS_KEY, 'stopped');
        finish();
      },
    });
    const timer = setInterval(() => {
      overlayTick(db, supervisor);
      if (Date.now() - lastBeat >= HEARTBEAT_MS) beat();
    }, POLL_MS);
    const finish = () => {
      clearInterval(timer);
      supervisor.shutdown();
      resolve(0);
    };
    process.once('SIGTERM', finish);
    process.once('SIGINT', finish);
    safeSet(db, STATUS_KEY, 'running');
    beat();
    supervisor.start();
  });
}
