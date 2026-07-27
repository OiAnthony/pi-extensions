# pi-command-history

Folder-based persistent command history for [pi](https://github.com/badlogic/pi-mono). Recall previous commands with `up`/`down` across sessions — as long as you're in the same folder, your full command history is always available.

## Install

```bash
pi install npm:@oipsanthony/pi-command-history
```

Or try without installing:

```bash
pi -e npm:@oipsanthony/pi-command-history
```

## Usage

| Shortcut | Action |
|----------|--------|
| `up` | Previous command (older) |
| `down` | Next command (newer) |

When you enter a command in pi, it's saved to a per-folder history file. Next time you open pi in the same folder (even in a new session), press `up` from an empty editor to cycle through your previous commands.

By default, `up`/`down` are handled through raw terminal input to avoid pi extension shortcut conflict warnings with `tui.select.up` and `tui.select.down`. The extension intercepts these keys when history navigation owns the cursor position; other cases fall back to pi's normal cursor movement or command completion.

## Config

Create `~/.pi/pi-command-history.json` to customize shortcuts, conflict handling, or status display:

```json
{
  "shortcuts": {
    "prev": "up",
    "next": "down"
  },
  "conflictStrategy": "auto",
  "showStatus": "hidden",
  "debug": false
}
```

Invalid config values are ignored and fall back to the defaults.

The `showStatus` field controls whether a status indicator appears in the footer:

| Value | Behavior |
|---|---|
| `"hidden"` | No status indicator shown (default) |
| `"text"` | Show `12 cmds (↑/↓)` without icon |
| `"full"` | Show `📜 12 cmds (↑/↓)` with icon |

Set `debug` to `true`, or start pi with `PI_COMMAND_HISTORY_DEBUG=1`, to write terminal key diagnostics to `~/.pi/pi-command-history-debug.log`. Debug logging records escape sequences and history state, not normal text input.

### Conflict strategy

| Strategy | Behavior |
|----------|----------|
| `auto` | Default. Known conflicting `up`/`down` shortcuts use raw terminal input; other shortcuts use `pi.registerShortcut()`. |
| `register` | Always use `pi.registerShortcut()`. This can show pi shortcut conflict warnings for `up`/`down`. |
| `safe` | Replace conflicting `up`/`down` shortcuts with `ctrl+up`/`ctrl+down`. |

Raw terminal input interception starts history navigation only from an empty editor. Once browsing history, it consumes `up` on the first visual line and `down` on the last visual line, including at the oldest and newest boundaries, so pi's built-in history cannot take over. Autocomplete always keeps ownership of `up`/`down`.

Registered shortcuts reserve their key in pi even when history navigation is unavailable. Use `auto` with `up`/`down` when the editor should retain its normal behavior outside history navigation.

### What gets saved

- All user input is saved, including `/` slash commands
- History is deduplicated — repeated commands move to the most recent position
- Up to 500 commands are stored per folder

### How it works

- History files are stored in `~/.pi/folder-history/` as JSONL, keyed by a SHA-256 hash of the working directory
- Each history file is compacted to the latest 500 entries after reaching 1,000 stored records
- A status indicator in the footer shows the number of saved commands
- Compatible with other editor extensions (e.g., `pi-vim`) — no editor replacement conflicts
- Non-conflicting shortcuts are registered with `pi.registerShortcut()`; conflicting `up`/`down` shortcuts use raw terminal input in `auto` mode

## Uninstall

```bash
pi remove npm:pi-command-history
```

To also remove saved history:

```bash
rm -rf ~/.pi/folder-history/
```

## License

MIT

## Acknowledgments

The history navigation state machine was informed by [oh-my-pi](https://github.com/can1357/oh-my-pi).
