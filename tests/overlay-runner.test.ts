import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb, seedPoint } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { getSetting } from '../src/settings.js';
import { POSITION_KEY, applyHelperMessage, nextOverlayMessage, parseHelperLine } from '../src/overlay.js';
import { CRASH_LOOP_LIMIT, HelperSupervisor, overlayTick, type HelperProcess } from '../src/overlay-runner.js';

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

interface Harness {
  supervisor: HelperSupervisor;
  helpers: FakeHelper[];
  lines: string[];
  stopped: string[];
  pending: Array<{ fn: () => void; ms: number }>;
  clock: { t: number };
  spawnThrows: { value: boolean };
}

function harness(): Harness {
  const helpers: FakeHelper[] = [];
  const lines: string[] = [];
  const stopped: string[] = [];
  const pending: Array<{ fn: () => void; ms: number }> = [];
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
    schedule: (fn, ms) => pending.push({ fn, ms }),
  });
  return { supervisor, helpers, lines, stopped, pending, clock, spawnThrows };
}

function runPending(h: Harness): void {
  const due = h.pending.splice(0);
  for (const item of due) item.fn();
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
