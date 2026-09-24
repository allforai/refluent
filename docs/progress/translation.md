# Chinese messages are translated into English

Date: 2026-09-24
Code state: the commit preceding the evidence commit (see `git log`); evidence regenerated
after it.

## 1. The report

The owner wrote `推送并更新` in Pi and got no suggestion at all. Expectation, in their words:

> 如果我使用中文，应该要帮我翻译成英文才对

Reproduced before the change: every message they had sent in Chinese was dropped by the
filter, so no model call was ever made.

| message | old result |
| --- | --- |
| `推送并更新` | `no_english` → dropped |
| `是不是不需要显示原文？` | `no_english` → dropped |
| `如果我使用中文，应该要帮我翻译成英文才对` | `no_english` → dropped |
| `这个 tip position is too short` | passed → `中式夹英` (works, English-dominant) |

## 2. What changed

1. **Filter (`src/filter.ts`, `filter-v3`).** The last gate was `latinWordCount < 2` →
   `no_english`. It is now "fewer than 2 Latin words **and** fewer than 4 CJK ideographs" →
   `no_coachable_text`. Chinese content is material to translate; only text that is neither
   English prose nor Chinese is skipped.
2. **Issue class (`src/issue-classes.ts`).** New `chinese_translation` (中文→英文), priority
   **5 of 5** — lowest on purpose, so a sentence that is also English practice is still
   coached as mixing/grammar/collocation, and translation only surfaces when nothing else
   applies. The system prompt tells the model to translate a Chinese message, to put the
   translation in `rewrite`, and to store the reused English phrase as an
   `expression-unit` knowledge point (so it returns in review as a zh-to-en question).
3. **Status line (`src/statusline.ts`).** For a translation the class label already says
   what happened, so the model's `reason` is not rendered: the columns go to the
   translation itself. Claude Code shows `原文 → English (中文→英文)`; Pi (shared footer,
   100-column cap) shows `English (中文→英文)`.

```
claude-code: refluent: 帮我看看这个状态行的 tip 为什么还是被截断 → Can you help me check why the tip in this status line is still truncated? (中文→英文)
pi:          refluent: Can you help me check why the tip in this status line is still truncated? (中文→英文)
```

## 3. Prompt wording is a reliability decision, not a style choice

The model returns one JSON object. With the first wording of the new rule (colons, quoted
literals, one long clause), gpt-4o-mini emitted **structurally invalid JSON** — a trailing
comma after `explanation`, `rewrite`/`reason`/`knowledge_point` nested inside `issue` — for
short Chinese inputs in 4 of 6 samples; a repair pass (strip trailing commas, balance
braces) did not recover them, and a retry with the same wording did not either. Rewriting
the rule as separate plain sentences returned a contract-valid object for **6 of 6** Chinese
samples and 4 of 4 English samples in the same session. The wording carries a comment in
`src/issue-classes.ts` so it is not "tidied" back into the failing shape.

## 4. Verification on this tree

| Check | Result |
| --- | --- |
| `npm run build` | exit 0 |
| `npm test` | **165 passed / 165** (17 files; 160 before, +5) |
| `node scripts/verify-product-acceptance.mjs docs/progress/evidence/verify-product-acceptance.json` | **28/28 checks passed** (27 before, +1) |
| live OpenRouter end-to-end, Chinese prompt | `done` in 2.6s, `issue_class=chinese_translation`, tip rendered as above, knowledge point stored |
| live sample, 6 short Chinese inputs | 6/6 contract-valid responses; English-dominant mixed input still `chinese_code_mixing` |

New coverage: filter (Chinese admitted, `no_coachable_text` for a third script),
issue classes (the fifth class, its rank last, a translation result validates), status line
(translation rendering drops the redundant reason), and harness check
`chinese-message-becomes-english` (own temp store + model endpoint: job `done`, no skip, tip
with 中文→英文, expression-unit point stored).

## 5. Records

- `decision-journal.json` gained batch `refluent-zh-translation-20260924` with the intent
  revisions the owner confirmed: `value-proposition` and `target-users` and
  `usage-scenarios` all revision 2 (the status line's shared-pane behaviour from the same
  conversation is folded into `value-proposition`). All three copies of each intent
  (`concept-baseline.json`, `product-contract.json`, `product-concept.json`) match the
  journal payload.
- `validate_bootstrap.py` passes; `check_decision_inputs.py` reports every decision wired.
- **The local evidence ledger is stale: all 19 nodes.** It was already partly stale before
  this change (17 `stale` / 2 `uncertain`) because post-closure product work changed
  `src/**` and `docs/progress/**`; these commits add the intent/contract diffs. The ledger
  was not re-stamped: that means re-running every node's recorded verification against a
  changed product, which is a planning decision, not part of this change.

## 6. Limits

- **A malformed model response costs the suggestion.** `invalid_response` is intermittent
  (small samples put it around 1 in 6, for English as well as Chinese). No retry was added;
  a malformed response still ends as a failed analysis with no suggestion. A single bounded
  retry on `invalid_response` is the obvious follow-up if the rate bothers the owner.
- **Third-script text is now `no_coachable_text`**, a renamed skip reason (`no_english` is
  no longer produced; historical rows keep the old value). The frozen design-fixes plan
  still says `G5-no-english`; that record is left untouched as the audit artifact.
- **Terse Chinese commands are translated too.** `推送并更新记录` becomes
  "Push and update the records." with a knowledge point. Whether those deserve a tip is a
  product call the owner has not made separately.
- **Not re-run:** a live Pi TUI screenshot of the new translation line (the hook command the
  extension issues was run instead), a live Claude Code session, and Windows.
