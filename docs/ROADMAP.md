# QPanes roadmap

Every slice needs an approved spec, a testable finish line, and a short recorded verification report. Only one write-heavy GOAL should touch a given worktree at a time.

| Slice | Scope | Result |
| --- | --- | --- |
| 000 | Bootstrap | Generated Tauri app launches in WSLg, scripts and repo docs valid |
| 001 | Read-only dual pane | Two local folders browsable independently with keyboard navigation and correct states |
| 001.5 | Integrated window chrome and DPI | Existing header gains native window operations; native scaling retained, WSLg boundary measured; see [verification and platform limits](slices/001.5-window-chrome-dpi.md) |
| 002 | Safe local mutations | Create directory, rename, staged copy, same-filesystem move, native Trash with conflict rejection; see [scope, safety and verification](slices/002-safe-file-operations.md). Windows Trash intentionally fails closed; native Windows/macOS release verification remains outstanding. |
| 003 | Operation engine | Implemented: one background FIFO worker, real copy progress, safe cancellation/retry, Operations dock and deliberate shutdown. Independent acceptance PASS within the verified Linux/WSLg single-instance scope; findings hardened with regression coverage. See [Slice 003](slices/003-background-operations.md#final-acceptance-record). Target-native Windows/macOS, physical OS input/DPI and concurrent multi-instance startup remain unverified. |
| 004 | Daily usability | Implemented and accepted for merge (2026-11-11) after independent Codex review findings R004-01/02/03 were corrected and re-checked PASS within the Linux/WSLg scope: independent panel tabs with session restore, favorites, per-tab Quick Filter, internal drag/drop that queues confirmed Copy/Move through the OperationManager, and centralized configurable shortcuts with versioned Rust-owned settings. Verified on Linux/WSLg (mocked renderer suites plus real Tauri/Rust native runs, including XTest input); Windows/macOS runtime remains unverified. See [Slice 004](slices/004-daily-usability.md). |
| 005 | Integrated terminal | Platform-native PTY shell and panel-directory synchronization |
| 006 | AI/MCP | Permission-gated local MCP service using the same Rust core |

Later: remote filesystem providers (e.g. SFTP), archive viewing, previews, advanced integrations. Do not build these before the basic workflow is reliable.
