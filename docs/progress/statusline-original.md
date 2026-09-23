# Status line: the user's own sentence where the pane is shared

Date: 2026-09-24
Code state: the commit preceding the evidence commit (see `git log`); evidence regenerated
after it.

## 1. The report

In a live Pi session the suggestion read (screenshot, 2026-09-24):

```
bg ⬆ v2.6.5 /bg-update   refluent: How is this project efforting? → How is this project progressing? (Chinglish 搭配: Improved colloc…
```

The tip was cut mid-reason: `Improved collocation for clarity.` lost its tail.

## 2. Root cause (reproduced, not inferred)

Rendering the same stored suggestion (instance 18, `created_at` 2026-09-23T17:45:19Z) from
`~/.refluent` through `renderStatusline`:

| form | columns |
| --- | --- |
| original → rewrite (label: reason) | **127** |
| rewrite (label: reason), no original | **94** |
| the line as rendered by Pi | **109**, ending `colloc…` |

refluent's own truncation cannot produce a half-reason line here: the reason is cut to 60
columns *before* the ladder, and this reason is 33 columns, so a refluent cut would keep it
whole. The `…` is Pi's: Pi renders every keyed status in **one shared footer row**, and the
hook measures the whole terminal (~133 columns), not the slot left after
`bg ⬆ v2.6.5 /bg-update`. So refluent emitted a 127-column line it believed fit, and Pi cut
it at ~109.

The ladder in `src/statusline.ts` already treats the original as the first thing to
sacrifice; it simply never fired, because the budget was measured against the wrong pane.

## 3. The change

1. **`statusline-original` switch** (`auto` default, `on`, `off`). `auto` keeps the
   sentence where refluent owns the line (Claude Code) and drops it on Pi, whose footer is
   shared. `on`/`off` force it everywhere. The original is the user's own message and is
   visible in the transcript, so it is the cheapest field to spend.
2. **Pi budget cap** (`PI_STATUSLINE_BUDGET = 100`, `statuslineBudgetFor`). The slot width
   is not readable, so refluent fits itself to a conservative width instead of the whole
   terminal. It is a ceiling: a narrower pane still wins, and `REFLUENT_TERMINAL_COLUMNS`
   can force it narrower but not wider.
3. The `--agent` value now reaches the renderer, so the policy is per-surface rather than a
   global guess.

Same suggestion, both surfaces:

```
claude-code: refluent: [code] this tip postion is too short → this tip position is too short (语法错误: Spelling error detected.)
pi:          refluent: this tip position is too short (语法错误: Spelling error detected.)
```

## 4. Verification on this tree

| Check | Result |
| --- | --- |
| `npm run build` | exit 0 |
| `npm test` | **160 passed / 160** (17 files; 154 before, +6 for this change) |
| `node scripts/verify-product-acceptance.mjs docs/progress/evidence/verify-product-acceptance.json` | **27/27 checks passed** (26 before, +1) |
| live hook call the Pi extension makes (`hook statusline --agent pi`) | 77 columns, original dropped, reason whole |

New coverage: `tests/statusline.test.ts` (auto policy per agent, `on`/`off` override, budget
cap, the hook path for Pi) and `tests/settings-and-install.test.ts` (the new switch accepts
`auto|on|off` and rejects anything else). The harness gained
`pi-statusline-drops-the-original`, which renders the *same* stored suggestion through both
agents.

## 5. Limits (explicit)

- **100 is a conservative constant, not a measurement.** Pi's slot shrinks as other
  extensions set more statuses; a session with several of them can still have refluent's
  line cut, and nothing can widen the budget past the cap today.
- **A long rewrite *and* a long reason still cannot fit.** The fallback keeps the rewrite
  readable and spends what is left on the reason, so both are cut at the tail. The rewrite
  keeps priority on purpose (`MAX_REWRITE_CHARS` rationale in `src/statusline.ts`).
- **Not re-run:** a live Pi TUI screenshot of the new line (the hook call above is the
  extension's own command, not a rendered session), a live Claude Code session, and a real
  paid model endpoint.
- The confirmed intent line ("a suggestion showing the original, the rewrite and why",
  `product-contract.json:176`) is now explicitly conditional rather than implicitly so; the
  orchestration artifact itself was not rewritten.
