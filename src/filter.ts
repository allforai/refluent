/**
 * The single choke point between capture and any model egress.
 *
 * Phase A removes code, logs, stack traces, diffs and error output. Phase B
 * decides whether the survivors are worth analyzing. The function is pure and
 * dependency-free so the privacy rule ("no source code, logs or error output in
 * a model request") holds by construction.
 */

import { isBareShellCommand, isCodeToken, redactLine } from './redact.js';

export const FILTER_VERSION = 'filter-v4';
export const MAX_FILTERED_LENGTH = 1500;

export type SkipReason =
  | 'agent_generated'
  | 'empty_after_filter'
  | 'too_short'
  | 'telegraphic_command'
  | 'low_natural_language'
  | 'no_coachable_text';

export interface FilterResult {
  filteredText: string | null;
  skipReason: SkipReason | null;
  /** Rule ids that removed or trimmed content, in application order. */
  redactions: string[];
}

export const COMMAND_LEXEMES: ReadonlySet<string> = new Set([
  'run', 'fix', 'add', 'remove', 'delete', 'check', 'test', 'build', 'install',
  'commit', 'push', 'pull', 'deploy', 'revert', 'stop', 'continue', 'go', 'do',
  'make', 'show', 'list', 'open', 'close', 'update', 'refactor', 'rename',
  'move', 'merge', 'rebase', 'explain', 'review', 'read', 'write', 'edit',
  'create', 'start', 'restart',
]);

const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'git', 'cd', 'ls', 'cat', 'grep', 'rg', 'rm',
  'mkdir', 'cp', 'mv', 'touch', 'curl', 'wget', 'docker', 'kubectl', 'python',
  'python3', 'node', 'go', 'cargo', 'make', 'brew', 'sudo', 'chmod', 'chown',
  'tar', 'ssh', 'scp', 'kill', 'echo', 'sed', 'awk', 'find',
]);

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const FULL_TIMESTAMP_RE = /^\s*(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?|\d{2}:\d{2}:\d{2})(?:[.,]\d+)?/;
const LEVEL_TAG_RE = /^\s*[\[\(]\s*(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\s*[\]\)]/i;
const BARE_LEVEL_RE = /^\s*(?:INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)(?=[\s:\-]|$)/;
const JSON_LOG_RE = /^\s*\{.*"(?:level|severity|msg|message|timestamp|time)"\s*:/;
const STACK_HEADER_RE = /^(?:Traceback \(most recent call last\)|Caused by:|\s+at .+\(.+\)$)/;
const STACK_FRAME_RE = /^(?:\s+at .+|\s*File ".+", line \d+.*|\s+[\w.$<>]+\([^)]*\)\s*)$/;

const ERROR_LINE_PATTERNS: readonly RegExp[] = [
  /(?:^|\s)(?:TypeError|RangeError|ReferenceError|SyntaxError|Error|Exception|Fatal|FATAL|panic|segfault)\s*:/,
  /\berrno\b/i,
  /\bexit\s+(?:code|status)\s*[:=]?\s*\d+/i,
  /\berror\s+TS\d+/i,
  /command not found/i,
  /permission denied/i,
  /No such file or directory/,
  /\bpanic:/,
  /^\s*[A-Z][A-Z0-9_]*_(?:ERROR|FATAL)\b/,
];

const DIFF_RE = /^\s*(?:diff --git |index [0-9a-f]{4,}|\+\+\+ |--- |@@ |On branch )/;

function isPorcelainStatus(line: string): boolean {
  const m = /^(\s*)(\?\?|[ MADRCU][MADRCU]) (\S.*)$/.exec(line);
  if (!m) return false;
  const status = m[2];
  return status === '??' || /[MADRCU]/.test(status);
}

function isShellCommandLine(line: string): boolean {
  if (/^\s*[$>%]\s+\S/.test(line)) return true;
  if (!/[|&;]/.test(line)) return false;
  const first = line.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  return COMMAND_LEXEMES.has(first) || SHELL_COMMANDS.has(first);
}

function isLocatorOnly(line: string): boolean {
  const t = line.trim();
  if (!t || /\s/.test(t)) return false;
  return isCodeToken(t);
}

function isLogLine(line: string): boolean {
  return (
    FULL_TIMESTAMP_RE.test(line) ||
    LEVEL_TAG_RE.test(line) ||
    BARE_LEVEL_RE.test(line) ||
    JSON_LOG_RE.test(line)
  );
}

function isErrorLine(line: string): boolean {
  return ERROR_LINE_PATTERNS.some((re) => re.test(line));
}

/** Phase A: remove fenced code regions, including their info strings. */
function removeFencedRegions(lines: string[], redactions: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (fence !== null) {
      redactions.push('R1-fenced-code');
      if (m && m[1][0] === fence[0]) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      redactions.push('R1-fenced-code');
      continue;
    }
    out.push(line);
  }
  return out;
}

function normalize(parts: string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim().normalize('NFC');
}

function capLength(text: string, redactions: string[]): string {
  if (text.length <= MAX_FILTERED_LENGTH) return text;
  const cut = text.slice(0, MAX_FILTERED_LENGTH);
  const boundary = cut.lastIndexOf(' ');
  redactions.push('R11-length-cap');
  return (boundary > 0 ? cut.slice(0, boundary) : cut).trim();
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g;
const LATIN_WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

/** Fewer Latin words than this and the message is not English prose to coach. */
const MIN_LATIN_WORDS = 2;
/**
 * ...but Chinese content is still material: it is translated into English rather than
 * dropped. Below this many ideographs a message carries no sentence to translate, and a
 * message with neither enough English nor enough Chinese is `no_coachable_text`.
 */
const MIN_CJK_CHARACTERS = 4;

function latinWordCount(text: string): number {
  return (text.match(LATIN_WORD_RE) ?? []).length;
}

/** CJK ideographs in the text, the unit the filter uses to recognise Chinese content. */
export function cjkCount(text: string): number {
  return (text.match(CJK_RE) ?? []).length;
}

/**
 * Word units for the length gates. A whitespace token counts as one unit unless
 * it contains CJK ideographs, which carry no spaces: then each ideograph and
 * each embedded Latin word counts, so `帮我look一下this bug` is 7 units, not 2.
 */
export function countWords(text: string): number {
  let units = 0;
  for (const token of text.split(/\s+/)) {
    if (token.length === 0) continue;
    const cjk = (token.match(CJK_RE) ?? []).length;
    units += cjk === 0 ? 1 : cjk + latinWordCount(token);
  }
  return units;
}

function firstLexeme(text: string): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const first = words[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (first === 'please') {
    return words[1]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  }
  return first;
}

function isTelegraphicCommand(text: string): boolean {
  if (text.includes('?') || /[.,;:!]/.test(text)) return false;
  if (countWords(text) > 8) return false;
  return COMMAND_LEXEMES.has(firstLexeme(text));
}

function isLowNaturalLanguage(text: string): boolean {
  const nonSpace = text.replace(/\s/g, '').length;
  if (nonSpace === 0) return true;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  return letters / nonSpace < 0.5;
}

/**
 * Text the agent harness submits through the user-prompt hook without the user having
 * written it: a background agent's result (`<task-notification>`), a system reminder, a
 * slash-command or `!` shell echo. They arrive as whole messages that open with the tag;
 * a user merely mentioning a tag mid-sentence is still the user's writing.
 */
const AGENT_GENERATED_RE =
  /^\s*<(?:task-notification|system-reminder|local-command-(?:stdout|stderr|caveat)|command-(?:name|message|args)|bash-(?:input|stdout|stderr))>/;

export function filterNaturalLanguage(rawText: string): FilterResult {
  if (AGENT_GENERATED_RE.test(rawText)) {
    return { filteredText: null, skipReason: 'agent_generated', redactions: [] };
  }
  const redactions: string[] = [];
  const rawLines = rawText.split(/\r?\n/);
  const fenced = removeFencedRegions(rawLines, redactions);

  const survivors: string[] = [];
  let inStack = false;
  for (const line of fenced) {
    if (line.trim() === '') {
      inStack = false;
      survivors.push(line);
      continue;
    }
    if (inStack && STACK_FRAME_RE.test(line)) {
      redactions.push('R4-stack-trace');
      continue;
    }
    inStack = false;

    if (STACK_HEADER_RE.test(line)) {
      redactions.push('R4-stack-trace');
      inStack = true;
      continue;
    }
    if (/^(?:\t| {4,})\S/.test(line)) {
      redactions.push('R2-indented-code');
      continue;
    }
    if (line.includes('`')) {
      redactions.push('R3-inline-code');
    }
    const withoutInline = line.replace(/`[^`]*`/g, ' ');

    if (isLogLine(withoutInline)) {
      redactions.push('R5-log-line');
      continue;
    }
    if (isErrorLine(withoutInline)) {
      redactions.push('R6-error-line');
      continue;
    }
    if (DIFF_RE.test(withoutInline) || isPorcelainStatus(withoutInline)) {
      redactions.push('R7-diff-status');
      continue;
    }
    if (isShellCommandLine(withoutInline)) {
      redactions.push('R8-shell-command');
      continue;
    }
    if (isBareShellCommand(withoutInline)) {
      redactions.push('R8-shell-command');
      continue;
    }
    if (isLocatorOnly(withoutInline)) {
      redactions.push('R9-locator-only');
      continue;
    }
    const redacted = redactLine(withoutInline);
    if (redacted.dropLine) {
      redactions.push('R13-code-line');
      continue;
    }
    if (redacted.redactedTokens > 0) redactions.push('R12-code-token');
    survivors.push(redacted.text);
  }

  const normalized = capLength(normalize(survivors), redactions);

  if (normalized.length === 0) {
    return { filteredText: null, skipReason: 'empty_after_filter', redactions: unique(redactions) };
  }
  if (countWords(normalized) < 4) {
    return { filteredText: null, skipReason: 'too_short', redactions: unique(redactions) };
  }
  if (isTelegraphicCommand(normalized)) {
    return { filteredText: null, skipReason: 'telegraphic_command', redactions: unique(redactions) };
  }
  if (isLowNaturalLanguage(normalized)) {
    return { filteredText: null, skipReason: 'low_natural_language', redactions: unique(redactions) };
  }
  if (latinWordCount(normalized) < MIN_LATIN_WORDS && cjkCount(normalized) < MIN_CJK_CHARACTERS) {
    return { filteredText: null, skipReason: 'no_coachable_text', redactions: unique(redactions) };
  }
  return { filteredText: normalized, skipReason: null, redactions: unique(redactions) };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}