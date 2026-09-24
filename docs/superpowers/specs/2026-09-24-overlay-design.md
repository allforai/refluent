# Global suggestion overlay (macOS) — design

Date: 2026-09-24
Status: approved in conversation, awaiting written-spec review

## Intent

**What the user said.** The refluent status line costs a terminal row in every agent pane
(Claude Code, Pi), in every project, and the user does not need it per project. They want
one system-level floating overlay instead, visible over any app — including while they
are chatting elsewhere. It must pop up only when there is a new suggestion, and it must be
draggable to a position of their choice.

**Scope decided.** Only the *display surface* changes. Capture still comes only from the
coding agents (Claude Code, Codex, Pi) through the existing hooks; capturing English typed
in other apps is explicitly out of scope.

**Success looks like.**
- No refluent row in any terminal pane once the overlay is installed.
- A new suggestion appears in a small floating panel over whatever app is frontmost,
  including full-screen apps, without taking keyboard focus.
- The panel goes away by itself, stays while hovered or expanded, and reappears where the
  user last dragged it.
- Removing the overlay restores the previous terminal behaviour exactly.

**Assumptions (not stated by the user).**
- macOS only; Swift toolchain (`swiftc`) is available (it is on this machine: Swift 6.4).
- The existing 15-minute freshness window (`STATUSLINE_TTL_MS`) stays the definition of
  a current suggestion.

## Approach

A small native Swift helper renders the panel; a long-lived Node process owns every
decision and feeds it. Alternatives rejected: Electron (≈200 MB dependency and resident
memory for one small window) and macOS notifications (no hover-to-hold, no expand, suppressed
by Focus modes, pile up in Notification Center).

## Components and data flow

```
agent hooks ──write──▶ ~/.refluent/analysis-and-data.sqlite
                                  │ poll latest suggestion id, 1 s
                                  ▼
                   refluent overlay run   (Node, LaunchAgent)
                                  │ JSON lines on stdin
                                  ▼
                   refluent-overlay       (Swift, renderer only)
                                  │ JSON lines on stdout (moved, dismissed)
                                  ▼
                   Node persists position in the settings table
```

### Node side — `src/overlay.ts`

- **Detection.** Reuses `latestSuggestion()` from `src/statusline.ts`. A suggestion is new
  when its id is greater than the last id shown (`overlay-last-shown-id`, stored) and it is
  fresh (`isFresh`, 15 min). When `overlay-last-shown-id` is unset (first run ever), the
  current latest id is recorded without showing it, so old suggestions are never
  replayed; after a restart the stored id carries on, so a suggestion produced while the
  overlay was down is still shown if it is fresh.
- **Failure notice.** When `getLastAnalysisResult()` is `failed` and fresh, one
  `analysis unavailable (run \`refluent settings\`)` notice is shown per distinct failure
  timestamp, never repeatedly.
- **Quiet mode.** `quietModeOn()` suppresses everything.
- **Payload.** `{type:"show", rewrite, reason, label, original, durationMs}`. Fields are
  sanitised with the existing control-character stripping from `statusline.ts` and capped
  (wider than the terminal caps, e.g. 300 chars each, but bounded). A `chinese_translation`
  suggestion carries an empty reason, as on the status line today.
- **Supervision.** Spawns the Swift binary; restarts it on exit with backoff; after 5 exits
  within 60 s it stops, logs to `~/.refluent/overlay.log`, and reports `stopped`.
- **Position.** Handles `{type:"moved", x, y}` from the helper by storing
  `overlay-position` (JSON `{x,y}`); sends it with each `show`. Malformed or partial
  lines from the helper are ignored.

Pure functions (detection, payload building, message parsing) are separated from the
process/IO shell so they can be unit tested without spawning anything.

### Swift side — `overlay/RefluentOverlay.swift`

Single file, AppKit only, no Xcode project. Renderer only — it makes no decisions.

- `NSPanel` with `.nonactivatingPanel`, level `.floating` (status-bar level if needed to
  sit over full-screen apps), `collectionBehavior` `[.canJoinAllSpaces,
  .fullScreenAuxiliary]`, app activation policy `.accessory` (no Dock icon, never steals
  focus).
- `isMovableByWindowBackground = true`; on drag end it writes `{"type":"moved","x":…,"y":…}`.
- Default position: top-right of the main screen. A stored position that is not on any
  current screen (e.g. an external display was unplugged) falls back to the default.
- Visual effect material background, follows system light/dark appearance.

## Show and hide behaviour

- **Collapsed (default):** two lines — the rewrite (larger), then `label: reason`
  (smaller, secondary colour). A close `×` in the corner.
- **Expanded (click):** adds the user's original sentence and un-truncates the fields up
  to the payload caps.
- **Auto-hide:** fades out after `overlay-duration` seconds (default 12). Hover pauses the
  timer; leaving restarts it; a drag restarts it. Expanded panels never auto-hide — clicking
  the panel again collapses it (and restarts the timer); `×` closes it.
- **Replacement:** a new `show` while visible replaces the content and restarts the timer;
  panels never stack.

## Terminal status line

The existing `statusline-suggestion` preference already gates both the Claude Code
statusLine and the Pi footer (`renderStatusline`). No new switch:

- `refluent overlay install` stores the current value in `overlay-prev-statusline-suggestion`
  and sets `statusline-suggestion` to `off`.
- `refluent overlay uninstall` restores the stored value.
- Anyone wanting both surfaces runs `refluent settings set statusline-suggestion on`.

Hooks, capture and analysis are untouched.

## Settings

| key | kind | values | default |
|---|---|---|---|
| `overlay-duration` | preference | `6`, `12`, `20`, `30`, `60` (seconds) | `12` |
| `overlay-position` | internal | JSON `{x,y}` | unset |
| `overlay-last-shown-id` | internal | instance id | unset |
| `overlay-prev-statusline-suggestion` | internal | `on`/`off` | unset |

`overlay-duration` uses the existing enumerated-value preference mechanism
(`PREFERENCE_KEYS`/`ALLOWED_VALUES`).

## CLI

- `refluent overlay install` — compile with `swiftc -O overlay/RefluentOverlay.swift -o
  ~/.refluent/bin/refluent-overlay`; write `~/Library/LaunchAgents/com.refluent.overlay.plist`
  running `<abs node> <abs bin/refluent> overlay run` (absolute paths, as the hooks do);
  `launchctl bootstrap gui/<uid>`; turn the terminal line off. If `swiftc` is missing it
  stops before changing anything and says to run `xcode-select --install`.
- `refluent overlay uninstall` — `launchctl bootout`, remove the plist and binary, restore
  `statusline-suggestion`.
- `refluent overlay run` — the long-lived process the LaunchAgent starts.
- `refluent overlay test` — sends a sample suggestion to the running overlay for manual
  checking and positioning.
- `refluent settings` / `refluent install` report `overlay: running | stopped |
  not_installed`.

## Error handling

- Helper not built, crashed, or stopped: the only effect is that no panel appears. Agent
  sessions are never affected. Status is visible in `refluent settings`.
- Database locked or unreadable during a poll: skip that tick.
- Helper output that is not valid JSON or has the wrong shape: ignored.

## Testing

`tests/overlay.test.ts` (vitest, temp SQLite via existing helpers):

- detection: newer id + fresh → show; first run does not replay; restart shows a fresh suggestion missed while down; stale → no show;
  quiet mode → no show; a failure notice is shown once per failure;
- payload: fields, label, empty reason for `chinese_translation`, control characters
  stripped, caps enforced;
- helper messages: `moved` persists and round-trips into the next `show`; malformed lines
  ignored;
- install/uninstall: `statusline-suggestion` turned off and restored; plist content and
  paths correct; missing `swiftc` aborts with no state change (`launchctl`/`swiftc`
  replaced by fakes);
- supervision: restart on exit; stop after the crash-loop threshold (fake child process).

The Swift renderer has no logic to unit test. Manual acceptance with `refluent overlay test`,
recorded in `docs/progress/overlay.md`:

1. the panel appears with the sample content;
2. typing in an editor while it appears — focus is not taken;
3. visible over a full-screen app;
4. hovering keeps it open;
5. clicking expands and shows the original;
6. drag it, run `overlay test` again — it appears at the new position.

## Out of scope

History list, click-to-copy the rewrite, global hotkey, Windows/Linux, and capturing
text from non-agent apps.
