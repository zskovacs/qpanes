# Slice 001 — Read-only dual-pane filesystem browser

Status: DRAFT — approve design/plan before running the implementation GOAL.

## Outcome
QPane launches under WSLg and presents two independent, resizable local-file panes driven by real Rust directory listings, with predictable keyboard control and explicit loading/empty/error states.

## Scope
- Display path, filenames, entry type (directory/file/symlink), size when meaningful, and modified timestamp where available.
- Browse into directories and up to a parent directory; prevent navigation beyond logical roots.
- Switch active pane with Tab. Arrow Up/Down moves the active pane's selection. Enter opens a selected directory. Backspace navigates to parent.
- Click-to-select and double-click directory navigation; focus remains comprehensible after input.
- Sorting by filename, size, and modification date; directory-first behavior and stable tie-breaks are documented and tested.
- Left and right paths/selection/sorting remain independent.
- Changes in directory are loaded asynchronously without freezing the UI; older responses may not replace newer results.
- Both panels look intentionally designed, with visible active focus and selection.
- Long names, hidden files, Unicode names, inaccessible and disappearing directories are handled deliberately.

## Non-goals
No file mutations; no terminal; no MCP; no remote filesystems; no previews; no plugins; no shell command execution.

## Acceptance evidence
1. `mise run ui-build`, `mise run rust-fmt`, `mise run rust-clippy`, `mise run rust-test` all pass, or precise blockers are documented.
2. Rust tests use temp directories to validate listing, ordering, metadata edge cases, missing directories, permissions where supported and symlink policy.
3. UI automated tests verify independent pane state, active focus, Tab, arrows, Enter, Backspace, and sorting with deterministic mocked IPC fixtures; results are explicitly labeled mocked.
4. A real WSLg Tauri smoke test shows browsing two distinct real directories with screenshot or a precise manual QA checklist.
5. UI is usable at a moderate window width without horizontal scroll of the whole application.
6. No code to copy, move, delete or rename files appears in this slice.
7. A handoff report lists commands and their actual results plus remaining Windows/macOS checks.

## Safety and implementation notes
- The implementation must not run destructive tests on the user's actual files.
- Avoid converting lossy display names back to filesystem paths.
- Do not traverse directory symlinks implicitly until navigation/loop policy is explicitly decided.
- Use ordinary Rust error propagation; no panics for filesystem errors.
- Keep Tauri commands narrow and typed; keep core filesystem code independently testable.

## Planning gate
Before implementation, use Superpowers brainstorming and writing-plans to decide native path transport, symlink navigation, sorting conventions, and what can be reliably UI-tested under WSLg. The proposed plan must be approved by the user.
