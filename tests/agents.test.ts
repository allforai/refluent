import { describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  agentDefinition,
  agentSource,
  normalizePromptPayload,
  parseAgentId,
} from '../src/agents.js';

describe('agents: one capture contract, three adapters', () => {
  it('parses ids and loose aliases', () => {
    expect(parseAgentId('codex')).toBe('codex');
    expect(parseAgentId(' Pi ')).toBe('pi');
    expect(parseAgentId('claude')).toBe('claude-code');
    expect(parseAgentId('claude_code')).toBe('claude-code');
    expect(parseAgentId('gemini')).toBeNull();
    expect(parseAgentId(undefined)).toBeNull();
  });

  it('knows which agents can render a status line', () => {
    // Codex's status_line is a built-in toggle; nothing can be injected into it.
    expect(agentDefinition('codex').hasInjectableStatusline).toBe(false);
    expect(agentDefinition('claude-code').hasInjectableStatusline).toBe(true);
    expect(agentDefinition('pi').hasInjectableStatusline).toBe(true);
    expect(agentDefinition('pi').capture).toBe('extension');
    expect(AGENT_IDS).toEqual(['claude-code', 'codex', 'pi']);
  });

  it('records a distinct origin per agent', () => {
    expect(agentSource('claude-code')).toBe('claude-code:UserPromptSubmit');
    expect(agentSource('codex')).toBe('codex:UserPromptSubmit');
    expect(agentSource('pi')).toBe('pi:before-agent-start');
  });
});

describe('agents: payload shapes are mapped onto one contract', () => {
  it('reads the Claude Code and Codex shape', () => {
    expect(
      normalizePromptPayload({ hook_event_name: 'UserPromptSubmit', prompt: 'check this bug', session_id: 's-1' }),
    ).toEqual({ prompt: 'check this bug', sessionId: 's-1', messageId: null });
  });

  it('reads the Pi extension shape', () => {
    expect(normalizePromptPayload({ prompt: 'why is it broken？', session_id: 'pi-7' })).toEqual({
      prompt: 'why is it broken？',
      sessionId: 'pi-7',
      messageId: null,
    });
  });

  it('accepts the tolerant aliases an adapter might send', () => {
    expect(normalizePromptPayload({ text: 'hello there' })?.prompt).toBe('hello there');
    expect(normalizePromptPayload({ message: 'hello there' })?.prompt).toBe('hello there');
    expect(normalizePromptPayload({ content: 'hello there' })?.prompt).toBe('hello there');
    expect(normalizePromptPayload({ user_prompt: 'hello there' })?.prompt).toBe('hello there');
    expect(normalizePromptPayload({ messageId: 'm-1', sessionId: 's-1', prompt: 'x' })?.messageId).toBe('m-1');
  });

  it('ignores a payload with nothing to capture, and never invents text', () => {
    expect(normalizePromptPayload({})).toBeNull();
    expect(normalizePromptPayload({ prompt: '' })).toBeNull();
    expect(normalizePromptPayload({ prompt: 42 })).toBeNull();
    expect(normalizePromptPayload({ tool_name: 'Bash' })).toBeNull();
  });
});
