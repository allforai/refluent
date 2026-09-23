# Refluent analysis-and-data design

Status: passed. Node: `refresh-analysis-and-data-design` (amends
`design-analysis-and-data`, now superseded). This document records the design as
amended by the refluent design fixes (Task 1-9) and mirrors
`.allforai/bootstrap/analysis-and-data-design.json` one-to-one: the same seven
decisions, the same filter rule ids, the same issue-class ids, the same tables and
columns, and the same scheduler rationale. MVP integrates Claude Code only; the
runtime is Node.js + TypeScript with a local better-sqlite3 store, tested with vitest,
and analysis runs against an environment-configured small model.

## 1. Pipeline and where each stage lives

The closed loop is `capture -> filter -> analyze -> write -> surface -> review ->
re-enter`, and each stage has one owner:

- **capture** - the Claude Code `UserPromptSubmit` hook forwards the outgoing message
  to the agent byte-for-byte first, then snapshots it into an `analysis_jobs` row.
  Capture never mutates the message.
- **filter** - the deterministic, dependency-free `filterNaturalLanguage()` function
  turns raw text into `filtered_text` or a `skip_reason` before any model call.
- **analyze** - `AnalysisClient.analyze()` receives only `filtered_text`, one call per
  message, off the critical path; on failure it returns `null` and touches nothing.
- **write** - `writePath()` runs one better-sqlite3 transaction that inserts the
  instance, links the knowledge point and upserts the review state.
- **surface** - the statusLine renders one line, `original -> rewrite (reason)`, from
  the latest stored instance and shows it for 15 minutes; it runs a wrapped user
  statusLine first, then adds its own line below. Nothing is written back into the agent
  context. Session start emits one JSON `systemMessage` carrying only the due count and
  never calls the model. The line has a bounded display budget — original and rewrite cap
  at 80 characters and the reason at 60 (worst case 250 characters) — and truncation never
  splits a `[code]` placeholder, so the rewrite keeps its place on a narrow pane instead of
  being pushed off it by the other two fields.
- **review** - `refluent review` selects the whole due set; the session-start notice is a
  count only, and the learner opens `refluent review` in a terminal to answer.
- **re-enter** - `gradeAnswer()` sends the answer through the same filter, the same
  client and the same write path.

## 2. Natural-language filter

`filterNaturalLanguage` has version `filter-v2` and two phases. Phase A removes code
and machine output:

| Rule | Detect | Action |
|---|---|---|
| R1-fenced-code | a region delimited by ` ``` ` or `~~~` fences, info string included | remove the whole region |
| R2-indented-code | consecutive lines indented >=4 spaces or one tab, bounded by blank lines | remove the block |
| R3-inline-code | a span wrapped in single backticks | remove the span |
| R4-stack-trace | `Traceback (most recent call last)`, `Caused by:`, or `  at ...(...)` followed by frame lines | remove header and frames |
| R5-log-line | a timestamp or `[INFO]/[WARN]/[ERROR]/[DEBUG]` level tag at line start | remove the line |
| R6-error-line | error/exception/panic/segfault/errno/exit-code phrases, or shell errors | remove the line |
| R7-diff-status | `diff --git`, `index `, `+++ `, `--- `, `@@`, `On branch `, porcelain status pairs | remove the line |
| R8-shell-command | a shell prompt (`$ `, `> `, `% `), a command line with shell metacharacters, or a bare command whose first word is `npm`, `git`, `docker` and the like even without metacharacters | remove the line |
| R9-locator-only | a single whitespace-free token that is code-shaped (a path, URL, or a token `isCodeToken` classifies), so `he/she` is kept | remove the line |
| R12-code-token | a path, identifier, flag, operator, email, URL, hash or secret token inside prose | replace the token with `[code]` |
| R13-code-line | a line shaped like code, or whose redacted-token share is at least 0.3 | remove the line |

Phase A ends with normalization: **R10-normalize** collapses whitespace to single
spaces, trims and applies NFC; **R11-length-cap** truncates at 1500 characters on a
word boundary when needed (a capped message is still analyzed).

Phase B gates decide whether the survivors are worth analyzing:

- **G1-empty-after-filter** - nothing survives -> skip.
- **G2-too-short** - fewer than 4 word units (e.g. `run tests`) -> skip. A unit is one
  whitespace token, except that a token containing CJK ideographs contributes one unit
  per ideograph plus one per embedded Latin word, so `帮我look一下this bug` counts as 7.
- **G3-telegraphic-command** - at most 8 words, starts with a command lexeme
  (`run, fix, add, remove, delete, check, test, build, install, commit, push, pull,
  deploy, revert, stop, continue, go, do, make, show, list, open, close, update,
  refactor, rename, move, merge, rebase, explain, review, read, write, edit, create,
  start, restart`), no `?` and no internal sentence punctuation -> skip.
- **G4-low-natural-language** - letters are less than half of non-space characters
  -> skip.
- **G5-no-english** - fewer than 2 Latin words -> skip (a Chinese message that only
  borrows one English term is not English practice).

A skip records the `skip_reason` and sets `analysis_jobs.status='filtered'`; no model
call is made. The filter is the single choke point between capture and egress. The filter
is a conservative heuristic: it redacts or drops anything code-shaped, and new leak
patterns are added as regression tests in `tests/filter-privacy.test.ts`.

## 3. Four issue classes and telegraphic tolerance

An analyzed message yields at most one suggestion, so the classifier selects the
single highest-priority issue: **chinese_code_mixing (1)** > **grammar_error (2)** >
**chinglish_collocation (3)** > **register_tone (4)**.

- `chinese_code_mixing` (中式夹英): CJK ideographs or pinyin inside an otherwise
  English sentence; rewrite replaces the Chinese span with natural English.
- `grammar_error` (语法错误): tense/aspect, subject-verb agreement, articles,
  prepositions, singular/plural, broken patterns, run-ons.
- `chinglish_collocation` (Chinglish 搭配): literal translation, false friend, or an
  unnatural collocation, e.g. `look this bug` -> `look into this bug`.
- `register_tone` (语域语气): register that misfits a professional request, e.g.
  `Please kindly be so good as to possibly check the logs.` -> `Could you check the logs?`.

Telegraphic agent-command style is tolerated as acceptable ellipsis, not an error.
Allowed patterns include bare imperatives with dropped subject, noun-fragment requests,
acknowledgements such as `looks good` / `LGTM` / `done`, and dropped articles where
meaning is unambiguous. If the only candidate issue for such a message would be
grammar, collocation or register, the model must return `issue=null`;
`chinese_code_mixing` may still be flagged because it is a vocabulary gap.

The model returns one JSON object with `issue` (`null` or class/severity/span/
explanation), `rewrite`, `reason`, `knowledge_point` (`null` or `kind`/`canonical_form`/
`explanation`/`rule_key`) and `recurrence_of_kp_id`. Invariants: at most one issue;
`issue=null` implies no knowledge point and no suggestion; `issue!=null` implies
rewrite, reason and knowledge point are present.

## 4. New knowledge point vs recurrence on the write path

`writePath()` decides new-vs-recurrence inside one transaction. It computes
`match_key = kind + ':' + normalized(canonical_form)` (NFC, lowercase, collapsed
whitespace, punctuation stripped except internal apostrophes/hyphens) and then:

1. If `match_key` already exists, it is a **recurrence**: insert the instance with
   `role='recurrence'`, link it and increment `occurrence_count`.
2. If it does not exist but the model returned `recurrence_of_kp_id` for a knowledge
   point of the same kind, accept it only when token-level Jaccard similarity between
   the normalized forms is >= 0.6, then link as a recurrence.
3. Otherwise create a **new** knowledge point (`occurrence_count=1`), insert the
   instance with `role='origin'`, and create a `review_states` row with `state='new'`
   and `due_at=now`.

Guards: a `canonical_form` shorter than 2 or longer than 200 characters is rejected;
`issue=null` writes nothing; a skipped or failed analysis writes nothing. Because
`knowledge_points.match_key` is `UNIQUE`, a repeated mistake can only add an instance
and a link, never a duplicate knowledge point. `occurrence_count` is the running count
of linked instances.

## 5. Spaced-repetition scheduler: FSRS-5, not SM-2

The user allowed either. This design chooses **FSRS-5** through the MIT-licensed,
pure-TypeScript, fully offline `ts-fsrs` library, at desired retention 0.9, and
rejects SM-2. Evidence:

- SM-2 (Wozniak, 1987) drives intervals from a single ease factor per card and cannot
  separate item difficulty from memory stability, so it over-reviews easy items and
  under-reviews hard ones.
- FSRS models Difficulty, Stability and Retrievability explicitly and fits its
  parameters from review history. The public open-spaced-repetition benchmark corpus
  (tens of thousands of Anki collections, hundreds of millions of reviews) reports
  FSRS reaching a target retention with roughly 20-30% fewer reviews than SM-2.
- FSRS ships defaults that work with no personal history and adapts as history grows,
  which fits a tool that starts empty.
- `ts-fsrs` has no native dependencies and is deterministic given `(state, rating,
  review time)`, so local-first and vitest-exact due dates both hold.

Ratings and verdicts map from grading:

| Knowledge point | Condition | Verdict | Rating |
|---|---|---|---|
| expression unit | answer does not contain the target | incorrect | 1 (`again`) |
| expression unit | contains the target, model found another issue | correct | 2 (`hard`) |
| expression unit | contains the target, no issue or no model | correct | 3 (`good`) |
| grammar rule | no model result | ungraded | none; schedule untouched |
| grammar rule | model found the same rule broken | incorrect | 1 (`again`) |
| grammar rule | model found a different issue | correct | 2 (`hard`) |
| grammar rule | no issue | correct | 3 (`good`) |

"Same rule" means the answer's `knowledge_point.rule_key` equals the point's `rule_key`;
when the point has no `rule_key` it falls back to the issue class. 4 `easy` is reserved
and never emitted by the MVP. The scheduler writes `due_at`, `state`
(`new|learning|review|relearning`), `stability`, `difficulty`, `reps`, `lapses`,
`last_review_at` and `last_rating`. Skipping a question changes no scheduler field.
If the dependency is rejected, the documented fallback is SM-2 (interval = previous
interval * ease, ease adjusted per quality 0-5); it is not the chosen scheduler.
Session start counts the due points (`due_at <= now`, or `state='new'`) and emits one
JSON `systemMessage` carrying only that count - it generates no questions and calls no
model. `refluent review` offers the whole due set ordered by `due_at` ascending;
selection is local and needs no network.

## 6. SQLite schema

Store: `~/.refluent/analysis-and-data.sqlite` (overridable with `REFLUENT_DATA_DIR`),
better-sqlite3, WAL mode,
`foreign_keys=ON`, `schema_version=1`.

- **schema_migrations**: `version` INTEGER PRIMARY KEY, `applied_at` TEXT NOT NULL.
- **settings** (`data-settings`): `key` TEXT PRIMARY KEY, `value` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL. Rows: `capture-enabled`, `statusline-suggestion`,
  `session-start-review`, `quiet-mode`, `reminder-channel`, plus install/liveness state
  `hook_installed`, `hook_seen_at` and `wrapped_statusline`.
- **analysis_jobs** (`data-captured-message`, `data-analysis-job`): `id` INTEGER
  PRIMARY KEY AUTOINCREMENT; `message_id` TEXT NOT NULL UNIQUE; `session_id` TEXT;
  `raw_text` TEXT NOT NULL (local only); `filtered_text` TEXT; `skip_reason` TEXT
  (`empty_after_filter|too_short|telegraphic_command|low_natural_language|no_english`);
  `status` TEXT NOT NULL (`queued|running|done|failed|filtered`); `error` TEXT;
  `created_at` TEXT NOT NULL; `finished_at` TEXT; `latency_ms` INTEGER.
- **instances** (`data-knowledge-instance`, `data-suggestion`): `id` INTEGER PRIMARY
  KEY AUTOINCREMENT; `analysis_job_id` REFERENCES analysis_jobs(id); `original_text`
  TEXT NOT NULL (the filtered text; the raw message stays in `analysis_jobs.raw_text`); `rewrite_text` TEXT; `reason` TEXT; `issue_class` TEXT (the four
  class ids or NULL); `created_at` TEXT NOT NULL; `source` TEXT NOT NULL
  (`claude-code:UserPromptSubmit|refluent:review|refluent:manual`); `message_id` TEXT;
  `session_id` TEXT; `model` TEXT; `model_version` TEXT; `filter_version` TEXT.
- **knowledge_points** (`data-knowledge-point`): `id` INTEGER PRIMARY KEY
  AUTOINCREMENT; `kind` TEXT NOT NULL (`expression-unit|grammar-rule`);
  `canonical_form` TEXT NOT NULL; `match_key` TEXT NOT NULL UNIQUE; `rule_key` TEXT
  (`tense|sentence-pattern|article|preposition|singular-plural` for grammar rules);
  `explanation` TEXT; `occurrence_count` INTEGER NOT NULL DEFAULT 1;
  `first_instance_id` REFERENCES instances(id); `status` TEXT NOT NULL DEFAULT
  `active` (`active|suspended`); `created_at`, `updated_at` TEXT NOT NULL.
- **instance_knowledge_points** (the many-to-many relation): `instance_id` INTEGER
  NOT NULL REFERENCES instances(id) ON DELETE CASCADE; `knowledge_point_id` INTEGER
  NOT NULL REFERENCES knowledge_points(id) ON DELETE CASCADE; `role` TEXT NOT NULL
  (`origin|recurrence|review`); `linked_at` TEXT NOT NULL; primary key
  `(instance_id, knowledge_point_id, role)`.
- **review_states** (`data-review-state`): `knowledge_point_id` INTEGER PRIMARY KEY
  REFERENCES knowledge_points(id) ON DELETE CASCADE; `due_at` TEXT NOT NULL;
  `state` TEXT NOT NULL (`new|learning|review|relearning`); `stability` REAL;
  `difficulty` REAL; `reps` INTEGER NOT NULL DEFAULT 0; `lapses` INTEGER NOT NULL
  DEFAULT 0; `last_review_at` TEXT; `last_rating` INTEGER; `scheduler` TEXT NOT NULL
  DEFAULT `fsrs-5`; `created_at`, `updated_at` TEXT NOT NULL.
- **review_questions** (`data-review-question`): `id` INTEGER PRIMARY KEY
  AUTOINCREMENT; `knowledge_point_id` INTEGER NOT NULL REFERENCES
  knowledge_points(id) ON DELETE CASCADE; `type` TEXT NOT NULL
  (`zh-to-en|rewrite-original|fill-in`); `prompt` TEXT NOT NULL; `expected` TEXT;
  `context_instance_id` REFERENCES instances(id); `generated_at` TEXT NOT NULL;
  `model` TEXT; `status` TEXT NOT NULL DEFAULT `pending`
  (`pending|asked|answered|expired`).
- **review_answers** (`data-review-answer`): `id` INTEGER PRIMARY KEY AUTOINCREMENT;
  `question_id` INTEGER NOT NULL REFERENCES review_questions(id) ON DELETE CASCADE;
  `answer_text` TEXT NOT NULL; `verdict` TEXT NOT NULL
  (`correct|incorrect|skipped|ungraded`); `issue_class` TEXT; `feedback_rewrite` TEXT;
  `feedback_reason` TEXT; `instance_id` REFERENCES instances(id); `rating` INTEGER;
  `created_at` TEXT NOT NULL; `duration_ms` INTEGER.

Indexes: `idx_knowledge_points_kind`, `idx_knowledge_points_rule_key`,
`idx_review_states_due_at`, `idx_instances_created_at`, `idx_instances_issue_class`,
`idx_ikp_knowledge_point`, `idx_review_questions_kp_status`,
`idx_review_answers_question`, `idx_analysis_jobs_status`. Integrity rules:
`foreign_keys=ON`; `match_key` UNIQUE prevents duplicate knowledge points;
`instance_knowledge_points` is the only join and its `role` distinguishes origin,
recurrence and review links; deleting the local database removes all learner data
because there is no server copy.

### Logical data ref -> storage

| Logical ref | Storage |
|---|---|
| data-captured-message | analysis_jobs.raw_text (+ message_id, session_id, created_at) |
| data-analysis-job | analysis_jobs.status / filtered_text / skip_reason / error / latency_ms |
| data-suggestion | instances.original_text / rewrite_text / reason / issue_class |
| data-knowledge-point | knowledge_points.kind / canonical_form / explanation / occurrence_count |
| data-knowledge-instance | instances + instance_knowledge_points (role=origin/recurrence/review) |
| data-review-state | review_states.due_at / state / stability / difficulty / reps / lapses |
| data-review-question | review_questions.type / prompt / expected / context_instance_id |
| data-review-answer | review_answers.answer_text / verdict / issue_class / feedback_* |
| data-settings | settings.key / value |

## 7. Small-model call boundary and privacy

`AnalysisClient` exposes `analyze({filteredText, filterVersion})` and
`generateQuestion({knowledgePoint, type})`; tests inject a deterministic in-process
stub so vitest makes no network call. `HttpAnalysisClient` reads three environment
variables from `setup-runtime-env.analysis_model_contract`:

- `REFLUENT_MODEL_ENDPOINT` - base URL of an OpenAI-compatible endpoint; the client
  POSTs to `{endpoint}/chat/completions`.
- `REFLUENT_MODEL_API_KEY` - sent as `Authorization: Bearer <key>`; never logged.
- `REFLUENT_MODEL` - the model identifier placed in the request `model` field.

The request is `{ model, messages: [static system prompt, one user message whose
content is exactly filtered_text], temperature: 0, max_tokens: 512,
response_format: {type: "json_object"} }`. A missing env var, a timeout (8000 ms), a
non-2xx response or an unparseable body all yield `null`; the job is marked failed and
nothing is written.

Privacy rule: **no request to the analysis model contains source code, logs or error
output.** Only `filtered_text` or already-filtered stored natural-language text may be
placed in a request body; `raw_text` stays local; a skip issues no request; review
generation sends only the canonical form/explanation and a filtered original sentence.
`HttpAnalysisClient` sends only the `filteredText` it is given, and the guarantee lives
in `filterNaturalLanguage`, which every caller runs first. Non-blocking rule: the hook forwards the message first and returns
immediately, capture hands the job to a detached async worker, the statusLine never
triggers analysis inline, and failures are dismissed silently so the next qualifying
message starts a fresh job. Cost boundary: at most one call per qualifying message,
input capped at 1500 characters, output at 512 tokens, no retry queue, no replay.

## 8. Review question types and re-entry

Three production question types, each carrying its original sentence through
`context_instance_id`:

- **zh-to-en** - a Chinese rendering of the point's meaning; the user writes the
  English expression.
- **rewrite-original** - the user's own sentence; the user rewrites it naturally.
- **fill-in** - the canonical expression with the target span blanked.

A grammar-rule point gets a freshly generated sentence each time (via
`generateQuestion`) so the user transfers the rule; when the model is unavailable it
falls back to a fill-in on the canonical form, so reviews still work offline. Grading:
`gradeAnswer()` runs `answer_text` through the same `filterNaturalLanguage` and
`analyze` path and sets `verdict` (`correct|incorrect|skipped|ungraded`), following the
rating table in section 5: an expression unit must contain the target
(`containsTarget`, inflected forms of words >= 3 letters match) or it is
`incorrect`/1; a grammar rule with no model result is `ungraded` with the schedule left
untouched; and rating is null whenever the verdict is `skipped` or `ungraded`. It then
calls `writePath()` with `source='refluent:review'` so the answer produces an instance
linked with `role='review'` - storing only the filtered answer text - and updates
`review_states` via the scheduler only when rating is not null. Thus a review answer's
errors feed back into the same correction pipeline, and a newly observed issue creates
or links its own knowledge point. Skipping changes no scheduler field and writes no
instance.

## 9. Acceptance coverage and effect verification

Each confirmed acceptance maps to a schema or pipeline element: capture/filter to
`analysis_jobs` and R1-R13/G1-G5; the single suggestion to
`model_result_contract.invariants` and `instances.original_text/rewrite_text/reason`;
new-vs-recurrence to `write_path` plus `match_key` UNIQUE and
`instance_knowledge_points.role='recurrence'`; answer re-entry to
`review_answers.instance_id`; privacy to the filter and `privacy_rule`; local/offline
to `~/.refluent/` and local `due_at` selection; zero impact from failure to
`failure_behavior` and `non_blocking_rule`.

This node produces design documents only and has no runtime effect. Its stage-local
proof is internal consistency: the schema matches the logical `data_refs` used by the
experience specs, the filter and issue-class rules are decidable, and
`document_verification` confirms this document mirrors the JSON one-to-one. The full
product effect is implemented and proven downstream by `implement-refluent-cli`,
`verify-capture-and-review`, `verify-product-acceptance`, `review-experience-runtime`,
`repair-runtime-experience` and `close-launch-readiness`; a pass here is not product
completion.

Known open items: `ts-fsrs` is an added dependency beyond `decision-tech-stack.json`,
justified above with the SM-2 fallback recorded; the local database filename under the
user-level `~/.refluent/` is a design choice (setup-runtime-env proved only that the
user-level directory is writable); and the filter's R4-R13 regex patterns may be refined
by the implementer as long as the rule ids, effects and skip reasons stay as designed.