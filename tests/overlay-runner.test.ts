import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb, seedPoint } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { POSITION_KEY, STATUS_KEY, applyHelperMessage, nextOverlayMessage, parseHelperLine } from '../src/overlay.js';
import { CRASH_LOOP_LIMIT, HelperSupervisor, overlayTick, runOverlay, type HelperProcess } from '../src/overlay-runner.js';

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  written: string[] = [];
  killed = false;
  constructor() {
    super();
    this.stdin.on('data', (chunk) => this.written.push(String(chunk)));
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface PendingRestart {
  fn: () => void;
  ms: number;
  cancelled: boolean;
}

interface Harness {
  supervisor: HelperSupervisor;
  helpers: FakeHelper[];
  lines: string[];
  stopped: string[];
  pending: PendingRestart[];
  clock: { t: number };
  spawnThrows: { value: boolean };
}

function harness(): Harness {
  const helpers: FakeHelper[] = [];
  const lines: string[] = [];
  const stopped: string[] = [];
  const pending: PendingRestart[] = [];
  const clock = { t: 0 };
  const spawnThrows = { value: false };
  const supervisor = new HelperSupervisor({
    spawnHelper: () => {
      if (spawnThrows.value) throw new Error('ENOENT');
      const helper = new FakeHelper();
      helpers.push(helper);
      return helper as unknown as HelperProcess;
    },
    onLine: (line) => lines.push(line),
    onStopped: (reason) => stopped.push(reason),
    now: () => clock.t,
    schedule: (fn, ms) => {
      const item: PendingRestart = { fn, ms, cancelled: false };
      pending.push(item);
      return () => {
        item.cancelled = true;
      };
    },
  });
  return { supervisor, helpers, lines, stopped, pending, clock, spawnThrows };
}

function runPending(h: Harness): void {
  const due = h.pending.splice(0);
  for (const item of due) if (!item.cancelled) item.fn();
}

describe('overlay runner: supervisor', () => {
  it('sends one JSON line per message', async () => {
    const h = harness();
    h.supervisor.start();
    h.supervisor.send({ type: 'show', rewrite: 'x' });
    await new Promise((r) => setImmediate(r));
    expect(h.helpers[0]!.written.join('')).toBe('{"type":"show","rewrite":"x"}\n');
  });

  it('reassembles helper lines split across chunks', async () => {
    const h = harness();
    h.supervisor.start();
    h.helpers[0]!.stdout.write('{"type":"mo');
    h.helpers[0]!.stdout.write('ved","x":1,"y":2}\n{"type":"dismissed"}\n');
    await new Promise((r) => setImmediate(r));
    expect(h.lines).toEqual(['{"type":"moved","x":1,"y":2}', '{"type":"dismissed"}']);
  });

  it('restarts with a doubling backoff after an exit', () => {
    const h = harness();
    h.supervisor.start();
    h.helpers[0]!.emit('exit', 1);
    expect(h.pending.map((p) => p.ms)).toEqual([1000]);
    runPending(h);
    expect(h.helpers).toHaveLength(2);
    h.clock.t += 1000;
    h.helpers[1]!.emit('exit', 1);
    expect(h.pending.map((p) => p.ms)).toEqual([2000]);
  });

  it('counts an exit and an error from the same process once', () => {
    const h = harness();
    h.supervisor.start();
    h.helpers[0]!.emit('error', new Error('spawn failed'));
    h.helpers[0]!.emit('exit', null);
    expect(h.pending).toHaveLength(1);
  });

  it(`stops after ${CRASH_LOOP_LIMIT} exits within a minute`, () => {
    const h = harness();
    h.supervisor.start();
    for (let i = 0; i < CRASH_LOOP_LIMIT; i += 1) {
      h.helpers.at(-1)!.emit('exit', 1);
      h.clock.t += 1000;
      runPending(h);
    }
    expect(h.stopped).toHaveLength(1);
    expect(h.supervisor.isStopped).toBe(true);
    expect(h.helpers).toHaveLength(CRASH_LOOP_LIMIT);
  });

  it('keeps restarting when exits are spread out', () => {
    const h = harness();
    h.supervisor.start();
    for (let i = 0; i < CRASH_LOOP_LIMIT * 2; i += 1) {
      h.helpers.at(-1)!.emit('exit', 1);
      h.clock.t += 20_000;
      runPending(h);
    }
    expect(h.stopped).toHaveLength(0);
  });

  it('treats a spawn that throws (binary missing) as an exit and eventually stops', () => {
    const h = harness();
    h.spawnThrows.value = true;
    h.supervisor.start();
    for (let i = 0; i < CRASH_LOOP_LIMIT; i += 1) {
      h.clock.t += 1000;
      runPending(h);
    }
    expect(h.stopped).toHaveLength(1);
  });

  it('does not restart after shutdown', () => {
    const h = harness();
    h.supervisor.start();
    h.supervisor.shutdown();
    expect(h.helpers[0]!.killed).toBe(true);
    h.helpers[0]!.emit('exit', null);
    expect(h.pending).toHaveLength(0);
    expect(h.stopped).toHaveLength(0);
  });

  it('drops a send while no helper is running', () => {
    const h = harness();
    expect(() => h.supervisor.send({ type: 'show' })).not.toThrow();
  });

  it('cancels a pending restart timer on shutdown, so it never fires', () => {
    const h = harness();
    h.supervisor.start();
    h.helpers[0]!.emit('exit', 1);
    expect(h.pending).toHaveLength(1);
    expect(h.pending[0]!.cancelled).toBe(false);
    h.supervisor.shutdown();
    // The bug this guards against: node keeps the process alive for up to `ms` because the
    // scheduled timer is never cleared, even though the callback becomes a no-op once
    // `stopped` is set. Cancelling the timer itself is what lets the process exit promptly.
    expect(h.pending[0]!.cancelled).toBe(true);
    runPending(h);
    expect(h.helpers).toHaveLength(1);
  });
});

describe('overlay runner: tick', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = memoryDb();
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  it('forwards a new suggestion to the helper', () => {
    const sent: object[] = [];
    nextOverlayMessage(db);
    seedPoint(db, { canonicalForm: 'tick', rewrite: 'Tick.' });
    overlayTick(db, { send: (m) => sent.push(m) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'show', rewrite: 'Tick.' });
  });

  it('skips the tick instead of throwing when the database is unusable', () => {
    db.close();
    expect(() => overlayTick(db, { send: () => undefined })).not.toThrow();
  });

  it('stores a position reported by the helper, ignoring garbage lines', () => {
    for (const line of ['garbage', '{"type":"moved","x":42,"y":900}']) {
      const message = parseHelperLine(line);
      if (message) applyHelperMessage(db, message);
    }
    expect(JSON.parse(getSetting(db, POSITION_KEY)!)).toEqual({ x: 42, y: 900 });
  });
});

describe('overlay runner: run loop', () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = memoryDb();
  });

  afterEach(() => {
    if (db.open) db.close();
  });

  it('records status stopped once a clean shutdown finishes, without a real signal or process', async () => {
    const logs: string[] = [];
    const handlers: Record<string, () => void> = {};
    const helper = new FakeHelper();
    const promise = runOverlay(db, '/unused-binary-path', (line) => logs.push(line), {
      onSignal: (signal, handler) => {
        handlers[signal] = handler;
      },
      spawnHelper: () => helper as unknown as HelperProcess,
    });
    expect(getSetting(db, STATUS_KEY)).toBe('running');
    expect(handlers.SIGTERM).toBeDefined();
    handlers.SIGTERM!();
    const code = await promise;
    expect(code).toBe(0);
    expect(getSetting(db, STATUS_KEY)).toBe('stopped');
    expect(helper.killed).toBe(true);
  });
});
