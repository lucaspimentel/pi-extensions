# pi-extensions

Personal [pi-coding-agent](https://github.com/badlogic/pi) extensions and skills.

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
- **plan-with-opus** – switch to Opus when planning
- **questionnaire** – interactive questionnaire tool
- **web** – fetch & convert web pages (depends on `html-to-text`)
- **pi-tool-permissions** – Claude Code-style allow/deny/ask permissions
- **external-editor-fix** – fix Ctrl+G external editor on Windows / Git Bash by adding wait flags for GUI editors

### Skills

`add-todo`, `git-commit`, `review-pr`, `ship`, `update-changelog`,
`update-docs`, `update-pr-description`, `whats-next`.

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
