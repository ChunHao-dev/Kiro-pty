# Kiro PTY

<p align="center">
  <img src="banner.png" width="256" />
</p>

Enhanced terminal wrapper for [kiro-cli](https://kiro.dev) using a pseudoterminal (node-pty) for full input control.

## Why

kiro-cli runs in a terminal — which means no drag-and-drop, no image paste, and no quick way to reference project files. Things that IDE-based AI tools get for free become friction points in a CLI workflow:

- **Screenshots** — You take a screenshot to show the AI a bug, but the CLI can't receive images. You have to manually save the file, find the path, and type it in.
- **File/folder paths** — You want to point the AI at a specific file or directory. In Finder you can see it, but getting the full path into the terminal takes multiple steps.
- **Project file references** — Other AI coding tools let you type `@` to quickly reference files. Without that, you're copy-pasting paths or navigating by memory.

Kiro PTY solves these by sitting between you and kiro-cli, intercepting input to add the missing capabilities:

- `Cmd+V` a screenshot → auto-saved to `/tmp`, path sent to kiro-cli
- `Cmd+V` files copied in Finder → paths sent directly
- Type `@` → inline fuzzy file picker over your project, path inserted on selection

The result: the same DX you'd expect from an IDE-integrated AI, but with kiro-cli.

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
