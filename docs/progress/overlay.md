# Global suggestion overlay — acceptance

Date: 2026-09-24
Machine: macOS 26.6.2, Apple Swift 6.4 (`xcrun swiftc`), run from the main checkout.
Code state: `3a6c12b` plus this record. Spec: `docs/superpowers/specs/2026-09-24-overlay-design.md`.

## 1. Install

```
$ node bin/refluent overlay install
  Overlay helper compiled: ~/.refluent/bin/refluent-overlay
  LaunchAgent written and started: ~/Library/LaunchAgents/com.refluent.overlay.plist
  The terminal status line is off; suggestions now pop up in the overlay.
  Run `refluent overlay test` to see it and drag it where you want it.
$ node bin/refluent settings show --no-probe | grep -E "statusline-suggestion|overlay"
  statusline-suggestion: off / on
  overlay-duration: 12 / 12
  overlay        : running
```

`launchctl print gui/$UID/com.refluent.overlay` reported `state = running`. macOS showed its
"App Background Activity: node can run in the background" notice once (login item added).

## 2. Defect found and fixed: reinstall left the overlay stopped

The second `overlay install` failed:

```
refluent: launchctl could not start the overlay: Bootstrap failed: 5: Input/output error
```

`bootout` returns before launchd has torn the old job down, so the immediate `bootstrap`
lost the race and the overlay stayed `stopped`. Fixed in `3a6c12b`: poll
`launchctl print` until the label is gone (up to 5 s), retry the bootstrap once. Three
new tests; after the fix three consecutive installs all exited 0 and ended `running`.

## 3. Checklist

Panel position and state were read from the window server (`CGWindowListCopyWindowInfo`,
owner `refluent-overlay`, layer 25); the front app from `lsappinfo front`. Keyboard input
went through `orca computer` targeted at TextEdit; mouse input through `cliclick`.

| # | check | result | evidence |
|---|---|---|---|
| 1 | sample appears | pass | 380×56 panel with rewrite + `语法错误: …`; screenshot |
| 2 | no focus theft while typing | pass | TextEdit front before, during and after the pop; typed `before `, popped, typed `after` → document text `before after` |
| 3 | visible over a full-screen app | **not verified** | TextEdit would not enter full screen from automation (hotkey and `AXFullScreen` both no-ops); left for the owner |
| 4 | hover holds, leaving fades | pass | duration 6 s: still up after 10 s hovering; gone 8.5 s after the mouse left |
| 5 | click expands / collapses | pass | height 56 → 75 (original shown), still up after 8 s expanded; second click → 56; front app unchanged (TextEdit) |
| 6 | drag moves and is remembered | pass | drag moved panel to (850, 672), stored `{"x":850,"y":310}`, next pop appeared there; the owner had also dragged it by hand (stored 11:43, honoured by every later pop). Owner's position restored afterwards |
| 7 | real suggestion pops up | pass | the owner's Claude Code message `继续测试一下` → instance 80 `Let's continue testing.` (`chinese_translation`); `overlay-last-shown-id` = 80 |
| 8 | light / dark appearance | pass | dark: dark panel, light text; light: light panel, dark text (screenshots) |
| 9 | helper missing → reported, not spinning | pass | helper binary moved away and killed: `overlay: stopped` within 20 s, log `overlay helper stopped after repeated exits: spawn … ENOENT`; `overlay test` → "installed but not running; see …/overlay.log" (exit 1); binary restored + reinstall → `running` |

## 4. Side effects during testing

- One early attempt typed with `cliclick` while TextEdit had not come to the front, so
  `before after` went to whatever Orca had focused. Later input was app-targeted only.
- The dark-mode check switched the system to light for a few seconds; it was restored to
  dark, and Auto appearance (`AppleInterfaceStyleSwitchesAutomatically = 1`) stayed on.
- `overlay-duration` was set to 6 for the hover check and restored to 12.

## 5. Open

- Check 3 (full screen) needs a human.
- Expanding grows the panel downward from its top edge, so a panel parked at the very
  bottom of the screen expands partly off it. Not a spec requirement; noted.
