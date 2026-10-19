# App settings

Shortcuts, opening at login and automatic updates belong to the Yap app. It
answers them on its own socket, so they work while the service is down, and
they change the same settings the Settings window shows.

## Shortcuts

Read what is bound first:

```sh
yap shortcuts.get
```

Each action answers with its `name`, `keys`, `label`, `during` and `state`:

```json
{"bindings": {"capture.startOrStop": {"name": "Start or Finish Recording",
  "keys": "option+shift+s", "label": "⌥⇧S", "during": "app", "state": "active"}}}
```

| Action | Default | During |
|---|---|---|
| `capture.startOrStop` Start or Finish Recording | `option+shift+s` | app |
| `capture.pastePrompt` Paste Prompt | `option+shift+v` | app |
| `capture.undoMark` Undo Mark | `option+shift+z` | recording |
| `capture.cancel` Cancel Take | `option+shift+x` | recording |
| `capture.pauseOrResume` Pause or Resume Recording | `option+shift+p` | recording |
| `capture.restart` Restart Take | `option+shift+r` | recording |

`app` bindings are held while Yap runs; `recording` bindings only during a take,
so the same keys stay free for other apps the rest of the time.

Bind the actions the user named, using the keys they asked for:

```sh
yap shortcuts.set --params '{"bindings": {"capture.startOrStop": "ctrl+cmd+r", "capture.pastePrompt": "ctrl+cmd+v"}}'
```

It applies at once, persists, and answers like `shortcuts.get`. Actions you do
not name keep their keys. One bad entry refuses the whole call, so nothing is
half-set.

Keys are modifiers then one key, joined by `+`, in any order and case:

- Modifiers: `ctrl`, `option` (`opt`, `alt`), `shift`, `cmd` (`command`).
- A character means the key the user's current keyboard layout types it with,
  so `z` is the key labelled Z on their keyboard. Digits are the top row.
- Named keys: `return`, `tab`, `space`, `delete`, `escape`, `forwarddelete`,
  `home`, `end`, `pageup`, `pagedown`, `left`, `right`, `up`, `down`, `f1`–`f20`,
  `keypad0`–`keypad9`, `keypadplus`, `keypadminus`, `keypadmultiply`,
  `keypaddivide`, `keypadequals`, `keypaddecimal`, `keypadenter`, `keypadclear`.
- `keyNN` names any physical key by its macOS key code, for a key the layout
  types nothing with. `shortcuts.get` uses it the same way.
- Anything but a function key needs `ctrl`, `option` or `cmd`; otherwise every
  app would lose that key.

Refusals, and what to tell the user:

- `INVALID_PARAMS` names the entry and why: an unknown action, a key the layout
  cannot type, a missing modifier.
- `DUPLICATE_SHORTCUT`: two actions would share keys. Pick different keys.
- `state: "refused_by_macos"` on a successful answer: the binding is saved, but
  macOS or another app already holds those keys, so it does nothing. Say which,
  and offer other keys. Yap never takes keys from something that holds them.

Report the `label` back to the user (`⌃⌘R`), not the `keys` string.

## Opening at login

`login.status` reads whether Yap opens at login. Change it with
`login.setEnabled` only after the user explicitly says yes; macOS may ask them
to approve it in System Settings.

## Automatic updates

`update.status` reports the updater, `update.setEnabled` turns automatic updates
on or off, and `update.check` checks now. For an update that will not install
or a version question, follow [installation](installation.md).
