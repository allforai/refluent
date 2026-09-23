import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataDir, dbPath } from '../src/config.js';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.REFLUENT_DATA_DIR;
  delete process.env.REFLUENT_DATA_DIR;
});
afterEach(() => {
  if (saved === undefined) delete process.env.REFLUENT_DATA_DIR;
  else process.env.REFLUENT_DATA_DIR = saved;
});

describe('config: one user-level store for every project', () => {
  it('defaults to ~/.refluent, not the current working directory', () => {
    expect(dataDir()).toBe(path.join(os.homedir(), '.refluent'));
    expect(dataDir()).not.toBe(path.join(process.cwd(), '.refluent'));
    expect(dbPath()).toBe(path.join(os.homedir(), '.refluent', 'analysis-and-data.sqlite'));
  });

  it('still honours REFLUENT_DATA_DIR', () => {
    process.env.REFLUENT_DATA_DIR = '/tmp/refluent-override';
    expect(dataDir()).toBe('/tmp/refluent-override');
  });
});
