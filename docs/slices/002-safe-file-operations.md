# Slice 002 — Safe local filesystem operations

Status: IMPLEMENTED; available Linux/WSLg verification PASS. Windows/macOS core compilation/lint PASS; target-native execution UNVERIFIED. Windows Trash intentionally unsupported. User-authorized native Codex planning and incremental execution; no Superpowers, separate approval cycle, commits, pushes, merges or Slice 003. This document records implementation verification, not independent acceptance.

## Scope and checkpoints

Keep the SvelteKit static frontend, Tauri blocking-worker adapters, independent pane state, opaque native identifiers and virtualized rows. Add one selected-entry operation at a time: F7 create directory, F2 rename, F5 staged copy, F6 same-filesystem move, Delete native Trash. Keep the existing appearance, chrome/DPI behavior and two deferred Slice 001 visual issues.

1. **A — Contracts and safety:** narrow request/result types in the core and TypeScript; native-name validation; inspect official platform APIs and pinned dependency implementations.
2. **B — Create and rename:** exclusive directory creation; native no-replace rename; temporary-fixture conflict, Unicode, permission and native-identity tests.
3. **C — Copy and move:** bounded streaming into private staging; no-follow traversal; reject aliases/descendants, special files, unsupported cases and cross-device moves; publish atomically without replacement; test partial failures and source preservation.
4. **D — Trash:** maintained Rust native integration with a verified recoverable-only policy. Reject any location/platform for which that guarantee cannot be established. Never offer permanent deletion or a deletion fallback.
5. **E — Renderer:** compact native modal dialogs, captured real-entry context, confirmations, busy/error state, input-safe shortcuts, focus restoration and sequence-guarded pane refresh. No queue or parallel UI operations.
6. **F — Verification:** focused real filesystem tests, mocked Playwright CLI renderer regressions, actual Tauri IPC smoke tests in disposable fixtures, all mise gates, native debug build, official Svelte analyzer, diff and critical self-review. Record Windows/macOS gaps explicitly.

## Existing contracts and operation contracts

- `NativePath` is an opaque `u:` Unix byte / `w:` Windows UTF-16 identifier. Existing `DirectoryTarget` permits explicit typed navigation; mutations never accept a display path or a typed navigation target.
- The pane's `PaneRow` union separates the virtual parent action from `FileEntry`. Operation snapshots contain a real `FileEntry` only; Rust accepts a real-entry source with `kind: file | directory | symlink | other | unknown`, never a parent action. Rust revalidates the actual filesystem type rather than trusting supplied metadata.
- `CreateDirectoryRequest { parent: NativePath, name: string }`; `RenameRequest { source: Entry, name: string }`; `TransferRequest { source: Entry, destination: NativePath }`; `TrashRequest { source: Entry }`.
- `OperationResult { path: NativePath | null, warnings: string[] }` returns the actual resulting identity for selection, or null for Trash. Structured `FsError` retains its code/message contract and adds conflict, invalid-name, same-entry, descendant, unsupported-entry, cross-device, unsupported-platform, source-changed and Trash failure codes as necessary.
- Each IPC command runs the corresponding core function on Tauri's blocking pool. The frontend holds a single operation busy flag, snapshots both pane locations and navigation revisions, refreshes only still-current affected locations and never commits an old operation response over a newer navigation.

## Safety policy

- **Conflict:** reject. Never replace, skip silently or synthesize a keep-both name. Native no-replace rename/publication and exclusive creation provide the guarantee; existence checks are for feedback only. A platform/filesystem without a working no-replace primitive fails closed.
- **New names:** exactly one nonempty native path component; reject NUL, dot/dot-dot and separators. Enforce Windows reserved names/characters/control characters and trailing dots/spaces on Windows, including DOS device basenames before extensions and superscript COM/LPT digits. Native OS errors enforce remaining length/filesystem restrictions. Never rebuild the source from a lossy label.
- **Path and symlink races:** anchor work to opened directory handles; reject symlink components and leaf symlinks for copying. Open recursive children without following links and verify their actual type/identity. Reject special files and recursive mount crossings/loops rather than reading device streams or unrelated trees. Revalidate source identity before destructive namespace changes where the OS permits it. Concurrent hostile namespace mutation and live file edits have limits and must be documented with the final implementation.
- **Copy:** support regular files and directory trees containing supported entries only. Use a fixed-size streaming buffer, exclusive files inside a marked staging directory, then a single no-replace publication. An error never publishes a normal-looking partial destination. Automatic cleanup removes only empty staging on every platform; retain all nonempty staging and report its reserved location for manual review. A crash may leave clearly marked `.qpanes-copy-*` staging for manual recovery. Copy is not a filesystem snapshot or a power-loss transaction.
- **Metadata:** preserve ordinary permission bits and modification/access times where supported. Do not promise ownership, ACLs, xattrs, resource forks, alternate data streams, hard-link relationships or sparse allocation. Reject unsupported rich-content cases where copying only the default stream would lose contents. Record final platform policy and limitations below.
- **Move/rename:** use one native no-replace namespace operation, never copy-then-delete. Cross-device moves return `cross_device_not_supported`; failed pre-commit operations retain the source. Case-only rename may be rejected by native conflict semantics rather than using a risky intermediate rename.
- **Trash:** only the OS Trash/Recycle Bin through the verified library implementation. A failure is an error, never permanent deletion. Do not call recursive deletion on a source as fallback. Native Trash is not assumed transactional; ambiguous outcomes must instruct the user to inspect source and Trash before retrying.
- **Memory/responsiveness:** bounded file buffer, depth bound and directory-handle traversal; no whole-file buffering, UI-thread I/O, job engine or automatic retry.

## Acceptance criteria

All five operations use real core/IPC semantics; existing entries cannot be silently overwritten; copy failures leave no completed-looking result; move failures do not destroy sources; native identities survive non-UTF-8 display; parent actions cannot enter mutation IPC; symlink/special/cross-device policies fail closed. Dialogs show the captured source/destination, require confirmation, support Enter/Escape and proper focus, prevent duplicate execution and input shortcuts, surface errors and preserve independent navigation/selection. Refreshes honor navigation revisions and existing sorting/virtualization. Tests use only generated disposable fixtures; mocked renderer and real native evidence are labeled separately. All available gates pass or exact missing evidence remains explicit. No Windows/macOS native-verification claim without execution.

## Research and verification record

### Implemented supported cases

| Operation | Implementation and policy |
| --- | --- |
| F7 create directory | Exclusive native directory creation in the active pane; empty name input, Unicode/native-name validation, conflict rejection and returned-path selection. |
| F2 rename | Native no-replace rename of a real regular file/directory within its native parent; prepopulated dialog; native source identity and returned-path selection. No case-only intermediate rename fallback. |
| F5 copy | Regular files and nested/empty directories; fixed 64 KiB stream buffer; exclusive staging files; final atomic no-replace publication. Cross-filesystem copies are supported; source data is never removed. |
| F6 move | One native no-replace rename, preserving file/directory identity and structure. Filesystem/mount errors are returned; cross-device moves have no copy/delete fallback. |
| Delete Trash | Linux Desktop Portal through maintained `trash` 5.3.0, with only `portal` enabled; macOS `NsFileManager` through the same crate. A confirmation names the entry and operation. Windows fails closed. No permanent-deletion API or Shift+Delete action exists. |

Top-level symlinks and special entries are rejected for copy, move, rename and Trash. Recursive copy rejects contained links rather than dereferencing them. Directory move/rename carries contained links unchanged using the native namespace operation, without recursive traversal. Recursive copy has a 128-level bound and rejects device crossings, loops and its own staging directory. On Linux, directory transfers require `statx` mount IDs (Linux 5.8+ with a filesystem/kernel supplying `STATX_MNT_ID`); different mounts of the same device are rejected to exclude bind-mount aliases. Copying a single regular file does not require mount IDs.

All mutation sources require readable native metadata/handles; directory-copy enumeration also requires directory read access. Linux Portal Trash additionally requires read/write access to regular files. Permission failures are reported even where another tool with different handle requirements could perform a native rename/Trash operation.

### Metadata and unsupported cases

- Copies preserve default file contents, ordinary Unix permission bits (Windows readonly permission where supported), and file/directory modification/access times. The source's access time may change from reading. Copy does not preserve ownership, ACLs, xattrs, creation time, hard-link relationships or sparse allocation. Unix setuid/setgid/sticky bits are not propagated to newly owned copies.
- Windows copy checks stream information with a bounded metadata buffer and rejects alternate data streams, reparse points and unverifiable stream information. macOS copy rejects nonempty resource forks. Metadata/query failures fail the copy before publication. Native Windows/macOS execution remains unverified.
- macOS Trash rejects non-UTF-8 full paths because the dependency's native path conversion cannot safely represent them. Linux copying/moving/renaming preserves non-UTF-8 source and child names through native identifiers.
- Windows Trash intentionally returns `unsupportedPlatform` and leaves the source intact. The reviewed crate's Windows implementation does not force recycle-only behavior. This is a release limitation, not an implemented Windows Recycle Bin claim.
- Unsupported no-replace filesystems return an error. No replace/skip/keep-both conflict workflow, cross-device move, permanent deletion, multi-selection, queue, transfer progress, cancellation after confirmation, watching, undo, terminal or Slice 003 work was added.

### Failure and concurrency guarantees

Kernel no-replace operations and exclusive creation enforce destination collision safety, including broken-symlink targets and a target created after validation. Copy publication happens only after all supported data and metadata have been copied; an I/O failure cannot publish a normal-looking partial destination. Staging names are exclusively reserved, with mode 0700 on Unix and inherited native ACLs on Windows. Directory creation and opening are separate system calls; the resulting handle is not proof that the opened directory or its contents belong to the operation. Acquisition rejects a directory that is already populated and leaves it untouched. This emptiness check is an early rejection only, not deletion authorization. On every platform, cleanup attempts only nonrecursive removal of an empty directory; the OS enforces emptiness at the removal itself. All nonempty staging, including partial payloads after failure and unrelated entries inserted by another writer, is retained for review. No staging contents are automatically deleted. Cleanup failure reports the reserved location (which may have been renamed); after successful publication, retained staging produces a success warning. A crash can leave `.qpanes-copy-*` staging; inspect it before manual removal. No startup cleanup or automatic retry is performed.

Failed native move/rename calls retain the original source according to the OS namespace operation; QPanes never copies and then removes a source. A lost worker result or disconnected Trash service can have an ambiguous outcome, so the error instructs inspection before another attempt. Trash service errors never trigger permanent deletion. The operating system's Trash implementation remains the trusted recovery boundary.

Opened directory/file handles, native identity checks, no-follow opens and pre-publication revalidation protect ordinary stale selections and detected namespace changes. Trash checks both its captured parent handle and the current absolute parent/leaf before the library pathname handoff. Windows rename also verifies the newly opened DELETE-capable handle before renaming that same handle. Regression tests cover both discovered gaps (Windows test is compile-checked, not executed here).

**Concurrency limit:** these operations are not filesystem transactions/snapshots and do not guarantee a stable selected object against an adversarial same-user process continuously replacing names in the final check/syscall interval. Unix rename-by-name and the native Trash library's pathname handoff retain that OS/API boundary race. Detected changes fail closed; do not concurrently reorganize/mount/replace an operated tree. Copy checks size, modification time and Unix change time around each streamed file, and directory metadata around traversal, but cannot promise a consistent snapshot of independently edited files. Crashes/power loss, corrupt or malicious filesystems and full recovery after OS/IPC failure are not transactionally solved in this slice. Destination no-replace semantics remain in force.

### Dependencies and official research

- `cap-std`/`cap-fs-ext` 4.0.3 supply maintained directory-handle-relative operations and explicit no-follow opens, avoiding bespoke cross-platform traversal code. [Directory handles](https://docs.rs/cap-std/4.0.3/cap_std/fs/struct.Dir.html), [no-follow directories](https://docs.rs/cap-fs-ext/4.0.3/cap_fs_ext/trait.DirExt.html).
- Rustix 1.1.6 supplies safe Unix syscall wrappers. Linux `NOREPLACE` and macOS's `RENAME_EXCL` mapping reject existing targets atomically. [Rustix rename API](https://docs.rs/rustix/1.1.6/rustix/fs/fn.renameat_with.html), [Apple implementation/flag mapping](https://github.com/bytecodealliance/rustix/blob/v1.1.6/src/backend/libc/fs/types.rs).
- Windows uses a small native boundary through `windows-sys` 0.61: file IDs, stream/reparse checks, and `SetFileInformationByHandle(FileRenameInfo)` with a relative name, destination directory handle and `ReplaceIfExists = false`. [Microsoft rename contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info), [native name rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
- `trash` is pinned to 5.3.0 after reviewing its released platform implementations. Linux defaults/`freedesktop` are disabled: that backend has a copy/delete fallback. Only the descriptor-based Portal backend is enabled; the actual feature graph was checked with Cargo. macOS selects `DeleteMethod::NsFileManager` instead of the default Finder/script integration. [Released manifest](https://github.com/Byron/trash-rs/blob/v5.3.0/Cargo.toml), [Portal backend](https://github.com/Byron/trash-rs/blob/v5.3.0/src/portal.rs), [Portal Trash contract](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Trash.html), [macOS implementation](https://github.com/Byron/trash-rs/blob/v5.3.0/src/macos/mod.rs).
- Windows Trash remains disabled because the current native integration does not configure `FOFX_RECYCLEONDELETE`. [Released Windows implementation](https://github.com/Byron/trash-rs/blob/v5.3.0/src/windows.rs), [Microsoft operation flags](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags).

The new libraries offer MIT-compatible license options (Trash is MIT; cap/Rustix/windows-sys offer MIT or Apache alternatives). `tempfile` is test-only. Portal adds D-Bus dependencies; the desktop already uses much of that ecosystem. No frontend dependency, provider framework, scheduler, arbitrary shell IPC, production browser hook or weakened security capability was introduced. Context7 resolved Rustix and retrieved current syscall/API documentation; released source and official OS documentation supplied platform-specific evidence.

### Test coverage and executed checks (2026-11-06)

All mutation fixtures are disposable. The core covers exact regular/binary/32 MiB+ copies, fixed-size reads, nested/empty trees, ordinary metadata, conflicts (including broken links and a concurrent creator), self/descendant rejection, missing/stale sources, native names, permissions, recursive links/specials, unpublished partial failure and retained staging. P1-1 regressions cover a populated directory substituted between creation and opening, unrelated entries introduced after acquisition, successful and failed copy cleanup, and renamed staging with a replacement at its reserved pathname. Deep traversal is checked on a 2 MiB worker stack, including rejection beyond the supported depth; the fixed 64 KiB file buffer is heap-allocated so optimization cannot multiply stack buffering across recursive frames. Injected `StorageFull` verifies write-error propagation without filling a real volume. Native tests separately verify actual filesystem operations and Trash recovery bytes. The core covers file/directory move identity, failure preservation, real cross-device rejection, Unicode/native-byte rename, source display-name independence, Trash failure without deletion and a replaced-parent Trash regression. Native inode-preservation and payload tests are actual filesystem evidence, not mocks.

The renderer suite covers all shortcuts, source/destination direction, parent-action exclusion (including a distinct real `[..]` file), native modal focus/Tab/Enter/Escape, name validation feedback, confirmation/cancellation, busy/duplicate prevention, structured errors, independent panes, selection, same-location pane refresh, stale operation/refresh rejection, sorting/navigation and compact layout. Existing regressions retain virtualization and chrome/DPI coverage. Browser IPC is mocked. Complete native smoke uses actual Tauri/Rust/Portal with explicitly labeled DOM-dispatched input; earlier opt-in XTest runs exercised trusted native keys but were interrupted by intermittent WSLg host focus, so no complete trusted native OS-key claim is made.

| Command/check | Actual result |
| --- | --- |
| `mise run ui-check` | PASS, zero Svelte/TypeScript errors or warnings. |
| `mise run ui-build` | PASS, static frontend output. Also rerun by final native builds. |
| `mise run ui-test` | PASS; `node tests/window-state.test.mjs` additionally reports all 7 window-state/config regressions passing. |
| `mise run rust-fmt` | PASS, both manifests. |
| `mise run rust-clippy` | PASS, both manifests/all local targets with warnings denied. |
| `mise run rust-test` | PASS, 33 core + 4 desktop tests; the isolated Trash-failure subprocess also passes. Binary/doc targets pass. |
| `cargo test --manifest-path crates/qpanes-core/Cargo.toml --release --offline deep_copy_fits_a_worker_stack_and_rejects_excess_depth_without_publication` | PASS, optimized deep copying on an explicitly bounded 2 MiB thread stack and safe excessive-depth rejection. |
| `cargo test --manifest-path crates/qpanes-core/Cargo.toml --offline cross_device_move_has_no_copy_delete_fallback -- --exact operations::tests::cross_device_move_has_no_copy_delete_fallback --nocapture` | PASS outside sandbox, real disposable `/tmp` → `/dev/shm` fixtures on different devices. Move rejects/preserves source; cross-filesystem copy preserves exact bytes. |
| `cargo clippy --manifest-path crates/qpanes-core/Cargo.toml --target x86_64-pc-windows-gnu --all-targets --offline -- -D warnings` | PASS, compilation/lint only; Windows-specific handle/cleanup regressions compile but were not executed. |
| Same command with `--target aarch64-apple-darwin` | PASS, compilation/lint only, not native macOS verification. |
| `cargo tree --manifest-path crates/qpanes-core/Cargo.toml -e features -i trash --offline`, and the same for `src-tauri/Cargo.toml` | PASS in both the core test and actual desktop dependency graphs: Linux `trash` has only `portal`; no default/FreeDesktop feature. |
| Official Svelte MCP `svelte_autofixer`, installed Svelte 5.57.3 | PASS for FilePane, OperationDialog, page and WindowHeader. No issues; existing optional DOM-handle suggestions only. |
| `playwright-cli -s=qpanes-operations --raw run-code --filename=tests/ui/operations.cli.mjs` | PASS, 46 assertions, mocked IPC with trusted Chromium input. |
| `playwright-cli -s=qpanes-regression --raw run-code --filename=tests/ui/readonly.cli.mjs` | PASS, 35 assertions. |
| Same command, `tests/ui/hardening.cli.mjs` | PASS, 95 assertions. |
| Same command, `tests/ui/acceptance-fixes.cli.mjs` | PASS, 105 assertions. |
| Same command, `tests/ui/window-chrome.cli.mjs` | PASS, 60 assertions. Renderer total: 341. |
| `pnpm tauri build --debug --no-bundle` | PASS, real Linux debug binary, final rebuild after race fixes. Existing `.app` identifier-suffix warning remains out of scope. |
| `bash tests/native/run-operations.sh` | PASS on final Linux binary: existing 32 native smoke checks + 35 mutation/UI/Trash checks, no skips. Actual Rust IPC, filesystem and isolated OS Trash; DOM-dispatched input. |
| `bash -n tests/native/run-operations.sh`, `node --check` for new JS suites, `git diff --check` | PASS. Unverified internal native-launch invocation also tested to exit before native activity. Final diff reviewed for scope/ownership. |

`mise` emitted a nonfatal read-only cache warning in the sandbox; tasks exited successfully. Native GTK emitted the existing WSLg DRI/render-device permission warnings. The isolated desktop Portal emitted missing PipeWire/RealtimeKit warnings; its Trash interface worked and exact recovered bytes were verified. These are not claims of GPU/performance or unrelated service health.

### Native reproduction and evidence

Build with `pnpm tauri build --debug --no-bundle`, then run `bash tests/native/run-operations.sh` on a Linux desktop with `dbus-run-session`, a working Desktop Portal, `gdbus`, `curl`, `ss`, `rg`, Node and the native GTK runtime. The launcher uses its own D-Bus session, generated XDG data root, owned app/Portal PIDs and loopback debug inspector. It verifies the generated isolation marker, bus/process environments and source/Trash filesystem placement before any Trash call. It never changes HOME or uses the developer's existing Trash service. Only generated fixtures and their isolated Trash are removed. The internal session branch rejects inherited/unverified invocation before writing logs or looking up service PIDs.

The native suite matches a Trash item by its `.trashinfo` **original Path**, then compares exact file/tree contents inside the generated Trash. Portal 1.21.1 inserts a numeric suffix before extensions even for the first item; an initial basename-based harness assertion was corrected after read-only official-source investigation. Automatic approval initially rejected a rerun while the destination was unproven. Primary-source/path/environment evidence established isolation, the corrected rerun was approved, and final verification passed. No permission or safety blocker remains.

Default native UI input is DOM-dispatched and clearly labeled. To opt into OS key delivery, build the existing X11 driver (`cc tests/native/x11-window.c -o /tmp/qpanes-x11 -lX11 -lXtst`) and use `QPANES_NATIVE_INPUT=xtest`, optionally `QPANES_WSLG_POINTER=1`. That path checks trusted delivery before proceeding but remains susceptible to this host's focus changes. The complete passing native evidence uses the default DOM path. Neither this nor browser DPR emulation proves Windows/macOS keyboard behavior or physical DPI transitions.

Ignored `test-results/` evidence includes `slice-002-native.json` (complete 35 checks), `slice-001-native.json` (32 existing checks), `slice-002-native-session.log`, native app/Portal introspection logs, the four `slice-002-*-renderer.json` regression reports, `slice-002-create-mocked.png`, `slice-002-compact-mocked.png`, and `slice-002-native-dialog.png`. Screenshots were inspected at wide/compact/native sizes. Earlier `*-partial.json` records are explicitly incomplete investigation evidence, not the final result.

### Acceptance status, files and handoff

| Requested criterion | Evidence/status |
| --- | --- |
| F5 regular/binary/large/recursive copy and bounded memory | PASS in Linux core/native tests; supported metadata and failure limits above. |
| F6 safe file/directory move, no dangerous cross-device fallback | PASS, inode/structure/conflict/permission tests and real cross-device rejection. |
| F7 native-name directory creation and F2 native-identity rename | PASS, Unicode, invalid/conflicting names, permissions, file/directory and Unix-byte identity coverage. Windows name rules tested on Linux; native Windows path cases unexecuted. |
| Delete native Trash, confirmation and cancellation, never permanent deletion | PASS on Linux real isolated Portal, files and directories, recovered bytes, read-only/missing-source failures. macOS compile-only; Windows deliberately unsupported. |
| No silent overwrites / no completed-looking partial copies | PASS in supported scope; exclusive creation, kernel no-replace, collision-race and staged-failure tests. |
| Failed moves preserve sources; structured actionable errors | PASS in native/core tests; ambiguous worker/Trash outcomes explicitly require inspection. |
| Parent action cannot be a mutation source/destination | PASS in typed renderer snapshots, Serde request rejection and browser/native keyboard tests. |
| Real Rust core, narrow typed IPC, worker-thread I/O | PASS in code review and actual native IPC tests; no shell/provider/queue abstraction. |
| Dialogs, keyboard, busy/error/focus, refresh/selection and stale results | PASS, 46 new renderer assertions plus real native UI checks. |
| Existing navigation/sorting/virtualization/chrome and appearance | PASS, 295 existing browser + 32 native regression checks; the two deferred Slice 001 visual issues remain unchanged. Only the now-inaccurate read-only badge wording changed to Local workspace. |
| Available gates and meaningful regressions | PASS as listed above; self-review findings fixed and covered. |
| Platform limitations documented and no unrelated work | PASS. Target-native Windows/macOS, unusual/network filesystems, non-WSLg Linux/Wayland and physical OS key/DPI QA remain UNVERIFIED. |

Files changed:

- Core: `crates/qpanes-core/Cargo.toml`, `Cargo.lock`, `src/lib.rs`, new `src/operations.rs`, `src/operations/native.rs`, `src/operations/tests.rs`.
- Desktop adapter: `src-tauri/src/lib.rs`, `src-tauri/Cargo.lock`.
- Renderer: `src/lib/filesystem.ts`, `FilePane.svelte`, new `OperationDialog.svelte`, `WindowHeader.svelte` (badge wording only), `src/routes/+page.svelte`.
- Verification: new `tests/ui/operations.cli.mjs`, `tests/native/operations.mjs`, executable `tests/native/run-operations.sh`.
- Documentation: this plan/policy/handoff, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`.

Checkpoints A–F are complete for the documented supported scope. Remaining release risks are native Windows/macOS behavior (including no-replace, path/stream/reparse handling and macOS Trash), unsupported Windows Trash, unsupported rich metadata, retained nonempty staging on all platforms/inherited Windows ACLs, unusual filesystems and the explicitly nontransactional concurrency/recovery boundary. Existing Slice 001 acceptance defects remain outside this slice.

Recommend an independent **read-only acceptance review** of this slice and its fixture/evidence boundaries before accepting it. This implementation self-review grants no independent acceptance, cross-platform release approval or merge authorization. No commit, push, branch change or merge was performed; Slice 003 was not started.

## P1-1 acceptance correction

Independent review reproduced unrelated data deletion when another writer substituted a populated directory between staging creation and opening, or inserted contents before recursive cleanup. The correction removes recursive staging deletion on every platform. Populated replacements are rejected during acquisition; any contents introduced later are retained. Successful publication with retained contents returns a warning, and failed copies retain partial payloads with their original error and a recovery-location message. Reserved paths can become stale under concurrent renames, so messages explicitly say that staging may have moved. This conservative policy intentionally trades automatic partial-copy cleanup for data preservation; no automatic cleanup/retry or ownership claim is made for directory contents.

Correction verification (2026-11-06), run in an isolated repository copy with synthetic mutation fixtures:

- `mise run ui-check`, `ui-build`, `ui-test`, `rust-fmt`, `rust-clippy`, `rust-test`: PASS. There are now 39 core + 4 desktop = 43 distinct Rust tests; the isolated Trash-failure subprocess is not counted again. Two new cleanup regressions were first observed failing against the original implementation, then passing after correction.
- Six additional Linux core regression cases cover nonempty cleanup on every platform, substituted staging contents, populated acquisition rejection, successful and failed copy cleanup, and renamed staging with a replacement. The Windows-only nonempty-cleanup test was promoted to all platforms; existing partial-tree/depth tests now assert retained payloads and recovery messages.
- Original public-API race reproducers: 4,000 copy attempts, 3,976 successful staging-directory substitutions, zero unrelated files deleted. All retained sentinel contents and preexisting conflicting payload bytes were compared exactly. Scheduling assistance makes the races repeatable; these counts do not measure production race frequency.
- Public copy-pipeline probes for read EIO, write ENOSPC, disappearing/modified source, concurrent destination creation and foreign staging insertion: PASS. Failed copies retain marked partials without publishing a destination; creator-owned destination bytes survive. A successful copy retains foreign staging bytes and returns a warning.
- `pnpm tauri build --debug --no-bundle`: PASS. `QPANES_NATIVE_PORT=19484 bash tests/native/run-operations.sh`: 32 existing + 35 mutation = 67 native checks PASS with real Linux Tauri/Rust IPC, DOM-dispatched input, generated fixtures and an isolated D-Bus/Trash environment.
- `cargo test --manifest-path crates/qpanes-core/Cargo.toml --release --offline deep_copy_fits_a_worker_stack_and_rejects_excess_depth_without_publication`: PASS. The actual `/tmp` to `/dev/shm` cross-device move rejection/copy test also PASS, run with access to generated fixtures on both devices.
- Windows GNU and macOS aarch64 core `cargo clippy --all-targets --offline -- -D warnings`: PASS, compilation/lint only. Target-native runtime remains UNVERIFIED, and Windows Trash remains unsupported.
- Fresh-context, read-only core reviewer: PASS for P1-1 closure and adjacent data safety, with 7 distinct focused core tests and 5 independent public-API fault probes; no new P0/P1/P2 finding in that review scope. Empty-directory ownership remains unauthenticated; automatic removal can remove an empty substituted directory, but never its nonempty contents. This is not a claim of full namespace ownership or snapshot consistency.
- Fresh-context, read-only renderer reviewer: existing 341 + 31 independent retained-staging message assertions = 372 PASS using mocked IPC and trusted Chromium input. Official Svelte analysis: zero issues in the dialog, page and pane components. Native OS-key delivery and physical DPI behavior were not newly verified.
- Implementation, tests and documentation remained unchanged during those read-only reviews; this verification record was appended afterward. Only the core operation implementation/tests, native mutation test and two directly relevant policy documents changed for this correction. No commits, branch changes or Slice 003 work.

P1-1 closure is verified within the exercised Linux scope. The targeted independent follow-up does not itself grant full Slice 002 acceptance; a fresh full read-only acceptance review remains recommended.
