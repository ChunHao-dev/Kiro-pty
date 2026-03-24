# Kiro PTY

<p align="center">
  <img src="banner.png" width="256" />
</p>

Enhanced terminal wrapper for [kiro-cli](https://kiro.dev) using a pseudoterminal (node-pty) for full input control.

## Features

- **@ File Picker** — Type `@` to open an inline file selector with fuzzy search. Open files are prioritized.
- **Image Paste** — `Cmd+V` detects clipboard images (screenshots), saves to `/tmp/kiro-imgN.png`, and sends the path to kiro-cli.
- **Finder File/Folder Paste** — `Cmd+V` detects files/folders copied in Finder and sends their paths.
- **Send Code from Editor** — Right-click selected code → "Send to Kiro-CLI" sends `file:line-range` reference.
- **Multi-session** — Open multiple kiro-cli terminals in the same window.
- **Auto venv** — Detects `.venv` in workspace and sets `VIRTUAL_ENV` + `PATH` for kiro-cli subprocesses.

## Keybindings

| Key | Action |
|-----|--------|
| `Cmd+V` | Smart paste (image / Finder files / text) |
| `Cmd+Shift+A` | File picker (QuickPick fallback) |
| `@` | Inline file picker (at line start or after space) |

## @ File Picker

```
> @ext
  ▸ src/extension.ts
    package.json
    tsconfig.json
  ↓ 5 more
```

- Type to fuzzy search
- ↑↓ to navigate
- Enter to confirm (sends full path)
- Esc to cancel (preserves typed text)

## Requirements

- macOS (arm64) — uses native clipboard APIs via Swift/osascript
- [kiro-cli](https://kiro.dev) installed at `~/.local/bin/kiro-cli`

## Commands

| Command | Description |
|---------|-------------|
| `Kiro PTY: Start Chat` | Open a new kiro-cli terminal |
| `Kiro PTY: Reference File` | File picker (QuickPick) |
| `Send to Kiro-CLI` | Send selected code reference to kiro-cli |
