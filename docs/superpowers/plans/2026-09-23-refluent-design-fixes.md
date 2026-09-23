# Refluent Design Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the design defects that stop refluent from reaching its goal in a real Claude Code setup: fragmented per-project data, review prompts leaking into the agent context, a leaky privacy filter, a clobbered statusLine, and review grading that does not measure learning.

**Architecture:** refluent is a Node CLI that Claude Code runs as three hooks (`UserPromptSubmit`, `SessionStart`, `statusLine`). Every hook opens one local SQLite store and returns quickly. These fixes keep that shape. They move the store to a user-level directory, make the hook process record its own liveness, route the session-start notice to the user only, add a token-level redaction pass in front of the model, wrap the user's existing statusLine instead of replacing it, and rewrite answer grading.

**Tech Stack:** Node.js ≥ 22, TypeScript 5.8 (strict, NodeNext modules, `.js` import suffixes), better-sqlite3, ts-fsrs, vitest 3.

**Spec:** `docs/analysis-and-data-design.md` is the design being amended. The defects come from two independent reviews of the design in this session: one by Claude Code, one by the project's pi instance. Each task below names the defect it fixes.

## Global Constraints

- Node `>=22`. No new runtime or dev dependencies.
- Imports between source files use the `.js` suffix (`import { x } from './redact.js'`).
- The `UserPromptSubmit` hook prints nothing to stdout, ever. The message reaches the agent byte-for-byte.
- Every hook swallows its own errors and exits 0.
- Tests never touch the network or the real `~/.claude/settings.json`. Use `memoryDb()` from `tests/helpers.ts` and temp directories.
- Only filtered text may be placed in a model request body.
- Run everything from the repo root: `~/workspace/refluent`.

## Out of Scope

These came up in review. They need a product decision or are low impact, so this plan leaves them alone:

- An explicit "accept this suggestion" step before a knowledge point is created.
- Writing the `REFLUENT_MODEL_*` variables into Claude Code settings. Task 8 only makes a missing model visible.
- Deduplication by `message_id`, which Claude Code does not send. It is harmless.
- Process-per-invocation cost of the statusLine hook.

## File Map

| File | Change | Responsibility |
|---|---|---|
| `src/config.ts` | modify | Default data directory becomes `~/.refluent` |
| `src/db.ts` | modify | Seed `hook_seen_at` instead of `hook_loaded` |
| `src/settings.ts` | modify | Capture enablement; `markHookSeen`; honest `hookStatus` |
| `src/install.ts` | modify | Registration check; statusLine wrapping; backup; uninstall |
| `src/hook.ts` | modify | Liveness marks; JSON `systemMessage`; wrapped statusLine |
| `src/review.ts` | modify | `renderDueNotice`; `containsTarget`; new grading |
| `src/capture.ts` | modify | Instances store filtered text |
| `src/redact.ts` | create | Token redaction, code-line and shell-command detection |
| `src/filter.ts` | modify | Wire in redaction; CJK-aware counting; `no_english` gate |
| `src/statusline.ts` | modify | Freshness window; "analysis unavailable" notice |
| `src/analysis/http.ts` | modify | Remove a self-comparison that guarded nothing |
| `src/cli.ts` | modify | `uninstall` command; new reason labels |
| `tests/config.test.ts` | create | Data directory default |
| `tests/redact.test.ts` | create | Redaction unit tests |
| `tests/filter-privacy.test.ts` | create | Filter v2 privacy behaviour |
| `tests/filter-mixing.test.ts` | create | Chinese-English counting |
| `tests/review-grading.test.ts` | create | Grading rules |
| `tests/statusline.test.ts` | create | Freshness, wrapping, uninstall |
| `tests/hook.test.ts`, `tests/review.test.ts`, `tests/settings-and-install.test.ts`, `tests/filter.test.ts` | modify | Follow the changed behaviour |
| `docs/analysis-and-data-design.md` | modify | Keep the design doc true |

---

### Task 0: Baseline commit on a work branch

Everything in the repo except the initial commit is untracked. Commit the current state so every later task has a clean diff.

**Files:** none changed.

- [ ] **Step 1: Confirm the suite is green before any change**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: `Tests  80 passed (80)` and no type errors.

- [ ] **Step 2: Create a branch and commit the baseline**

```bash
git checkout -b fix/design-defects
git add .gitignore package.json package-lock.json tsconfig.json bin hooks src tests scripts docs .pi .allforai
git commit -m "chore: baseline of the refluent MVP before design fixes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

`dist/`, `node_modules/` and `.refluent/` are already ignored by `.gitignore`.

---

### Task 1: One user-level data store

**Defect:** `dataDir()` defaults to `process.cwd()/.refluent`. Claude Code runs hooks with the project as cwd, so every repository gets its own database. Knowledge points never accumulate across projects. The raw-message database can also be committed into other repositories, because their `.gitignore` files do not know about it.

**Files:**
- Modify: `src/config.ts:4-13`
- Create: `tests/config.test.ts`

**Interfaces:**
- Produces: `dataDir(): string` returns `path.join(os.homedir(), '.refluent')` unless `REFLUENT_DATA_DIR` is set. `dbPath()` is unchanged in shape.

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL. The first test gets `<repo>/.refluent`.

- [ ] **Step 3: Implement**

In `src/config.ts`, replace the doc comment and `dataDir()`:

```ts
/**
 * Runtime paths and environment boundary for refluent.
 *
 * Everything learner-owned lives under one user-level directory, so knowledge
 * points accumulate across every project and never land inside a repository.
 * Deleting it removes all local data (no server copy exists).
 */
export function dataDir(): string {
  const override = process.env.REFLUENT_DATA_DIR?.trim();
  return override && override.length > 0 ? override : path.join(os.homedir(), '.refluent');
}
```

`os` is already imported in this file.

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: all pass. The existing install tests set `REFLUENT_DATA_DIR`, so they are unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "fix: store learner data in ~/.refluent instead of each project's cwd

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Honest hook liveness

**Defect:** Capture only turns on when `hook_loaded` is `'true'`. Install sets that flag after checking that the settings file contains the string `refluent`. That proves registration, not that Claude Code runs the hook. After Task 1 there is one database, so the right signal is simple: the hook process writes a timestamp each time it runs.

**Files:**
- Modify: `src/db.ts` (`SETTING_DEFAULTS`)
- Modify: `src/settings.ts` (`effectiveCaptureEnabled`, `hookStatus`, new `markHookSeen`)
- Modify: `src/install.ts` (`verifyHookConfig` comment, `runInstall`)
- Modify: `src/cli.ts` (install output, reason labels)
- Modify: `src/hook.ts` (`handleUserPromptSubmit`)
- Modify: `tests/settings-and-install.test.ts`, `tests/hook.test.ts`

**Interfaces:**
- Produces: `markHookSeen(db: DatabaseType, at?: string): void` in `src/settings.ts`.
- Produces: `effectiveCaptureEnabled` returns reasons `'preference_off' | 'hook_not_installed' | 'hook_installed'`.
- Produces: `hookStatus` returns `'installed_and_loaded'` only when `hook_seen_at` is non-empty.
- Produces: setting key `hook_seen_at` (ISO timestamp or `''`). The key `hook_loaded` is no longer read or written.

- [ ] **Step 1: Update the tests to the new contract**

In `tests/settings-and-install.test.ts`, add `markHookSeen` to the import from `../src/settings.js`:

```ts
  getSetting,
  markHookSeen,
  setSetting,
} from '../src/settings.js';
```

Replace the two tests `reports installed_not_loaded until Claude Code registration is confirmed` and `is enabled only when the preference is on and the hook is installed and loaded`, plus the first two lines of `an off preference wins over an installed and loaded hook`, with:

```ts
  it('enables capture once installed, but reports installed_not_loaded until the hook runs', () => {
    setSetting(db, 'hook_installed', 'true');
    expect(effectiveCaptureEnabled(db)).toEqual({ enabled: true, reason: 'hook_installed' });
    expect(hookStatus(db)).toBe('installed_not_loaded');
  });

  it('reports installed_and_loaded only after the hook process marked itself seen', () => {
    setSetting(db, 'hook_installed', 'true');
    markHookSeen(db, '2026-09-23T00:00:00.000Z');
    expect(hookStatus(db)).toBe('installed_and_loaded');
  });

  it('an off preference wins over an installed and loaded hook', () => {
    setSetting(db, 'hook_installed', 'true');
    markHookSeen(db);
```

The rest of that last test stays as it is.

In `reports hook status, endpoint liveness and capture reason from stored state`, replace `setSetting(db, 'hook_loaded', 'true');` with `markHookSeen(db);`. Also change the last assertion to:

```ts
    expect(report.captureReason).toBe('hook_installed');
```

Rename `authorized consent writes the hooks and records installed_and_loaded` to `authorized consent writes the hooks and enables capture, but does not claim loaded`. Then change its assertions:

```ts
    expect(report.installed).toBe(true);
    expect(report.hookLoaded).toBe(false);
    expect(report.hookStatus).toEqual({ installed: true, loaded: false });
```

and at the end of the same test:

```ts
    expect(effectiveCaptureEnabled(db)).toEqual({ enabled: true, reason: 'hook_installed' });
    expect(hookStatus(db)).toBe('installed_not_loaded');
```

In `tests/hook.test.ts`, delete the line `setSetting(db, 'hook_loaded', 'true');` in `beforeEach`. Then append this block at the end of the file:

```ts
describe('hook: liveness is recorded by the hook process itself', () => {
  it('marks the hook seen whenever Claude Code runs the capture hook', async () => {
    const { hookStatus } = await import('../src/settings.js');
    expect(hookStatus(db)).toBe('installed_not_loaded');
    await handleUserPromptSubmit(input, deps());
    expect(hookStatus(db)).toBe('installed_and_loaded');
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/settings-and-install.test.ts tests/hook.test.ts`
Expected: FAIL. `markHookSeen` is not exported and the reasons differ.

- [ ] **Step 3: Implement**

In `src/db.ts` `SETTING_DEFAULTS`, replace `hook_loaded: 'false',` with:

```ts
  hook_seen_at: '',
```

In `src/settings.ts`, replace the doc comment and body of `effectiveCaptureEnabled`, and add `markHookSeen` after it:

```ts
/**
 * The capture switch shows an *effective* value derived from the preference and
 * the install state. Whether Claude Code really runs the hook is reported
 * separately by `hookStatus`, from a timestamp the hook itself writes.
 */
export function effectiveCaptureEnabled(db: DatabaseType): CaptureEnablement {
  const pref = getSetting(db, 'capture-enabled') ?? 'off';
  if (pref !== 'on') return { enabled: false, reason: 'preference_off' };
  if (getSetting(db, 'hook_installed') !== 'true') return { enabled: false, reason: 'hook_not_installed' };
  return { enabled: true, reason: 'hook_installed' };
}

/** Called by the hook process itself: the only proof that Claude Code loaded it. */
export function markHookSeen(db: DatabaseType, at: string = nowIso()): void {
  setSetting(db, 'hook_seen_at', at);
}
```

Replace `hookStatus` in the same file:

```ts
export function hookStatus(db: DatabaseType): 'installed_and_loaded' | 'installed_not_loaded' | 'not_installed' {
  if (getSetting(db, 'hook_installed') !== 'true') return 'not_installed';
  return (getSetting(db, 'hook_seen_at') ?? '') !== '' ? 'installed_and_loaded' : 'installed_not_loaded';
}
```

In `src/install.ts`:

1. Change the settings import to `import { getSetting, setSetting } from './settings.js';`.
2. Delete both lines `setSetting(db, 'hook_loaded', 'false');`. One is in the not-writable branch and one is in the declined branch.
3. Replace the doc comment above `verifyHookConfig`:

```ts
/**
 * Whether the settings file still contains our hook registration. This proves
 * the hook is *registered*, not that Claude Code runs it: that is recorded by
 * the hook itself (see `markHookSeen`).
 */
```

4. Replace the consented block from `const loaded = verifyHookConfig(...)` through the first `messages.push(\`Wrote the ...\`)` with:

```ts
  const registered = verifyHookConfig(options.settingsPath);
  setSetting(db, 'hook_installed', registered ? 'true' : 'false');
  const loaded = (getSetting(db, 'hook_seen_at') ?? '') !== '';
  messages.push(`Wrote the UserPromptSubmit and SessionStart hooks and the statusLine to: ${options.settingsPath}`);
  if (!loaded) {
    messages.push('Claude Code has not run the hook yet: send any message there, then run `refluent settings` to confirm.');
  }
```

5. Replace the head of the final `return` object:

```ts
  return {
    installed: registered,
    captureEnabled: registered,
    hookPath: options.settingsPath,
    hookLoaded: loaded,
    hookStatus: { installed: registered, loaded },
```

In `src/cli.ts` `installCommand`, replace the capture output line:

```ts
  out(`  capture        : ${report.captureEnabled ? 'enabled' : 'not enabled'}`);
```

In `settingsCommand`, replace the two entries `hook_not_loaded` and `hook_installed_and_loaded` of `reasonText` with one entry:

```ts
      hook_installed: 'hook installed',
```

In `src/hook.ts`, add `markHookSeen` to the settings import:

```ts
import { effectiveCaptureEnabled, getSetting, markHookSeen, quietModeOn } from './settings.js';
```

Then make it the first statement inside the `try` of `handleUserPromptSubmit`:

```ts
  try {
    markHookSeen(deps.db);
    const payload = parseJson(inputText);
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/settings.ts src/install.ts src/cli.ts src/hook.ts tests/settings-and-install.test.ts tests/hook.test.ts
git commit -m "fix: report the hook as loaded only after the hook process has run

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Session-start notice goes to the user, not the agent

**Defect:** Claude Code injects the plain stdout of a `SessionStart` hook into the agent's context. The current teaser prints review prompts and the user's past sentences there. That breaks the rule against writing back into the agent context, and the user may never see it. The hook also calls the model up to three times in series with an 8-second timeout each, which delays the session. The fix sends one line as JSON `systemMessage`, which Claude Code shows to the user only. The line is built from a local count, with no model call.

**Files:**
- Modify: `src/hook.ts` (`handleSessionStart`, review import)
- Modify: `src/review.ts` (remove `ensureSessionStartQuestions` and `renderQuestionTeaser`, add `renderDueNotice`)
- Modify: `tests/hook.test.ts`, `tests/review.test.ts`

**Interfaces:**
- Consumes: `markHookSeen` from Task 2.
- Produces: `renderDueNotice(db: DatabaseType, now?: Date): string` in `src/review.ts`. It returns `''` when nothing is due.
- Removes: `ensureSessionStartQuestions` and `renderQuestionTeaser`. Nothing else in `src/` uses them.

- [ ] **Step 1: Update the tests**

In `tests/hook.test.ts`, replace the whole `describe('hook: session start offers 2-3 questions from history', ...)` header and its first test with:

```ts
describe('hook: session start notifies the user, never the agent', () => {
  it('emits a JSON systemMessage with only a count, and calls no model', async () => {
    seedPoint(db, { canonicalForm: 'look into', originalText: 'secret sentence one', issueClass: 'grammar_error' });
    seedPoint(db, { canonicalForm: 'walk through', originalText: 'secret sentence two', issueClass: 'grammar_error' });
    const client = new StubAnalysisClient(() => null);
    const result = await handleSessionStart('{}', deps({ client }));
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['systemMessage']);
    expect(payload.systemMessage).toContain('2 review item(s)');
    expect(payload.systemMessage).toContain('refluent review');
    expect(result.stdout).not.toContain('secret sentence');
    expect(client.calls.generateQuestion).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_questions').get()).toEqual({ n: 0 });
  });
```

Keep the existing `prints nothing when no knowledge point is due` test.

In `tests/review.test.ts`, change the import list: remove `ensureSessionStartQuestions` and `renderQuestionTeaser`, and add `renderDueNotice`:

```ts
  ensureReviewQuestions,
  gradeAnswer,
  questionContext,
  renderDueNotice,
  runReviewSession,
```

In `persists the question with its original-sentence context`, replace the three `teaser` lines with:

```ts
    expect(renderDueNotice(db)).toBe(
      'refluent: 1 review item(s) from your own sentences are due. Run `refluent review` in a terminal.',
    );
```

Replace `offers 2-3 due questions at session start and reuses the pending set` and the first line of `returns nothing when no knowledge point is due` with:

```ts
  it('reuses the pending set on the next review run', async () => {
    seedPoint(db, { canonicalForm: 'look into', originalText: 'one', issueClass: 'grammar_error' });
    seedPoint(db, { canonicalForm: 'walk through', originalText: 'two', issueClass: 'grammar_error' });
    const client = new StubAnalysisClient(() => null);

    const first = await ensureReviewQuestions(db, client);
    expect(first).toHaveLength(2);
    const again = await ensureReviewQuestions(db, client);
    expect(again.map((q) => q.id).sort()).toEqual(first.map((q) => q.id).sort());
  });

  it('returns nothing when no knowledge point is due', async () => {
    expect(renderDueNotice(db)).toBe('');
```

The `ensureReviewQuestions` assertion that follows stays.

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/hook.test.ts tests/review.test.ts`
Expected: FAIL. `renderDueNotice` is not exported and stdout is not JSON.

- [ ] **Step 3: Implement**

In `src/review.ts`, delete the whole `ensureSessionStartQuestions` function and its doc comment, which starts with `/**\n * Session-start selection:`. Also delete the whole `renderQuestionTeaser` function at the end of the file. Put this function in its place:

```ts
/**
 * The session-start notice. It carries only a count, never a prompt or an
 * original sentence, so nothing from past messages reaches the screen or the agent.
 */
export function renderDueNotice(db: DatabaseType, now: Date = new Date()): string {
  const due = selectDue(db, undefined, now).length;
  if (due === 0) return '';
  return `refluent: ${due} review item(s) from your own sentences are due. Run \`refluent review\` in a terminal.`;
}
```

In `src/hook.ts`, replace the review import:

```ts
import { renderDueNotice } from './review.js';
```

Then replace `handleSessionStart` and its comment:

```ts
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
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/hook.ts src/review.ts tests/hook.test.ts tests/review.test.ts
git commit -m "fix: show the session-start review notice to the user only, with no model call

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Instances keep only filtered text

**Defect:** `instances.original_text` stores the raw message. The statusLine and review prompts display that column, so pasted code and logs come back on screen. Review-answer instances store the raw answer as well. Raw text stays in `analysis_jobs.raw_text` only.

**Files:**
- Modify: `src/capture.ts` (`runAnalysis`, the `writePath` call)
- Modify: `src/review.ts` (`gradeAnswer`, the `writePath` call)
- Modify: `tests/hook.test.ts`

**Interfaces:** No signature changes.

- [ ] **Step 1: Write the failing assertion**

In `tests/hook.test.ts`, inside `keeps stdout empty even when analysis succeeds inline`, add these lines after the last `expect`:

```ts
    const stored = db.prepare('SELECT original_text FROM instances').get() as { original_text: string };
    const job = db.prepare("SELECT filtered_text FROM analysis_jobs WHERE message_id='evt-1'").get() as {
      filtered_text: string;
    };
    expect(stored.original_text).toBe(job.filtered_text);
    expect(stored.original_text).not.toContain('readToken');
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/hook.test.ts`
Expected: FAIL. `original_text` still contains the fenced code block.

- [ ] **Step 3: Implement**

In `src/capture.ts` `runAnalysis`, change the job passed to `writePath`:

```ts
    {
      analysisJobId: job.id,
      // Only the filtered text is kept on an instance: it is what the status
      // line and review prompts show, so raw code and logs never resurface.
      originalText: job.filtered_text,
```

`job.filtered_text` is non-null here, because the function returns early when it is null.

In `src/review.ts` `gradeAnswer`, replace the block that writes the answer instance:

```ts
  let instanceId: number | null = null;
  if (analysis && analysis.issue && filtered.filteredText) {
    const outcome = writePath(db, analysis, 'refluent:review', {
      originalText: filtered.filteredText,
      filterVersion: FILTER_VERSION,
    });
    instanceId = outcome.written ? (outcome.instanceId ?? null) : null;
  }
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts src/review.ts tests/hook.test.ts
git commit -m "fix: store only filtered text on instances so raw code never resurfaces

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Filter v2 redacts unfenced code

**Defect:** The filter only removes code that carries formatting, such as fences, backticks, indentation and log prefixes. Code without that formatting reaches the model unchanged. Verified leaks:

```
Can you fix the bug in src/db.ts? I think parseArgs() returns undefined.
npm run build --filter=@app/core --since origin/main
Look at the code below: function add(a, b) { return a + b }
I think the token = sk-live-abc123 is leaking somewhere
```

In the other direction, a line holding only `he/she` is deleted as a path. The client's "never send non-filtered text" check compares a variable with itself, so it guards nothing.

**Files:**
- Create: `src/redact.ts`
- Modify: `src/filter.ts` (version, locator rule, main loop)
- Modify: `src/analysis/http.ts:31-65`
- Create: `tests/redact.test.ts`, `tests/filter-privacy.test.ts`
- Modify: `tests/filter.test.ts` (version assertion)

**Interfaces:**
- Produces, in `src/redact.ts`:
  - `REDACTION_PLACEHOLDER = '[code]'`
  - `CODE_LINE_RATIO = 0.3`
  - `isCodeToken(core: string): boolean`
  - `isBareShellCommand(line: string): boolean`
  - `redactLine(line: string): { text: string; dropLine: boolean; redactedTokens: number }`
- Produces: `FILTER_VERSION = 'filter-v2'`. New redaction ids are `R12-code-token` and `R13-code-line`. `R8-shell-command` also covers bare commands such as `git push origin main`.

- [ ] **Step 1: Write the failing tests**

Create `tests/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isBareShellCommand, isCodeToken, redactLine } from '../src/redact.js';

describe('redact: code-like tokens are replaced, prose survives', () => {
  it('replaces a path and a call inside an otherwise natural sentence', () => {
    expect(redactLine('Can you fix the bug in src/db.ts? I think parseArgs() returns undefined.').text).toBe(
      'Can you fix the bug in [code]? I think [code] returns undefined.',
    );
  });

  it('replaces secrets, operators, hashes and email addresses', () => {
    expect(redactLine('I think the token = sk-live-abc123 is leaking somewhere').text).toBe(
      'I think the token [code] [code] is leaking somewhere',
    );
    expect(redactLine('The commit abc1234f broke it').text).toBe('The commit [code] broke it');
    expect(redactLine('Please email me at a@b.com about it').text).toBe('Please email me at [code] about it');
  });

  it('drops lines shaped like code or dominated by code tokens', () => {
    expect(redactLine('function add(a, b) { return a + b }').dropLine).toBe(true);
    expect(redactLine('const token = readToken();').dropLine).toBe(true);
    expect(redactLine('npm run build --filter=@app/core --since origin/main').dropLine).toBe(true);
  });

  it('leaves ordinary prose, abbreviations and slashed words alone', () => {
    for (const line of [
      'I think we should split this file.',
      '(see above) we need e.g. a fix, i.e. soon.',
      'he/she and/or 24/7 are fine here',
      '这里 is mixed language.',
    ]) {
      expect(redactLine(line)).toEqual({ text: line, dropLine: false, redactedTokens: 0 });
    }
  });

  it('classifies single tokens', () => {
    for (const t of ['README.md', './scripts', 'process.env', 'hook_installed', '--yes', 'ghp_abcdefghijkl']) {
      expect(isCodeToken(t)).toBe(true);
    }
    for (const t of ['bug', 'e.g', 'he/she', 'module']) {
      expect(isCodeToken(t)).toBe(false);
    }
  });

  it('recognises bare shell commands without metacharacters', () => {
    expect(isBareShellCommand('git push origin main')).toBe(true);
    expect(isBareShellCommand('go test ./...')).toBe(true);
    expect(isBareShellCommand('go ahead and merge it')).toBe(false);
    expect(isBareShellCommand('make sure the tests pass')).toBe(false);
  });
});
```

Create `tests/filter-privacy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filterNaturalLanguage } from '../src/filter.js';

describe('filter v2: unfenced code never reaches the model', () => {
  it('redacts identifiers and paths inside prose (R12)', () => {
    const result = filterNaturalLanguage('Can you fix the bug in src/db.ts? I think parseArgs() returns undefined.');
    expect(result.filteredText).toBe('Can you fix the bug in [code]? I think [code] returns undefined.');
    expect(result.redactions).toContain('R12-code-token');
  });

  it('drops unfenced code lines and keeps the prose around them (R13)', () => {
    const result = filterNaturalLanguage('Look at the code below and tell me why it fails:\nfunction add(a, b) { return a + b }');
    expect(result.filteredText).toBe('Look at the code below and tell me why it fails:');
    expect(result.redactions).toContain('R13-code-line');
  });

  it('drops bare shell commands without metacharacters (R8)', () => {
    const result = filterNaturalLanguage('I ran this and nothing happened at all.\ngit push origin main');
    expect(result.filteredText).toBe('I ran this and nothing happened at all.');
    expect(result.redactions).toContain('R8-shell-command');
  });

  it('never forwards a secret-looking token', () => {
    const result = filterNaturalLanguage('I think the token = sk-live-abc123 is leaking somewhere');
    expect(result.filteredText).not.toContain('sk-live');
  });

  it('keeps a slashed English word line instead of treating it as a path', () => {
    const result = filterNaturalLanguage('Ask whoever owns it, he/she will know the answer.');
    expect(result.filteredText).toBe('Ask whoever owns it, he/she will know the answer.');
  });
});
```

In `tests/filter.test.ts`, change the version assertion to:

```ts
    expect(FILTER_VERSION).toBe('filter-v2');
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/redact.test.ts tests/filter-privacy.test.ts tests/filter.test.ts`
Expected: FAIL. `src/redact.js` does not exist.

- [ ] **Step 3: Create `src/redact.ts`**

```ts
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
```

The trailing-punctuation class leaves out `)` on purpose. With `)` in the class, `parseArgs()` would become `[code])`.

- [ ] **Step 4: Wire it into `src/filter.ts`**

Replace the version line with an import plus the new version:

```ts
import { isBareShellCommand, isCodeToken, redactLine } from './redact.js';

export const FILTER_VERSION = 'filter-v2';
```

Replace `isLocatorOnly`:

```ts
function isLocatorOnly(line: string): boolean {
  const t = line.trim();
  if (!t || /\s/.test(t)) return false;
  return isCodeToken(t);
}
```

In the main loop of `filterNaturalLanguage`, replace the block from `if (isLocatorOnly(withoutInline)) {` through `survivors.push(withoutInline);` with:

```ts
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
```

- [ ] **Step 5: Remove the self-comparison in `src/analysis/http.ts`**

Delete these two lines in `analyze`:

```ts
    const message = body.messages[1];
    if (message.content !== content) return null; // defensive: never send a non-filtered string
```

Replace the privacy paragraph of the class doc comment:

```ts
 * Privacy boundary: `analyze` sends only the `filteredText` it is given. The
 * guarantee lives in `filterNaturalLanguage`, which every caller runs first;
 * `raw_text` never reaches this class.
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all pass. The existing R8, R9 and prose tests still pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/redact.ts src/filter.ts src/analysis/http.ts tests/redact.test.ts tests/filter-privacy.test.ts tests/filter.test.ts
git commit -m "fix: redact unfenced code, paths, identifiers and secrets before analysis

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Count Chinese-English mixed messages correctly

**Defect:** The length gate counts words by whitespace. A message such as `帮我look一下this bug` counts as 2 words and is skipped as `too_short`, although Chinese code-mixing is the highest-priority issue class. A mostly Chinese message that borrows one English term is not English practice at all. It gets a new skip reason, `no_english`.

**Files:**
- Modify: `src/filter.ts` (`SkipReason`, `countWords`, the gates)
- Create: `tests/filter-mixing.test.ts`

**Interfaces:**
- Produces: `countWords(text: string): number`, now exported. `SkipReason` gains `'no_english'`.

- [ ] **Step 1: Write the failing tests**

Create `tests/filter-mixing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { countWords, filterNaturalLanguage } from '../src/filter.js';

describe('filter v2: Chinese-English mixing', () => {
  it('counts each CJK ideograph and each embedded Latin word as a unit', () => {
    expect(countWords('帮我look一下this bug')).toBe(7);
    expect(countWords('run the tests')).toBe(3);
  });

  it('does not skip a spaceless mixed message as too_short', () => {
    const result = filterNaturalLanguage('帮我look一下this bug');
    expect(result.skipReason).toBeNull();
    expect(result.filteredText).toBe('帮我look一下this bug');
  });

  it('skips a Chinese message that only borrows one English term', () => {
    expect(filterNaturalLanguage('我觉得这个 function 有问题，帮我看看').skipReason).toBe('no_english');
  });

  it('keeps the numeric-only message as low_natural_language', () => {
    expect(filterNaturalLanguage('1234 5678 9012 3456').skipReason).toBe('low_natural_language');
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/filter-mixing.test.ts`
Expected: FAIL. `countWords` is not exported, and the mixed message is skipped as `too_short`.

- [ ] **Step 3: Implement**

In `src/filter.ts`, extend `SkipReason`:

```ts
  | 'low_natural_language'
  | 'no_english';
```

Replace `countWords`:

```ts
const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/g;
const LATIN_WORD_RE = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

function latinWordCount(text: string): number {
  return (text.match(LATIN_WORD_RE) ?? []).length;
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
```

After the `low_natural_language` gate in `filterNaturalLanguage`, add:

```ts
  if (latinWordCount(normalized) < 2) {
    return { filteredText: null, skipReason: 'no_english', redactions: unique(redactions) };
  }
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/filter.ts tests/filter-mixing.test.ts
git commit -m "fix: count CJK text in length gates and skip Chinese-only messages

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Grade what the learner actually produced

**Defect:** With the model available, any answer without an issue is graded `correct` with rating 3. An answer that avoids the target expression entirely still scores full marks. Offline, the answer is compared to a short canonical fragment with Jaccard ≥ 0.6. A correct full-sentence rewrite scores 1 (`again`), so FSRS keeps punishing points the learner already knows.

New rules:

| Knowledge point | Condition | Verdict | Rating |
|---|---|---|---|
| expression unit | answer does not contain the target | incorrect | 1 |
| expression unit | contains the target, model found another issue | correct | 2 |
| expression unit | contains the target, no issue or no model | correct | 3 |
| grammar rule | no model result | ungraded | none; schedule untouched |
| grammar rule | model found the same rule broken | incorrect | 1 |
| grammar rule | model found a different issue | correct | 2 |
| grammar rule | no issue | correct | 3 |

"Same rule" means the answer's `knowledge_point.rule_key` equals the point's `rule_key`. When the point has no `rule_key`, it falls back to the issue class.

**Files:**
- Modify: `src/review.ts` (`GradeResult`, new `containsTarget`, `gradeAnswer`, `runReviewSession` label, import)
- Create: `tests/review-grading.test.ts`

**Interfaces:**
- Consumes: the Task 4 version of the answer-instance block.
- Produces: `containsTarget(answer: string, target: string): boolean`. `GradeResult['verdict']` gains `'ungraded'`, which is stored as-is in `review_answers.verdict`.

- [ ] **Step 1: Write the failing tests**

Create `tests/review-grading.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb, seedPoint } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import type { AnalysisResult } from '../src/issue-classes.js';
import { StubAnalysisClient } from '../src/analysis/stub.js';
import { buildQuestion, containsTarget, createQuestionRow, gradeAnswer, selectDue, type QuestionRow } from '../src/review.js';

let db: DatabaseType;
beforeEach(() => {
  db = memoryDb();
});
afterEach(() => {
  db.close();
});

const noIssue: AnalysisResult = {
  issue: null,
  rewrite: '',
  reason: '',
  knowledge_point: null,
  recurrence_of_kp_id: null,
};

function tenseIssue(ruleKey: string): AnalysisResult {
  return {
    issue: { class: 'grammar_error', severity: 'high', span: 'finish', explanation: 'tense' },
    rewrite: 'I finished it yesterday.',
    reason: 'past simple',
    knowledge_point: { kind: 'grammar-rule', canonical_form: `rule ${ruleKey}`, explanation: 'x', rule_key: ruleKey },
    recurrence_of_kp_id: null,
  };
}

async function questionFor(kpId: number): Promise<QuestionRow> {
  const kp = selectDue(db).find((r) => r.id === kpId)!;
  return createQuestionRow(db, kpId, await buildQuestion(db, new StubAnalysisClient(() => null), kp));
}

function reviewState(kpId: number): unknown {
  return db.prepare('SELECT * FROM review_states WHERE knowledge_point_id = ?').get(kpId);
}

describe('grading: an expression unit must actually be used', () => {
  it('matches inflected forms of the target', () => {
    expect(containsTarget('I looked into the crash yesterday.', 'look into')).toBe(true);
    expect(containsTarget('I will check it.', 'look into')).toBe(false);
  });

  it('marks a fluent answer that avoids the target as incorrect', async () => {
    const kpId = seedPoint(db, { canonicalForm: 'look into', issueClass: 'chinglish_collocation' }).knowledgePointId!;
    const question = await questionFor(kpId);
    const result = await gradeAnswer(db, new StubAnalysisClient(() => noIssue), question, 'I will check it today.');
    expect(result.verdict).toBe('incorrect');
    expect(result.rating).toBe(1);
    expect(result.feedbackRewrite).toBe('look into');
  });

  it('marks an answer that uses the target without other issues as good', async () => {
    const kpId = seedPoint(db, { canonicalForm: 'look into', issueClass: 'chinglish_collocation' }).knowledgePointId!;
    const question = await questionFor(kpId);
    const result = await gradeAnswer(db, new StubAnalysisClient(() => noIssue), question, 'I looked into the crash yesterday.');
    expect(result.verdict).toBe('correct');
    expect(result.rating).toBe(3);
  });
});

describe('grading: a grammar rule needs the model', () => {
  function seedTense(): number {
    return seedPoint(db, {
      canonicalForm: 'past simple for finished actions',
      kind: 'grammar-rule',
      ruleKey: 'tense',
      issueClass: 'grammar_error',
    }).knowledgePointId!;
  }

  it('is ungraded offline and leaves the schedule untouched', async () => {
    const kpId = seedTense();
    const question = await questionFor(kpId);
    const before = reviewState(kpId);
    const result = await gradeAnswer(db, new StubAnalysisClient(() => null), question, 'I finished the migration yesterday.');
    expect(result.verdict).toBe('ungraded');
    expect(result.rating).toBeNull();
    expect(result.stateUpdated).toBe(false);
    expect(reviewState(kpId)).toEqual(before);
  });

  it('is incorrect only when the model finds the same rule broken', async () => {
    const kpId = seedTense();
    const question = await questionFor(kpId);
    const same = await gradeAnswer(db, new StubAnalysisClient(() => tenseIssue('tense')), question, 'I finish the migration yesterday.');
    expect(same.verdict).toBe('incorrect');
    expect(same.rating).toBe(1);

    const other = await gradeAnswer(db, new StubAnalysisClient(() => tenseIssue('article')), question, 'I finished migration yesterday.');
    expect(other.verdict).toBe('correct');
    expect(other.rating).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/review-grading.test.ts`
Expected: FAIL. `containsTarget` is not exported.

- [ ] **Step 3: Implement**

In `src/review.ts`:

1. Change the write-path import to drop `tokenJaccard`, which is no longer used:

```ts
import { writePath, normalizeCanonical } from './write-path.js';
```

2. Widen the verdict type in `GradeResult`:

```ts
  verdict: 'correct' | 'incorrect' | 'skipped' | 'ungraded';
```

3. Add `containsTarget` right above `const DUE_SELECT`:

```ts
/**
 * True when every token of the target expression appears in the answer. Words
 * of three or more letters may be inflected (`look` matches `looked`).
 */
export function containsTarget(answer: string, target: string): boolean {
  const answerTokens = normalizeCanonical(answer).split(' ').filter(Boolean);
  const targetTokens = normalizeCanonical(target).split(' ').filter(Boolean);
  if (targetTokens.length === 0) return false;
  return targetTokens.every((t) =>
    answerTokens.some((a) => a === t || (t.length >= 3 && a.startsWith(t))),
  );
}
```

4. In `gradeAnswer`, replace everything from `const target = question.expected ?? kp.canonical_form;` down to the line just before the `INSERT INTO review_answers` statement. That covers the old `reproduced`, `kpClass`, verdict, instance, schedule and feedback code:

```ts
  const target = question.expected ?? kp.canonical_form;
  const issue = analysis?.issue ?? null;

  let verdict: GradeResult['verdict'];
  let rating: RatingValue | null;
  if (kp.kind !== 'grammar-rule') {
    // An expression unit is learned only if the answer actually uses it.
    if (!containsTarget(trimmed, target)) {
      verdict = 'incorrect';
      rating = 1;
    } else {
      verdict = 'correct';
      rating = issue ? 2 : 3;
    }
  } else if (!analysis) {
    // A grammar rule cannot be judged by string matching; without the model the
    // answer is recorded but the schedule is left alone.
    verdict = 'ungraded';
    rating = null;
  } else {
    const sameRule = issue !== null && (kp.rule_key
      ? analysis.knowledge_point?.rule_key === kp.rule_key
      : issue.class === knowledgePointClass(db, kp.id));
    verdict = sameRule ? 'incorrect' : 'correct';
    rating = sameRule ? 1 : issue ? 2 : 3;
  }

  let instanceId: number | null = null;
  if (analysis && analysis.issue && filtered.filteredText) {
    const outcome = writePath(db, analysis, 'refluent:review', {
      originalText: filtered.filteredText,
      filterVersion: FILTER_VERSION,
    });
    instanceId = outcome.written ? (outcome.instanceId ?? null) : null;
  }

  const stateUpdated = rating === null ? false : updateSchedule(db, kp.id, rating, now);
  const feedbackRewrite = issue ? analysis!.rewrite : verdict === 'incorrect' ? target : null;
  const feedbackReason = issue
    ? analysis!.reason
    : verdict === 'ungraded'
      ? 'Could not grade this answer without the analysis model; your schedule is unchanged.'
      : verdict === 'correct'
        ? 'Looks good — no improvement needed.'
        : `Use the target expression: "${target}".`;

```

The `INSERT INTO review_answers` statement after it stays unchanged. It already writes `verdict` and `rating`, and `rating` may now be `null`.

5. In `runReviewSession`, replace the `verdictLabel` expression:

```ts
    const verdictLabel = result.verdict === 'skipped'
      ? 'Skipped'
      : result.verdict === 'ungraded'
        ? 'Not graded'
        : result.verdict === 'correct'
          ? 'Correct'
          : 'Needs work';
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all pass. The existing review tests still pass. `look into` contains its own target, and the grammar-error answer in `filters, analyzes and writes ...` does not contain `look into`, so it stays `incorrect`.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts tests/review-grading.test.ts
git commit -m "fix: grade review answers on target use, leave grammar ungraded offline

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Keep the user's statusLine, expire suggestions, add uninstall

**Defect:** Install sets `settings.statusLine` unconditionally. That replaces whatever the user had; on this machine it is Orca's statusLine command. There is no backup and no uninstall. The latest suggestion also stays on screen forever. When the model is not configured, every analysis fails silently.

**Files:**
- Modify: `src/install.ts` (`writeHookConfig` return, new `removeHookConfig`, `wrappedStatusLineCommand`, `runUninstall`, `WRAPPED_STATUSLINE_KEY`, `runInstall`)
- Modify: `src/statusline.ts` (freshness window, failure notice)
- Modify: `src/hook.ts` (`HookDeps.runStatusCommand`, `handleStatusline`)
- Modify: `src/cli.ts` (`uninstall` command, help)
- Create: `tests/statusline.test.ts`

**Interfaces:**
- Produces, in `src/install.ts`:
  - `writeHookConfig(settingsPath, nodePath, binPath): { previousStatusLine: Record<string, unknown> | null }`
  - `removeHookConfig(settingsPath: string, restoreStatusLine: Record<string, unknown> | null): void`
  - `WRAPPED_STATUSLINE_KEY = 'wrapped_statusline'`
  - `wrappedStatusLineCommand(db): string | null`
  - `runUninstall(db, settingsPath): string[]`
- Produces, in `src/statusline.ts`: `STATUSLINE_TTL_MS = 15 * 60 * 1000` and `renderStatusline(db, now?: Date): string`.
- Produces, in `src/hook.ts`: `HookDeps.runStatusCommand?: (command: string, input: string) => string`.

- [ ] **Step 1: Write the failing tests**

Create `tests/statusline.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryDb, seedPoint } from './helpers.js';
import type { DatabaseType } from '../src/db.js';
import { getSetting, setLastAnalysisResult, setSetting } from '../src/settings.js';
import { renderStatusline, STATUSLINE_TTL_MS } from '../src/statusline.js';
import { handleStatusline } from '../src/hook.js';
import { runInstall, runUninstall, WRAPPED_STATUSLINE_KEY } from '../src/install.js';

let db: DatabaseType;
let tmpDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  db = memoryDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refluent-statusline-'));
  savedDataDir = process.env.REFLUENT_DATA_DIR;
  process.env.REFLUENT_DATA_DIR = path.join(tmpDir, 'data');
});

afterEach(() => {
  db.close();
  if (savedDataDir === undefined) delete process.env.REFLUENT_DATA_DIR;
  else process.env.REFLUENT_DATA_DIR = savedDataDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('statusline: suggestions expire', () => {
  it('shows a fresh suggestion and hides it once it is older than the TTL', () => {
    seedPoint(db, { canonicalForm: 'look into', originalText: 'Can you help me look this bug?' });
    expect(renderStatusline(db)).toContain('refluent: ');
    const later = new Date(Date.now() + STATUSLINE_TTL_MS + 1000);
    expect(renderStatusline(db, later)).toBe('');
  });

  it('tells the user when analysis recently failed and there is nothing fresh to show', () => {
    setLastAnalysisResult(db, { outcome: 'failed', at: new Date().toISOString(), reason: 'analysis_unavailable' });
    expect(renderStatusline(db)).toBe('refluent: analysis unavailable (run `refluent settings`)');
  });
});

describe('statusline: an existing statusLine is kept, not replaced', () => {
  const orca = { type: 'command', command: '/opt/orca/statusline.sh', padding: 0 };

  function settingsWithOrca(): string {
    const settingsPath = path.join(tmpDir, 'claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: orca, model: 'opus' }), 'utf8');
    return settingsPath;
  }

  it('install wraps the previous statusLine, backs up the file, and keeps other keys', async () => {
    const settingsPath = settingsWithOrca();
    await runInstall(db, { consent: true, settingsPath, nodePath: 'node', binPath: '/x/bin/refluent', env: {} });

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, any>;
    expect(saved.statusLine.command).toContain('refluent');
    expect(saved.model).toBe('opus');
    expect(JSON.parse(getSetting(db, WRAPPED_STATUSLINE_KEY)!)).toEqual(orca);
    expect(JSON.parse(fs.readFileSync(`${settingsPath}.refluent-backup`, 'utf8')).statusLine).toEqual(orca);
  });

  it('runs the wrapped command with the hook input and prints its output above the refluent line', async () => {
    setSetting(db, WRAPPED_STATUSLINE_KEY, JSON.stringify(orca));
    seedPoint(db, { canonicalForm: 'look into', originalText: 'Can you help me look this bug?' });
    const seen: Array<[string, string]> = [];
    const result = await handleStatusline('{"model":"x"}', {
      db,
      runStatusCommand: (command, input) => {
        seen.push([command, input]);
        return 'orca: main ✓\n';
      },
    });
    expect(seen).toEqual([['/opt/orca/statusline.sh', '{"model":"x"}']]);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('orca: main ✓');
    expect(lines[1].startsWith('refluent: ')).toBe(true);
  });

  it('uninstall removes every refluent entry and restores the previous statusLine', async () => {
    const settingsPath = settingsWithOrca();
    await runInstall(db, { consent: true, settingsPath, nodePath: 'node', binPath: '/x/bin/refluent', env: {} });
    runUninstall(db, settingsPath);

    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, any>;
    expect(JSON.stringify(saved)).not.toContain('refluent');
    expect(saved.statusLine).toEqual(orca);
    expect(saved.model).toBe('opus');
    expect(getSetting(db, 'hook_installed')).toBe('false');
  });
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run tests/statusline.test.ts`
Expected: FAIL. `STATUSLINE_TTL_MS`, `runUninstall` and `WRAPPED_STATUSLINE_KEY` are not exported.

- [ ] **Step 3: Implement the statusline freshness window**

In `src/statusline.ts`:

1. Change the settings import:

```ts
import { getLastAnalysisResult, getSetting, quietModeOn } from './settings.js';
```

2. Add `createdAt: string;` as the last field of `Suggestion`. Then add these below `MAX_ORIGINAL_CHARS`:

```ts
/** A suggestion or failure notice is shown for this long after it was produced. */
export const STATUSLINE_TTL_MS = 15 * 60 * 1000;

function isFresh(at: string, now: Date): boolean {
  const t = Date.parse(at);
  return Number.isFinite(t) && now.getTime() - t <= STATUSLINE_TTL_MS;
}
```

3. In `latestSuggestion`, select `created_at`, add `created_at: string;` to the row type, and return `createdAt: row.created_at`:

```ts
      `SELECT id, original_text, rewrite_text, reason, issue_class, created_at
         FROM instances
```

4. Replace the start of `renderStatusline`, up to and including the `if (!suggestion) return '';` line:

```ts
export function renderStatusline(db: DatabaseType, now: Date = new Date()): string {
  if (quietModeOn(db)) return '';
  if ((getSetting(db, 'statusline-suggestion') ?? 'on') !== 'on') return '';

  const suggestion = latestSuggestion(db);
  if (!suggestion || !isFresh(suggestion.createdAt, now)) {
    const last = getLastAnalysisResult(db);
    if (last?.outcome === 'failed' && isFresh(last.at, now)) {
      return 'refluent: analysis unavailable (run `refluent settings`)';
    }
    return '';
  }
```

- [ ] **Step 4: Implement wrapping, backup and uninstall in `src/install.ts`**

Replace the `writeHookConfig` doc comment and its first three lines with:

```ts
function isRefluentEntry(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes('refluent');
}

export interface HookConfigWrite {
  /** The user's own statusLine that refluent now wraps, or null if there was none. */
  previousStatusLine: Record<string, unknown> | null;
}

/**
 * Merges the refluent hook registration into a Claude Code settings file.
 * Claude Code runs a single statusLine, so an existing non-refluent statusLine
 * is returned for the caller to keep and run from inside the refluent one. The
 * original file is copied once to `<settings>.refluent-backup`.
 */
export function writeHookConfig(settingsPath: string, nodePath: string, binPath: string): HookConfigWrite {
  const settings = readSettingsFile(settingsPath);
  const commands = hookCommands(nodePath, binPath);
  const backupPath = `${settingsPath}.refluent-backup`;
  if (fs.existsSync(settingsPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(settingsPath, backupPath);
  }
  const existing = settings.statusLine;
  const previousStatusLine =
    existing && typeof existing === 'object' && !isRefluentEntry(existing)
      ? (existing as Record<string, unknown>)
      : null;
```

At the end of `writeHookConfig`, after `fs.writeFileSync(...)`, add `return { previousStatusLine };`. Then add these below the function:

```ts
/** Removes every refluent entry and puts back the user's own statusLine, if one was wrapped. */
export function removeHookConfig(settingsPath: string, restoreStatusLine: Record<string, unknown> | null): void {
  if (!fs.existsSync(settingsPath)) return;
  const settings = readSettingsFile(settingsPath);
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, unknown>;
  for (const event of ['UserPromptSubmit', 'SessionStart']) {
    const kept = withoutRefluent(hooks[event]);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  settings.hooks = hooks;
  if (isRefluentEntry(settings.statusLine)) {
    if (restoreStatusLine) settings.statusLine = restoreStatusLine;
    else delete settings.statusLine;
  }
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export const WRAPPED_STATUSLINE_KEY = 'wrapped_statusline';

/** The wrapped statusLine command, if any; the refluent statusLine runs it first. */
export function wrappedStatusLineCommand(db: DatabaseType): string | null {
  const raw = getSetting(db, WRAPPED_STATUSLINE_KEY) ?? '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { command?: unknown };
    return typeof parsed.command === 'string' && parsed.command.length > 0 ? parsed.command : null;
  } catch {
    return null;
  }
}

export function runUninstall(db: DatabaseType, settingsPath: string): string[] {
  const raw = getSetting(db, WRAPPED_STATUSLINE_KEY) ?? '';
  let restore: Record<string, unknown> | null = null;
  try {
    restore = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    restore = null;
  }
  removeHookConfig(settingsPath, restore);
  setSetting(db, 'hook_installed', 'false');
  setSetting(db, 'hook_seen_at', '');
  setSetting(db, WRAPPED_STATUSLINE_KEY, '');
  return [
    `Removed the refluent hooks from: ${settingsPath}`,
    restore ? 'Restored your previous statusLine.' : 'Removed the refluent statusLine.',
    'Your knowledge points are kept; delete the data directory to remove them.',
  ];
}
```

In `runInstall`, replace the `writeHookConfig(...)` call:

```ts
  const { previousStatusLine } = writeHookConfig(options.settingsPath, nodePath, options.binPath);
  if (previousStatusLine) {
    setSetting(db, WRAPPED_STATUSLINE_KEY, JSON.stringify(previousStatusLine));
    messages.push('Your existing statusLine is kept: refluent runs it and adds its own line below.');
  }
```

- [ ] **Step 5: Run the wrapped command from the statusLine hook**

In `src/hook.ts`:

1. Change the child-process import to `import { execSync, spawn } from 'node:child_process';`.
2. Add `import { wrappedStatusLineCommand } from './install.js';` below the statusline import.
3. Add the optional dependency to `HookDeps`, and add a default runner below the interface:

```ts
  spawnDetached?: (jobId: number) => void;
  inlineAnalysis?: boolean;
  /** Runs the user's wrapped statusLine command with the hook input on stdin. */
  runStatusCommand?: (command: string, input: string) => string;
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
```

4. Replace `handleStatusline` and its comment:

```ts
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
    const line = renderStatusline(deps.db);
    if (line) lines.push(line);
  } catch {
    // Silent by design.
  }
  return { stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '', exitCode: 0 };
}
```

- [ ] **Step 6: Add the `uninstall` command to `src/cli.ts`**

Change the install import:

```ts
import { runInstall, runUninstall, probeEndpoint, recordEndpointProbe } from './install.js';
```

In `main`, add a case before `case 'settings':`:

```ts
    case 'uninstall': {
      const db = openDatabase();
      for (const line of runUninstall(db, claudeSettingsPath())) out(`  ${line}`);
      db.close();
      return 0;
    }
```

In `printHelp`, add this line above the `refluent settings [show]` line:

```ts
  out('  refluent uninstall                  remove the hooks and restore your own statusLine');
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all pass. The existing statusline hook tests still produce exactly one `refluent:` line, because no wrapped command is set.

- [ ] **Step 8: Commit**

```bash
git add src/install.ts src/statusline.ts src/hook.ts src/cli.ts tests/statusline.test.ts
git commit -m "fix: wrap the user's statusLine instead of replacing it; expire suggestions; add uninstall

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Update the design doc and verify in a real Claude Code session

**Files:**
- Modify: `docs/analysis-and-data-design.md`

- [ ] **Step 1: Bring the design doc in line with the code**

Edit `docs/analysis-and-data-design.md`:

- **§1 surface/review bullets.** The statusLine shows the latest suggestion for 15 minutes. It runs a wrapped user statusLine first. Session start emits one JSON `systemMessage` with the due count and never calls the model.
- **§2.** Change `filter-v1` to `filter-v2`. Add three rows to the Phase A table:
  - `R8-shell-command` also matches a bare command whose first word is `npm`, `git`, `docker` and the like, even without metacharacters.
  - `R12-code-token` replaces path, identifier, flag, operator, email, URL, hash and secret tokens with `[code]`.
  - `R13-code-line` drops a line that is shaped like code or whose redacted-token share is at least 0.3.

  In Phase B, G2 counts CJK ideographs and embedded Latin words as units. Add `G5-no-english`: fewer than 2 Latin words gives `no_english`.
- **§5.** Replace the rating paragraph with the table from Task 7, including `ungraded`, which leaves the schedule untouched.
- **§6.** The store becomes `~/.refluent/analysis-and-data.sqlite`. In the settings rows, replace `hook_loaded` with `hook_seen_at` and add `wrapped_statusline`. `review_answers.verdict` gains `ungraded`. `instances.original_text` holds the filtered text.
- **§7.** Replace "the privacy rule holds by construction" with this sentence: "The filter is a conservative heuristic: it redacts or drops anything code-shaped, and new leak patterns are added as regression tests in `tests/filter-privacy.test.ts`." Delete the sentence about the client refusing to send non-identical content.

- [ ] **Step 2: Full verification**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: every test passes, no type errors, and `dist/` rebuilds. The bin and hook wrappers load `dist/`, so the build is required.

- [ ] **Step 3: Verify inside a real Claude Code session**

The unit tests cannot prove how Claude Code treats hook output. Check it by hand, and record the result in the PR description.

```bash
cp ~/.claude/settings.json /tmp/claude-settings.before.json
node bin/refluent install --yes
node bin/refluent settings --no-probe   # expect: hook status installed_not_loaded
```

Then check each of these:

1. **Hook liveness.** Open Claude Code in a different repository and send any message. Then run `node bin/refluent settings --no-probe`. Expect `installed_and_loaded`, and no new `.refluent/` directory in that repository.
2. **Session-start notice.** Seed a due point by sending a message with a real mistake while the model is configured. Start a new session. Expect the `refluent: N review item(s) ...` notice to be visible to you. Ask Claude "what did the SessionStart hook tell you?" and expect it not to know.
3. **Wrapped statusLine.** Expect your previous statusLine output on the first line and the refluent line below it. If Claude Code shows only one line, change the join in `handleStatusline` from newline to `' · '` and rerun the Task 8 tests with the expectation updated.
4. **Uninstall.** Run `node bin/refluent uninstall`. Then run:

   ```bash
   diff <(jq -S . /tmp/claude-settings.before.json) <(jq -S . ~/.claude/settings.json)
   ```

   Expect no difference.

- [ ] **Step 4: Commit**

```bash
git add docs/analysis-and-data-design.md
git commit -m "docs: align the analysis-and-data design with the fixes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
