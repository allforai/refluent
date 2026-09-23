// Verification harness for the `verify-product-acceptance` workflow node.
//
// It drives the REAL product end to end: the real `bin/refluent` CLI and the
// real Claude Code hook entrypoints (`node bin/refluent hook ...`) run as child
// processes against a temp REFLUENT_DATA_DIR (real SQLite path) and a LOCAL fake
// OpenAI-compatible model endpoint, so the real HttpAnalysisClient path is
// exercised. The hook path itself is not mocked. Every observed value is read
// back from the real SQLite store or captured from the real process stdout.
//
// Usage:  node scripts/verify-product-acceptance.mjs [evidence-out.json]
// Output: a JSON report of raw commands, exit codes and observed output.

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
// The rendered column width is asserted exactly, so it comes from the same code the
// product uses (requires `npm run build`, which the harness already depends on).
import { displayWidth } from '../dist/statusline.js';

const PROJECT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN = path.join(PROJECT, 'bin', 'refluent');
const EVIDENCE_OUT = process.argv[2] ?? '/tmp/refluent-verify-evidence.json';

const checks = [];
function record(id, command, exitCode, observed, verdict, detail) {
  checks.push({ id, command, exit_code: exitCode, observed, verdict, detail: detail ?? null });
  const mark = verdict === 'passed' ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${id} :: ${observed}`);
}

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: PROJECT,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeoutMs ?? 0,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('close', (code) =>
      resolve({
        code,
        stdout,
        stderr,
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        elapsedMs: Date.now() - started,
      }),
    );
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  return db;
}

// `refluent review` is interactive: feed answers one at a time and only close
// stdin after the round finishes, so readline does not close mid-session.
function runReviewInteractive(env, lines) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, 'review'], {
      cwd: PROJECT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    let i = 0;
    const sendNext = () => {
      if (i < lines.length) {
        child.stdin.write(`${lines[i]}\n`);
        i += 1;
        setTimeout(sendNext, 350);
      } else {
        setTimeout(() => child.stdin.end(), 600);
      }
    };
    setTimeout(sendNext, 500);
    child.on('close', (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }));
  });
}

// ---------------------------------------------------------------------------
// Local fake OpenAI-compatible model endpoint.
// ---------------------------------------------------------------------------

const FORBIDDEN_TOKENS = [
  'computeTotal',
  'items.reduce',
  'Cannot read properties',
  'ERROR [main]',
  'connection refused',
  'at computeTotal',
  'Traceback (most recent call last)',
  'panic:',
];

function analysisResponse(text) {
  if (text.includes('看看') || text.includes('修复')) {
    return {
      // Two issues: the validator must keep exactly one (highest priority).
      issue: [
        { class: 'chinglish_collocation', severity: 'low', span: 'look', explanation: 'natural verb' },
        { class: 'chinese_code_mixing', severity: 'high', span: '看看', explanation: "write it in English" },
      ],
      rewrite: 'Can you help me look into this bug? I already fixed it, but the test still fails.',
      reason: 'Mixed Chinese with English; use the natural phrasal verb.',
      knowledge_point: {
        kind: 'expression-unit',
        canonical_form: 'look into',
        explanation: "investigate; use the phrasal verb 'look into'.",
        rule_key: null,
      },
      recurrence_of_kp_id: null,
    };
  }
  if (text.includes('She go to the office')) {
    return {
      issue: { class: 'grammar_error', severity: 'high', span: 'go / fail', explanation: 'third-person -s' },
      rewrite: 'She goes to the office every day and the build fails on her machine.',
      reason: 'Third-person singular verbs take -s.',
      knowledge_point: {
        kind: 'grammar-rule',
        canonical_form: 'third-person singular -s',
        explanation: 'Add -s to the verb with he/she/it in the present simple.',
        rule_key: 'singular-plural',
      },
      recurrence_of_kp_id: null,
    };
  }
  if (text.includes('Yesterday I go to the meeting')) {
    return {
      issue: { class: 'grammar_error', severity: 'high', span: 'go / tell', explanation: 'past tense' },
      rewrite: 'Yesterday I went to the meeting and I told them about the plan.',
      reason: 'Use the past tense for a finished past action.',
      knowledge_point: {
        kind: 'grammar-rule',
        canonical_form: 'past tense verb form',
        explanation: 'Use went/told for actions finished in the past.',
        rule_key: 'tense',
      },
      recurrence_of_kp_id: null,
    };
  }
  if (text.includes('look this bug')) {
    return {
      issue: { class: 'chinglish_collocation', severity: 'medium', span: 'look this bug', explanation: 'missing particle' },
      rewrite: 'Can you help me look into this bug?',
      reason: "Use the phrasal verb 'look into'.",
      knowledge_point: {
        kind: 'expression-unit',
        canonical_form: 'look into',
        explanation: "investigate; use the phrasal verb 'look into'.",
        rule_key: null,
      },
      recurrence_of_kp_id: null,
    };
  }
  return { issue: null, rewrite: text, reason: '', knowledge_point: null, recurrence_of_kp_id: null };
}

function questionResponse(payload) {
  if (payload.type === 'zh-to-en') {
    return {
      type: 'zh-to-en',
      prompt: '用英文表达：请帮我看看这个登录 bug。',
      expected: payload.canonical_form,
    };
  }
  if (payload.type === 'rewrite-original' && String(payload.canonical_form).includes('third-person')) {
    return {
      type: 'rewrite-original',
      prompt: 'Rewrite naturally: "He run the tests every morning."',
      expected: payload.canonical_form,
    };
  }
  if (String(payload.canonical_form).includes('past tense')) {
    return null; // forces the offline fill-in fallback
  }
  return { type: payload.type, prompt: `Practice: ${payload.canonical_form}`, expected: payload.canonical_form };
}

function startFakeServer({ mode = 'normal', delayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c.toString('utf8')));
    req.on('end', () => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        return;
      }
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        requests.push({ url: req.url, body: body });
        const finish = () => {
          if (mode === 'fail') {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
            return;
          }
          let parsed = {};
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = {};
          }
          const messages = parsed.messages ?? [];
          const system = String(messages[0]?.content ?? '');
          const user = String(messages[1]?.content ?? '');
          let content;
          if (system.startsWith('You are a concise English-writing coach')) {
            content = JSON.stringify(analysisResponse(user));
          } else if (system.startsWith('You generate one short English practice question')) {
            let payload = {};
            try {
              payload = JSON.parse(user);
            } catch {
              payload = {};
            }
            content = JSON.stringify(questionResponse(payload));
          } else {
            content = JSON.stringify({ issue: null, rewrite: user, reason: '' , knowledge_point: null, recurrence_of_kp_id: null });
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        };
        if (delayMs > 0) setTimeout(finish, delayMs);
        else finish();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        endpoint: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function mkTemp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `refluent-verify-${name}-`));
  return dir;
}

function settingsPathFor(dir) {
  return path.join(dir, 'claude-settings.json');
}

function dataDirFor(dir) {
  return path.join(dir, 'data');
}

function promptInput(prompt, id) {
  return JSON.stringify({ prompt, message_id: id, session_id: 'session-1' });
}

const M = {
  chinese: 'Can you help me 看看 this bug? I already 修复 it but the test still fail.',
  grammar1: 'She go to the office every day and the build fail on her machine.',
  grammar2: 'Yesterday I go to the meeting and I tell them about the plan.',
  recurrence: 'Can you help me look this bug? I want the phrasing to read naturally.',
  mixedCode:
    'Please refactor the helper below and keep the call site working.\n\n```ts\nfunction computeTotal(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\n```\nThe `computeTotal()` helper is used in checkout.',
  codeOnly: '```js\nconst x = computeTotal(rows);\n```',
  log: '2026-09-23 07:00:00 ERROR [main] failed to connect\n[ERROR] connection refused',
  stack:
    'Traceback (most recent call last):\n  File "parse.py", line 42, in parse\n    return computeTotal(items)\nTypeError: Cannot read properties of undefined (reading \'id\')\n    at computeTotal (/app/src/sum.js:3:9)',
  imperative: 'run tests',
};

async function main() {
  const dir = mkTemp('main');
  const dataDir = dataDirFor(dir);
  const dbFile = path.join(dataDir, 'analysis-and-data.sqlite');
  const server = await startFakeServer({ mode: 'normal' });
  const env = {
    REFLUENT_DATA_DIR: dataDir,
    REFLUENT_CLAUDE_SETTINGS: settingsPathFor(dir),
    REFLUENT_MODEL_ENDPOINT: server.endpoint,
    REFLUENT_MODEL: 'fake-model',
    REFLUENT_INLINE_ANALYSIS: '1',
    // The status line is fitted to the pane it will be rendered into, and this
    // harness has no pane. Pin the width so the bounded shape below is asserted
    // deterministically instead of depending on whatever TTY ran the tests; the
    // fitted shape is asserted separately, with a pinned narrow width.
    REFLUENT_TERMINAL_COLUMNS: 'off',
  };

  // --- First run: install (real consent + hook config + endpoint probe) -------
  const install = await run(['install', '--yes'], { env });
  record(
    'install',
    `REFLUENT_DATA_DIR=${dataDir} node bin/refluent install --yes`,
    install.code,
    `exit ${install.code}; stdout has "endpoint status: ready"=${install.stdout.includes('endpoint status: ready')}`,
    install.code === 0 && install.stdout.includes('endpoint status: ready') ? 'passed' : 'failed',
    install.stdout,
  );

  const help = await run(['help'], { env });
  const db0 = openDb(dbFile);
  const tables = db0
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  db0.close();
  const hasCatalogTable = tables.some((t) => /lesson|catalog|course|curriculum/i.test(t));
  const surfaces = /no lesson catalog|lesson catalog/i.test(help.stdout);
  record(
    'target-users-surfaces',
    'node bin/refluent help  +  sqlite_master table list',
    help.code,
    `tables=[${tables.join(',')}]; lesson/catalog table present=${hasCatalogTable}; help lists course commands=${/lesson|course|catalog/i.test(help.stdout)}`,
    !hasCatalogTable && !/lesson|course|catalog/i.test(help.stdout) ? 'passed' : 'failed',
    help.stdout,
  );

  // --- Capture one real message (hook), inline analysis for determinism ------
  async function sendMessage(prompt, id) {
    const r = await run(['hook', 'user-prompt-submit'], { env, input: promptInput(prompt, id) });
    return r;
  }

  const m1 = await sendMessage(M.chinese, 'msg-1');
  record(
    'capture-filtered-no-action',
    `printf '<UserPromptSubmit JSON prompt="${M.chinese}">' | node bin/refluent hook user-prompt-submit`,
    m1.code,
    `exit ${m1.code}; stdout ${m1.stdoutBytes} bytes; stderr ${m1.stderrBytes} bytes`,
    m1.code === 0 && m1.stdoutBytes === 0 && m1.stderrBytes === 0 ? 'passed' : 'failed',
    m1.stdout + m1.stderr,
  );

  const db = openDb(dbFile);
  const job1 = db.prepare("SELECT * FROM analysis_jobs WHERE message_id='msg-1'").get();
  const exactBytes = job1 && Buffer.from(job1.raw_text, 'utf8').equals(Buffer.from(M.chinese, 'utf8'));
  record(
    'captured-bytes-exact',
    'read analysis_jobs WHERE message_id=msg-1',
    null,
    `raw_text byte-for-byte equal=${exactBytes}; filtered_text="${job1?.filtered_text}"; status=${job1?.status}; skip_reason=${job1?.skip_reason}`,
    exactBytes && job1?.status === 'done' && !job1?.skip_reason ? 'passed' : 'failed',
    JSON.stringify(job1),
  );

  const inst1 = db.prepare('SELECT * FROM instances WHERE analysis_job_id=?').all(job1.id);
  const kp1 = db.prepare("SELECT * FROM knowledge_points WHERE match_key='expression-unit:look into'").get();
  record(
    'suggestion-produced-stored',
    'read instances + knowledge_points after capture',
    null,
    `instances for job=${inst1.length}; issue_class=${inst1[0]?.issue_class}; rewrite="${inst1[0]?.rewrite_text}"; reason="${inst1[0]?.reason}"; kp.canonical_form=${kp1?.canonical_form}`,
    inst1.length === 1 && inst1[0]?.rewrite_text && inst1[0]?.reason && inst1[0]?.issue_class === 'chinese_code_mixing'
      ? 'passed'
      : 'failed',
    JSON.stringify({ inst1, kp1 }),
  );

  const statusline1 = await run(['hook', 'statusline'], { env });
  record(
    'suggestion-produced-stored',
    'node bin/refluent hook statusline',
    statusline1.code,
    `stdout="${statusline1.stdout.trim()}"`,
    statusline1.stdout.includes('→') && statusline1.stdout.includes('look into') ? 'passed' : 'failed',
    statusline1.stdout,
  );

  // Two more natural-language messages (a grammar error each) so the store has a
  // history to draw session-start questions from.
  const m2 = await sendMessage(M.grammar1, 'msg-2');
  const m3 = await sendMessage(M.grammar2, 'msg-3');
  record(
    'capture-filtered-no-action',
    'node bin/refluent hook user-prompt-submit (grammar messages msg-2, msg-3)',
    m2.code,
    `msg-2 exit=${m2.code} stdout=${m2.stdoutBytes}B; msg-3 exit=${m3.code} stdout=${m3.stdoutBytes}B; knowledge_points=${db.prepare('SELECT COUNT(*) AS n FROM knowledge_points').get().n}`,
    m2.code === 0 && m3.code === 0 && m2.stdoutBytes === 0 && m3.stdoutBytes === 0 ? 'passed' : 'failed',
    m2.stdout + m3.stdout,
  );

  // --- Imperative / code / log content produces no knowledge point -----------
  const before = db.prepare('SELECT COUNT(*) AS n FROM knowledge_points').get().n;
  const reqBefore = server.requests.length;
  const skipCases = [
    ['code-only', M.codeOnly],
    ['log', M.log],
    ['stack', M.stack],
    ['imperative', M.imperative],
  ];
  const skipObserved = [];
  for (const [name, text] of skipCases) {
    const r = await sendMessage(text, `msg-${name}`);
    const j = db.prepare('SELECT status, skip_reason FROM analysis_jobs WHERE message_id=?').get(`msg-${name}`);
    skipObserved.push(`${name}: exit=${r.code} status=${j?.status} skip=${j?.skip_reason} stdout=${r.stdoutBytes}B`);
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM knowledge_points').get().n;
  const reqAfter = server.requests.length;
  record(
    'imperative-code-log-no-kp',
    'node bin/refluent hook user-prompt-submit x4 (code-only, log, stack, imperative)',
    0,
    `${skipObserved.join(' | ')}; knowledge_points ${before}->${after}; model requests ${reqBefore}->${reqAfter}`,
    after === before && reqAfter === reqBefore && skipObserved.every((s) => s.includes('skip=')) ? 'passed' : 'failed',
    skipObserved.join('\n'),
  );

  // --- Cumulative knowledge points without opening a learning app ------------
  const accum = db.prepare('SELECT COUNT(*) AS n FROM knowledge_points').get().n;
  record(
    'accumulates-from-daily-work',
    'read knowledge_points after hook captures only (no review/CLI surface opened)',
    null,
    `knowledge_points=${accum}; review/learning app was never invoked before this read`,
    accum >= 1 ? 'passed' : 'failed',
    String(accum),
  );

  // --- First-run value without a course --------------------------------------
  record(
    'first-value-no-course',
    'install --yes then one hook message then statusline (no lesson step)',
    statusline1.code,
    `after install + 1 captured message the statusLine already shows: "${statusline1.stdout.trim()}"`,
    statusline1.stdout.includes('→') ? 'passed' : 'failed',
    statusline1.stdout,
  );

  // --- At most one lightweight suggestion (original/rewrite/why) -------------
  record(
    'one-suggestion-original-rewrite-why',
    'statusline format + instances-per-job',
    null,
    `one instance for job=${inst1.length}; statusline has original→rewrite(reason)=${statusline1.stdout.includes('→') && statusline1.stdout.includes('(')}; model returned 2 issues but stored issue_class=${inst1[0]?.issue_class}`,
    inst1.length === 1 && statusline1.stdout.includes('→') && statusline1.stdout.includes('(') ? 'passed' : 'failed',
    statusline1.stdout,
  );

  // --- Knowledge point canonical form + review state -------------------------
  const rs = db.prepare('SELECT * FROM review_states WHERE knowledge_point_id=?').get(kp1.id);
  record(
    'kp-canonical-review-state',
    'read knowledge_points + review_states',
    null,
    `kp.canonical_form="${kp1.canonical_form}"; kp.match_key="${kp1.match_key}"; review_states.state=${rs?.state}; reps=${rs?.reps}`,
    kp1?.canonical_form && kp1?.match_key && rs?.state === 'new' ? 'passed' : 'failed',
    JSON.stringify({ kp1, rs }),
  );

  // --- Recurrence links to existing knowledge point --------------------------
  const kpCountBeforeRecur = db.prepare('SELECT COUNT(*) AS n FROM knowledge_points').get().n;
  const m4 = await sendMessage(M.recurrence, 'msg-4');
  const kpAfter = db.prepare('SELECT * FROM knowledge_points WHERE match_key=?').get('expression-unit:look into');
  const kpCountAfter = db.prepare('SELECT COUNT(*) AS n FROM knowledge_points').get().n;
  const link4 = db
    .prepare(
      `SELECT l.role FROM instance_knowledge_points l
        JOIN instances i ON i.id=l.instance_id
       WHERE i.analysis_job_id=(SELECT id FROM analysis_jobs WHERE message_id='msg-4')`,
    )
    .get();
  record(
    'recurrence-links-not-duplicate',
    `node bin/refluent hook user-prompt-submit (2nd "look into" message)`,
    m4.code,
    `knowledge_points ${kpCountBeforeRecur}->${kpCountAfter}; occurrence_count=${kpAfter.occurrence_count}; link role=${link4?.role}`,
    kpCountAfter === kpCountBeforeRecur && kpAfter.occurrence_count === 2 && link4?.role === 'recurrence'
      ? 'passed'
      : 'failed',
    JSON.stringify({ kpAfter, link4 }),
  );

  // --- Recurrence pipeline also holds for a mixed code+prose message ---------
  const m5 = await sendMessage(M.mixedCode, 'msg-5');
  const job5 = db.prepare("SELECT * FROM analysis_jobs WHERE message_id='msg-5'").get();
  record(
    'code-stripped-before-model',
    `node bin/refluent hook user-prompt-submit (prose + fenced code + inline code)`,
    m5.code,
    `filtered_text="${job5?.filtered_text}"`,
    job5?.filtered_text && !/computeTotal|items\.reduce|function /.test(job5.filtered_text) ? 'passed' : 'failed',
    String(job5?.filtered_text),
  );

  // --- Session start: one due-count notice for the user, never the agent ----
  // The confirmed behaviour (Task 3) is a single JSON `systemMessage` carrying only the due
  // count and the `refluent review` pointer. Session start must not render question text,
  // must not leak a stored sentence, and must not create the pending review set.
  const questionsBeforeSessionStart = db.prepare('SELECT COUNT(*) AS n FROM review_questions').get().n;
  const sessionStart = await run(['hook', 'session-start'], { env });
  let notice = null;
  try {
    notice = JSON.parse(sessionStart.stdout);
  } catch {
    notice = null;
  }
  const noticeKeys = notice && typeof notice === 'object' ? Object.keys(notice) : [];
  const storedOriginals = db
    .prepare('SELECT DISTINCT original_text FROM instances WHERE original_text IS NOT NULL')
    .all()
    .map((r) => r.original_text);
  const leaksStoredSentence = storedOriginals.some(
    (t) => typeof t === 'string' && t.length > 0 && sessionStart.stdout.includes(t),
  );
  const questionsAfterSessionStart = db.prepare('SELECT COUNT(*) AS n FROM review_questions').get().n;
  record(
    'session-start-notice-user-only',
    'node bin/refluent hook session-start',
    sessionStart.code,
    `stdout=${JSON.stringify(sessionStart.stdout)}; keys=[${noticeKeys.join(',')}]; review_questions ${questionsBeforeSessionStart}->${questionsAfterSessionStart}; leaks a stored sentence=${leaksStoredSentence}`,
    sessionStart.code === 0 &&
      notice !== null &&
      noticeKeys.length === 1 &&
      noticeKeys[0] === 'systemMessage' &&
      /refluent: \d+ review item\(s\)/.test(String(notice.systemMessage)) &&
      String(notice.systemMessage).includes('refluent review') &&
      !leaksStoredSentence &&
      questionsAfterSessionStart === questionsBeforeSessionStart
      ? 'passed'
      : 'failed',
    sessionStart.stdout,
  );

  // --- Display budget: the status line stays bounded and keeps its placeholders --
  // The suggestion is the product's whole value, so it has to survive a narrow pane: the
  // rendered line is bounded and a redaction placeholder is never cut in half.
  const longOriginal = `Please ${'x'.repeat(60)} the call at src/db.ts and also check parseArgs() output now`;
  const placeholderOriginal = `${'[code] and '.repeat(12)}end`;
  db.prepare(
    `INSERT INTO instances (analysis_job_id, original_text, rewrite_text, reason, issue_class, source, filter_version, created_at)
     VALUES (NULL, ?, ?, ?, 'chinglish_collocation', 'refluent:capture', 'filter-v2', ?)`,
  ).run(
    longOriginal,
    'Can you help me look into this bug? I already fixed it, but the test still fails because the parser returns undefined for the empty argument list.',
    'Mixed Chinese with English; prefer the natural phrasal verb "look into" and keep the sentence in one clause.',
    new Date().toISOString(),
  );
  const longLine = (await run(['hook', 'statusline'], { env })).stdout.trimEnd();
  db.prepare(
    `INSERT INTO instances (analysis_job_id, original_text, rewrite_text, reason, issue_class, source, filter_version, created_at)
     VALUES (NULL, ?, ?, ?, 'chinglish_collocation', 'refluent:capture', 'filter-v2', ?)`,
  ).run(placeholderOriginal, 'Keep the sentence natural.', 'Chinglish.', new Date().toISOString());
  const placeholderLine = (await run(['hook', 'statusline'], { env })).stdout.trimEnd();
  const openedBrackets = (placeholderLine.match(/\[/g) ?? []).length;
  const completePlaceholders = (placeholderLine.match(/\[code\]/g) ?? []).length;
  record(
    'statusline-bounded-and-placeholder-safe',
    'node bin/refluent hook statusline with a long suggestion and with 12 [code] placeholders',
    0,
    `long-line chars=${longLine.length} (narrow 40-col rows=${Math.ceil(longLine.length / 40)}); placeholder-line chars=${placeholderLine.length}; '[' count=${openedBrackets} vs complete '[code]' count=${completePlaceholders}`,
    longLine.length <= 250 && longLine.includes('→') && openedBrackets === completePlaceholders && !/\[c…/.test(placeholderLine)
      ? 'passed'
      : 'failed',
    `${longLine}\n${placeholderLine}`,
  );

  // --- Narrow pane: the reason survives instead of being cut off ---------------
  // Claude Code truncates an over-wide status line with `…` and never wraps, so on a
  // narrow pane the line must give up the user's own sentence (already in the
  // transcript) rather than cut the rewrite or the reason.
  const narrowColumns = 67;
  const narrowBudget = narrowColumns - 4;
  // A fresh copy of the same long suggestion, so it is the latest one on the line.
  db.prepare(
    `INSERT INTO instances (analysis_job_id, original_text, rewrite_text, reason, issue_class, source, filter_version, created_at)
     VALUES (NULL, ?, ?, ?, 'chinglish_collocation', 'refluent:capture', 'filter-v2', ?)`,
  ).run(
    longOriginal,
    'Can you help me look into this bug? I already fixed it, but the test still fails because the parser returns undefined for the empty argument list.',
    'Mixed Chinese with English; prefer the natural phrasal verb "look into" and keep the sentence in one clause.',
    new Date().toISOString(),
  );
  const narrowLine = (
    await run(['hook', 'statusline'], { env: { ...env, REFLUENT_TERMINAL_COLUMNS: String(narrowColumns) } })
  ).stdout.trimEnd();
  const narrowWidth = displayWidth(narrowLine);
  record(
    'statusline-fits-a-narrow-pane',
    `REFLUENT_TERMINAL_COLUMNS=${narrowColumns} node bin/refluent hook statusline (same long suggestion)`,
    0,
    `width=${narrowWidth} of ${narrowBudget} columns; original dropped=${!narrowLine.includes('src/db.ts')}; rewrite kept=${narrowLine.includes('Can you help me')}; reason kept=${narrowLine.includes('Mixed Chinese')}; line="${narrowLine}"`,
    narrowWidth <= narrowBudget &&
    !narrowLine.includes('src/db.ts') &&
    narrowLine.includes('Can you help me') &&
    narrowLine.includes('Mixed Chinese')
      ? 'passed'
      : 'failed',
    narrowLine,
  );

  const reviewRun = await runReviewInteractive(env, [    'Can you help me look this bug in my code',
    'He runs the tests every morning.',
    'went',
  ]);
  const reviewInstances = db
    .prepare("SELECT i.* FROM instances i WHERE i.source='refluent:review' ORDER BY i.id DESC")
    .all();
  const answers = db.prepare('SELECT * FROM review_answers ORDER BY id').all();
  record(
    'review-answer-feedback-loop',
    "interactive stdin: 'Can you help me look this bug in my code' ; 'He runs the tests every morning.' ; 'went' | node bin/refluent review",
    reviewRun.code,
    `exit=${reviewRun.code}; review instances written=${reviewInstances.length}; answers=${answers.length}; answer ratings=[${answers.map((a) => a.rating).join(',')}]`,
    reviewRun.code === 0 && reviewInstances.length >= 1 && answers.length === 3 ? 'passed' : 'failed',
    reviewRun.stdout,
  );

  // --- Review round: production question types + original sentence context ---
  // The pending set is built by `refluent review` itself; session start no longer creates
  // it, so this reads the store after the round rather than before it.
  const questions = db.prepare('SELECT * FROM review_questions ORDER BY id').all();
  const types = [...new Set(questions.map((q) => q.type))];
  const contextTexts = questions.map(
    (q) => db.prepare('SELECT original_text FROM instances WHERE id=?').get(q.context_instance_id)?.original_text,
  );
  const allHaveContext =
    questions.length > 0 && contextTexts.every((t) => typeof t === 'string' && t.length > 0);
  record(
    'review-question-types-and-context',
    'node bin/refluent review (the review round builds its own pending set)',
    reviewRun.code,
    `types=[${types.join(',')}]; all questions have original context=${allHaveContext}; contexts=${JSON.stringify(contextTexts)}`,
    ['zh-to-en', 'rewrite-original', 'fill-in'].every((t) => types.includes(t)) && allHaveContext
      ? 'passed'
      : 'failed',
    JSON.stringify(questions),
  );

  // --- Privacy: no model request contains code / logs / error output ---------
  const bodies = server.requests.map((r) => r.body);
  const leaked = [];
  for (const b of bodies) for (const t of FORBIDDEN_TOKENS) if (b.includes(t)) leaked.push(t);
  const analyzeContents = [];
  for (const r of server.requests) {
    let parsed;
    try {
      parsed = JSON.parse(r.body);
    } catch {
      continue;
    }
    const system = String(parsed.messages?.[0]?.content ?? '');
    if (!system.startsWith('You are a concise English-writing coach')) continue;
    analyzeContents.push(String(parsed.messages?.[1]?.content ?? ''));
  }
  const filteredTexts = db
    .prepare('SELECT DISTINCT filtered_text FROM analysis_jobs WHERE filtered_text IS NOT NULL')
    .all()
    .map((r) => r.filtered_text);
  const rawCodeLogStack = db
    .prepare(
      "SELECT raw_text FROM analysis_jobs WHERE message_id IN ('msg-code-only','msg-log','msg-stack','msg-5')",
    )
    .all()
    .map((r) => r.raw_text);
  const analyzeMatchesFiltered = analyzeContents.filter((c) => filteredTexts.includes(c)).length;
  const rawEchoed = analyzeContents.filter((c) => rawCodeLogStack.includes(c));
  const mixedRequest = analyzeContents.find((c) => c.includes('refactor the helper'));
  const mixedCodeRaw = db.prepare("SELECT raw_text FROM analysis_jobs WHERE message_id='msg-5'").get()?.raw_text;
  record(
    'privacy-no-code-logs-errors',
    'inspect every request body received by the local model endpoint',
    null,
    `requests=${bodies.length}; analyze requests=${analyzeContents.length} (${analyzeMatchesFiltered} match a stored filtered_text; the remainder is the filtered review answer); forbidden-token leaks=${JSON.stringify(leaked)}; code/log/stack raw_text echoed to the model=${rawEchoed.length}; mixed-code request user content="${mixedRequest}"; equals raw_text=${mixedRequest === mixedCodeRaw}`,
    leaked.length === 0 && rawEchoed.length === 0 && mixedRequest && !/computeTotal/.test(mixedRequest) && mixedRequest !== mixedCodeRaw
      ? 'passed'
      : 'failed',
    JSON.stringify({ leaked, analyzeContentCount: analyzeContents.length, analyzeMatchesFiltered, rawEchoed, mixedRequest }),
  );

  // --- Offline: stop the model, read learner data from local SQLite ----------
  await server.close();
  const offlineEnv = { ...env };
  delete offlineEnv.REFLUENT_MODEL_ENDPOINT;
  delete offlineEnv.REFLUENT_MODEL;
  delete offlineEnv.REFLUENT_INLINE_ANALYSIS;
  const offlineStatus = await run(['hook', 'statusline'], { env: offlineEnv });
  const offlineReview = await run(['review'], { env: offlineEnv, input: 'q\n' });
  const dbFileExists = fs.existsSync(dbFile);
  record(
    'local-offline-readable',
    'stop model endpoint, unset REFLUENT_MODEL_*, then hook statusline + review',
    offlineStatus.code,
    `db file=${dbFile} exists=${dbFileExists}; offline statusline="${offlineStatus.stdout.trim()}"; offline review exit=${offlineReview.code}`,
    dbFileExists && offlineStatus.code === 0 && offlineStatus.stdout.includes('→') && offlineReview.code === 0
      ? 'passed'
      : 'failed',
    offlineStatus.stdout + '---\n' + offlineReview.stdout,
  );

  db.close();

  // --- (g)/(g2): failed and slow analysis never delay/alter the message -----
  // Failed endpoint (500 on chat completions), inline analysis.
  const failDir = mkTemp('fail');
  const failServer = await startFakeServer({ mode: 'fail' });
  const failEnv = {
    REFLUENT_DATA_DIR: dataDirFor(failDir),
    REFLUENT_CLAUDE_SETTINGS: settingsPathFor(failDir),
    REFLUENT_MODEL_ENDPOINT: failServer.endpoint,
    REFLUENT_MODEL: 'fake-model',
    REFLUENT_INLINE_ANALYSIS: '1',
  };
  await run(['install', '--yes'], { env: failEnv });
  const failHook = await run(['hook', 'user-prompt-submit'], {
    env: failEnv,
    input: promptInput(M.recurrence, 'fail-1'),
  });
  const failDb = openDb(path.join(dataDirFor(failDir), 'analysis-and-data.sqlite'));
  const failJob = failDb.prepare("SELECT * FROM analysis_jobs WHERE message_id='fail-1'").get();
  const failInstances = failDb.prepare('SELECT COUNT(*) AS n FROM instances').get().n;
  failDb.close();
  await failServer.close();
  record(
    'failed-analysis-no-effect',
    'endpoint returns HTTP 500; inline analysis; node bin/refluent hook user-prompt-submit',
    failHook.code,
    `exit=${failHook.code}; stdout=${failHook.stdoutBytes}B; stderr=${failHook.stderrBytes}B; job.status=${failJob?.status}; instances=${failInstances}`,
    failHook.code === 0 && failHook.stdoutBytes === 0 && failJob?.status === 'failed' && failInstances === 0
      ? 'passed'
      : 'failed',
    JSON.stringify(failJob),
  );

  // Slow endpoint (6s delay), detached analysis (production path: no inline flag).
  const slowDir = mkTemp('slow');
  const slowServer = await startFakeServer({ mode: 'normal', delayMs: 6000 });
  const slowEnv = {
    REFLUENT_DATA_DIR: dataDirFor(slowDir),
    REFLUENT_CLAUDE_SETTINGS: settingsPathFor(slowDir),
    REFLUENT_MODEL_ENDPOINT: slowServer.endpoint,
    REFLUENT_MODEL: 'fake-model',
  };
  await run(['install', '--yes'], { env: slowEnv, timeoutMs: 30000 });
  const slowHook = await run(['hook', 'user-prompt-submit'], {
    env: slowEnv,
    input: promptInput(M.recurrence, 'slow-1'),
  });
  const slowDb = openDb(path.join(dataDirFor(slowDir), 'analysis-and-data.sqlite'));
  const slowJob = slowDb.prepare("SELECT status FROM analysis_jobs WHERE message_id='slow-1'").get();
  slowDb.close();
  record(
    'slow-analysis-no-delay',
    'endpoint delays 6000ms; detached analysis (no REFLUENT_INLINE_ANALYSIS); node bin/refluent hook user-prompt-submit',
    slowHook.code,
    `hook elapsed=${slowHook.elapsedMs}ms while the model endpoint delays 6000ms; exit=${slowHook.code}; stdout=${slowHook.stdoutBytes}B; job was queued for detached analysis status=${slowJob?.status}`,
    slowHook.code === 0 && slowHook.stdoutBytes === 0 && slowHook.elapsedMs < 2000 && slowJob?.status === 'queued'
      ? 'passed'
      : 'failed',
    JSON.stringify({ slowHook, slowJob }),
  );
  await slowServer.close();

  // --- Codex and Pi capture through their own adapters -----------------------
  // Both are driven here exactly as their platform does: a Codex-shaped hook payload
  // (`hook_event_name` + `prompt`) and the Pi extension's own contract. The recorded
  // origin must name the agent, and Codex's hooks file must resolve against CODEX_HOME.
  const codexDir = mkTemp('codex');
  const codexHome = path.join(codexDir, 'orca-account-home');
  // The main fake endpoint is closed by this point in the run, so this check owns one.
  const codexServer = await startFakeServer({ mode: 'normal' });
  const codexEnv = {
    ...env,
    REFLUENT_DATA_DIR: dataDirFor(codexDir),
    REFLUENT_MODEL_ENDPOINT: codexServer.endpoint,
    CODEX_HOME: codexHome,
    REFLUENT_CODEX_SETTINGS: '',
  };
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, 'hooks.json'),
    `${JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/opt/orca/codex-hook.sh' }] }] } }, null, 2)}\n`,
    'utf8',
  );
  const codexInstall = await run(['install', '--agent', 'codex', '--yes'], { env: codexEnv });
  const codexHooksFile = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
  const codexHookJson = JSON.stringify(codexHooksFile);
  const codexKeepsOrca = codexHookJson.includes('/opt/orca/codex-hook.sh');
  const codexNoStatusline = !('statusLine' in codexHooksFile);
  const codexPayload = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'codex-session',
    // A prompt the fake model answers with an improvement (see analysisResponse).
    prompt: 'Can you help me look this bug',
  });
  await run(['hook', 'user-prompt-submit', '--agent', 'codex'], { env: codexEnv, input: codexPayload });
  const codexDb = openDb(path.join(dataDirFor(codexDir), 'analysis-and-data.sqlite'));
  const codexInstance = codexDb.prepare("SELECT source FROM instances WHERE source LIKE 'codex%' LIMIT 1").get();
  codexDb.close();
  await codexServer.close();
  record(
    'codex-capture-through-its-own-adapter',
    'CODEX_HOME=<account home> node bin/refluent install --agent codex --yes, then hook user-prompt-submit --agent codex',
    codexInstall.code,
    `hooks written under CODEX_HOME=${fs.existsSync(path.join(codexHome, 'hooks.json'))}; kept the other agent's hook=${codexKeepsOrca}; wrote no statusLine=${codexNoStatusline}; recorded origin=${codexInstance?.source ?? 'none'}`,
    codexInstall.code === 0 && codexKeepsOrca && codexNoStatusline && codexInstance?.source === 'codex:UserPromptSubmit'
      ? 'passed'
      : 'failed',
    JSON.stringify(codexHooksFile),
  );

  // --- Uninstall hands the user's own settings file back untouched -----------
  // Last step of the loop: after install wraps the hooks, uninstall must return the file
  // byte-for-byte to what the user had, including their own statusLine and unrelated keys.
  const unDir = mkTemp('uninstall');
  const unSettings = settingsPathFor(unDir);
  const unOriginal = {
    model: 'opus',
    statusLine: { type: 'command', command: '/opt/mine/statusline.sh', padding: 0 },
  };
  fs.mkdirSync(path.dirname(unSettings), { recursive: true });
  fs.writeFileSync(unSettings, `${JSON.stringify(unOriginal, null, 2)}\n`, 'utf8');
  const unEnv = { REFLUENT_DATA_DIR: dataDirFor(unDir), REFLUENT_CLAUDE_SETTINGS: unSettings };
  const unInstall = await run(['install', '--yes'], { env: unEnv });
  const wrapped = JSON.parse(fs.readFileSync(unSettings, 'utf8'));
  const unUninstall = await run(['uninstall'], { env: unEnv });
  const restored = JSON.parse(fs.readFileSync(unSettings, 'utf8'));
  const wrappedIsRefluent = String(wrapped?.statusLine?.command ?? '').includes('refluent');
  const restoredExactly = restored.model === unOriginal.model && restored.statusLine?.command === unOriginal.statusLine.command && !('hooks' in restored);
  record(
    'uninstall-restores-user-settings',
    'node bin/refluent install --yes ; node bin/refluent uninstall (user already had a statusLine)',
    unUninstall.code,
    `install exit=${unInstall.code}; installed statusLine wraps refluent=${wrappedIsRefluent}; after uninstall model=${restored.model}; statusLine restored=${restored.statusLine?.command === unOriginal.statusLine.command}; 'hooks' key present=${'hooks' in restored}`,
    unInstall.code === 0 && unUninstall.code === 0 && wrappedIsRefluent && restoredExactly ? 'passed' : 'failed',
    JSON.stringify({ wrapped, restored }),
  );

  // --- A closed stdout ends quietly instead of crashing -----------------------
  // `refluent settings | head` is a normal thing to type; the command must not answer a
  // consumer that stopped reading with an unhandled EPIPE stack trace.
  const epipeDir = mkTemp('epipe');
  const epipe = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'settings'], {
      cwd: PROJECT,
      env: {
        ...process.env,
        REFLUENT_DATA_DIR: dataDirFor(epipeDir),
        REFLUENT_CLAUDE_SETTINGS: settingsPathFor(epipeDir),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.stdout.once('data', () => child.stdout.destroy());
    child.on('close', (code) => resolve({ code, stderr }));
  });
  record(
    'closed-stdout-no-crash',
    'node bin/refluent settings with the reading end of stdout closed after the first chunk',
    epipe.code,
    `exit=${epipe.code}; stderr bytes=${Buffer.byteLength(epipe.stderr, 'utf8')}; stderr="${epipe.stderr.trim().slice(0, 120)}"`,
    epipe.code === 0 && epipe.stderr.trim() === '' ? 'passed' : 'failed',
    epipe.stderr,
  );

  // Shut down any detached analysis child left by the slow test.
  setTimeout(() => process.exit(0), 1500).unref();

  const report = {
    generated_at: new Date().toISOString(),
    harness: 'scripts/verify-product-acceptance.mjs',
    node_version: process.version,
    main_data_dir: dataDir,
    checks,
    model_requests: server.requests.map((r) => r.body),
  };
  fs.writeFileSync(EVIDENCE_OUT, JSON.stringify(report, null, 2));
  console.log(`\nEvidence written to ${EVIDENCE_OUT}`);
  const failed = checks.filter((c) => c.verdict !== 'passed');
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) console.log('FAILED:', failed.map((f) => f.id).join(', '));
}

main().catch((error) => {
  console.error('harness error:', error);
  process.exit(1);
});