# pi-extensions

Personal [pi-coding-agent](https://github.com/earendil-works/pi) extensions and skills.

## Install

Global (all projects):

```bash
pi install git:github.com/lucaspimentel/pi-extensions
```

Project-local (writes to `.pi/settings.json`):

```bash
pi install -l git:github.com/lucaspimentel/pi-extensions
```

Pin to a specific ref so `pi update` won't bump it:

```bash
pi install git:github.com/lucaspimentel/pi-extensions@v0.1.0
```

Try without installing:

```bash
pi -e git:github.com/lucaspimentel/pi-extensions
```

## Contents

### Extensions

- **colored-footer** – custom footer styling
- **idle-summary** – generates a brief summary of the session when pi has been idle for a while
- **plan-with-opus** – switch to Opus when planning
- **questionnaire** – interactive questionnaire tool (copied from the [pi sample](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/questionnaire.ts) by [@ferologics](https://github.com/ferologics))
- **web** – fetch & convert web pages (depends on `html-to-text`)
- **wt-tab-status** – updates the Windows Terminal tab title with the current session status
- **pi-tool-permissions** – Claude Code-style allow/deny/ask permissions
- **external-editor-fix** – fix Ctrl+G external editor on Windows / Git Bash by adding wait flags for GUI editors
- **pwsh** – PowerShell tool for Windows-native object pipelines (JSON via `ConvertFrom-Json`, registry, WMI/CIM, .NET, `Get-*` cmdlets). Auto-detects `pwsh` (7+) → `powershell` (5.1). Mirrors the built-in `bash` tool's tail-truncation and temp-file dump for long output.

### Skills

`add-todo`, `atlassian-cli`, `git-commit`, `review-pr`, `ship`, `update-changelog`,
`update-docs`, `update-pr-description`, `whats-next`.

`atlassian-cli` is authored by [Jakob He](https://github.com/leweii), repackaged from [leweii/atlassian-cli](https://github.com/leweii/atlassian-cli) under the MIT License.

## Layout

```
pi-extensions/
├── package.json          # pi manifest
├── extensions/
│   ├── *.ts              # single-file extensions
│   ├── web/              # multi-file extension
│   └── pi-tool-permissions/
└── skills/
    └── <skill>/SKILL.md
```

Runtime npm deps live in the root `package.json` so a single `npm install`
(run by pi after `git clone`) covers all extensions.

## Update

```bash
pi update git:github.com/lucaspimentel/pi-extensions
```
