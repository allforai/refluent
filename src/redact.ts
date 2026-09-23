/**
 * Token-level redaction for lines that mix prose with code.
 *
 * Conservative by design: when a token looks like a path, identifier, flag,
 * operator, address or secret, it is replaced with a neutral placeholder. A
 * line that is mostly such tokens, or that is shaped like code, is dropped.
 */

export const REDACTION_PLACEHOLDER = '[code]';
/** A line whose redacted-token share reaches this ratio is dropped entirely. */
export const CODE_LINE_RATIO = 0.3;

const CODE_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|json|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|zsh|bash|yml|yaml|toml|ini|md|sql|html|css|scss|lock|env|txt|log|sqlite|db';
const FILE_NAME_RE = new RegExp(`^[\\w.@-]+\\.(?:${CODE_EXTENSIONS})$`, 'i');

const CODE_TOKEN_TESTS: readonly RegExp[] = [
  /^https?:\/\//i, // URL
  /^www\./i, // bare web address
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/, // email address
  /[=<>{}[\];$|&`\\]/, // operators, brackets, shell metacharacters
  /^--?[A-Za-z][\w-]*(?:=.*)?$/, // CLI flag
  /^[A-Za-z_$][\w$.]*\(/, // call: parseArgs( / db.close(
  /^[a-z]+[A-Z]\w*$/, // camelCase
  /^[A-Z][a-z]+[A-Z]\w*$/, // PascalCase with two or more humps
  /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/, // snake_case / CONSTANT_CASE
  /^[a-z_$][\w$]{1,}\.[a-z_$][\w$]{1,}/, // member access: process.env
  /^(?:sk|pk|rk)-[\w-]{6,}$/, // API keys
  /^gh[pousr]_\w{10,}$/, // GitHub tokens
  /^AKIA[0-9A-Z]{12,}$/, // AWS access keys
  /^xox[abprs]-[\w-]+$/, // Slack tokens
  /^eyJ[\w-]+\./, // JWT
  /^(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}$/, // long mixed alphanumeric
  /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/, // commit hash
];

function isPathToken(core: string): boolean {
  if (FILE_NAME_RE.test(core)) return true;
  if (!/[/\\]/.test(core)) return false;
  if (/^(?:\.{1,2}\/|~\/|\/)/.test(core)) return true;
  if ((core.match(/\//g) ?? []).length >= 2) return true;
  return FILE_NAME_RE.test(core.split(/[/\\]/).pop() ?? '');
}

export function isCodeToken(core: string): boolean {
  if (core.length === 0) return false;
  return isPathToken(core) || CODE_TOKEN_TESTS.some((re) => re.test(core));
}

/** A line shaped like source code: ends in a brace/semicolon, has an arrow, or opens with a keyword. */
const CODE_LINE_RE =
  /[{};]\s*$|=>|^\s*(?:const|let|var|function|def|class|import|export|return|public|private|func|fn)\b.*[=({:]/;

const SHELL_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'npm', 'npx', 'pnpm', 'yarn', 'bun', 'git', 'cd', 'ls', 'grep', 'rg', 'rm', 'mkdir',
  'cp', 'mv', 'curl', 'wget', 'docker', 'kubectl', 'python', 'python3', 'pip', 'node',
  'cargo', 'brew', 'sudo', 'chmod', 'chown', 'tar', 'ssh', 'scp', 'sed', 'awk', 'vitest',
  'tsc', 'pytest', 'go',
]);

/** `git push origin main`: a command line whose first word is never an English word. */
export function isBareShellCommand(line: string): boolean {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length < 2) return false;
  const first = tokens[0];
  if (first === 'go') return /^(?:build|run|test|mod|get|vet|fmt|install)$/.test(tokens[1]);
  return SHELL_ONLY_COMMANDS.has(first);
}

export interface RedactedLine {
  text: string;
  dropLine: boolean;
  redactedTokens: number;
}

export function redactLine(line: string): RedactedLine {
  if (CODE_LINE_RE.test(line)) return { text: '', dropLine: true, redactedTokens: 0 };
  const tokens = line.split(/\s+/).filter((t) => t.length > 0);
  let redacted = 0;
  const out = tokens.map((token) => {
    const m = /^(.*?)([,.;:!?"']*)$/.exec(token);
    const core = m ? m[1] : token;
    const trail = m ? m[2] : '';
    if (!isCodeToken(core)) return token;
    redacted += 1;
    return `${REDACTION_PLACEHOLDER}${trail}`;
  });
  if (tokens.length > 0 && redacted / tokens.length >= CODE_LINE_RATIO) {
    return { text: '', dropLine: true, redactedTokens: redacted };
  }
  return { text: out.join(' '), dropLine: false, redactedTokens: redacted };
}
