# Local readiness report — refluent

Date: 2026-09-23
Verified implementation commit: `9da1a290feb8451e02cb92ac2f033348079b662d`
(`git log` is the authority for the commit that adds this report.)

Scope: bring the already-reviewed delivery to a reproducible, verified, locally
committed state within the confirmed product requirements. No new product features, no
push, no deletion of existing work, no change to the user's real Claude Code
configuration or data.

## 1. Where the delivery actually stands

| Item | State | Evidence |
| --- | --- | --- |
| Workflow nodes | 19/19 `completed` | `.allforai/bootstrap/workflow.json` `transition_log` (36 entries) |
| Closure node | `close-design-fixes` published, `status: passed`, 9/9 intents with named evidence | `.allforai/bootstrap/close-design-fixes.json` |
| Runtime experience gate | `review-experience-runtime-fixes` attempt 4 `passed`; `must_fix_before_release=[]`, `quality_gaps=[]` | `.allforai/bootstrap/review-experience-runtime-fixes.json` |
| Product concept | direction + `learning-loop` both at revision 2, consistent ("session start = due-count notice only"); baseline v4 | `.allforai/product-concept/` |
| Accounting | `run_completed` + `local_readiness_pass` appended; earlier `run_blocked` / `repair_budget_conflict` / infra failures preserved | `.allforai/bootstrap/run-log.jsonl`, `run-summary.md` |

The recorded recovery path is intact and re-readable: `run_blocked`
(exhausted_obligations) → owner-authorized cycle-2 repair loop → attempt 4 passed →
closure. No ledger entry was re-priced or reset.

## 2. Product defects found by evidence and fixed

Both were on the status line — the surface that carries the product's whole value.

| Defect | Before | After | Evidence |
| --- | --- | --- | --- |
| Unbounded line: `original` was capped at 80 chars but `rewrite` and `reason` were unbounded, so a long suggestion pushed the rewrite itself off a narrow pane | 305 chars (a 200-char rewrite + 200-char reason) | 191 chars; worst case 250 | `src/statusline.ts`, `tests/statusline.test.ts`, probe output below |
| Truncation split a redaction placeholder | `[code] and [code] … and [c…` | `[code] and [code] … and…` (no partial token) | same |

Fix (minimal, in `src/statusline.ts`): per-field caps `original 80 / rewrite 80 / reason
60` (worst case 250 chars for the widest label) and a single placeholder-aware
`truncate()` that drops an unterminated `[code]` before adding the ellipsis.

Measured with the real renderer (`dist/`, temp `REFLUENT_DATA_DIR`, no user data):

```
B long rewrite+reason: before len=305  after len=191   (40-col rows: 8 -> 5)
D many placeholders:   before partialPlaceholder=true  after false  ([c… -> [code] …)
```

Third, smaller fix: `src/cli.ts` now ends quietly when stdout is closed by the reader
(`refluent settings | head`), instead of dying with an unhandled `EPIPE` stack trace.
Verified: pipeline exit 0, stderr 0 bytes.

Design doc kept true: `docs/analysis-and-data-design.md` §1 `surface` now states the
display budget and the placeholder rule.

## 3. Verification artifacts corrected

`scripts/verify-product-acceptance.mjs` (the committed end-to-end harness) was reporting
**2 stale failures** that encoded the pre-Task-3 behaviour — a reproducibility problem,
not a product defect:

- `new-session-2-3-questions` expected session start to print 2–3 numbered questions with
  `Context:`. Since Task 3 it emits one JSON `systemMessage` with the due count. Replaced
  by `session-start-notice-user-only`, which asserts the confirmed behaviour **and** that
  session start creates no `review_questions` row and leaks no stored sentence.
- `review-question-types-and-context` read the question table *before* `refluent review`
  ran (it used to be populated at session start). Moved after the review round, where it
  now observes the three production question types and their original-sentence context.

Added coverage for the gaps the coordinator named: `statusline-bounded-and-placeholder-safe`
(long text + 12 `[code]` placeholders), `uninstall-restores-user-settings` (last loop step,
byte-for-byte restoration of the user's own statusLine and keys), `closed-stdout-no-crash`.

Harness result: **24/24 checks passed** (`/tmp/e2e-committed.json`). It uses throwaway
`REFLUENT_DATA_DIR` / `REFLUENT_CLAUDE_SETTINGS` and a local fake OpenAI-compatible
endpoint, so no network and no real configuration are involved.

Critical checks it exercises end to end (real `bin/refluent`, real hook entrypoints, real
SQLite): install → capture (stdout 0 bytes, raw text byte-identical) → filtering (code /
logs / stack / imperative produce no knowledge point) → suggestion + knowledge point →
recurrence links instead of duplicating → session-start notice → review (3 types, each
with original context) → answer feeds back → privacy (no code/log/error token in any
model request) → offline readability → failed and slow analysis never delay or alter the
message → uninstall restores the user's settings.

## 4. Reproduction

README (`README.md`) now carries purpose, prerequisites, install/use/test/uninstall, data
and privacy, and known limits. Verified from a genuinely clean copy (no `node_modules`,
`dist`, or orchestration state):

```
npm ci            -> exit 0
npm run build     -> exit 0
npm test          -> 114 passed (13 files)
README isolated smoke (install -> capture hook -> settings) -> hook status installed_and_loaded
```

## 5. Checks at the verified commit

| Check | Result |
| --- | --- |
| `node --version` | v26.7.0 (engine requires >= 22) |
| `npm run typecheck` | exit 0, no output |
| `npm run build` | exit 0 |
| `npm test` | 114 passed / 114 (13 files) |
| `node scripts/verify-product-acceptance.mjs` | 24/24 |
| Worktree | clean (`git status --porcelain` empty) |
| Tracked files | 46 (implementation, tests, docs, config, harness) |
| Real `~/.claude/settings.json` | sha256 `bfafab88…` **unchanged**, 0 refluent entries |
| Real `~/.refluent` | absent (all runs used temp dirs) |

## 6. Git / tracking scope

- Commit `9da1a29` adds the implementation, tests, docs, entrypoints, config and the
  verification harness (46 files, 9568 insertions). Local only: **not pushed, not
  published, nothing deleted**.
- `.gitignore` now also excludes the myskills orchestration state (`.allforai/`, `.pi/`)
  because it holds captured terminal transcripts, freshness observations and the local
  decision journal rather than product source, plus `__pycache__/` for the copied
  orchestrator helpers. That state stays on disk untouched — it is excluded, not removed.
- A stray empty `./.refluent/` at the repo root (residue from an earlier probe) was
  removed; the design keeps learner data in `~/.refluent`.

## 7. Post-run state reconciliation (disclosed)

My post-run edits touched a tracked design document, so the run's recorded freshness went
`not_ready` and `external-changes` reported drift. That was reconciled with the protocol's
own boundary check rather than hidden, and the reconciliation is itself bookkeeping:

1. `{"operation":"external-changes"}` classified the only changed product document
   (`docs/analysis-and-data-design.md`) as **`fact-update`** for `verify-design-fixes` —
   the recorded acceptance still passes on the current source, so it is an implementation
   fact, not a product conflict.
2. `docs/progress/local-readiness.md` (this report) was initially unmapped and reported
   `uncertain`. It is a generated report, not product source, so it is now declared in
   `workflow.json.generated_outputs` — recorded in `reconciliation_applied` with the
   reason. That is a judgement call about tracking, stated here rather than buried.
3. The affected nodes' contracts and evidence were re-observed and republished in
   dependency order. **This re-binding asserts no new verification**: the substantive
   evidence for the changed surfaces is the fresh `npm test` (114/114) and harness run
   (24/24) at commit `9da1a29`, listed in §5.

Final state after reconciliation: `validate_bootstrap` passed, `check_decision_inputs`
OK, every node's artifacts `all_exist`, `readiness` **ready** (0 blockers),
`external-changes` **clear**.

## 8. Unresolved / disclosed

1. **Known, disclosed product limitations** (carried forward from the closed run, not
   defects): no screenshot manifest exists for a CLI, so the runtime critique recorded
   `insufficient_evidence`; `[code]` placeholders inside review context can read oddly for
   a sentence that was mostly code; one `src/review.ts` comment still attributes the
   pending-question table to session start (a comment-only nit).
2. **Display budget is a deliberate trade-off.** The line is bounded (≤250 chars) but not
   forced to fit a 40-column pane: `original → rewrite (why)` is inherently longer, and
   cutting to 40 columns would remove the rewrite the line exists to show. A narrower cap
   (`original/rewrite 60`, `reason 40`) is a one-line change if the coordinator prefers it.
3. **Worst-case line is 250 chars**, so on a very narrow pane it still wraps to ~5 rows at
   40 columns. Only the fields are capped; there is no width-adaptive mode.
4. **`docs/superpowers/plans/2026-09-23-refluent-design-fixes.md` contains one absolute
   machine path** (`~/workspace/refluent`). Left untouched on purpose: it is the
   plan record the run was audited against, and rewriting the user's plan was out of scope.
5. **Not verified in this pass**: Windows paths, a real paid model endpoint (the harness
   uses a local fake), and a real Claude Code TUI session (verified earlier in the run,
   not re-run here to avoid touching the user's configuration).
6. **`src/review.ts` comment nit** and the `docs/experience-review/*.md` historical review
   notes were left as-is; they are record, not claims about current behaviour.
7. **The run's recorded freshness was re-bound after my edits** (see §7). A reviewer who
   reads the node reports as fresh evidence for the *current* tree would be over-reading
   them: they describe the state at closure, before this pass. The pass's own evidence is
   §5.

## 9. Evidence locations

- Build/test/harness outputs: `/tmp/e2e-committed.json`, `/tmp/e2e-final.json` (this
  session); the harness writes a fresh JSON wherever it is pointed.
- The run's own evidence (orchestration state, on disk, untracked):
  `.allforai/bootstrap/verify-design-fixes.json`,
  `.allforai/bootstrap/review-experience-runtime-fixes.json`,
  `.allforai/bootstrap/close-design-fixes.json`,
  `.allforai/quality-checks/design-fixes-evidence/`.
