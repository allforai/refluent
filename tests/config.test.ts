import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataDir, dbPath, stableNodePath } from '../src/config.js';

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

describe('config: a node path that survives upgrades', () => {
  const cellar = '/opt/homebrew/Cellar/node/26.9.0/bin/node';
  const links: Record<string, string> = {
    '/opt/homebrew/bin/node': cellar,
    [cellar]: cellar,
    '/usr/local/bin/node': '/usr/local/Cellar/node/20.0.0/bin/node',
  };
  const realpath = (p: string) => {
    const target = links[p];
    if (!target) throw new Error(`ENOENT: ${p}`);
    return target;
  };

  it('prefers a node on PATH that resolves to the running binary', () => {
    expect(stableNodePath(cellar, '/usr/bin:/opt/homebrew/bin', realpath)).toBe('/opt/homebrew/bin/node');
  });

  it('ignores a node on PATH that is a different binary', () => {
    expect(stableNodePath(cellar, '/usr/local/bin', realpath)).toBe(cellar);
  });

  it('falls back to the running binary when PATH has no node', () => {
    expect(stableNodePath(cellar, '', realpath)).toBe(cellar);
    expect(stableNodePath(cellar, '/nowhere', realpath)).toBe(cellar);
  });
});
