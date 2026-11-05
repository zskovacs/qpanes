# QPanes roadmap

Every slice needs an approved spec, a testable finish line, and a short recorded verification report. Only one write-heavy GOAL should touch a given worktree at a time.

| Slice | Scope | Result |
| --- | --- | --- |
| 000 | Bootstrap | Generated Tauri app launches in WSLg, scripts and repo docs valid |
| 001 | Read-only dual pane | Two local folders browsable independently with keyboard navigation and correct states |
| 002 | Basic mutations | Create folder, rename, copy, move, trash/delete with safe conflict/permission handling |
| 003 | Operation engine | Progress, cancellation, background jobs and error recovery |
| 004 | Daily usability | Tabs, favorites, search/filter, drag/drop, configurable shortcuts |
| 005 | Integrated terminal | Platform-native PTY shell and panel-directory synchronization |
| 006 | AI/MCP | Permission-gated local MCP service using the same Rust core |

Later: remote filesystem providers (e.g. SFTP), archive viewing, previews, advanced integrations. Do not build these before the basic workflow is reliable.
