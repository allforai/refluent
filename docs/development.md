# Development

## Build and test

```sh
npm ci
npm run build     # bin/ and hooks/ load dist/
npm test          # vitest unit/integration suite (in-memory SQLite, no network)
npm run typecheck
```

## End-to-end verification

Drives the real CLI and the real hook entrypoints against a **local** fake
OpenAI-compatible endpoint — no network, no real Claude config touched:

```sh
node scripts/verify-product-acceptance.mjs /tmp/refluent-evidence.json
```

It runs install → capture → suggestion → knowledge point → recurrence → review →
uninstall and writes every raw observation to the JSON file. It uses throwaway
`REFLUENT_DATA_DIR` / `REFLUENT_CLAUDE_SETTINGS` paths, so it is safe to run repeatedly.

## Trying the hooks in a sandbox

To try the hooks without touching your real Claude Code configuration:

```sh
TMP=$(mktemp -d)
REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent install --yes
printf '{"prompt":"Can you help me 看看 this bug?"}' | REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent hook user-prompt-submit
REFLUENT_DATA_DIR="$TMP/data" REFLUENT_CLAUDE_SETTINGS="$TMP/settings.json" node bin/refluent settings
```

No Claude login is involved: this drives the CLI and the hook entrypoints directly, and
writes only inside the temporary directory.

## Comparing analysis models

`scripts/bench-models.mjs` runs the fixture set through the real system prompt at the real
request shape and reports contract-valid responses, latency, output tokens and cost. See
[progress/model-choice.md](progress/model-choice.md) for the last measured run.

## Status line rendering

- **Display budget.** The status line is one bounded, single-line, control-sequence-free
  string (worst case 250 characters; original and rewrite capped at 80 columns, the reason
  at 60). Newlines, tabs and ANSI escapes are stripped, a redaction placeholder is never
  cut in half, and a cut prefers a word boundary.
- **Narrow panes.** Claude Code truncates an over-wide status line with `…` instead of
  wrapping, and it does not tell the command how wide the pane is. refluent therefore reads
  the width from the agent's own TTY (`ps -o tty=` + `stty -f`), and when the full form does
  not fit it gives up the *least* useful part first: the redundant issue-class label, then
  the user's own sentence (already in the transcript), and only then the reason. The
  rewrite and the reason survive as long as possible. Widths are in terminal columns, so a
  CJK label counts as two. If the width cannot be discovered, the bounded form is used
  unchanged. Two known limits remain upstream: multi-line output is dropped to one line on
  macOS, and an over-wide line is never wrapped.
