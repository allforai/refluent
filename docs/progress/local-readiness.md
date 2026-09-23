# Local readiness report — refluent

Date: 2026-09-23
**Verified commit for this round: `2c8cf60`** (`git log` is the authority for the commit
that adds this report.)

Scope: bring the already-reviewed delivery to a reproducible, verified, locally committed
state within the confirmed product requirements. No new product features, no push, nothing
deleted, and the user's real Claude Code configuration and data were never touched.

---

## 1. What this round verified — against the current code

Everything in this section was produced by this round, on the tree at `2c8cf60`
(or its immediate parent, noted per item).

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run typecheck` | exit 0, no output | this round |
| `npm run build` | exit 0 | this round |
| `npm test` | **115 passed / 115** (13 files) | this round |
| `node scripts/verify-product-acceptance.mjs` | **24/24 checks passed** | `/tmp/e2e-r2.json` |
| Clean-directory reproduction | `npm ci` → `npm run build` → README install/capture/settings all succeed | temp copy without `node_modules`, `dist` or orchestration state |
| Status-line control-sequence probe | newline/tab/ANSI all absent from the rendered line | §3 |
| Unconfigured-endpoint probe | message **and** filtered text stored locally, job `failed`, no instance, failure notice shown | §3 |
| Real `~/.claude/settings.json` | sha256 `bfafab88…` unchanged, 0 refluent entries | this round |
| Real `~/.refluent` | absent (every run used temp dirs) | this round |
| Worktree | clean | this round |

## 2. What the closed run recorded — historical, not re-verified here

The workflow itself was closed **before** this pass, against an earlier tree. These
results are the record of that closure and are **not** evidence about the current code:

- 19/19 nodes `completed`; `close-design-fixes` `passed` with 9/9 intents carrying named
  evidence (`.allforai/bootstrap/close-design-fixes.json`).
- `verify-design-fixes` reported 23/23 acceptance, **including a real Claude Code 2.1.280
  session** (hook liveness, the session-start notice visible to the user and unknown to
  the agent, the wrapped status line rendering two lines, uninstall restoring settings).
  That session was run during the workflow, not in this pass.
- `review-experience-runtime-fixes` attempt 4 `passed` (`must_fix_before_release=[]`,
  `quality_gaps=[]`).
- Recovery on record: `run_blocked` (exhausted_obligations) → owner-authorized cycle-2
  repair loop → attempt 4 passed → closure. No ledger entry was re-priced or reset.

Explicitly: **the live-session and runtime-review conclusions above were not re-run in
this pass.** They describe the closure-time tree. This pass changed `src/statusline.ts`,
`src/cli.ts`, `tests/statusline.test.ts`, one sentence of `docs/analysis-and-data-design.md`
and `README.md`; the fresh evidence for those changes is §1 and §3.

## 3. Defects found by evidence and fixed

| # | Defect | Before → after | Where |
| --- | --- | --- | --- |
| 1 | `rewrite` and `reason` were unbounded, so a long suggestion pushed the rewrite itself off a narrow pane | 305 chars → 191; worst case bounded at 250 | `src/statusline.ts` |
| 2 | Truncation could split a redaction placeholder | `…and [c…` → `…and…` (never a partial `[code]`) | `src/statusline.ts` |
| 3 | Only `original` was folded to one line; ANSI escapes in `rewrite`/`reason` reached the terminal, contradicting the function's own "no control sequences" contract | ESC present → absent; newline/tab → single spaces | `src/statusline.ts`, repro below |
| 4 | A closed stdout (`node bin/refluent settings \| head`) crashed with an unhandled `EPIPE` stack trace | exit 0, stderr 0 bytes; **non-EPIPE stdout errors still fail** | `src/cli.ts` |

Reproduction for #3 (real renderer, temp `REFLUENT_DATA_DIR`, no user data), before → after:

```
reason: 'line one\nline two\u001b[31mRED\u001b[0m', rewrite: 'First line.\nSecond.\tTabbed.'
before: "... (Chinglish 搭配: line one line two\u001b[31mRED\u001b[0m)"   has newline=false tab=false ESC=true
after:  "... (Chinglish 搭配: line one line twoRED)"                    has newline=false tab=false ESC=false
```

Reproduction for #4:

```
$ REFLUENT_DATA_DIR=… node bin/refluent settings | head -3     # with pipefail
before: "Error: write EPIPE" stack trace, non-zero exit
after : pipeline exit 0, stderr 0 bytes
```

Fix #4 keeps failure semantics: the guard treats only `EPIPE` as a normal end and
rethrows every other stdout write error, so installing the listener does not swallow real
failures.

Design doc kept true: `docs/analysis-and-data-design.md` §1 `surface` states the display
budget, the placeholder rule and the control-sequence guarantee.

## 4. Verification artifacts corrected

`scripts/verify-product-acceptance.mjs` was reporting **2 stale failures** that encoded the
pre-Task-3 behaviour — a reproducibility problem, not a product defect:

- `new-session-2-3-questions` expected session start to print 2–3 numbered questions with
  `Context:`. Since Task 3 it emits one JSON `systemMessage` with the due count. Replaced
  by `session-start-notice-user-only`, which asserts the confirmed behaviour **and** that
  session start creates no `review_questions` row and leaks no stored sentence.
- `review-question-types-and-context` read the question table *before* `refluent review`
  ran (it used to be populated at session start). Moved after the review round.

Added coverage for the gaps the coordinator named: `statusline-bounded-and-placeholder-safe`
(long text + 12 `[code]` placeholders), `uninstall-restores-user-settings` (last loop step,
byte-for-byte restoration), `closed-stdout-no-crash`.

The harness exercises the loop end to end with the real `bin/refluent`, the real hook
entrypoints, real SQLite and a **local** fake OpenAI-compatible endpoint (no network, no
real configuration): install → capture (stdout 0 bytes, raw text byte-identical) → filtering
(no knowledge point from code/logs/stack/imperatives) → suggestion + knowledge point →
recurrence instead of duplicate → session-start notice → review (3 types, original context)
→ answer feedback → privacy (no code/log/error token in any model request) → offline
readability → failed/slow analysis never delay the message → uninstall restoration.

## 5. Reproduction

`README.md` carries purpose, prerequisites, install/use/test/uninstall, the data/privacy
boundary and known limits. Verified from a genuinely clean copy:

```
npm ci            -> exit 0
npm run build     -> exit 0
README install / capture / settings in an isolated temp dir -> hook status installed_and_loaded
```

## 6. Git / tracking scope

- `9da1a29` adds the implementation, tests, docs, entrypoints, config and harness (46 files).
  `2c8cf60` adds this round's fixes; `caa7546`/`c011bd3` add this report.
  **Local only: not pushed, nothing published or deleted.**
- `.gitignore` also excludes myskills orchestration state (`.allforai/`, `.pi/`) — it holds
  captured terminal transcripts, freshness observations and the local decision journal,
  not product source — plus `__pycache__/` for the copied orchestrator helpers. That state
  stays on disk untouched; it is excluded, not removed.
- A stray empty `./.refluent/` at the repo root (probe residue) was removed.

## 7. Post-run state reconciliation (disclosed)

This pass edited a tracked design document, so the run's recorded freshness went
`not_ready` and `external-changes` reported drift. It was reconciled with the protocol's
own boundary check rather than hidden:

1. `{"operation":"external-changes"}` classified the only changed product document as
   **`fact-update`** for `verify-design-fixes` — the recorded acceptance still passes on the
   current source, so it is an implementation fact, not a product conflict.
2. `docs/progress/local-readiness.md` (this report) was initially unmapped and reported
   `uncertain`. It is a generated report, not product source, so it is declared in
   `workflow.json.generated_outputs`, recorded in `reconciliation_applied` with the reason.
   That is a judgement call about tracking, stated here rather than buried.
3. Affected nodes were re-observed and republished in dependency order, using each node's
   declared artifact gate as the publish command.

**What that re-binding does and does not assert.** It restores the structural binding
between each node's inputs and the current tree; it runs no node's substantive acceptance
again. Read as evidence it would be over-read: the node reports describe the closure-time
state (§2), and the only node whose publish ran a content check was
`refresh-analysis-and-data-design`, whose `document_verification` executed against the
current document. The fresh evidence for the code changed in this pass is §1 and §3.

Final state after reconciliation: `validate_bootstrap` passed, `check_decision_inputs` OK,
every node's artifacts `all_exist`, `readiness` **ready** (0 blockers),
`external-changes` **clear**.

## 8. Unresolved / disclosed

1. **Known, disclosed product limitations** carried forward from the closed run: no
   screenshot manifest exists for a CLI (`insufficient_evidence` in the runtime critique);
   `[code]` placeholders inside review context can read oddly for a sentence that was
   mostly code; one `src/review.ts` comment still attributes the pending-question table to
   session start (comment-only nit). None of these were changed.
2. **The display budget is a deliberate trade-off.** The line is bounded (≤250 chars) but
   not forced to fit a 40-column pane: `original → rewrite (why)` is inherently longer, and
   cutting to 40 columns would remove the rewrite the line exists to show. A narrower cap
   (`original/rewrite 60`, `reason 40`) is a one-line change if the coordinator prefers it.
   Worst case still wraps to ~5 rows at 40 columns; there is no width-adaptive mode.
3. **Hooks were not re-exercised against a live Claude Code session in this round** — that
   would mean touching the user's real configuration. The earlier session evidence is
   historical (§2).
4. **Only the local fake endpoint is exercised.** Behaviour against a real paid endpoint
   (auth, model quirks, latency) is untested.
5. **One committed doc contains an absolute machine path**
   (`docs/superpowers/plans/2026-09-23-refluent-design-fixes.md`). Left untouched on
   purpose: it is the plan record the run was audited against.
6. **Windows paths are untested.**

## 9. Evidence locations

- This round: `/tmp/e2e-r2.json` (harness), plus the probe outputs quoted in §3.
- The run's own record (orchestration state, on disk, untracked):
  `.allforai/bootstrap/verify-design-fixes.json`,
  `.allforai/bootstrap/review-experience-runtime-fixes.json`,
  `.allforai/bootstrap/close-design-fixes.json`,
  `.allforai/bootstrap/run-log.jsonl`, `.allforai/bootstrap/run-summary.md`,
  `.allforai/quality-checks/design-fixes-evidence/`.
