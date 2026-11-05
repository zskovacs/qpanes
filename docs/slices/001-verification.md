# Slice 001 — Verification and handoff

Project names in these historical command examples have been updated to the current branding. Disposable test paths are illustrative and may no longer exist.

Historical initial implementation report. The independent acceptance review subsequently identified focus, compact-layout and pending-navigation defects. Current resolutions and evidence are recorded in [Slice 001 hardening verification](001-hardening-verification.md); the original PASS statements below are not the current acceptance verdict.

Date: 2026-11-05. Scope: read-only local filesystem browsing. Native platform tested: Linux under WSLg, WebKitGTK 2.52.6. Existing SvelteKit static output and Tauri scaffold retained. No commits, pushes or merges performed.

## Acceptance review

| Criterion | Status | Evidence |
| --- | --- | --- |
| Two real, independent filesystem panels | PASS | Native home discovery and distinct temporary left/right directories through real Tauri IPC |
| Filename, type, size, modification date and current path | PASS | Rust metadata tests; native visible 5-byte file, Unicode name and broken link |
| Directory/parent navigation and root boundaries | PASS | Core tests; renderer Enter/Backspace/root checks; native navigation and restored child selection |
| Independent selection, active pane and keyboard controls | PASS | Playwright trusted Tab, arrows, Enter, Backspace, Ctrl+L, Home/End; native DOM-dispatched handlers |
| Name/size/date ordering | PASS | Rust ascending/descending tests and deterministic ties; renderer sort IPC; native size order |
| Resizable, dark, compact layout and focus indicators | PASS | Keyboard/pointer resize checks, screenshot inspection, 720px layout with no whole-app overflow |
| Loading, empty, errors and stale responses | PASS | Delayed/out-of-order mocked IPC; Rust missing/disappearing/permission errors; native empty/permission/missing checks |
| Large-directory rendering and Rust I/O evaluation | PASS | 10,000 mocked entries rendered 23 options; real 10,000-file Rust test, approximately 18.7ms for enumeration/metadata/name sort in one local debug run |
| Read-only production filesystem boundary | PASS | Only list/read-metadata/canonicalize code in the filesystem core; test writes confined to generated temporary fixtures |
| Build, static checks, tests and handoff | PASS | Commands below; architecture and design decisions documented |
| Windows/macOS native behavior and installers | UNVERIFIED | Target-native machines and release packaging were outside this Linux verification run; required before cross-platform release |

Slice review found no known critical defect in the verified scope. It is ready for review as Slice 001; this report does not authorize merging or claim a cross-platform release.

## Commands and outcomes

| Command | Outcome |
| --- | --- |
| `mise run ui-check` | PASS: 0 Svelte/TypeScript errors, 0 warnings |
| `mise run ui-build` | PASS: adapter-static writes `build/` |
| `mise run rust-fmt` | PASS: both crates |
| `mise run rust-clippy` | PASS: both crates, all targets, `-D warnings` |
| `mise run rust-test` | PASS: 11 core tests, desktop/doc test targets successful |
| `rtk bypass cargo test --manifest-path crates/qpanes-core/Cargo.toml large_directory -- --nocapture` | PASS: real 10,000-entry listing and ordering, timing above |
| `npx @sveltejs/mcp svelte-autofixer <component> --svelte-version 5.57.3` | PASS: no issues in FilePane/page; Icon previously checked with no issues. Optional suggestions about DOM bindings retained because focus, scrolling and resize require element handles |
| `pnpm tauri build --debug --no-bundle` | PASS: final Linux binary at `src-tauri/target/debug/qpanes` |
| `pnpm dev` | PASS outside the restricted network sandbox; local Vite server on port 1420 |
| `playwright-cli -s=qpanes --raw run-code --filename=tests/ui/readonly.cli.mjs` | PASS: 34 mocked-IPC renderer acceptance checks |
| `WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9222 GDK_BACKEND=x11 src-tauri/target/debug/qpanes` | PASS: final native build launches on WSLg |
| `node tests/native/smoke.mjs` | PASS: 14 real Tauri/Rust IPC checks with DOM-dispatched input events |
| `git diff --check` | PASS |

Core fixtures cover empty folders, files/metadata, hidden and Unicode names, ascending/descending name/size/date sorting, stable ties, unknown metadata, pre-epoch time, nonexistent/non-directory/relative/malformed paths, parent/root boundaries, colliding non-UTF-8 display names, broken/looping symlinks, Unix permission denial and a large directory. Permission assertions explicitly skip on filesystems/users that bypass mode bits; permissions were enforced in this WSL run. A Windows-only unpaired UTF-16 surrogate roundtrip test is present but was not executed here.

Current documentation was retrieved using the installed Context7 CLI for Tauri/Svelte, plus the official Svelte documentation/autofixer CLI. No new project frontend dependencies, MCP servers or skills were installed.

## UI evidence and reproduction

Local artifacts are intentionally ignored by Git, per repository policy:

- `test-results/slice-001-native.png` — actual built Tauri webview with two distinct real temporary directories, metadata and size sorting. Inspected visually.
- `test-results/slice-001-native.json` — native check results.
- `test-results/slice-001-desktop-mocked.png` — 1200×780 mocked renderer, independent paths and selections. Inspected visually.
- `test-results/slice-001-compact-mocked.png` — 720×480 mocked renderer. Inspected visually.
- `test-results/slice-001-renderer.txt` — 34 renderer assertions.

Renderer reproduction: start `pnpm dev`, open a Playwright CLI Chromium session at `http://127.0.0.1:1420`, then run the renderer command above. The suite installs its own deterministic IPC implementation before navigation and never reads the machine filesystem. It also verifies the explicit desktop-unavailable error.

This machine initially had no Playwright browser and lacked Chromium's `libnspr4`/`libnss3` libraries. Chromium was downloaded to `/tmp/qpanes-browsers`; the missing packages were downloaded and extracted into `/tmp/qpanes-browser-libs`, without system installation. The successful browser session used:

```sh
LD_LIBRARY_PATH=/tmp/qpanes-browser-libs/usr/lib/x86_64-linux-gnu \
  playwright-cli -s=qpanes open http://127.0.0.1:1420 --config=/tmp/qpanes-playwright.json
```

The temporary CLI config selected Chromium with `executablePath` `/tmp/qpanes-browsers/chromium-1252/chrome-linux64/chrome` and `headless: true`. A normal installed Playwright browser needs no such override.

Native reproduction: build the debug binary, launch it with the inspector command above, then run `node tests/native/smoke.mjs`. The script discovers the WebKit page target, generates fixtures under the system temp directory, drives the actual UI, captures the native page and cleans its fixtures. It uses real Rust IPC throughout. Its keyboard events are DOM-dispatched; this is distinct from OS input delivery and from the mocked browser suite. Inspector configuration is confined to the launch environment; no production testing hooks were added.

## Changed areas and decisions

- `crates/qpanes-core/`: standalone Serde-only filesystem library, lossless path encoding, typed errors/listings, sorting, fixture tests and lockfile.
- `src-tauri/`: path dependency and lockfile update, thin asynchronous listing command, desktop window dimensions/minimum.
- `src/lib/`: typed frontend IPC contract, formatting, reusable SVG icons, pane component and shared dark design tokens.
- `src/routes/+page.svelte`, `src/app.html`: dual-pane shell, active focus and resize behavior; template title removed.
- `tests/`: repeatable renderer CLI acceptance suite and native WebKitGTK smoke script. These run in their respective CLI/Node contexts as `.mjs` files.
- `mise.toml`: TypeScript/Svelte check task and verification of both Rust crates.
- `README.md`, architecture/design/slice docs: usage, concrete decisions, plan and this verification report.

Full decisions are in `docs/ARCHITECTURE.md`: opaque Unix-byte/Windows-UTF-16 identifiers; explicit typed-path navigation; non-traversed symlink rows; canonical native parents; directory-first deterministic ordering; blocking-pool filesystem work; pane-local sequence guards; viewport rendering without a new library.

## Limitations and release QA

- Windows and macOS native builds, drive/UNC roots, Windows UTF-16 cases, macOS permissions, native focus and shortcut conventions require target-native testing before release.
- Real native OS keyboard delivery, screen-reader use and hardware/GPU rendering remain manual QA. WSLg emitted EGL/DRI device-access warnings but rendered the native screenshot successfully; GPU acceleration was not verified. No app security controls were disabled.
- The original `io.qpanes.app` bundle identifier triggers a Tauri macOS packaging warning because of its `.app` suffix. Installer/signing/release builds were not verified; only a debug native build without bundles was requested for this slice.
- Narrow panes collapse type/date columns; selected type and tooltips provide detail where shown. At ordinary desktop widths all requested columns/sort controls are present.
- Listings are fully enumerated and serialized; metadata on slow/mounted filesystems can remain pending. Older responses are ignored rather than cancelling Rust jobs. The 18.7ms result is one local fixture measurement, not a performance guarantee.
- Symlink rows are deliberately non-navigable. Explicit typed paths may resolve symlinks. Sorting is deterministic Unicode case-insensitive ordering, not locale-aware natural ordering.
- No live filesystem watcher, persistence, multi-selection or file launching is included. Refresh reloads a directory. Non-UTF-8 labels can contain replacement glyphs, while their identifiers/navigation remain lossless; glyph coverage depends on installed fonts.
- `mise` emitted a cache-write warning in the restricted environment; final task exit codes passed. Initial sandbox DNS/listen failures were resolved by running documentation/local-server/browser checks with the appropriate external access.

Recommended Slice 002 scope: safe create-folder and rename, then copy/move/trash with explicit conflicts, permissions and errors; reusable Rust domain operations and temporary-fixture tests first. Keep operation progress/cancellation, terminals, remote providers and AI/MCP in their planned later slices. Resolve target-native release QA before shipping mutating workflows.
