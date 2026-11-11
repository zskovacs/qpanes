# Slice 004 — Daily usability

Status: Implemented, independently reviewed and accepted by the user for merge into `main` (2026-11-11) within the Linux/WSLg scope. An independent read-only Codex review returned FAIL with two P2 findings (R004-01/02); both were corrected and the focused re-review confirmed them (PASS), while finding R004-03, which is now also corrected with red/green regressions. A final focused re-check returned **PASS for R004-01, R004-02 and R004-03 with no new P0–P3 finding** (see below). Trusted native XTest pointer evidence depends on WSLg granting the test window OS focus and is reported per run. The user explicitly authorized proceeding from this plan directly to implementation and verification. Superpowers is not used; `AGENTS.md` was minimally updated to reflect that project decision. Windows/macOS runtime is NOT VERIFIED.

## Inspection baseline

Read AGENTS, PRODUCT, ARCHITECTURE, DESIGN, ROADMAP and the Slice 003 specification, hardening and final acceptance record (PASS within the verified Linux/WSLg single-instance scope; no open acceptance-blocking defect). Inspected `FilePane.svelte`, `+page.svelte`, `OperationDialog.svelte`, `OperationsPanel.svelte`, `WindowHeader.svelte`, `operations.ts`, `filesystem.ts`, the desktop adapter, `qpanes-core` (listing, native identifiers, invalidation, OperationManager) and every renderer/native/Node test harness.

Relevant findings:

- Each `FilePane` instance owns its listing, request sequence, navigation revision, selection, sort, scroll, path draft and invalidation guards. Reusing one instance per tab preserves all of these guarantees without re-implementing sequencing.
- All mutations already go through `submit_operation` with immutable captured intent and per-renderer submission tokens; completions invalidate panes by exact native directory/subtree. Inactive tabs must simply be included in that broadcast.
- Keyboard handling is split between the list's navigation keys (`FilePane`) and a window-level handler in `+page.svelte` for F2/F5/F6/F7/Delete and Ctrl/Cmd+L. There is no settings or persistence layer yet.
- The installed Tauri 2.12.5 builds a default native menu **on macOS only**. It owns ⌘W (Close Window), ⌘Q, ⌘H, ⌥⌘H, ⌘M, ⌃⌘F and the Edit-menu clipboard keys. Windows/Linux have no default menu.
- Native tests do not isolate `XDG_CONFIG_HOME`; once settings exist they would write the developer's real configuration. The native launcher must isolate it.
- No unresolved Slice 003 safety defect affects this slice. Known inherited limits (Windows Trash fails closed, no cross-device move, Windows/macOS runtime unverified) remain.

## Scope

A. Independent tabs in both panels; B. Favorites; C. Quick Filter; D. internal single-entry drag and drop between panels that queues Copy/Move through the existing OperationManager after explicit confirmation; E. centralized configurable keyboard shortcuts. Plus the minimal persistence needed for favorites, custom shortcuts and tab/session restoration.

## Explicit non-goals

Multi-selection, batch operations, recursive/indexed/fuzzy/full-text search, external OS drag and drop, drops onto rows or inactive tabs, remote filesystems, terminal, MCP/AI, operation-engine redesign, pause/resume, themes, large redesign, general performance rewrites, unrelated cosmetic fixes, a custom macOS native menu, global (system-wide) hotkeys, databases, cloud sync.

## Architecture

```
Svelte UI ──typed IPC──▶ Tauri adapter (thin) ──▶ qpanes-core
  PanelTabs (per side)                               list_directory (+ directory name)
    └─ FilePane (one per tab)                        probe_directories (favorite availability)
  FavoritesDialog / ShortcutsDialog                  settings: versioned JSON load/save
  OperationDialog (+ transfer choice)                OperationManager (unchanged, sole mutator)
  shortcuts.ts / filter.ts / tabs.ts / favorites.ts / settings.ts (pure, Node-tested)
```

- **Tabs.** A new `PanelTabs.svelte` owns one side: its heading, tab strip and one mounted `FilePane` per tab. Inactive tabs stay mounted but `hidden`, so listing data, selection, sort, filter, path draft and logical scroll survive switching without re-reading. Scroll is tracked logically while hidden (a hidden element has no scroll box) and re-applied when shown. Restored inactive tabs load lazily on first activation. The page talks to the active tab through the wrapper and broadcasts operation invalidations to every mounted tab. Row element IDs include the tab ID.
- **Directory name.** `DirectoryListing` gains `name` (the native final component, lossy display only; the full label for roots) so tab labels never split opaque or display paths in JavaScript.
- **Quick Filter.** Pure `filter.ts` normalizes names once per listing (NFC + `toLowerCase`) and filters the already-sorted in-memory entries; no IPC per keystroke. The virtual `[..]` row stays first when the directory has a parent. Virtualization operates on the filtered rows.
- **Drag & drop.** Pointer Events, not HTML5 DnD: deterministic on WebView2/WebKitGTK/WKWebView, independent of Tauri's native file-drop handler (which stays enabled, so external OS drops keep being absorbed without navigating the webview), and testable with trusted Playwright and XTest pointer input. The page owns one drag controller. A drop only opens the confirmation dialog; the chosen Copy/Move is submitted through the existing `submit_operation` path.
- **Shortcuts.** Pure `shortcuts.ts` defines actions, platform defaults, canonical combos, validation, reserved keys, conflicts and resolution. The page has the single window `keydown` dispatcher. List navigation keys stay in `FilePane`.
- **Persistence.** `qpanes-core::settings` owns a versioned JSON document in the Tauri app configuration directory, with lenient load, strict save, size/count bounds, native-path validation and atomic replace. The adapter adds `load_settings`, `save_settings` and `probe_directories`. No plugin, database or new capability permission. `serde_json` is added to the core crate only (already in the desktop dependency graph).

## Keyboard behavior

Defaults (Windows/Linux · macOS):

| Action | Default | Customizable |
| --- | --- | --- |
| Copy / Move / New folder / Rename / Trash | F5 / F6 / F7 / F2 / Delete (both) | yes |
| New tab | Ctrl+T · ⌘T | yes |
| Close tab | Ctrl+W · ⇧⌘W (⌘W is the native macOS Close Window menu item) | yes |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab (physical Control on macOS too) | yes |
| Quick Filter | Ctrl+F · ⌘F | yes |
| Add current directory to Favorites | Ctrl+D · ⌘D | yes |
| Open Favorites | Ctrl+B · ⌘B | yes |
| Keyboard shortcuts settings | Ctrl+, · ⌘, | yes |
| Arrows, Home/End, PageUp/PageDown, Enter, Backspace, Tab, Escape, Alt+Enter, Ctrl/Cmd+L | unchanged | no (reserved) |

Dispatch rules: one window listener; matched shortcuts call `preventDefault`. Nothing dispatches while a dialog, the shutdown prompt or a drag owns input. In text inputs only Quick Filter is honoured (it re-focuses/selects the filter); all other shortcuts are suppressed so typing never triggers actions. Key repeat is ignored except for next/previous tab. Actions only open the existing confirmation dialogs, never mutate directly. A small set of WebView defaults (F3, F5, F7, Ctrl/Cmd+F/G/P/R) is suppressed where they would otherwise navigate or open browser UI.

Validation: printable keys require Ctrl, Alt or ⌘; reserved navigation keys, OS-reserved combinations (Windows/Linux: any Super/Windows-key combination, Alt+F4, Alt+Tab, Ctrl+Alt+Delete, Ctrl+Alt+F1–F12; macOS: ⌘Q/W/H/M, ⌥⌘H, ⌘Tab/Space/\`, ⌃⌘F/Q, ⇧⌘3/4/5, Edit-menu ⌘C/V/X/A/Z/⇧Z) and conflicts are rejected with the conflicting action named. Letter/digit keys fall back to `KeyboardEvent.code` when the layout produces a non-ASCII character. Persisted overrides that are unknown, invalid, reserved or conflicting are dropped individually with a warning; defaults are conflict-free by test.

Tabs: Ctrl/Cmd+T opens a new tab on the current directory (copying sort), placed after the current tab, and focuses its list. Close keeps at least one tab per panel (closing the last tab is refused with a notice) and activates the right neighbour, else the left. Next/previous wrap within the active panel. Tab clicks activate and focus the list; Arrow Left/Right move between tabs in the tab strip; middle-click closes. At most 32 tabs per panel.

Quick Filter: Ctrl/Cmd+F opens/focuses the filter bar of the active tab. Typing filters immediately. ArrowUp/Down/PageUp/PageDown move the list selection while typing. Enter moves focus to the list and opens the selection. Escape (in the filter or in the list while a filter is active) clears and closes the filter and returns focus to the list, keeping the selected entry. Clicking the list keeps the filter. Navigating to another directory clears it; refreshing the same directory keeps it.

## Persistence model

File: `<app config dir>/settings.json` (Linux `$XDG_CONFIG_HOME/io.qpanes.app`, Windows `%APPDATA%\io.qpanes.app`, macOS `~/Library/Application Support/io.qpanes.app`).

```json
{ "version": 1,
  "favorites": [{ "id": "…", "label": "Projects", "path": "u:2f686f6d65…", "location": "/home/u/projects" }],
  "shortcuts": { "closeTab": "Ctrl+Shift+W" },
  "session": { "activeSide": "left",
    "left":  { "activeTab": 0, "tabs": [{ "path": "u:…", "location": "/home/u", "name": "u", "sort": "name", "direction": "ascending" }] },
    "right": null } }
```

- Paths are the opaque native identifiers; `location`/`name`/`label` are display-only and never converted back into paths.
- Only shortcut overrides are stored. Filters, selection and scroll are not persisted (transient view state).
- Load: missing → defaults; unreadable (I/O error) → defaults with persistence **disabled** for the session so an unreadable file is never overwritten; corrupt, oversized, wrong version or individually invalid items → the original bytes are first preserved as `settings.invalid.json`, then valid content (or defaults) is used with visible warnings. If that backup cannot be written, persistence is disabled.
- Save: strict validation (rejects rather than silently dropping), ≤ 2 MiB, written to an exclusive temporary file, flushed and atomically renamed. The renderer serializes writes (one in flight, latest state wins) and only enables saving after a successful load.
- Limits: 256 favorites, 200-character labels, 32 tabs per panel, 64 shortcut entries, bounded identifier lengths.
- Single-instance assumption: concurrent instances are last-writer-wins (documented, not merged).

## Filesystem safety requirements

- The OperationManager remains the only mutation executor. Tabs, favorites, filter and shortcuts never mutate filesystem contents. Favorites editing touches only the settings file.
- Drag and drop: only a real `file`/`directory` row of the active tab can be dragged; the `[..]` action never can. A drop captures source entry identity, source and destination native locations at drop time, then opens a modal Copy / Move / Cancel dialog. Nothing is submitted without an explicit choice. Same-directory and directory-into-itself/descendant drops are rejected before the dialog (descendant check through the existing pure Rust classifier; IPC failure fails closed). The backend still revalidates identities, types, ancestry and conflicts and never overwrites.
- Any keyboard input, window blur, pointer cancellation, lost capture or release outside the opposite pane's displayed directory cancels a drag. Tab strip, header (Tauri drag region), source pane and outside-window releases are not drop targets.
- Queued/running jobs keep their originally confirmed intent; tab switches, closes and drag state never alter or resubmit them. Invalidations reach all mounted tabs whose displayed or in-flight directory is affected and nothing else.
- All new filesystem tests use disposable fixtures; native launchers isolate `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and the D-Bus session.

## Implementation checkpoints

- **A Tabs:** core `name`, `PanelTabs`, `FilePane` view refactor, tab actions, logical scroll, invalidation broadcast, session capture.
- **B Favorites:** core settings + `probe_directories`, adapter commands, `settings.ts`, `favorites.ts`, `FavoritesDialog`, add/open/new-tab/rename/remove, unavailable state.
- **C Quick Filter:** `filter.ts`, filter bar, selection/focus rules, empty state, 10,000-entry responsiveness.
- **D Drag & drop:** pointer drag controller, drop feedback, validation, transfer dialog, submission through the manager.
- **E Shortcuts:** `shortcuts.ts`, dispatcher, `ShortcutsDialog`, persistence/reset, labels in toolbar and titles.
- **F Integration:** cross-feature races (tab switch during dialog/drag, completion into inactive tabs, filter + invalidation, persistence + restart).
- **G Final QA:** all gates, existing and new browser suites, native IPC/restart/XTest checks, Svelte analyzer, self-review.

Each confirmed defect gets a regression test that fails before the correction.

## Test plan

- Rust: settings load/save (missing, corrupt, wrong version, oversized, partial invalid items, backup, unreadable/disabled, atomic replace, strict save rejection, non-UTF-8 Unix identifiers, cross-platform identifier rejection), `probe_directories`, listing `name`; disposable fixtures only.
- Node: shortcuts (defaults conflict-free on both platforms, canonicalization incl. layout fallback, reserved/invalid, conflicts, sanitizing persisted overrides), filter (case/Unicode policy, 10,000-entry timing), tabs helpers, favorites helpers, settings writer serialization/coalescing.
- Browser (mocked IPC, trusted Chromium input): tabs in both panels with state restoration and no re-read on switch; invalidation of inactive tabs; favorites persistence/navigation/unavailable/duplicates; Quick Filter with 10,000 entries, empty state, focus, Enter/double-click, `[..]`; drag/drop with no mutation before confirmation, Copy/Move submission, cancellation, invalid targets, tab switch attempts during drag/dialog; shortcuts customization/conflict/persistence/reset/text-input suppression/no duplicate submission; controlled IPC delays for races; all existing suites as regressions.
- Native (Linux/WSLg, real Tauri IPC + Rust, disposable fixtures, isolated config): tabs/favorites persistence across a real close and relaunch, unavailable restored tab, real copy/move via drag dialog with byte verification and no mutation before confirmation, filter on a real 10,000-entry directory, XTest keyboard shortcuts and XTest pointer drag where available.

## Acceptance criteria

1. Both panels support independent tabs; switching restores directory, selection, sort, filter and scroll without re-reading unchanged data.
2. Ctrl/Cmd+T, close (Ctrl+W / ⇧⌘W), Ctrl+Tab, Ctrl+Shift+Tab work; the last tab cannot be closed into an invalid state.
3. Tabs, active tab and active panel restore after restart; an unavailable restored directory shows an unavailable state at its own location.
4. Favorites can be added (duplicates detected), opened here or in a new tab, renamed, removed, and persist; unavailable targets are flagged; targets are never rewritten.
5. Quick Filter is case-insensitive, per tab, IPC-free per keystroke, responsive at 10,000 entries, keeps sorting, `[..]`, virtualization, Enter/double-click and focus rules, and shows an empty state.
6. Internal drag/drop queues exactly one Copy or Move through the OperationManager only after explicit confirmation, rejects invalid targets, and survives the listed edge cases.
7. Shortcuts are centralized, customizable, persisted, resettable, conflict/reserved-checked, platform-aware and suppressed in text inputs and dialogs.
8. Existing keyboard workflows, operations, safety guarantees, focus behavior, chrome and DPI behavior do not regress.
9. All configured gates and suites pass; native evidence is reported with its input method; Windows/macOS gaps are stated.

## Implementation and verification record — 2026-11-11

This is an implementation handoff and self-review, **not independent acceptance**. Branch `slice-004-daily-usability`; nothing was committed, pushed, merged or switched. Slice 005 was not started.

### Implemented behavior

- **Tabs:** independent tab strips in both panel headings (no extra vertical space); Ctrl/Cmd+T, close (Ctrl+W / ⇧⌘W, × glyph or middle-click), Ctrl+Tab / Ctrl+Shift+Tab, click and Arrow/Home/End roving in the strip. Per-tab directory, selection, sort, filter, path draft and scroll survive switching without IPC. Inactive tabs receive operation invalidations; unaffected tabs are not re-read. The last tab cannot be closed. Session (tabs, active tab, active panel, sort) restores after restart; restored inactive tabs load lazily; an unavailable restored directory shows the existing unavailable state at its own location with Retry.
- **Favorites:** ★ button per panel, Ctrl/Cmd+D (add current), Ctrl/Cmd+B (open). Modal list with Enter (open here), Shift+Enter (new tab), F2 (rename label), Delete (remove favorite only), Arrow/Home/End. Exact native-identity duplicate detection, Rust availability badges (Missing, Not a folder, No access, Not valid here, Unavailable), persisted labels and identifiers. Targets are never rewritten.
- **Quick Filter:** Ctrl/Cmd+F filter bar per tab; NFC + Unicode default lowercase substring policy; IPC-free; sorting, virtualization, `[..]`, Enter/double-click, selection and operations work on filtered rows; empty state; Escape/× clears and focuses the list; Tab goes from the field to its list; refresh keeps, navigation clears.
- **Drag and drop:** pointer drag of one real file/folder from the visible tab to the opposite visible directory, ghost + source/target highlighting, Copy/Move/Cancel confirmation, submission only through `submit_operation`, Operations dock integration.
- **Shortcuts:** centralized registry/dispatcher, settings dialog (capture, conflict naming, reserved/invalid rejection, per-action reset, restore defaults, fixed-key reference), persisted overrides, toolbar/tooltips/footer follow bindings.
- **Persistence:** `qpanes-core::settings` + three thin commands; see the persistence model above.

### Defects found during implementation (red → green)

| Defect (introduced by this slice unless noted) | Detection | Correction | Regression evidence |
| --- | --- | --- | --- |
| At the 720 px minimum window with a 30 % split, the new ★ button left the path field 0 px wide. | Existing `acceptance-fixes` suite: 85 passed, bounded-errors probe failed ("element is not visible"). | Compact navigation spacing only in the ≤360 px container layout. | Same suite 105/105; screenshot measures 50 px. |
| Typing a filter while `[..]` was selected kept `[..]` instead of the first match. | New renderer suite (red run, 6 failures incl. this). | Keep only a still-matching real entry; else select the first match. | "first match is selected in sorted order" now passes. |
| Tab from the filter field stopped on the × button. | New renderer suite (red). | × is a pointer-only affordance (`tabindex=-1`); Escape clears. | "Tab from the filter moves to its list". |
| Filtered footer read "1,429 of10,000". | Screenshot review. | Explicit text expression. | New footer check (added after the fix; red state taken from the screenshot, not an executed red run). |
| WebKitGTK delivers physical Ctrl+Shift+Tab as `key: "Unidentified"`, `code: "Tab"`, so previous-tab never fired with real Linux input. Mocked Chromium and DOM-dispatched native input could not show this. | Strengthened XTest native check (effect asserted, events logged). | `normalizeKey` falls back to the physical `code` for unidentified keys. | Node test red (`test-results/slice-004-webkitgtk-shift-tab-red.log`) → green; XTest native 36/36. |
| Windows cross-lint: a Unix-only test helper was dead code on Windows. | `cargo clippy --target x86_64-pc-windows-gnu`. | Helper gated to Unix. | Cross-target lint passes. |

### Independent read-only code review (pre-acceptance)

A separate read-only reviewer (no edits, no test runs) examined the uncommitted change and found no high-severity defect: no unconfirmed or redirected mutation path, no stuck drag, no stale cross-tab commit, no dispatcher double-fire. Its lower-severity findings were checked against the code; every confirmed one received a regression test that was executed red before the correction (`test-results/slice-004-review-red-{rust,node,renderer}.log`: 2 Rust, 2 Node and 6 renderer failures) and green after. The first correction for the tab-limit focus case was itself insufficient (focus was requested while the modal dialog still made the page inert); the final pass caught it and it now waits for the dialog to close.

| Finding | Disposition |
| --- | --- |
| Resetting one shortcut could recreate a default already assigned elsewhere (duplicate binding). | Fixed: reset uses the same conflict check and reports the blocking action. |
| Closing an inactive tab with its × (and opening a favorite in a new tab at the 32-tab limit) left focus on BODY. | Fixed: focus moves to the visible list before the focused control disappears / when the tab is refused. |
| After invalid saved tabs were dropped, Rust restored a different tab as active. | Fixed: the saved active tab is followed to its new position; a dropped active tab falls back to the first. |
| Pressing Enter on an unedited unavailable restored location resubmitted the lossy label as a typed path. | Fixed: the remembered native identifier is used, as for committed listings. |
| Unknown shortcut actions (e.g. after a downgrade) were silently deleted on the next save. | Fixed: kept verbatim when they meet the strict-save format and reported. Invalid overrides of known actions are still replaced by defaults with a visible warning. (The first version of this fix also capped the kept entries at 51; see R004-01.) |
| A symlinked `settings.json` was replaced by a regular file on save. | Fixed: saves write through to the link target by native path. |
| A cancelled/rejected drag left focus on a row instead of its list. | Fixed: ending a started drag hands focus to the source list. |
| Shift+F5, Ctrl+F5 and Ctrl/⌘+Shift+R were not suppressed (WebView reload). | Fixed: all F5 variants and primary-modifier(+Shift)+R are suppressed. Not verified on WebView2. |
| Shortcut settings could be opened and edited before settings loaded. | Fixed: settings-backed actions and the button wait for the load. |
| A pending save is not flushed when the window closes. | Not changed; documented limitation (writes are immediate and coalesced, so the window is small; the previous file stays intact). |

### Independent Codex review — R004-01/02

An independent Codex agent reviewed the same worktree strictly read-only (before/after SHA-256 inventories of all 135 tracked and non-ignored files matched; Git state unchanged). It re-ran all six gates, all ten renderer suites (573/573) and the native usability (XTest, 36/36), background (32 + 35 + 20), hardening (10) and history (5) suites, and confirmed by execution that drop identities are captured before the asynchronous ancestry check (a destination change during a delayed check did not redirect the confirmed Copy). Verdict: **FAIL** for the Linux/WSLg scope with two P2 findings, no P0/P1. Report: `test-results/slice-004-codex-review.md`.

| Finding | Root cause | Correction | Regression evidence |
| --- | --- | --- | --- |
| R004-01 (P2): a valid settings file with 64 shortcut entries from another version saved back only 51, while warning that they were "kept unchanged". | The earlier fix reserved room for all 13 current actions by trimming preserved entries. | Every stored entry is kept (Rust already bounds a loaded map to 64). The limit is enforced only when a new override would exceed it: the assignment is refused with a visible message instead of trimming stored data. `persistedShortcuts` builds the saved map. | Node: 51 ≠ 64 red (`slice-004-codex-red-node.log`) → green. Renderer: "64 entries survive saving" and "new override beyond the limit is refused" red (`slice-004-codex-red-renderer.log`) → green. |
| R004-02 (P2): cancelling a drag after an operation refresh removed the focused dragged row left focus on BODY. | The earlier focus fix only handled a row that still held focus. | The drag records whether it owned list focus when it started; on ending, focus returns to the source list if focus is still on its row or fell to BODY, never overriding a newer owner. | Renderer: "cancelling a drag whose row vanished returns focus to the source list" red (focus BODY) → green. |

Test-assumption fixes (not product defects) were made where a check relied on the hidden tab's DOM, a locale's digit grouping, a non-exact label match, a synchronous read of Svelte's microtask DOM update, or awaiting an IPC reply from a window that had already closed.

### Executed verification

Environment: WSL2 Linux 6.18.58.1-microsoft-standard-WSL2 under WSLg (X11 backend for native runs), Rust stable via mise, Node 24.22.2, Chromium build 1252 headless through Playwright CLI (NSS/NSPR libraries extracted to a scratch directory, no system change).

| Command / suite | Result |
| --- | --- |
| `mise run ui-check` | PASS, 0 errors, 0 warnings |
| `mise run ui-build` | PASS |
| `mise run ui-test` | PASS: 7 window + 11 operation + 11 new Slice 004 state tests |
| `mise run rust-fmt`, `mise run rust-clippy` | PASS (both crates, warnings denied) |
| `mise run rust-test` | PASS: 103 core (86 existing + 17 new settings/probe/listing) + 7 desktop (6 + 1 wire-contract) |
| Core clippy `--target x86_64-pc-windows-gnu` and `--target aarch64-apple-darwin` | PASS — compile/lint only, no target execution |
| Official Svelte autofixer on all six new/changed components | 0 issues; advisory suggestions reviewed (lazy first load in an effect starts I/O rather than syncing state; `Map`/`Set` are non-reactive bookkeeping) |
| Existing renderer suites (mocked IPC, trusted Chromium input): readonly 35, hardening 95, acceptance-fixes 105, window-chrome 60, operations 47, background-operations 37, slice003-hardening 31, history-invalidation 11, acceptance-focus 24 | PASS: 445/445, unchanged from the Slice 003 total (run after the review fixes, same scope note as the native row) |
| New `tests/ui/slice004-usability.cli.mjs` | PASS 132/132 after the R004-01/02/03 corrections (tabs, favorites, filter, drag/drop, shortcuts, persistence/restart via reload, invalid/failed/recovered/slow/full settings, macOS context) |
| `pnpm tauri build --debug --no-bundle` | PASS (Linux debug executable) |
| `QPANES_NATIVE_PHASE=usability bash tests/native/run-operations.sh` | PASS 34/34 on the final build (two consecutive runs) — real Tauri/Rust IPC and filesystem; DOM-dispatched input. One earlier run lost the inspector reply to the request that closed the window (harness race); the close is now scheduled after the reply. |
| Same with `QPANES_NATIVE_INPUT=xtest` | PASS 36/36 on the final build — adds trusted XTest Ctrl+Alt+N / Ctrl+Shift+Tab (effect asserted) and a trusted XTest pointer drag. Stability: one early run timed out on its first XTest key before diagnostics existed (cause not established); all later runs completed. |
| Existing native suites: `QPANES_NATIVE_BACKGROUND=1` (smoke 32 + operations 35 + background 20), phase `hardening` (10), phase `history` (5) | PASS 102/102 on the tabbed UI (run after the review fixes; the last one-line focus fix only affects the favorites tab-limit branch, which these suites do not reach) |
| `git diff --check` | PASS |

Measurements (indicative, this machine only): Quick Filter over 10,000 names — pure matching ≤0.3 ms per keystroke (Node); renderer update including the next animation frame ≈16.6 ms in Chromium; 9–31 ms in native WebKitGTK; ≤50 rendered rows while filtering.

Evidence (ignored `test-results/`): `slice-004-renderer.log`, `slice-004-final-ui-*.log`, `slice-004-native.json`, `slice-004-native-xtest.json`, `slice-004-final-native-*.log`, `slice-004-gate-*.log`, `slice-004-clippy-*.log`, `slice-004-webkitgtk-shift-tab-{red,green}.log`, screenshots `slice-004-{renderer,tabs-filter,drag,drop-dialog,favorites,shortcuts,minimum-window}.png` (inspected at 1200×780 and 720×420).

### Acceptance criteria status

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Independent tabs; state restored without re-reading | PASS (mocked + native) |
| 2 | Tab shortcuts; last tab never invalid | PASS; macOS close default is ⇧⌘W by design |
| 3 | Session restore; unavailable restored directory | PASS (reload in mocks, real relaunch natively) |
| 4 | Favorites add/duplicate/open/new tab/rename/remove/persist/unavailable | PASS |
| 5 | Quick Filter correctness and 10,000-entry responsiveness | PASS |
| 6 | Drag/drop queues one confirmed Copy/Move through the manager; edge cases | PASS (mocked, DOM-dispatched native, XTest pointer to the confirmation step) |
| 7 | Centralized, persisted, validated, platform-aware shortcuts | PASS on Linux; macOS behavior verified only in a mocked Chromium context with a macOS user agent |
| 8 | No regressions | PASS for all existing renderer and native suites |
| 9 | Gates and native evidence | PASS as listed; Windows/macOS NOT VERIFIED |

### Files changed

- Core: `crates/qpanes-core/Cargo.toml`, `Cargo.lock` (adds `serde_json`, `itoa`, `zmij`), `src/lib.rs`, new `src/settings.rs`, new `src/settings/tests.rs`.
- Adapter: `src-tauri/src/lib.rs`, `src-tauri/Cargo.lock` (records the core's `serde_json` edge only).
- Renderer: `src/routes/+page.svelte`, `src/lib/FilePane.svelte`, `OperationDialog.svelte`, `Icon.svelte`, `filesystem.ts`; new `PanelTabs.svelte`, `FavoritesDialog.svelte`, `ShortcutsDialog.svelte`, `shortcuts.ts`, `filter.ts`, `tabs.ts`, `favorites.ts`, `settings.ts`.
- Tests/tooling: `mise.toml` (`ui-test`), new `tests/slice004-state.test.mjs`, new `tests/ui/slice004-usability.cli.mjs`, new `tests/native/slice004.mjs`, `tests/native/run-operations.sh` (isolated `XDG_CONFIG_HOME`, `usability` phase).
- Docs: this file, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `AGENTS.md` (Superpowers workflow line only).

No Tauri capability, permission, window configuration or OperationManager/filesystem-primitive change. No new frontend dependency.

### Known limitations and deferred work

- macOS: ⌘W remains the native Close Window menu item (a custom macOS menu was deliberately not added without target-native QA); Close tab defaults to ⇧⌘W. WebKit/WKWebView key reporting on macOS is untested.
- Windows: WebView2 browser accelerators (e.g. Ctrl+F) are suppressed via `preventDefault`; not verified on Windows. AltGr is reported as Ctrl+Alt there, so a custom Ctrl+Alt+letter binding may also match an AltGr character.
- Every mounted tab keeps its listing in memory (≤32 tabs per panel). Filters, selection and scroll are not persisted across restarts. Closing a tab activates its right neighbour, not the tab it was opened from.
- Favorites detect duplicates by exact canonical identity; case-insensitive volumes may still produce distinct identities for one folder. Favorites do not follow moved/renamed folders (shown as Missing instead).
- Settings are last-writer-wins across concurrent instances; each change triggers a coalesced atomic write with fsync. A save still pending when the window closes is not awaited (the last completed file remains intact). Stale `.settings.json.*.tmp` files from a crash are not cleaned automatically. `settings.invalid.json` keeps only the latest invalid file.
- Drag and drop: single entry, opposite visible directory only; no drop onto rows/tabs, no auto-scroll, no external OS drag/drop, no keyboard drag (F5/F6 remain the keyboard path). Native drag evidence beyond the confirmation step uses DOM-dispatched pointer events; the trusted XTest drag stops at the confirmation.
- Unicode filter policy limits as documented in `filter.ts` (no full case folding, accents significant).

### Windows/macOS verification gaps

NOT VERIFIED on either target: settings paths and atomic replace semantics, `probe_directories` statuses, keyboard event reporting and reserved menu keys, pointer drag behavior in WebView2/WKWebView, tab/filter rendering, and all inherited Slice 002/003 runtime gaps. Cross-target compile/lint of the core is not runtime evidence.

### Critical self-review

Checked: no mutation path outside the existing submission IPC; drop identities captured synchronously at release and immutable behind a modal; shortcuts suppressed in fields, dialogs and during drags, with repeat ignored for non-navigation actions; settings never saved after a failed or timed-out load; strict save validation and atomic replace; opaque identifiers only (no path reconstruction from labels); hidden tabs never touch the DOM scroll box; stale responses still guarded per tab. Residual risks are the platform gaps above and the absence of target-native keyboard/pointer evidence outside Linux.

Recommendation: an independent, strictly read-only acceptance review focused on the drag controller and drop-time identity capture, the shortcut dispatcher's suppression rules, settings load/save failure handling, hidden-tab state (scroll, invalidation, lazy load) and the native fixture isolation; plus target-native Windows and macOS QA before release.

### Re-verification after R004-01/02 — 2026-11-11

All six mise gates PASS (ui-test 7 + 11 + 11; rust-test 103 core + 7 desktop). Renderer: Slice 004 131/131 plus the nine existing suites 445/445 (576 total; mocked IPC, trusted Chromium input). Native debug rebuild PASS; native usability 34/34 (DOM-dispatched input) and 36/36 (with trusted XTest input); existing native suites 32 + 35 + 20 + 10 + 5 PASS. Official Svelte autofixer: zero issues on the changed page. `git diff --check` PASS. The browser environment was recreated under the ignored `test-results/slice-004-browser-env/` (downloaded NSS/NSPR libraries and runner scripts kept in separate directories). A focused independent re-review of R004-01/02 is recommended before acceptance; Windows/macOS remain NOT VERIFIED.

### Focused Codex re-review — R004-03

The same agent re-reviewed R004-01/02 strictly read-only (SHA-256 inventories of all 135 files matched; Git unchanged): **R004-01 PASS** (including 130 boundary cases and capacity replace/reset/restore paths) and **R004-02 PASS** (including newer-focus-owner, outside-release, pointer-cancel, lost-capture and blur variants; no submission without confirmation). Report: `test-results/slice-004-codex-rereview.md`.

| Finding | Root cause | Correction | Regression evidence |
| --- | --- | --- | --- |
| R004-03 (P2): a structurally valid stored shortcut key named `__proto__` was dropped on save while reported as kept. | `preserved[action] = combo` on a plain object invoked the inherited `__proto__` setter. | The preserved map is built with `Object.fromEntries`, which defines own data properties for every key. | Node: own `__proto__` entry missing (`slice-004-codex-r3-red-node.log`) → green. Renderer: saved keys `["constructor"]` only (`slice-004-codex-r3-red-renderer.log`) → green. |

The re-review's two trusted XTest native attempts did not complete in its environment (one drop-dialog timeout with undetermined cause; one with no key events and `document.hasFocus()` false, i.e. the WSLg window had no OS focus). DOM-input native passed 34/34 there. No product finding was assigned. The XTest harness now establishes OS window focus explicitly (five attempts) and fails with a precise environment message otherwise, and records focus, window geometry and received events if the XTest drop dialog does not appear. Trusted XTest evidence therefore depends on WSLg granting focus to the test window; results are reported per run.

Re-verification after R004-03 (2026-11-11): all six mise gates PASS (ui-test 7 + 11 + 11; rust-test 103 core + 7 desktop); renderer Slice 004 132/132 plus the nine existing suites 445/445 (577 total; mocked IPC, trusted Chromium input); native debug rebuild PASS; native usability 34/34 (DOM-dispatched) and 36/36 (trusted XTest, OS focus obtained); existing native suites 32 + 35 + 20 + 10 + 5 PASS; `git diff --check` PASS. Windows/macOS remain NOT VERIFIED.

### Final focused Codex re-check — 2026-11-11

Verdict: **PASS for R004-03, R004-01 and R004-02 within the verified Linux scope; no new P0–P3 code finding.** Strictly read-only (SHA-256 inventories of all 135 files matched). Evidence: Node checks over 258 cases (0–64-entry maps on both platform configurations and all 1–64-entry maps containing `__proto__`), unchanged `Object.prototype` descriptors, own data-property `__proto__` round trip, overflow refusal with the map intact, the original R004-01/02 probes, the adversarial focus/cancellation variants (20/20), `mise run ui-test` 29/29, `ui-check`, `rust-test` 103 + 7, and the Slice 004 renderer suite 132/132. The forced missing-focus branch of the new XTest precondition was executed (five focus requests, no keys or drag sent, explicit environment-limitation rejection). Report: `test-results/slice-004-codex-recheck-r3.md`.

The reviewer's native XTest run completed the trusted key checks but its pointer drag did not open the confirmation; diagnostics showed the window had lost OS focus by then (`document.hasFocus()` false). A window blur deliberately cancels a drag, so this is recorded as an environment/verification gap, not a product result. In this implementation environment the same XTest phase passed 36/36 on the final build with focus obtained. Windows/macOS remain NOT VERIFIED.
