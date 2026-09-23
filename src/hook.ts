import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dbPath } from './config.js';
import { openDatabase, type DatabaseType } from './db.js';
import { effectiveCaptureEnabled, getSetting, markHookSeen, quietModeOn } from './settings.js';
import { captureMessage, runAnalysis } from './capture.js';
import { analysisClientFor } from './analysis/http.js';
import type { AnalysisClient } from './analysis/types.js';
import { renderDueNotice } from './review.js';
import { renderStatusline, statuslineBudget } from './statusline.js';
import { detectTerminalWidth } from './terminal-width.js';
import { DEFAULT_AGENT, agentSource, normalizePromptPayload, type AgentId } from './agents.js';
import { wrappedStatusLineCommand } from './install.js';

export type HookName = 'user-prompt-submit' | 'session-start' | 'statusline';

export interface HookResult {
  /** stdout for the hook. Always '' for capture, which is how the message is left byte-for-byte. */
  stdout: string;
  exitCode: number;
  captured?: boolean;
  queued?: boolean;
  jobId?: number;
}

export interface HookDeps {
  db: DatabaseType;
  client?: AnalysisClient;
  spawnDetached?: (jobId: number) => void;
  inlineAnalysis?: boolean;
  /** Runs the user's wrapped statusLine command with the hook input on stdin. */
  runStatusCommand?: (command: string, input: string) => string;
  /** Injected for tests; null means "no terminal width known". */
  terminalColumns?: number | null;
  /** Which agent is capturing; decides the recorded origin of a knowledge point. */
  agent?: AgentId;
}

function runStatusCommand(command: string, input: string): string {
  try {
    return execSync(command, {
      input,
      encoding: 'utf8',
      timeout: 2000,
      shell: '/bin/sh',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The hook resolves its model through the same entrypoint as every other
 * command: Claude Code runs hooks as children of the agent, so configuration
 * that exists only in a terminal profile never arrives.
 */
function analysisClient(deps: HookDeps): AnalysisClient {
  if (deps.client) return deps.client;
  return analysisClientFor(deps.db);
}

/**
 * `UserPromptSubmit` capture. The message has already been forwarded by Claude
 * Code; this handler writes a snapshot and returns without printing anything, so
 * the message reaches the agent byte-for-byte. Every failure path is silent.
 */
export async function handleUserPromptSubmit(
  inputText: string,
  deps: HookDeps,
): Promise<HookResult> {
  try {
    markHookSeen(deps.db);
    const payload = parseJson(inputText);
    const normalized = normalizePromptPayload(payload);
    if (!normalized) return { stdout: '', exitCode: 0 };
    if (!effectiveCaptureEnabled(deps.db).enabled) return { stdout: '', exitCode: 0 };
    const source = agentSource(deps.agent ?? DEFAULT_AGENT);

    const outcome = captureMessage(deps.db, {
      rawText: normalized.prompt,
      messageId: normalized.messageId,
      sessionId: normalized.sessionId,
    });

    if (outcome.queued) {
      if (deps.inlineAnalysis) {
        await runAnalysis(deps.db, analysisClient(deps), outcome.jobId, source);
      } else if (deps.spawnDetached) {
        deps.spawnDetached(outcome.jobId);
      } else {
        spawnAnalysisJob(outcome.jobId, deps.agent ?? DEFAULT_AGENT);
      }
    }
    return { stdout: '', exitCode: 0, captured: true, queued: outcome.queued, jobId: outcome.jobId };
  } catch {
    return { stdout: '', exitCode: 0, captured: false };
  }
}

/**
 * Session start: one short notice for the *user*. Plain stdout from a
 * SessionStart hook is injected into the agent's context, so the notice is sent
 * as JSON `systemMessage`, which Claude Code shows to the user only. It reads
 * local state and never calls the model, so it cannot delay the session.
 */
export async function handleSessionStart(inputText: string, deps: HookDeps): Promise<HookResult> {
  try {
    markHookSeen(deps.db);
    if (!effectiveCaptureEnabled(deps.db).enabled) return { stdout: '', exitCode: 0 };
    if (quietModeOn(deps.db)) return { stdout: '', exitCode: 0 };
    if ((getSetting(deps.db, 'session-start-review') ?? 'on') !== 'on') {
      return { stdout: '', exitCode: 0 };
    }
    void inputText;
    const notice = renderDueNotice(deps.db);
    if (!notice) return { stdout: '', exitCode: 0 };
    return { stdout: `${JSON.stringify({ systemMessage: notice })}\n`, exitCode: 0 };
  } catch {
    return { stdout: '', exitCode: 0 };
  }
}

/**
 * statusLine: the user's own statusLine output (if refluent wrapped one), then
 * at most one refluent line. Read-only; never triggers analysis.
 */
export async function handleStatusline(inputText: string, deps: HookDeps): Promise<HookResult> {
  const lines: string[] = [];
  try {
    const wrapped = wrappedStatusLineCommand(deps.db);
    if (wrapped) {
      const own = (deps.runStatusCommand ?? runStatusCommand)(wrapped, inputText).replace(/\s+$/, '');
      if (own) lines.push(own);
    }
  } catch {
    // The wrapped command is best-effort; refluent's own line still renders.
  }
  try {
    // Claude Code truncates an over-wide status line instead of wrapping, so the
    // line is fitted to the pane it will be rendered into.
    const columns = deps.terminalColumns === undefined ? detectTerminalWidth() : deps.terminalColumns;
    const line = renderStatusline(deps.db, new Date(), {
      maxColumns: columns === null || columns === undefined ? null : statuslineBudget(columns),
    });
    if (line) lines.push(line);
  } catch {
    // Silent by design.
  }
  return { stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '', exitCode: 0 };
}

export function spawnAnalysisJob(jobId: number, agent: AgentId = DEFAULT_AGENT): void {
  try {
    const bin = fileURLToPath(new URL('../bin/refluent', import.meta.url));
    const child = spawn(process.execPath, [bin, 'analyze-job', String(jobId), '--agent', agent], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    // Detached analysis is best-effort; failure is silent and non-blocking.
  }
}

export async function runHook(name: HookName, agent: AgentId = DEFAULT_AGENT): Promise<number> {
  const inputText = await readStream(process.stdin).catch(() => '');
  const db = openDatabase();
  const inline = process.env.REFLUENT_INLINE_ANALYSIS === '1';
  const deps: HookDeps = { db, inlineAnalysis: inline, agent };
  const result =
    name === 'user-prompt-submit'
      ? await handleUserPromptSubmit(inputText, deps)
      : name === 'session-start'
        ? await handleSessionStart(inputText, deps)
        : await handleStatusline(inputText, deps);
  if (result.stdout) process.stdout.write(result.stdout);
  db.close();
  return result.exitCode;
}

export { dbPath };