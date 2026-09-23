import { execFileSync } from 'node:child_process';

/**
 * The terminal width the agent is rendering into.
 *
 * Claude Code captures a statusLine command's stdout through a pipe and passes
 * no width in the hook payload, so `process.stdout.columns`, `COLUMNS` and
 * `tput cols` all report nothing (or a lie). It also truncates an over-wide line
 * with `…` instead of wrapping, which silently cuts the suggestion.
 *
 * The agent process itself does have a terminal, so the width is readable from
 * its TTY: `ps -o tty= -p <ppid>` names the device and `stty -f` reports its
 * size. This walks up a few ancestors because Claude Code may run the hook
 * through a shell, and returns null rather than guessing when nothing is found.
 */
export interface TerminalWidthDeps {
  /** Injected for tests; defaults to a real `execFileSync`. */
  exec?: (file: string, args: string[]) => string;
  /** Where to start walking; defaults to this process's parent. */
  startPid?: number;
  stdoutColumns?: number | undefined;
  env?: NodeJS.ProcessEnv;
  maxAncestors?: number;
}

const MIN_COLUMNS = 20;
const MAX_COLUMNS = 1000;
const EXEC_TIMEOUT_MS = 500;

function usableColumns(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_COLUMNS && value <= MAX_COLUMNS
    ? Math.floor(value)
    : null;
}

export function detectTerminalWidth(deps: TerminalWidthDeps = {}): number | null {
  const env = deps.env ?? process.env;

  // An explicit override makes the rendered shape deterministic for tests, for a
  // caller that pipes the line somewhere else, and for a pane that reports a
  // width the agent does not actually use.
  const override = env.REFLUENT_TERMINAL_COLUMNS?.trim().toLowerCase();
  if (override === 'off' || override === 'none' || override === '0') return null;
  const forced = usableColumns(override ? Number(override) : null);
  if (forced !== null) return forced;

  const direct = usableColumns(deps.stdoutColumns ?? process.stdout.columns);
  if (direct !== null) return direct;

  const fromEnv = usableColumns(env.COLUMNS ? Number(env.COLUMNS) : null);
  if (fromEnv !== null) return fromEnv;

  const run =
    deps.exec ??
    ((file: string, args: string[]): string =>
      execFileSync(file, args, { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }));

  const read = (file: string, args: string[]): string => {
    try {
      return run(file, args);
    } catch {
      return '';
    }
  };

  let pid = deps.startPid ?? process.ppid;
  const limit = deps.maxAncestors ?? 4;
  for (let depth = 0; depth < limit && pid > 1; depth += 1) {
    const tty = read('ps', ['-o', 'tty=', '-p', String(pid)]).trim();
    if (tty && tty !== '??' && tty !== '-') {
      const size = read('stty', ['-f', `/dev/${tty}`, 'size']).trim();
      const [, cols] = size.split(/\s+/);
      const columns = usableColumns(cols ? Number(cols) : null);
      if (columns !== null) return columns;
    }
    const parent = read('ps', ['-o', 'ppid=', '-p', String(pid)]).trim();
    const next = Number(parent);
    if (!Number.isInteger(next) || next <= 1) break;
    pid = next;
  }
  return null;
}
