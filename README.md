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
npm run dev:server   # API on 127.0.0.1:4317
npm run dev:ui       # UI on http://127.0.0.1:5173
```

Run the two commands in separate terminals.

## Platform notes

- **Windows:** stopping a task force-kills its whole process tree right away (`taskkill /T /F`); there is no graceful shutdown step as on macOS and Linux. `npm`, `npx` and other `.cmd` tools are found on `PATH`, never in the project folder.
- **Linux:** screenshots need the stable Google Chrome build (`google-chrome`), not Chromium.
