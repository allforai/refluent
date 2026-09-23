import { describe, expect, it } from 'vitest';
import { detectTerminalWidth } from '../src/terminal-width.js';

/** A fake process table: pid -> { tty, ppid }, plus recorded commands. */
function fakeSystem(table: Record<number, { tty: string; ppid: number }>, sizes: Record<string, string>) {
  const calls: string[] = [];
  const exec = (file: string, args: string[]): string => {
    calls.push(`${file} ${args.join(' ')}`);
    if (file === 'ps') {
      const pid = Number(args[args.length - 1]);
      const row = table[pid];
      if (!row) throw new Error('no such process');
      return args[1] === 'tty=' ? `${row.tty}\n` : `${row.ppid}\n`;
    }
    if (file === 'stty') {
      const device = args[1] ?? '';
      const size = sizes[device];
      if (size === undefined) throw new Error('not a terminal');
      return `${size}\n`;
    }
    throw new Error(`unexpected command: ${file}`);
  };
  return { exec, calls };
}

describe('terminal width: the hook reads the pane the agent renders into', () => {
  it('prefers a directly known width over any probing', () => {
    const { exec, calls } = fakeSystem({}, {});
    expect(detectTerminalWidth({ stdoutColumns: 120, exec })).toBe(120);
    expect(calls).toEqual([]);
  });

  it('reads the size of the agent TTY through the parent chain', () => {
    // The hook's parent is a shell; the agent is its parent and owns the TTY.
    const { exec } = fakeSystem(
      { 500: { tty: 'ttys007', ppid: 400 }, 400: { tty: '??', ppid: 300 }, 300: { tty: 'ttys002', ppid: 1 } },
      { '/dev/ttys007': '48 67' },
    );
    expect(detectTerminalWidth({ exec, startPid: 500, stdoutColumns: 0 })).toBe(67);
  });

  it('ignores the control TTY and keeps walking when a parent has none', () => {
    const { exec } = fakeSystem(
      { 500: { tty: '??', ppid: 400 }, 400: { tty: '-', ppid: 300 }, 300: { tty: 'ttys009', ppid: 1 } },
      { '/dev/ttys009': '24 132' },
    );
    expect(detectTerminalWidth({ exec, startPid: 500, stdoutColumns: 0 })).toBe(132);
  });

  it('returns null instead of guessing when no TTY can be sized', () => {
    const { exec } = fakeSystem({ 500: { tty: '??', ppid: 1 } }, {});
    expect(detectTerminalWidth({ exec, startPid: 500, stdoutColumns: 0 })).toBeNull();
  });

  it('rejects implausible sizes and unset COLUMNS', () => {
    const { exec } = fakeSystem({ 500: { tty: 'ttys001', ppid: 1 } }, { '/dev/ttys001': '48 0' });
    expect(detectTerminalWidth({ exec, startPid: 500, env: {}, stdoutColumns: 0 })).toBeNull();

    const huge = fakeSystem({ 500: { tty: 'ttys001', ppid: 1 } }, { '/dev/ttys001': '48 99999' });
    expect(detectTerminalWidth({ exec: huge.exec, startPid: 500, env: {}, stdoutColumns: 0 })).toBeNull();

    expect(detectTerminalWidth({ stdoutColumns: 0, env: { COLUMNS: '80' }, exec: () => '' })).toBe(80);
  });
});
