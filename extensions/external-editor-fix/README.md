# external-editor-fix

Fixes pi's external-editor keybinding (`Ctrl+G` by default) for GUI editors that return before the file is closed.

## Problem

Pi writes the current prompt to a temp file, launches `$VISUAL` or `$EDITOR`, then reads the file back and deletes it when the editor process exits.

On Windows / Git Bash, `EDITOR=code` starts VS Code and returns immediately unless `--wait` is supplied. Pi then deletes the temp file before VS Code opens it, so VS Code reports that the temp file does not exist.

## What this extension does

The extension installs a custom editor component that intercepts the configured `app.editor.external` keybinding and runs a fixed external-editor launcher.

It automatically adds a wait flag for known GUI editors when one is not already present:

- `code` / `code-insiders` → `--wait`
- `cursor` → `--wait`
- `windsurf` → `--wait`
- `zed` → `--wait`
- `subl` / `sublime_text` → `-w`

All other editor behavior is delegated to pi's normal `CustomEditor` implementation.

## Notes

- No path conversion is done in v1. In the Windows / Git Bash environment this was built for, Node reports `os.tmpdir()` as a Windows path (e.g. `C:\Users\<user>\AppData\Local\Temp`), which is what GUI editors expect.
- If you already set `EDITOR="code --wait"`, the extension will not add a duplicate wait flag.
- Terminal editors like `vim`, `nvim`, and `nano` are passed through unchanged.
