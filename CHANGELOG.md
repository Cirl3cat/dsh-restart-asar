# Changelog

All notable changes to this project are documented here.

## 0.1.0 — 2026-11-25

### Added

- Application menu: **重启** directly above **退出**, below the same separator group as `检查更新…` / `管理 dsh 命令…`.
- System tray: **重启 DeepSeek Harness** between **打开 DeepSeek Harness** and **退出 DeepSeek Harness**, separated with the shell's own separators.
- Restart semantics: `app.relaunch()` plus the shell's own quit path, so the Host shuts down and the new process cold-starts.
- The official quit inspection (`inspectQuit()` + `resolveDesktopQuitPrompt()`) decides whether a native confirmation is needed; its title and buttons say **重启**.
- Labels use the shell's own locale dictionaries, so they follow the application language setting.
- Byte-length-preserving `app.asar` patch with refreshed SHA-256, original-file backup, `node --check` preflight, and `restore`.
- Automatic re-apply after every desktop update.
