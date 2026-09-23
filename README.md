# refluent

Turns the English you already write to a coding agent into phrasing suggestions and
durable, locally-owned knowledge points — so written English improves during work
instead of in a separate study session.

It runs as three Claude Code hooks. Every message you send to the agent is captured,
filtered, and (asynchronously) checked by a small model you point it at. A single
corrective line appears on your status line, and the underlying knowledge points come
back later as production questions in `refluent review`.

Nothing is written back into the agent's context. The database that holds your knowledge
points stays on your machine; the only thing that leaves it is the filtered text of a
message you sent (see [Data and privacy](#data-and-privacy)).

## Requirements

- **Node.js >= 22**
- **Claude Code** for the hook integration (the CLI itself works without it)
- An **OpenAI-compatible chat-completions endpoint** for analysis. Without one the
  product still captures and filters, but produces no suggestions: analysis fails
  silently and the agent conversation is unaffected.

## Install

```sh
npm ci
npm run build          # bin/ and hooks/ load dist/
node bin/refluent install
```

Every command below is shown as `node bin/refluent ...`, which works from the repository
root without any extra setup. To get a short `refluent` command instead, put it on your
PATH once (optional):

```sh
npm link               # or: npm install -g .
```

`install` asks for consent, then merges the three hooks into your Claude Code settings,
wraps (never replaces) your existing `statusLine`, and writes a one-time copy of the
file to `settings.json.refluent-backup`. It prints the capture state and a real
endpoint probe:

```
  hook status    : installed_not_loaded     # it becomes loaded once Claude Code runs it
  endpoint status: ready
  capture        : enabled
```

Point it at a model. Claude Code runs the hooks as children of the agent, so the
endpoint and model are stored locally (they are not secrets) — an environment only
needs to exist for the very first `install`:

```sh
# one-time, read by `install` and stored locally
export REFLUENT_MODEL_ENDPOINT="https://api.example.com/v1"   # base URL, no /chat/completions
export REFLUENT_MODEL="some-small-model"
```

Or set them directly at any time, without any shell profile:

```sh
node bin/refluent settings set model-endpoint https://api.example.com/v1
node bin/refluent settings set model some-small-model
```

The API key is the one secret and is **never stored**. Name the environment variable
that already holds it, so the hook looks it up by name:

```sh
node bin/refluent settings set model-api-key-env OPENROUTER_API_KEY   # or any var name
```

Naming a variable does not move a value between environments: the hook reads it from
the environment **Claude Code passes to its hook commands**, which is the agent's
environment. A variable that exists only in a separate terminal is not visible there, so
verify it in the hook's own environment (`refluent install` says which variable it could
not reach, and `refluent settings` shows which one the hook resolves).

`REFLUENT_MODEL_ENDPOINT`, `REFLUENT_MODEL` and `REFLUENT_MODEL_API_KEY` still work and
win over the stored values for a single command (for example a one-off `refluent
review` against another model). After changing what the hooks should use, restart
Claude Code.

`node bin/refluent settings` is the single place that shows what the hook really
resolves — endpoint, model, the *name* of the key's variable, and why the last analysis
failed:

```
Analysis model (what the hook really resolves):
  endpoint       : https://api.example.com/v1 (source: local settings)
  model          : some-small-model (source: local settings)
  api key        : read from env OPENROUTER_API_KEY

Last analysis result (read-only):
  failed at 2026-01-01T00:00:00.000Z — not_configured
  why: no analysis model is configured for the hook — run `refluent settings set model-endpoint <url>` ...
```

Failure reasons are sanitized (`not_configured`, `auth_rejected`, `rate_limited`,
`timeout`, `network_error`, `empty_response`, `invalid_response`, `http_error_<status>`)
and never include response bodies or your text.

## Use

Nothing to remember during a conversation:

- **Every message you send** is captured and filtered. Code, logs, stack traces, bare
  commands and short imperatives are dropped before anything reaches the model.
- **The status line** shows at most one suggestion:
  `refluent: <your sentence> → <better phrasing> (<why>)`. Your own wrapped status line is
  printed first and refluent's line is appended below it; a suggestion expires after
  15 minutes.
- **Session start** shows you one line: `refluent: N review item(s) ... are due. Run
  \`refluent review\` in a terminal.` It is sent as a JSON `systemMessage`, so it is
  visible to you and never injected into the agent's context. It does not call the model.
- **`node bin/refluent review`** asks production questions drawn from your own sentences —
  Chinese→English, rewriting your own sentence, and fill-in — and feeds your answers
  back through the same correction pipeline. Grammar-rule answers are left ungraded
  (schedule untouched) when the model is unavailable.

Switches:

```sh
node bin/refluent settings                          # show switches + real enablement state
node bin/refluent settings set quiet-mode on        # suppress every terminal output
node bin/refluent settings set statusline-suggestion off
node bin/refluent settings reset                    # switches only; model config is kept
```

Model configuration uses the same command with its own keys — `model-endpoint`,
`model`, `model-api-key-env`; pass `none` to clear one.

## Data and privacy

- Your learner data — messages, filtered text, knowledge points and settings — lives in one
  user-level SQLite database: `~/.refluent/analysis-and-data.sqlite`. Override the directory
  with `REFLUENT_DATA_DIR`. Nothing is written inside a repository.
- Deleting `~/.refluent` removes that local data; the product keeps no server-side copy.
- **The analysis is remote.** For each message worth analysing, its *filtered* text is sent
  to the OpenAI-compatible endpoint you configure, and the endpoint's reply is used to build
  the suggestion. Anything you do not configure an endpoint for stays local.
- Only filtered natural-language text is sent. Source code, logs and error output are
  stripped, or replaced with a `[code]` placeholder, before the request.

## Test

```sh
npm test          # vitest unit/integration suite (in-memory SQLite, no network)
npm run typecheck
npm run build
```

End-to-end verification against the real CLI, the real hook entrypoints and a **local**
fake OpenAI-compatible endpoint (no network, no real Claude config touched):

```sh
node scripts/verify-product-acceptance.mjs /tmp/refluent-evidence.json
```

It drives install → capture → suggestion → knowledge point → recurrence → review →
uninstall and writes every raw observation to the JSON file. It uses throwaway
`REFLUENT_DATA_DIR` / `REFLUENT_CLAUDE_SETTINGS` paths, so it is safe to run repeatedly.

To try the hooks yourself without touching your real Claude Code configuration:

```sh
TMP=$(mktemp -d)
REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent install --yes
printf '{"prompt":"Can you help me 看看 this bug?"}' | REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent hook user-prompt-submit
REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent settings
```

No Claude login is involved: this drives the CLI and the hook entrypoints directly, and
writes only inside the temporary directory.

## Uninstall

```sh
node bin/refluent uninstall
```

Removes every refluent hook, restores the status line you had before (or removes the key
if you had none), and leaves your knowledge points in place. Delete `~/.refluent` to
remove the data too.

## Known limits

- **Requires your own model endpoint.** With none configured, analysis fails silently by
  design: captured and stored locally with the failure recorded, but no suggestion and no
  knowledge point are produced. The status line says the analysis was unavailable and
  `refluent settings` names the sanitized reason, so a missing configuration, a rejected
  key and a timeout are distinguishable.
- **Display budget.** The status line is one bounded, single-line, control-sequence-free
  string (worst case 250 characters; original and rewrite capped at 80, the reason at 60).
  Newlines, tabs and ANSI escapes are stripped, anything longer is truncated, and a
  redaction placeholder is never cut in half. On a very narrow pane the line still wraps.
- **`[code]` placeholders.** Filtered-out code appears as `[code]`, including inside
  review question context, which can read oddly for a sentence that was mostly code.
- **Written English only.** Speech, pronunciation and rich formatting are out of scope.
- **Single local user.** No accounts, no sync, no multi-device merge.
- **Linux/macOS only, verified on macOS.** Paths assume a POSIX home directory; Windows
  is untested.
- **CLI surfaces are text.** There is no graphical UI, so visual checks are limited to
  captured terminal output rather than screenshots.
