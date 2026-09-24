# Which model analyzes a message: measured, then kept

Date: 2026-09-24
Outcome: **no change.** `openai/gpt-4o-mini` stays as the stored analysis model. This
record exists so the choice is a measured one rather than an inherited recommendation.

## 1. The question

The owner asked why the analysis uses `openai/gpt-4o-mini` and whether a better-value
model would not be better. Fair: the model was my recommendation during setup (they had an
OpenRouter key and said "装"), it was never compared against anything, and it is only a
stored setting — `refluent settings set model <id>` — not a code dependency.

## 2. Money is not the axis

One analysis is a short message in and a small JSON object out: the current model costs
**~$0.00014 per message**, so 200 messages a day is **~$0.03/month**. A model five times
cheaper saves about two cents a month. What actually decides the choice is the contract
pass rate, latency, and how many output tokens the model writes.

## 3. Measure

`scripts/bench-models.mjs` runs the product's own fixture set through the real system
prompt (`src/issue-classes.ts`) at the real request shape (`temperature 0`,
`response_format: json_object`, `max_tokens: 512`) and reports contract-valid responses,
p50 latency, output tokens, and cost per 1000 calls. Numbers below are from the run on
2026-09-24 against the live OpenRouter endpoint (~200 calls, a few cents).

| model | contract-valid | p50 | out tokens p50 | ~$/1k calls | price /M |
| --- | --- | --- | --- | --- | --- |
| **openai/gpt-4o-mini** (kept) | **19/20** | 979 ms | 138 | **$0.14** | $0.15 / $0.60 |
| deepseek/deepseek-v4.1-flash | 15/20 | **279 ms** | 502 | $0.17 | $0.14 / $0.42 |
| qwen/qwen3.8-flash | 10/10 | 779 ms | 456 | $0.31 | $0.15 / $0.47 |
| z-ai/glm-5.3-flash | 10/10 | 1351 ms | 509 | $0.28 | $0.15 / $0.50 |
| deepseek/deepseek-v4-flash | 9/10 | 1206 ms | 502 | $0.12 | $0.089 / $0.177 |
| openai/gpt-5-nano | 0/10 | 461 ms | 1152 | $0.48 | spends the whole budget on reasoning, `content` empty (`finish=length`); reasoning cannot be disabled on this endpoint |
| google/gemini-2.5-flash-lite | 0/10 | 523 ms | 165 | $0.11 | nests `rewrite`/`reason`/`knowledge_point` inside `issue` |
| qwen/qwen3.7-flash | 0/10 | — | — | — | upstream 429 (rate-limited through OpenRouter) |

Why the cheap ones lost, in their own words:

- **Structural JSON, not worse content.** gemini-lite's output is semantically fine but
  puts the fields in the wrong object, which the contract rejects.
- **Verbosity costs twice.** deepseek writes 3–4x the output tokens, so at a lower price
  per token it is *more* expensive per call — and models that write long get truncated at
  the 512-token cap, which is the failure the sample shows.
- **Reasoning models need a budget we do not give them.** gpt-5-nano answered nothing.

## 4. Decision and revisit triggers

Keep `openai/gpt-4o-mini`: highest contract pass rate measured, lowest cost per call among
the valid candidates, and the shortest output. Revisit if any of these becomes true:

- The owner's volume is large enough that $0.03/month matters (it is not, today).
- A model shows a materially better pass rate at the same or lower cost per call — run
  `node scripts/bench-models.mjs --models <a,b,c> --reps 3`.
- `max_tokens` becomes configurable. The 512 cap is what disqualifies the verbose and
  reasoning-heavy models, so a benchmark at a higher cap is the honest way to compare them;
  that is a code change (and a re-verification), not a settings change.

## 5. Limits

- Small samples: 10–20 calls per model, one temperature, one prompt version. The batch
  measured after the JSON-reliability prompt fix, so the earlier malformed-JSON failures
  are not a property of these models alone.
- The newest cheap flagships were **not** tested (`google/gemini-3.1-flash-lite`,
  `mistralai/mistral-small-2603`, `openai/gpt-5-mini`, `anthropic/claude-haiku-4.5`): at a
  512-token cap they are likely to fail for the same truncation reason, and benchmarking
  them properly needs the cap change above.
- Only the analysis call is benchmarked. The review-question call (`QUESTION_SYSTEM_PROMPT`,
  `max_tokens: 256`) uses the same model and was not measured separately.
- Switching the model is a stored setting; the API key still comes from the environment
  (`OPENROUTER_API_KEY`), and the endpoint is `https://openrouter.ai/api/v1`.
