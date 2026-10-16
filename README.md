# refluent

[中文](README.zh-CN.md)

**Improve your written English from the prompts you already send to coding agents.**

You write to Claude Code, Codex or Pi in English (or in Chinese) all day. refluent reads
each message in the background, and when a sentence could be better it shows you one line:

```
refluent: Please help me check this code whether has bug. → Please check whether this code has a bug. (语法错误: Keep statement order after "whether".)
```

Write in Chinese and you get the idiomatic English instead:

```
refluent: 帮我看看这个登录 bug 为什么一直失败 → Can you help me look into why this login bug keeps failing? (中文→英文)
```

Each correction becomes a knowledge point, and `refluent review` later asks you to produce
it yourself — so the English sticks without a separate study session.

- **Never in the agent's way.** Nothing is written back into the agent's context, and the
  hook returns immediately; analysis runs detached.
- **Local data.** Your messages and knowledge points live in one SQLite file on your machine.
- **Bring your own model.** Any OpenAI-compatible endpoint; a small model is enough
  (about $0.03/month at 200 messages a day with `openai/gpt-4o-mini`).

## Who it's for

Developers who are not native English speakers — especially Chinese speakers — and who
spend their day writing to a coding agent. The issue labels are in Chinese
(`语法错误`, `中式夹英`, `Chinglish 搭配`, `语域语气`, `中文→英文`); the suggestions and
reasons are in English.

## Quick start

Requires **macOS**, **Node.js >= 22**, and an API key for an OpenAI-compatible
endpoint. The example uses [OpenRouter](https://openrouter.ai).

```sh
npm install -g refluent

refluent settings set model-endpoint https://openrouter.ai/api/v1
refluent settings set model openai/gpt-4o-mini
refluent settings set model-api-key-env OPENROUTER_API_KEY   # the *name* of the variable
refluent install                            # adds the Claude Code hooks
```

Restart Claude Code and send a message.

The API key itself is never stored — refluent looks it up by name in the environment
Claude Code gives its hooks, so `OPENROUTER_API_KEY` must be set where Claude Code runs.
`refluent install` tells you if it can't reach it.

## Everyday use

There is nothing to remember during a conversation:

- **Every message you send** is captured and filtered. Code, logs, stack traces, bare
  commands and short imperatives are dropped before anything reaches the model.
- **The status line** shows at most one suggestion, below your own status line if you have
  one. A suggestion expires after 15 minutes.
- **A new session** tells you how many review items are due. The notice is shown to you
  only and never injected into the agent's context.
- **`refluent review`** asks production questions drawn from your own sentences —
  Chinese→English, rewriting your own sentence, and fill-in — and grades your answers
  through the same pipeline.

## Configuration

`refluent settings` shows every switch and what the hook really resolves — endpoint,
model, the name of the key's variable, and why the last analysis failed:

```
Analysis model (what the hook really resolves):
  endpoint       : https://openrouter.ai/api/v1 (source: local settings)
  model          : openai/gpt-4o-mini (source: local settings)
  api key        : read from env OPENROUTER_API_KEY
```

```sh
refluent settings set quiet-mode on              # suppress every terminal output
refluent settings set statusline-suggestion off  # no suggestion on the status line
refluent settings set statusline-original off    # drop your own sentence from the line
refluent settings reset                          # switches only; model config is kept
```

Model keys are `model-endpoint`, `model` and `model-api-key-env`; pass `none` to clear one.
The environment variables `REFLUENT_MODEL_ENDPOINT`, `REFLUENT_MODEL` and
`REFLUENT_MODEL_API_KEY` override the stored values for a single command. After changing
what the hooks use, restart Claude Code.

Failure reasons are sanitized (`not_configured`, `auth_rejected`, `rate_limited`,
`timeout`, `network_error`, `empty_response`, `invalid_response`, `http_error_<status>`)
and never include response bodies or your text.

## Supported agents

```sh
refluent install --agent claude-code   # default
refluent install --agent codex
refluent install --agent pi
```

`uninstall` takes the same flag.

| | Claude Code | Codex | Pi |
|---|---|---|---|
| capture | `UserPromptSubmit` hook | `UserPromptSubmit` hook | `before_agent_start` extension |
| written to | `~/.claude/settings.json` | `$CODEX_HOME/hooks.json` | `~/.pi/agent/extensions/refluent.ts` |
| suggestion shown in | status line (wrapped, never replaced) | — (use `refluent review` or the overlay) | Pi's status bar, under its own key |

- **Claude Code**: `install` asks for consent, merges the hooks, wraps your existing
  `statusLine`, and keeps a one-time backup at `settings.json.refluent-backup`.
- **Codex** reads its hooks from `CODEX_HOME`, not the literal `~/.codex`, so managers that
  run Codex with a per-account home work too. Existing hooks are kept and the file is backed
  up. Codex asks you to trust the hook the first time it sees it.
- **Pi** gets a small extension. Restart Pi to load it. Your own sentence is left out of
  Pi's shared status bar unless you set `statusline-original on`.

## Floating overlay

Instead of a status row in every agent pane, suggestions can pop up in one small floating
panel over whatever app you are in. It never takes keyboard focus and fades after 12
seconds — hover to keep it, click to see your original sentence, drag to move it.

```sh
refluent overlay install     # needs Xcode command line tools (swiftc)
refluent overlay test        # show a sample, then drag it into place
refluent settings set overlay-duration 20   # 6 | 12 | 20 | 30 | 60 seconds
refluent overlay uninstall   # removes it and brings the status line back
```

The overlay also pops up when analysis fails for a reason you have to fix — no model
configured, a rejected key, or a request refused with HTTP 4xx. Timeouts and other
transient failures stay quiet and show up in `refluent settings`.

Installing the overlay turns `statusline-suggestion` off; uninstalling turns it back on.

## Data and privacy

- Messages, filtered text, knowledge points and settings live in one SQLite database at
  `~/.refluent/analysis-and-data.sqlite` (override the directory with `REFLUENT_DATA_DIR`).
  Nothing is written inside your repositories, and there is no server-side copy.
- **Analysis is remote.** For each message worth analysing, its *filtered* text is sent to
  the endpoint you configure. Source code, logs and error output are stripped or replaced
  with a `[code]` placeholder first.
- Deleting `~/.refluent` removes all local data.

## Uninstall

```sh
refluent uninstall
```

Removes every refluent hook and restores the status line you had before. Knowledge points
are kept; delete `~/.refluent` to remove them too.

## Known limits

- **Requires your own model endpoint.** With none configured, messages are captured but no
  suggestions are produced; `refluent settings` says why.
- **Written English only.** Speech and pronunciation are out of scope.
- **Single local user.** No accounts, no sync across devices.
- **macOS only.** Linux and Windows are not supported.
- **`[code]` placeholders** can make a review question read oddly when the original sentence
  was mostly code.
- Claude Code cuts an over-wide status line with `…`; refluent fits the line to the pane
  width when it can detect it.

## Development

To run from a clone instead of the npm package:

```sh
git clone https://github.com/allforai/refluent.git && cd refluent
npm ci && npm run build
npm link          # optional: puts `refluent` on your PATH; otherwise use `node bin/refluent ...`
npm test
npm run typecheck
```

The hooks point at the checkout, so keep it in place while refluent is installed.

See [docs/development.md](docs/development.md) for end-to-end verification, sandboxed
hook testing, model benchmarks and how the status line is fitted to narrow panes.

## License

[MIT](LICENSE)
