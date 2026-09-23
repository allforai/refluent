import type { WriteSource } from './write-path.js';

/**
 * The coding agents refluent can capture from.
 *
 * Capture and display are separate concerns, because the platforms differ:
 *
 * - `claude-code` has command hooks *and* an injectable status line, so it is
 *   the only agent where refluent can own the line it wraps.
 * - `codex` has command hooks with the same event names and payload shape as
 *   Claude Code (`~/.codex/hooks.json`), but its `status_line` is a built-in
 *   boolean — nothing can be injected into its TUI.
 * - `pi` has no hook file at all; a personal extension sees the outgoing prompt
 *   (`before_agent_start`) and can render into Pi's *keyed* status bar, which is
 *   the one status surface several tools can share.
 */
export type AgentId = 'claude-code' | 'codex' | 'pi';

export const AGENT_IDS: readonly AgentId[] = ['claude-code', 'codex', 'pi'];

export const DEFAULT_AGENT: AgentId = 'claude-code';

export interface AgentDefinition {
  id: AgentId;
  label: string;
  /** How this agent receives capture: a hook file, or an extension we write. */
  capture: 'hooks-file' | 'extension';
  /** Whether the agent has a status line refluent can render into. */
  hasInjectableStatusline: boolean;
  /** What a stored knowledge point records as its origin. */
  source: WriteSource;
}

const DEFINITIONS: Record<AgentId, AgentDefinition> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    capture: 'hooks-file',
    hasInjectableStatusline: true,
    source: 'claude-code:UserPromptSubmit',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    capture: 'hooks-file',
    hasInjectableStatusline: false,
    source: 'codex:UserPromptSubmit',
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    capture: 'extension',
    hasInjectableStatusline: true,
    source: 'pi:before-agent-start',
  },
};

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/** Accepts an id or a loose alias (`claude`, `claude_code`, `Pi`). */
export function parseAgentId(value: string | undefined | null): AgentId | null {
  const raw = value?.trim().toLowerCase();
  if (!raw) return null;
  if (isAgentId(raw)) return raw;
  if (raw === 'claude' || raw === 'claudecode' || raw === 'claude_code') return 'claude-code';
  return null;
}

export function agentDefinition(id: AgentId): AgentDefinition {
  return DEFINITIONS[id];
}

export function agentSource(id: AgentId): WriteSource {
  return DEFINITIONS[id].source;
}

/**
 * The hook payload is one small contract shared by every adapter: each agent's
 * own shape is mapped onto `{prompt, session_id?, message_id?}` before it
 * reaches the core, so the core never grows an agent-specific branch.
 */
export interface NormalizedPrompt {
  prompt: string;
  sessionId: string | null;
  messageId: string | null;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function normalizePromptPayload(payload: Record<string, unknown>): NormalizedPrompt | null {
  const prompt = firstString(payload, ['prompt', 'user_prompt', 'text', 'message', 'content']);
  if (prompt === null) return null;
  return {
    prompt,
    sessionId: firstString(payload, ['session_id', 'sessionId', 'turn_id', 'thread_id']),
    messageId: firstString(payload, ['message_id', 'messageId', 'id']),
  };
}
