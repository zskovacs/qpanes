# Slice 001 — Hardening verification and acceptance handoff

Project names in these historical command examples have been updated to the current branding. Disposable test paths are illustrative and may no longer exist.

Historical first-hardening report. The second independent review found four further P2 defects; its FAIL verdict supersedes the PASS statements below. See [second hardening verification](001-second-hardening-verification.md) for corrections and the next review handoff.

Date: 2026-11-05. This continues Slice 001; Slice 002 was not started. No production mutation, terminal, provider, plugin or AI/MCP functionality was added. No commits, pushes or merges were performed.

## Original findings and resolutions

| Finding | Resolution | Evidence |
| --- | --- | --- |
| Retry removes its focused button and leaves focus on BODY | Transfer focus to the existing pane list synchronously, before clearing the error. No request completion changes focus. Preserve path edits started while a request is pending. | Trusted browser keyboard/pointer regressions: success, failure, empty directory, immediate arrows/Enter, intentional focus moves to the other pane and both same/other-pane path controls. Native successful Retry also retains list focus. |
| Narrow panes hide required metadata and modification sorting | Replace collapsed headers with a native sort select and direction button. Keep complete selected name/type/exact size/modification time in a native details control at every width; Alt+Enter opens it and Escape on its summary returns to the list. | Keyboard tests at 720×420 with 30%, 50%, 70% splits; 1200×780 equal/unequal panes; screenshots inspected; no whole-window horizontal scrolling. |
| Sorting supersedes navigation using the previous directory path | Introduce a pure typed Rust sorting command using the existing comparator. Loaded data sorts without filesystem reads. During navigation, coalesce sort preferences and order the arriving destination to the latest preferences. Keep the same sequence guard for newer navigation. | Controlled deferred directory and sort responses; repeated changes, independent pane preferences, no additional directory reads, and stale navigation/sort responses ignored. |
| Windows-only modulo parity expression fails current Clippy rules | Use `!bytes.len().is_multiple_of(2)`. | Linux formatting/Clippy checks pass; isolated parity-expression Clippy probe passes. Windows compilation itself remains unverified. |

## Parent navigation

- A discriminated UI row union separates real `FileEntry` objects from the virtual parent action. Only a backend-provided native parent identifier causes `[..]` to appear; frontend code never computes parents from path strings.
- The action is the first logical row in all sort modes/directions and is absent at roots. It has an up icon, participates in Arrow/Home/End selection, and opens through Enter or double-click.
- All parent actions reuse the same operation as Backspace and the toolbar. The exited directory's native identity is carried into the parent response, selected and scrolled into view. This works with a 10,000-entry virtualized listing.
- Missing-child fallback selects the first real entry, then the parent action if the directory is empty, then no selection at an empty root. Normal navigation preserves the existing first-real-entry selection convention.
- `[..]` is excluded from item/folder counts and real-entry sorting IPC. A real file named `[..]` is still an ordinary, distinct file. A desktop Rust test rejects a virtual `kind: parent` payload as a filesystem entry. No mutation API exists.

## Acceptance checklist

| Criterion | Result |
| --- | --- |
| Original listing, navigation, selection, errors, sorting and independent panes | PASS on Linux/WSLg |
| Retry retains usable focus on success/failure, without stealing intentional focus | PASS |
| Minimum-size and unequal panes retain sorting and selected metadata | PASS |
| Repeated sorting during navigation preserves destination/latest preferences | PASS |
| Stale navigation and sort responses cannot replace newer navigation | PASS |
| Parent row first in every ordering, absent at backend roots | PASS |
| Parent Enter/double-click/Backspace, independent state and restored child selection | PASS |
| Virtualized offscreen selection restoration and missing-child fallback | PASS |
| Virtual actions excluded from counts and real-entry IPC | PASS |
| Formatting, linting, Rust tests, Svelte checks/build and analyzer | PASS |
| Real filesystem access through the native Tauri application | PASS |
| Windows/macOS native compilation, root behavior, UI and release packaging | UNVERIFIED |

## Commands and final results

| Command | Result |
| --- | --- |
| `mise run ui-check` | PASS: 0 errors, 0 warnings |
| `mise run ui-build` | PASS: static production frontend |
| `mise run rust-fmt` | PASS: both crates |
| `mise run rust-clippy` | PASS: both crates/all local targets with `-D warnings` |
| `mise run rust-test` | PASS: 11 core tests plus 1 desktop boundary test; doc/binary targets successful |
| `npx @sveltejs/mcp svelte-autofixer <component> --svelte-version 5.57.3` | PASS: no issues in FilePane, Icon or page; optional suggestions about retained DOM handles only |
| `pnpm tauri build --debug --no-bundle` | PASS: native Linux binary |
| `playwright-cli -s=qpanes-hardening --raw run-code --filename=tests/ui/readonly.cli.mjs` | PASS: 35 original renderer acceptance checks, extended for the virtual row |
| `playwright-cli -s=qpanes-hardening --raw run-code --filename=tests/ui/hardening.cli.mjs` | PASS: 95 hardening regression checks |
| `WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9224 GDK_BACKEND=x11 src-tauri/target/debug/qpanes` | PASS: final built app launches on WSLg |
| `QPANES_INSPECTOR=http://127.0.0.1:9224 node tests/native/smoke.mjs` | PASS: 18 real Tauri/Rust IPC checks |
| `clippy-driver --crate-type lib --edition 2024 --emit metadata ... -D warnings -` | PASS: isolated native-byte-length parity expression using `is_multiple_of` |
| `git diff --check` | PASS |

The renderer suites mock IPC only. They never substitute fixtures in production code. The hardening suite uses controlled promises instead of timing guesses and verifies captured keyboard events are trusted; after Retry it uses `page.keyboard` without locator helpers that would conceal lost focus. The native suite reads actual generated temporary files through Rust, including a native root, Unicode metadata, broken links, permissions, pure sorting, parent selection restoration and Retry. Its input is DOM-dispatched, explicitly distinct from trusted browser input or native OS keyboard delivery.

The initial native suite needed selectors updated to distinguish the virtual parent from real rows. One intermediate renderer run was interrupted by Vite reloading generated files during a concurrent frontend check/build. Final renderer runs were executed after builds completed and passed.

## Evidence and reproduction

Start `pnpm dev`, open a Playwright CLI Chromium session, then run both renderer commands above sequentially. For native verification, build and launch the debug binary with the localhost inspector environment above, then run the native smoke command. The scripts generate temporary fixtures and clean them; they do not mutate user files. The browser/runtime setup for this WSL environment is described in the historical [initial verification report](001-verification.md).

Ignored local evidence under `test-results/`:

- `slice-001-renderer.txt` — 35 baseline assertions.
- `slice-001-hardening.txt` — 95 controlled hardening assertions.
- `slice-001-hardening-compact.png` — 720×420 with selected metadata open.
- `slice-001-hardening-unequal.png` — 1200×780 with unequal panes, compact sorting and metadata.
- `slice-001-hardening-desktop.png` — normal desktop view, including distinct real/virtual `[..]` rows.
- `slice-001-native.png` and `slice-001-native.json` — real built Tauri application and 18 native checks.

## Changed areas and critical self-review

Changes are limited to the pane component, shared icon/IPC modules, thin Tauri adapter, Windows core lint expression/serialization derives/root tests, the existing renderer/native suites plus an additional hardening suite, and Slice 001 usage/design/architecture/acceptance documentation. No project dependency was added or framework replaced.

Self-review found no known critical defect in the verified scope. Rust still owns parent/path semantics and comparator behavior. Async completion never refocuses controls. The virtual action has no filesystem-entry payload. Every production filesystem operation remains read-only. The approved hardening acceptance criteria pass in the Linux/WSLg scope; this is not a claim of cross-platform release readiness, nor authorization to merge.

Remaining risks and manual checks:

- Only `x86_64-unknown-linux-gnu` is installed. Windows/macOS native compilation, Windows drive/UNC roots, surrogate transport, and platform-native permissions require target-native runs. New Windows root tests and the existing surrogate test were not executed on Linux; mocked root labels do not verify native Windows behavior.
- Native OS keyboard delivery and screen-reader interaction remain manual QA. Trusted Chromium input is verified; the native script's DOM-dispatched input does not prove OS event delivery.
- WSLg emitted EGL/DRI access warnings but rendered native screenshots successfully. Hardware acceleration, installers, signing and release builds remain unverified. The inherited `io.qpanes.app` bundle-identifier warning remains a packaging follow-up.
- The pure sorter avoids filesystem I/O but serializes the complete real listing across IPC. Rust listing/metadata still materializes all entries; very large or slow mounted filesystems remain a performance risk. Superseded worker jobs finish rather than being cancelled.
- Parent directory symlink rows remain deliberately non-navigable; explicitly typed paths may canonicalize links. No watchers, persistence, multi-selection, mutation or navigation-history feature was introduced.

Recommended next action: independent acceptance review of these Slice 001 fixes, then target-native release QA. Slice 002 remains out of scope until Slice 001 is accepted.
