# Slice 001 — Read-only dual-pane filesystem browser

Status: IMPLEMENTED; ACCEPTANCE FAIL — the latest independent review confirmed the second-hardening fixes but found remaining warning-layout and rapid disclosure-close defects. See [current acceptance status](001-acceptance-status.md) and [second hardening verification](001-second-hardening-verification.md). Merging the current implementation is explicitly user-authorized; it does not grant Slice 001 acceptance. Native Codex planning; no Superpowers.

## Outcome
QPanes launches under WSLg and presents two independent, resizable local-file panes driven by real Rust directory listings, with predictable keyboard control and explicit loading/empty/error states.

## Scope
- Display path, filenames, entry type (directory/file/symlink), size when meaningful, and modified timestamp where available.
- Browse into directories and up to a parent directory; prevent navigation beyond logical roots.
- Show a virtual `[..]` row first when Rust supplies a parent. Enter/double-click and Backspace share parent navigation and restore the exited child selection, including offscreen virtualized rows. Exclude the action from real counts and file-entry IPC.
- Switch active pane with Tab. Arrow Up/Down moves the active pane's selection. Enter opens a selected directory. Backspace navigates to parent.
- Click-to-select and double-click directory navigation; focus remains comprehensible after input.
- Sorting by filename, size, and modification date; directory-first behavior and stable tie-breaks are documented and tested.
- All sort keys/directions and full selected metadata remain accessible at 720×420 and unequal panel widths, through compact controls where columns collapse.
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
8. Trusted browser input verifies Retry focus after success/failure, pending focus moves to another pane/control, and intentional edits made during a request.
9. Deferred navigation and memory-sort regressions prove destination preservation, latest sort preferences, independent panes and stale-response rejection. Loaded sorting performs no directory reads.
10. Compact sort controls and selected metadata are keyboard-accessible at 720×420 with 30%, 50% and 70% splits, without whole-app horizontal scrolling.
11. Parent actions are first in all six sort combinations, absent at backend roots, keyboard/double-click navigable and excluded from counts/real-entry IPC. Returning through parent/Backspace restores and reveals the child; a missing child has a valid fallback.
12. The Windows-only parity lint is corrected; Windows/macOS compilation and target-native tests remain unverified until executed there.
13. Retry preserves the original destination and desired child selection through repeated parent permission failures, for both `[..]` and Backspace. Offscreen selections are revealed; inactive panes and intentional focus moves are preserved.
14. Escape cancels unsubmitted address editing. Pending completion may update the address, active genuine edits survive, and stale successes/failures cannot replace a newer location.
15. At 720×420 and 30%, 50%, 70% splits, paths/messages exceeding 500 characters cannot collapse the list or clip the footer. Retry and full scrollable error details remain keyboard-accessible without whole-window overflow.
16. Window/splitter resizing in either direction transfers disappearing sort focus to a visible equivalent, preserves selection/active pane, and leaves unrelated controls' focus alone.

## Safety and implementation notes
- The implementation must not run destructive tests on the user's actual files.
- Avoid converting lossy display names back to filesystem paths.
- Do not traverse directory symlinks implicitly until navigation/loop policy is explicitly decided.
- Use ordinary Rust error propagation; no panics for filesystem errors.
- Keep Tauri commands narrow and typed; keep core filesystem code independently testable.

## Implementation plan

1. Keep the generated SvelteKit static client, Vite, Tauri 2 and existing toolchains. Add `crates/qpanes-core`, referenced by the desktop crate, with no Tauri dependency.
2. Implement directory listing and sorting in the core. Transport native paths as opaque, platform-tagged hexadecimal bytes (Unix) or UTF-16 units (Windows); lossy strings are display labels only. Typed absolute paths are a separate explicit navigation target. Canonical paths provide parents and root boundaries. Start each pane at the home directory, falling back to the working directory.
3. Use `symlink_metadata`: show links, including broken links, without following them for metadata or opening them through rows. Explicit typed paths may resolve links through canonicalization. Report per-entry metadata failures and partial enumeration warnings without failing the whole directory.
4. Sort directories first in either direction. Name order uses Unicode lowercase comparison, exact names, then opaque native path as deterministic ties. Size/date unknowns remain last; name is the tie-breaker. Keep sorting in Rust.
5. Expose one typed listing command; run all filesystem work through Tauri's blocking worker pool. Each pane owns its request sequence, path, sort, selection and scroll. Ignore stale responses; preserve the previous location after failed navigation.
6. Build a compact dark desktop UI with editable paths, parent/home/refresh controls, independent selection, keyboard operation, accessible resize control and visible loading/empty/error states. Render only a viewport plus overscan using fixed-height rows; no virtualization dependency.
7. Verify core behavior with isolated temporary fixtures, then renderer interaction using Playwright CLI and mocked IPC, including delayed/out-of-order responses and large directories. Separately build/launch the native app and verify real Rust listings under WSLg where supported. Record exact evidence and Windows/macOS limitations.

No additional approval cycle is required by the user's explicit instruction to plan and then implement this goal. No commits, pushes or merges are authorized.

## Acceptance hardening plan

1. Transfer Retry focus to its pane synchronously before removing the error banner; never refocus after the asynchronous request. Test success, failure, empty results and intentional focus moves with trusted browser keyboard events.
2. Keep all sort keys/directions available through a compact select and direction button when headers collapse. Add keyboard-accessible selection details with complete name/type/size/time at every pane width. Verify 720×420 and normal/unequal layouts without whole-window overflow.
3. Add a thin, typed pure-sort IPC adapter reusing Rust `sort_entries`, without filesystem I/O. Sort loaded entries in memory. During navigation, retain sort preferences and apply the latest preferences to the arriving destination before committing it; retain sequence guards and independent pane state.
4. Fix the Windows parity expression with `is_multiple_of`. Retain native path semantics and existing filesystem tests; explicitly leave Windows/macOS native verification unclaimed.
5. Model displayed rows as a discriminated union of real entries and a virtual parent action. Prepend `[..]` only when Rust supplies a parent. Route Enter/double-click/Backspace through the same parent operation, retain native child identifiers for selection restoration and scroll into view, and exclude the virtual row from real item counts and file-entry IPC.
6. Extend the existing renderer and native suites; add deterministic deferred-navigation/sort/focus regressions, virtual-row/root/return-selection checks, compact metadata checks and virtualized offscreen selection checks. Run all configured quality gates and the Svelte analyzer, inspect screenshots, then critically review the resulting diff and update acceptance evidence.

## Second acceptance hardening plan

1. Retain a pane-local navigation intent containing both destination and desired selection. Retry replays that intent, including across repeated failures; sequence guards and virtualized selection restoration remain unchanged.
2. Distinguish an active address edit from a canceled/submitted edit. Preserve edits made during requests, but let Escape release the address for the current and subsequently committed location.
3. Bound the error banner independently of path/message length. Offer keyboard-accessible, scrollable full details while retaining the list, Retry and footer at 720×420, including unequal panes.
4. Preserve focus ownership when responsive sort controls become hidden. Transfer only disappearing sort focus to a visible equivalent; do not refocus on asynchronous navigation or steal focus from another control.
5. Add deterministic trusted-input browser regressions for both panes and native temporary-fixture permission recovery/long paths. Prove the reported failures before editing, run all existing suites and quality gates, inspect screenshots, and record platform limits for another independent review.
