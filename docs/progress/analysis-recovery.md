# Analysis recovery: live statusLine said "analysis unavailable"

Status: fixed and verified against the live installation. Local commit only; nothing pushed.

## Symptom

The installed Claude Code statusLine showed

```
refluent: analysis unavailable (run `refluent settings`)
```

and `refluent settings` had nothing to add: the only recorded reason was the generic
`analysis_unavailable`. Every captured message failed with `latency_ms = 0`, so the model
was never called.

## Exact root cause

**The hook could not see the model configuration at all — it was never a network, auth or
schema problem.** Two defects combined:

1. **Configuration lived only in a process environment that the hook never inherits.**
   The endpoint/model were set as `REFLUENT_MODEL_*` in `~/.zprofile`. Claude Code runs its
   hooks as child processes of the agent, so the hook inherits the *agent process*
   environment. Evidence:
   - `ps eww` on the running `claude` processes: `OPENROUTER_API_KEY`, `FAL_KEY`,
     `ANDROID_HOME` present; `REFLUENT_MODEL_ENDPOINT` absent in all of them.
   - Those panes' login shells started (`Sep 23 14:37`, `Sep 14 19:42`) *before* the
     profile was edited, so they had sourced the older profile.
   - A fresh login shell had the variables; non-login `zsh` and `/bin/sh -c` did not.
   With no endpoint/model, `hook.ts` fell back to `NullAnalysisClient`, which returns
   `null` without any HTTP call — hence `latency_ms = 0`.
   Reproduction against the real installed entrypoint with the agent-like environment
   (no `REFLUENT_*`) produced byte-identical rows:
   `status=failed, error=analysis_unavailable, latency_ms=0` (live jobs 1–3, 15:30–15:34Z).

2. **The failure reason was swallowed.** `HttpAnalysisClient.post` returned `null` for
   *every* cause (non-2xx, timeout, unparseable body, schema mismatch), and `runAnalysis`
   recorded the single string `analysis_unavailable`. A missing configuration was
   indistinguishable from a rejected key or a timeout, which is why the statusLine pointed
   at `refluent settings` while `refluent settings` had nothing to show.

## Fix

Durable, non-secret configuration plus sanitized failure reasons. The API key is still
never stored.

- **`src/model-config.ts` (new).** Stored settings `model-endpoint`, `model`,
  `model-api-key-env` with validation (URL scheme/host, single line, env-var-name shape,
  `none` clears). `resolveModelConfig(db, env)` resolves endpoint/model with environment
  overriding stored values, and reads the key from `REFLUENT_MODEL_API_KEY` or from the
  environment variable **named** by `model-api-key-env` — the name is stored, the value
  never is. `sanitizedEndpoint` drops credentials/query before anything is printed.
- **`src/analysis/http.ts`.** `HttpAnalysisClient.fromConfig`, and a sanitized
  `lastFailure` classified as `auth_rejected` (401/403), `rate_limited` (429),
  `http_error_<status>`, `timeout`, `network_error`, `empty_response`, `invalid_response`.
  No response body or request text is ever recorded.
- **`src/analysis/stub.ts`.** `NullAnalysisClient.lastFailure = 'not_configured'` — the
  missing-configuration case now names itself.
- **`src/capture.ts`.** Records `client.lastFailure ?? 'analysis_unavailable'` on the job
  and in `last_analysis_result`.
- **`src/hook.ts`, `src/cli.ts`.** Hook, `review` and `analyze-job` all build the client
  from the DB-aware resolver, so the detached `analyze-job` child (spawned with the hook's
  environment) resolves the same configuration.
- **`src/install.ts`.** `install` persists the non-secret endpoint/model it sees in the
  environment ("Saved the analysis endpoint and model locally …"), so the hook no longer
  depends on a shell profile, and warns when no key is reachable or when the key came from
  `REFLUENT_MODEL_API_KEY` (which hooks may not inherit).
- **`src/settings.ts`, `src/cli.ts`.** `refluent settings` now prints what the hook really
  resolves (endpoint/model + source, the *name* of the key variable) and a plain-language
  `why:` line for the last failure.
- **`README.md`.** Documents the stored settings, the key-by-name indirection, that env
  still overrides for a single command, and the reason vocabulary.

## Live configuration applied

Only refluent's own state changed; hooks, statusLine and the wrapped Orca statusLine are
untouched.

```sh
node bin/refluent settings set model-endpoint https://openrouter.ai/api/v1
node bin/refluent settings set model openai/gpt-4o-mini
node bin/refluent settings set model-api-key-env OPENROUTER_API_KEY
```

The three `REFLUENT_MODEL_*` lines previously appended to `~/.zprofile` were **removed**
(backup: `~/.zprofile.bak-refluent`); the key now has exactly one copy in the environment
(`OPENROUTER_API_KEY`, already present in the agent's environment) and is read by name.
`env | grep -c '^REFLUENT_'` in a fresh login shell is now `0`.

## Before / after evidence (sanitized)

Before — live installation, agent-like environment (no `REFLUENT_*`):

```
jobs:  {"id":1,"status":"failed","error":"analysis_unavailable","latency_ms":0}
last:  {"outcome":"failed","reason":"analysis_unavailable"}
```

After — same installed entrypoint, minimal environment (`env -i HOME PATH OPENROUTER_API_KEY`):

```
hook status    : installed_and_loaded
endpoint       : https://openrouter.ai/api/v1 (source: local settings)
model          : openai/gpt-4o-mini (source: local settings)
api key        : read from env OPENROUTER_API_KEY
statusLine     : refluent: Can you help me check this bug? I have already try to fix it. → …I have already tried to fix it. (语法错误: …)
```

A synthetic sentence through the installed hook path (`bin/refluent hook user-prompt-submit`
with `REFLUENT_MODEL_*` unset) produced `job status=done, latency_ms=2136`, knowledge point
`grammar-rule / tried`, and `last_analysis_result = suggestion_emitted`, with the hook's
stdout empty (0 bytes) so the agent message is unchanged. The synthetic rows were then
removed and the learner DB verified back at its pre-probe counts
(`analysis_jobs=5`, everything else `0`, `last_analysis_result` restored to the user's own
`skipped_filtered/too_short`).

Reproducible, isolated artifact (throwaway data dir, throwaway Claude settings, real
endpoint): `docs/progress/analysis-recovery-evidence.json`.

## Verification

- `npm run typecheck` clean; `npm run build` clean.
- `npm test`: 14 files, 126 tests pass (11 new: resolution precedence, key-by-name
  indirection, no secret stored, `not_configured`, each HTTP/transport classification,
  endpoint sanitization, install persistence, and the hook path with an empty environment).
- `node scripts/verify-product-acceptance.mjs`: 24/24 checks pass.
- Live `~/.claude/settings.json` re-read: refluent owns only the statusLine plus
  `UserPromptSubmit`/`SessionStart`; 11 other hook events untouched; the 2891-character
  Orca statusLine is still stored (`settings.wrapped_statusline`) and still runs first;
  `settings.json.refluent-backup` present.

## Residual risks and limits

- The stored endpoint/model are duplicated in two places by design (environment wins);
  deleting `~/.refluent` loses the stored copy and requires re-running the three
  `settings set` commands.
- The detached `analyze-job` child reads configuration from the DB, so a *changed*
  environment is only honoured by `review`/`analyze-job` when they are started directly;
  hooks use the stored values plus the agent's environment, as documented.
- `analysis_unavailable` remains the reason only for an unexpected throw that carries no
  classified failure.
- Not addressed (out of scope): the `README` still requires a manual restart of Claude Code
  after changing hook wiring; no change was made to the model call's 8s timeout.
