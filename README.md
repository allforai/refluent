# refluent

Turns the English you already write to a coding agent into phrasing suggestions and
durable, locally-owned knowledge points — so written English improves during work
instead of in a separate study session.

It runs as three Claude Code hooks. Every message you send to the agent is captured,
filtered, and (asynchronously) checked by a small model you point it at. A single
corrective line appears on your status line, and the underlying knowledge points come
back later as production questions in `refluent review`.

Nothing is written back into the agent's context, and all learner data stays on this
machine.

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

`install` asks for consent, then merges the three hooks into your Claude Code settings,
wraps (never replaces) your existing `statusLine`, and writes a one-time copy of the
file to `settings.json.refluent-backup`. It prints the capture state and a real
endpoint probe:

```
  hook status    : installed_not_loaded     # it becomes loaded once Claude Code runs it
  endpoint status: ready
  capture        : enabled
```

Point it at a model with three environment variables (see your Claude Code settings
environment or your shell profile):

```sh
export REFLUENT_MODEL_ENDPOINT="https://api.example.com/v1"   # base URL, no /chat/completions
export REFLUENT_MODEL="some-small-model"
export REFLUENT_MODEL_API_KEY="..."                           # optional
```

Restart Claude Code so the hooks pick up the environment. `refluent settings` shows the
endpoint status and capture state at any time.

## Use

Nothing to remember during a conversation:

- **Every message you send** is captured and filtered. Code, logs, stack traces, bare
  commands and short imperatives are dropped before anything reaches the model.
- **The status line** shows at most one suggestion:
  `refluent: <your sentence> → <better phrasing> (<why>)`. It alternates with your own
  wrapped status line, and a suggestion expires after 15 minutes.
- **Session start** shows you one line: `refluent: N review item(s) ... are due. Run
  \`refluent review\` in a terminal.` It is sent as a JSON `systemMessage`, so it is
  visible to you and never injected into the agent's context. It does not call the model.
- **`refluent review`** asks production questions drawn from your own sentences —
  Chinese→English, rewriting your own sentence, and fill-in — and feeds your answers
  back through the same correction pipeline. Grammar-rule answers are left ungraded
  (schedule untouched) when the model is unavailable.

Switches:

```sh
node bin/refluent settings                          # show switches + real enablement state
node bin/refluent settings set quiet-mode on        # suppress every terminal output
node bin/refluent settings set statusline-suggestion off
node bin/refluent settings reset
```

## Data and privacy

- All learner data lives in one user-level SQLite database: `~/.refluent/analysis-and-data.sqlite`.
  Override the directory with `REFLUENT_DATA_DIR`. Nothing is written inside a repository.
- Deleting `~/.refluent` removes everything; there is no server copy.
- Only filtered natural-language text is ever sent to your endpoint. Source code, logs
  and error output are stripped (or replaced with a `[code]` placeholder) before the request.

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
cp -p ~/.claude/.credentials.json "$TMP/" 2>/dev/null || true
REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent install --yes
printf '{"prompt":"Can you help me 看看 this bug?"}' | REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent hook user-prompt-submit
REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent settings
```

## Uninstall

```sh
node bin/refluent uninstall
```

Removes every refluent hook, restores the status line you had before (or removes the key
if you had none), and leaves your knowledge points in place. Delete `~/.refluent` to
remove the data too.

## Known limits

- **Requires your own model endpoint.** With none configured, analysis fails silently by
  design: nothing is suggested and nothing is stored.
- **Display budget.** The status line is one bounded line (worst case 250 characters,
  original and rewrite capped at 80 and the reason at 60). Anything longer is truncated,
  and a redaction placeholder is never cut in half. On a very narrow pane the line still
  wraps.
- **`[code]` placeholders.** Filtered-out code appears as `[code]`, including inside
  review question context, which can read oddly for a sentence that was mostly code.
- **Written English only.** Speech, pronunciation and rich formatting are out of scope.
- **Single local user.** No accounts, no sync, no multi-device merge.
- **Linux/macOS only, verified on macOS.** Paths assume a POSIX home directory; Windows
  is untested.
- **CLI surfaces are text.** There is no graphical UI, so visual checks are limited to
  captured terminal output rather than screenshots.
