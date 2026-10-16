# eray-kanban

A local kanban board: each project gets one headless Claude Code agent, and nothing reaches git until you accept the review. Runs on macOS, Windows and Linux.

## Requirements

- Node 24 or newer
- Git
- [Claude Code](https://claude.com/claude-code), installed and logged in (`claude` on your PATH). On Windows, Claude Code also needs Git for Windows (Git Bash).
- Google Chrome, for screenshots of web projects
- Notifications: built in on macOS and Windows; on Linux, `notify-send` (package `libnotify-bin` or `libnotify`). Set `KANBAN_NOTIFY=0` to turn them off.

## Run

```bash
npm install
npm run shortcut   # once: adds an Agent Kanban icon to your desktop (and Start menu / app menu)
```

Double-click the icon. It builds the UI when it changed, starts the server on http://127.0.0.1:4317 and opens the board in your browser. If the board is already running, the icon just opens it again.

- **Windows:** the server runs with no window and an Agent Kanban icon appears in the system tray. Double-click it to open the board; right-click for *Open log* and *Stop Agent Kanban*. The shortcut runs `scripts/windows/tray.ps1` with `-ExecutionPolicy Bypass` for that one process; no system setting changes.
- **Linux:** the server starts in the background with no terminal.
- **macOS:** the server runs in a Terminal window; close it or press Ctrl+C to stop.

`npm run stop` stops a running server from any terminal: it stops the agents first, like Ctrl+C. Background runs log to `data/server.log` (the previous run's log is kept as `server.old.log`).

From a terminal: `npm start` runs it in that terminal, `npm start -- --background` detaches it. Set `KANBAN_OPEN=0` to skip opening the browser.

## Develop

```bash
npm run dev   # API watcher and Vite in one terminal; the UI is on http://127.0.0.1:5173
```

Ctrl+C stops both. `npm run dev:server` and `npm run dev:ui` still run them separately.

## Platform notes

- **Windows:** stopping a task force-kills its whole process tree right away (`taskkill /T /F`); there is no graceful shutdown step as on macOS and Linux. `npm`, `npx` and other `.cmd` tools are found on `PATH`, never in the project folder.
- **Linux:** screenshots need the stable Google Chrome build (`google-chrome`), not Chromium.
