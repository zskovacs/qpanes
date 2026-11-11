# Slice 003 — Background operations

Status: Implemented; independent acceptance PASS for the verified Linux/WSLg single-instance scope (2026-11-06). Windows/macOS target-native execution, physical OS input/DPI and concurrent multi-instance startup remain NOT VERIFIED. See the final acceptance record below.

## Safety prerequisite

Read PRODUCT, ARCHITECTURE, DESIGN, ROADMAP and Slice 002's specification, implementation handoff and P1-1 acceptance correction. Inspected the core's handle-relative traversal, identities, no-replace publication, empty-only cleanup, native Trash boundary, IPC/dialogs and tests. Baseline `mise run rust-test`: 39 core + 4 desktop PASS (2026-11-06). The known staging deletion defect is corrected and regression-tested; no unresolved acceptance-blocking data-safety defect was identified in this audit. This is implementation inspection, not independent acceptance or target-native Windows/macOS evidence.

## Scope and non-goals

Manage copy, same-filesystem move, create directory, rename and native Trash in one process-owned FIFO worker. Add truthful copy progress, cooperative cancellation, safe explicit retry, bounded history, a compact bottom Operations panel, snapshot reconciliation and deliberate shutdown. Preserve all Slice 002 filesystem, confirmation, native identity and UI guarantees.

No parallel workers, pause/resume, durable jobs/recovery database, checkpoint resume, batches/multi-selection, conflict resolver, copy/delete move fallback, permanent deletion, undo, providers, terminal, AI/MCP or redesign.

## Architecture and contracts (checkpoint A)

- A Tauri-independent `OperationManager` in `qpanes-core` owns a mutex-protected registry, FIFO and condition variable. A dedicated standard-library thread performs filesystem I/O with no registry lock held. Core copy remains the single staging/publication implementation.
- Immutable tagged intent captures native source entry and destination/parent plus confirmed new name. Display labels never become native paths. IDs are process-unique decimal strings. Submission/start/completion times are backend timestamps.
- Explicit transitions: Queued → Preparing → Running → Completed/Failed; Queued/Preparing → Cancelled; cancellable Running → Cancelling → Cancelled (or Failed on a different failure). Terminal states never transition. Copy publication gate atomically checks cancellation and closes cancellation before the no-replace syscall. Requests arriving after that gate are too late; successful publication wins and is never rolled back.
- 32 pending/active jobs, 64 terminal history entries, bounded submission-client tracking. Monotonically increasing client submission sequences protect duplicate IPC, including dismissed/evicted jobs (expired duplicates fail instead of executing). Reusing a sequence for different intent fails. Queue order follows registry admission order.
- Worker panics are caught at each job boundary where unwinding is supported: mark Failed with unknown outcome, disable retry, continue the queue. Abort/crash/power loss cannot guarantee a result or cleanup.

## Progress and cancellation (checkpoint C)

Copy streams the existing 64 KiB bounded buffer and counts actual successful writes with checked arithmetic. File count increases after a file's content and metadata succeed. A single file has a verified initial byte total and file total 1; recursive copies aggregate actual work with unknown totals (no expensive prescan/live-tree total claim). Empty files and directories work. Current item is a native identifier with a display label.

Throttle intermediate transport notifications to about 10 Hz; always report lifecycle/final updates. Elapsed time uses a monotonic clock. Smoothed speed uses measured byte deltas only after sufficient samples; ETA requires a known remaining total, warm samples and current progress. Never present data-copy 100% as publication success: pending publication remains explicit, and failed/cancelled bars never show successful completion.

Check cancellation before reads/writes, between entries, and before publication. Original source is never removed. Nonempty staging is always retained under Slice 002's policy, including cancelled partial payloads. Report recovery location/identifier and cleanup failure visibly; never claim clean cancellation when staging remains. No automatic removal of unknown/previous staging.

Queued jobs can always be cancelled. Once short native primitives start, rename/move/create/Trash cannot be interrupted. Repeated cancellation is idempotent while Cancelling; invalid/terminal/too-late requests return structured errors.

## Transport (checkpoint D)

Use Tauri managed state and low-frequency events as **invalidation hints**, plus an authoritative versioned full snapshot command. Channels were considered: their ordered high-frequency stream is unnecessary at 10 Hz and couples a process-owned job to one renderer attachment. Notifications contain only registry revision; frontend coalesces them into at most one in-flight snapshot read. Attach the listener before the initial snapshot, repeat if a newer revision arrived during retrieval, and reject older snapshots. Full snapshots also reconcile removals without unbounded tombstones. No timer polling. Registration finishing after unmount is immediately released.

Narrow commands: submit, list snapshot, details, cancel, retry, dismiss and shutdown actions. Remove legacy direct-mutation IPC paths so every desktop mutation uses the same single worker. Backend exclusively owns status/results. Frontend reload/remount attaches without resubmitting jobs.

Research: official [state management](https://v2.tauri.app/develop/state-management/), [events/channels](https://v2.tauri.app/develop/calling-frontend/), [window events](https://docs.rs/tauri/latest/tauri/enum.WindowEvent.html), [run events](https://docs.rs/tauri/latest/tauri/enum.RunEvent.html); Context7 CLI resolves official Tauri documentation. Verify against installed APIs before adapter implementation.

## Recovery policy

Never automatically retry. Eligible Failed copy/create/rename/move attempts retry as a new ID with `retryOf`, using the original intent and full current core validation, new staging and no-replace primitives. Stale source identities remain failures requiring a refreshed selection. Unknown worker outcomes and native Trash failures are not retryable. Copy conflicts after a publication race cannot overwrite on retry. Published success with a staging warning is Completed, not a retryable failure. Retained staging is never reused.

## UI and lifecycle (checkpoints E–F)

Existing confirmation/input dialogs submit once, close on admission and return focus immediately; admission errors remain in the dialog. Bottom panel can expand/collapse without changing job execution. Show status, immutable intent, current item, bytes/counts, optional speed/ETA, cancel/retry/error/warnings and terminal-only dismissal. History is bounded and scrollable. Ordinary progress never moves focus; a disappearing focused action transfers focus within the Operations panel. Keep panes independently navigable/sortable/selectable while jobs run.

Refresh only affected current directories without navigation or stale selection restoration. Pending invalidations retain at most the displayed native path and one in-flight request revision, drain after navigation/sorting/path editing, and never replay submission-time selection. Reattachment refreshes current matching directories conservatively while preserving current selection.

Intercept custom/native Close and application Exit in Rust whenever work exists. Ask whether to keep working or cancel and close; clearly state jobs cannot continue after exit and partial staging may remain. Shutdown stops admission, cancels queued jobs and requests safe copy cancellation. Wait a bounded grace period off the UI thread; a blocked/noninterruptible primitive exposes an explicit force-exit choice with outcome/cleanup limits. Never silently kill active work or block indefinitely. Minimize/focus/collapse do nothing to jobs.

## Cross-platform limits

Retain Linux no-replace/mount checks, Windows native no-replace/reparse/stream restrictions, macOS rich-content checks and fail-closed Windows Trash. No new production native interop, unsafe Rust or dependency was introduced. Linux/WSLg tests cannot establish target-native Windows/macOS acceptance. No daemon or crash recovery/startup cleanup.

## Checkpoints and test plan

1. A: contracts/state machine/policy; validate serialization and transitions.
2. B: bounded manager, FIFO/uniqueness/dedup, snapshots, failure continuation, panic handling. Deterministic barriers/channels, not sleeps.
3. C: real byte/file counts, recursive/zero-byte/unknown totals, overflow, read/write failures, cancellation before/during/around publication, source/conflict/foreign-stage preservation, retained cleanup and retry revalidation. Disposable fixtures only.
4. D: typed Tauri commands/invalidation transport; snapshot races and listener teardown unit tests.
5. E: trusted Playwright CLI renderer input with mocked IPC; panel controls, progress, queue, navigation, confirmation, duplicates, focus, stale events/reconciliation, remount and compact screenshots. Existing UI regressions updated for intentional contract changes.
6. F: shutdown interception, admission/cancellation/grace/force path tests; native minimize/close smoke where feasible.
7. G: `mise run ui-check`, `ui-build`, `ui-test`, `rust-fmt`, `rust-clippy`, `rust-test`; all browser regressions, Svelte autofixer, native debug build and real Tauri/Rust disposable-fixture tests. Native Trash runs only with existing isolated D-Bus/Trash launcher. Measure representative large-file/small-file/tree/queue workloads, update frequency/overhead/memory where feasible; report actual environment and numbers only. Review diff and use slice-review gate; independent read-only acceptance remains recommended.

## Acceptance criteria

All 20 user Definition of Done criteria apply: responsive background operations; FIFO/single worker; real incremental progress; truthful speed/ETA/cancellation limits; safe source/staging/publication; structured failures/retry; accessible compact panel; immutable queued intent; deliberate shutdown; race/regression coverage and passing available gates; documented platform/recovery limits; no unrelated work. Final acceptance is independent and read-only; execution evidence must distinguish core tests, mocked browser, native IPC and OS input.

## Initial implementation verification and handoff

This original self-review predates the independent FAIL. Its acceptance claims are historical; the hardening record below supersedes them.

Checkpoints A–G are complete within the supported and exercised scope below (2026-11-06). This records implementation verification and critical self-review, not independent final acceptance.

### Implemented behavior

All five mutation types use the manager's single FIFO worker. A failure does not freeze later work; queued cancellation prevents execution. Core state transitions and publication gates own success/cancellation outcomes. Copy reports actual streamed bytes, completed files, current native item, elapsed time and optional smoothed speed/ETA. Recursive copies are intentionally indeterminate. Explicit safe retry creates a new ID, revalidates source/destination and never reuses staging. Native Trash and unknown outcomes cannot be retried from history.

`submit_operation`, `list_operations`, `get_operation`, `cancel_operation`, `retry_operation`, `dismiss_operation` and `shutdown_operations` replace direct mutation IPC. Snapshots contain IDs, immutable intent, labels, affected native directories, timestamps, state, progress, cancellation status, result/error/recovery, retry eligibility and original retry ID. Versioned complete snapshots survive reload; the renderer never invents job state. A full queue returns `queueFull` without consuming its submission token. At most 64 renderer clients are admitted per process; retired sequence numbers remain consumed after history eviction. Restart after finishing jobs if that attachment limit is reached.

The dock is keyboard operable, collapsible and scrollable. Failed/Cancelled are distinct, recovery messages remain visible, and only terminal history can be dismissed. Existing dialogs still require confirmation; they close on admission and guard repeated input. Action focus moves synchronously to a persistent control when that explicit action removes its button; asynchronous updates never refocus. Completion preserves current pane location/selection and drains invalidations through active listings/sorts. Compact spacing changed only where needed to fit the added dock at 720×420; the integrated title bar and existing design tokens remain unchanged.

Close/Exit with active jobs exposes a recoverable confirmation prompt. Cancel and close stops admission, cancels queued jobs, requests cooperative copy cancellation and waits three seconds off the UI thread. A blocked native call exposes Force exit/Keep working. The native suite verified the blocked prompt and Keep working path, then separately verified actual safe cancellation and process exit. It did not deliberately force-kill a blocked kernel operation. Minimize, focus changes and dock collapse do not own job lifetimes.

### Regression tests and critical self-review

- **17 manager tests:** state-machine terminal finality, unique IDs, immutable FIFO order, one active worker, queued/preparing cancellation, repeated/invalid/late cancellation, partial-progress failure, next-job continuation, duplicate/expired token protection, queue/history/client limits, snapshot removal/reconciliation, retry conflict/stale-identity checks, bounded shutdown and panic/transport-failure handling. Real-copy barriers test cancellation during writes, just before the publication gate and after that gate. An injected panic after actual directory creation proves the unknown outcome is Failed/non-retryable rather than rolled back.
- **7 new copy tests** plus preserved Slice 002 tests: exact chunked byte counters, recursive/empty files/directories and unknown totals, partial writes/read failures/disk-full codes, checked overflow and total bounds, cancellation with foreign staging contents and native recovery identity, final-publication conflict after all bytes copied. Fixture contents are compared; no original/user files are mutated.
- **2 new desktop contract tests:** reject virtual parent/forged job state and validate snapshot/error JSON naming. Existing 4 desktop tests remain.
- **8 frontend state/client tests:** listener-before-snapshot, single in-flight/coalesced snapshots, stale terminal/removal rejection, late unlisten/dispose/remount, reconnect after registration/read failure, truthful percentages/unknown totals and immutable idempotent submission/retry tokens. `mise run ui-test` runs these plus the existing 7 window-state tests directly, exposing all 15 individual results.
- **37 new browser assertions:** compact/expanded panel, real-status/progress contracts, cancellation/retry/dismissal, preserved confirmation/duplicates, stale speed/ETA expiry, focus, immutable destinations, navigation during copying, completion during snapshot/listing/sort races, reload/listener ownership and shutdown UI. Mocked Tauri IPC with trusted Chromium input is explicitly labeled. Existing suites add 342 passing assertions: 47 operation, 35 readonly, 95 hardening, 60 chrome, 105 acceptance/layout.
- **20 new native checks:** real Tauri/Rust copy progress, exact 32 MiB payload, FIFO, queued/running cancellation, conflict and continuation, partial ENOSPC failure, safe retry, UI navigation/minimize, close/keep-working, reload identity preservation, blocked shutdown prompt and actual cancel-and-close process exit. These run alongside 32 original navigation + 35 mutation checks (including actual isolated native Trash recovery).

Confirmed renderer defects were corrected with regressions: stale invalidation after pure sorting (test reproduced before the one-line drain fix); artificial 99% clamping (now preserve true partial ratios, show finalization indeterminate until Completed); Svelte setting an existing progress element's value to zero when undefined (explicit determinate/indeterminate branches); expiring stale speed/ETA; and repeated Retry/focus-loss windows. Existing minimum-height acceptance assertions were kept, and the dock spacing was corrected until they passed. No assertion was weakened or test disabled.

### Executed verification

| Command/check | Actual outcome |
| --- | --- |
| `mise run ui-check` | PASS, zero errors/warnings. |
| `mise run ui-build` | PASS, static SvelteKit client build. |
| `mise run ui-test` | PASS, 7 window + 8 operation state/client tests. |
| `mise run rust-fmt` | PASS, both manifests. |
| `mise run rust-clippy` | PASS, both manifests/all targets with warnings denied. |
| `mise run rust-test` | PASS, **63 core + 6 desktop = 69 distinct tests**. The isolated Trash-failure subprocess is not counted twice. |
| `cargo test --manifest-path crates/qpanes-core/Cargo.toml --release --offline` | PASS, final 63-test core suite, including panic recovery, publication races and the 2 MiB-stack deep-copy regression. The isolated Trash-failure subprocess is not counted twice. |
| `cargo test --manifest-path crates/qpanes-core/Cargo.toml --offline cross_device_move_has_no_copy_delete_fallback -- --nocapture` | PASS with generated `/tmp` and `/dev/shm` fixtures outside the default sandbox. No copy/delete move fallback. |
| Playwright CLI: `tests/ui/{readonly,hardening,acceptance-fixes,window-chrome,operations,background-operations}.cli.mjs` | PASS, **379 assertions**, mocked IPC + trusted Chromium input. Final focused suite rerun after self-review corrections. |
| Official Svelte MCP autofixer | PASS, zero issues in page, FilePane, OperationDialog, OperationsPanel and ShutdownDialog. Optional existing bind/Map/Set bookkeeping suggestions reviewed. |
| `mise exec -- pnpm tauri build --debug --no-bundle` | PASS, rebuilt final Linux native app. |
| `QPANES_NATIVE_PORT=19485 QPANES_NATIVE_BACKGROUND=1 bash tests/native/run-operations.sh` | PASS, **87 checks** (32 + 35 + 20), real Linux WebKitGTK/Tauri/Rust and isolated Portal Trash; DOM-dispatched input. |
| Core `cargo clippy --all-targets --offline -- -D warnings` with `--target x86_64-pc-windows-gnu` and `--target aarch64-apple-darwin` | PASS, compilation/lint only. **Target-native runtime NOT VERIFIED.** |
| `git diff --check`, source/diff/safety inspection and wide/compact/native screenshots | PASS. No branch switch, commit, push or merge. |

Native write delays/failures are an external Linux-only `LD_PRELOAD` test shim, compiled into the generated fixture root. It intercepts only `.qpanes-copy-*` payload writes underneath the explicitly marked root, bounds injected blocking, and never touches developer Trash or arbitrary user paths. The original private D-Bus/XDG isolation launcher is retained. Production code has no fault hooks or weakened security capabilities. Native UI input is DOM-dispatched, **not OS-level trusted keyboard delivery**. Chromium covers trusted browser input separately. WSLg minimize calls/progress were exercised; physical host focus/scaling remains outside this evidence.

An initial native run passed all existing checks and 16 new checks before a test-harness reload timing error; a reload-generation guard fixed the harness and the complete final run passed. Earlier interrupted browser runs caused by concurrent development/build reloads and `*-partial.json` files are investigation evidence only.

### Performance measurements

Environment: WSL2/Linux `6.18.54.1-microsoft-standard-WSL2`, Intel i9-13900KF, Rust 1.99.1, Node 24.22.2, `/tmp` on a 7.9 GiB tmpfs. Release core example, generated fixtures, no artificial delay: `cargo run --manifest-path crates/qpanes-core/Cargo.toml --release --example operation_benchmark --offline`. These are local workload observations, not disk-storage or cross-platform benchmarks.

| Workload | Direct core | Managed core | Notes |
| --- | --- | --- | --- |
| 256 MiB file, 3 alternating-order runs | 103.273 / 55.639 / 56.206 ms | 63.264 / 57.050 / 58.434 ms | Exact managed byte/file counts; 7 registry notifications per short copy, including lifecycle/final transitions. |
| 1,024 × 4 KiB files | 6.454 ms | 6.471 ms | 4,194,304 actual bytes / 1,024 files. |
| 20-level nested tree, 200 files | 31.930 ms | 2.968 ms | 819,200 bytes; large timing variance. |
| 4,000 empty files | 20.107 ms | 20.747 ms | 0 bytes / 4,000 completed files. |
| 1,000 sequential queued directory jobs | — | 35.747 ms | Exactly 64 history jobs retained. RSS 4,816 → 4,884 KiB; process initial RSS 3,864 KiB. |

Cache/scheduling/order variance prevents a reliable percentage-overhead conclusion from these timings. The probe compares managed vs direct current core, not the old Slice 002 implementation or production IPC. Production frontend/native application memory was not separately profiled. Queue memory is also bounded by tests at 32 active / 64 history / 64 clients and input size limits.

In the final native delayed-write test, pane navigation during a running copy took **26 ms**; 107 snapshot observations saw 26 distinct byte values over 2,810 ms (about 9.3 observed byte changes/sec). The copy's writes were deliberately delayed 6 ms per chunk to make cancellation/lifecycle observable. These numbers demonstrate responsiveness/progress behavior, not transfer throughput. Core notification throttling is separately deterministic-test verified at 100 ms plus forced lifecycle/final updates.

### Acceptance status

| Definition of Done | Status/evidence |
| --- | --- |
| 1–3 background execution, multiple jobs, single worker | PASS, manager + real native queue/navigation checks. |
| 4–5 real progress and truthful metrics | PASS, chunk/partial-write/zero/recursive/overflow tests, smoothing/throttling tests, renderer finalization tests, native byte counts. |
| 6–9 running/queued cancellation, truthful primitive limits, data integrity | PASS within inherited Slice 002 guarantees; deterministic publication-race tests, foreign-stage preservation and native cancellation. |
| 10–11 structured visible failures and explicit safe retry | PASS, unit/browser/native conflict, partial ENOSPC and retry revalidation. |
| 12–14 compact accessible UI, responsiveness, immutable intent | PASS, 379 browser assertions + real native navigation/reload checks. |
| 15–16 minimize/collapse independence and deliberate close | PASS within Linux/WSLg evidence, including blocked grace and actual safe process exit. |
| 17–18 race coverage and available checks | PASS as executed above. |
| 19–20 documented limits and scope | PASS. Target-native Windows/macOS remains NOT VERIFIED; no unrelated feature or redesign. |
| Independent acceptance | Subsequent independent review returned FAIL: four P2 and two P3 findings. See the hardening corrections below; a new independent review is required. |

### Files changed and handoff

- Core: `src/lib.rs`, `src/operations.rs`, `src/operations/tests.rs`, new `src/operation_manager.rs`, `src/operation_manager/tests.rs`, new disposable `examples/operation_benchmark.rs` under `crates/qpanes-core`.
- Desktop adapter: `src-tauri/src/lib.rs`.
- Renderer: `src/lib/operations.ts`, `OperationsPanel.svelte`, `ShutdownDialog.svelte`, `OperationDialog.svelte`, `FilePane.svelte`, `filesystem.ts`, `src/routes/+page.svelte`.
- Verification: `mise.toml`, new `tests/operations-state.test.mjs`, new `tests/ui/background-operations.cli.mjs`, existing five UI mocks/regression suites updated for the new authoritative snapshot/admission IPC, native `operations.mjs`/`run-operations.sh`, new `background-operations.mjs`/`io-faults.c`.
- Docs: this scope/plan/evidence/handoff, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`.
- **Dependencies:** none introduced; existing test-only tempfile and installed CLI/compiler/browser tools reused. Lockfiles/security capabilities/native Rust boundary unchanged.

Ignored evidence: `test-results/slice-003-native.json`, `slice-003-native-run.log`, `slice-003-native-operations.png`, `slice-003-background-renderer.json`, `slice-003-acceptance-renderer.json`, `slice-003-operations{,-compact}-mocked.png`, `slice-003-sort-race-before-fix.json`, `slice-003-performance.txt`, plus the existing suite reports. Screenshots were inspected at 1200×780, 720×420 and native WebKitGTK size.

### Unsupported behavior, remaining risks and manual QA

No parallel workers, pause/resume, persistent jobs, startup/automatic staging recovery, checkpoint resume, cross-device move fallback, permanent deletion or later-slice features. Windows Trash remains intentionally unsupported. Rich metadata/platform filesystem restrictions and adversarial concurrent namespace/live-content limits remain those of Slice 002. Copies are not filesystem snapshots or power-loss transactions. Nonempty cancelled/failed staging intentionally consumes disk until manually reviewed/removed; no automatic cleanup touches unknown staging. Empty-only cleanup retains Slice 002's documented namespace/ownership limits.

A native primitive or filesystem call can block beyond the grace period. Force exit, process abort (including the existing desktop release panic-abort setting), OS crash or power loss may leave marked staging and unknown outcomes; cleanup/rollback is not guaranteed. Panic recovery is tested for unwind builds. If the frontend cannot load at all, it cannot display the recovery prompt; Rust still prevents silent normal close with active work. No persistent recovery store or daemon exists.

Windows/macOS **target-native execution NOT VERIFIED**: release QA must exercise native no-replace/cancellation/publication, Windows path/reparse/stream cases, macOS Trash/metadata, native chrome/quit and actual OS input. Full desktop cross-target builds were not claimed; the cross-target checks cover the core. Physical OS keyboard/focus/DPI transitions and unusual/network filesystems remain manual QA. Independent read-only acceptance should review the cancellation/publication gate, retained staging, duplicate-token retention, snapshot/listener races, shutdown and fixture boundaries before final acceptance. Do not merge automatically. Slice 004 was not started.

## Slice 003 hardening — corrective plan

The independent review reproduced obsolete shutdown finishers affecting newer attempts, Blocked shutdown remaining after terminal work, stale panes inside renamed directories, incoherent preparation-time copy totals, a false connection warning after equal-revision reconnect, and focus falling to BODY when Cancel disappears. No P0/P1 was confirmed. Preserve the existing FIFO manager, publication/cancellation gate, staging policy and dirty working tree.

1. Add and execute failing regressions before each correction. Use deterministic barriers and disposable fixtures; retain red/green logs. Preserve existing assertions.
2. Give close prompts/drains explicit attempt identity, guard all asynchronous completion/force decisions, and wake obsolete waiters on Keep working. Reconcile outstanding drains to Ready when the final actual mutation terminates; one cancellation-aware waiter per current attempt handles grace timeout and later safe exit. No frontend polling or manager replacement.
3. Carry old source-directory subtree invalidations for rename/move/Trash. Classify affected native canonical paths in Rust using path components, retaining native case and roots according to the existing canonical-identifier boundary. Preserve opaque IDs and sequence-guarded, in-place pane refresh; vanished current paths show errors.
4. Use coherent source metadata at the preparation/stream boundary, rejecting changes before writing while preserving every actual positive write count on later failure. Retain recursive unknown totals and all source/staging/publication checks.
5. Separate connection health from action errors, acknowledge healthy reads even at equal revisions, and recover focus only when an owned action is removed/disabled. Ordinary progress and other-pane focus remain untouched.
6. Run targeted regressions, all mise gates, existing/new browser suites, official Svelte analysis, optimized core tests, native debug build and isolated native mutation/shutdown smoke. Inspect the integrated diff and document actual results, platform limits and remaining inherited filesystem limitations. Request a new independent read-only acceptance review; do not claim acceptance or begin Slice 004.


## Hardening implementation and verification — 2026-11-06

The four P2 and two P3 independent findings were reproduced before their production corrections. All six are corrected within the verified Linux/WSLg scope. This is an implementation handoff and self-review, **not independent acceptance**. Initial dirty work was preserved; branch `main` and HEAD `2a1ebad35ae95bad233f2b5c795d6ea9d543cace` were not changed. No commit, push, merge, branch switch or Slice 004 occurred.

### Findings, root causes and corrections

| Finding | Root cause | Implemented correction | Regression evidence |
| --- | --- | --- | --- |
| P2-1 obsolete shutdown attempt | A timeout/finisher had no initiating identity and could change whichever drain happened to be current. | Each close prompt has an opaque `shutdownAttempt`. Repeated Close retains it; drain, waiter, finish, Keep working and Force exit validate it under the registry lock. Keep working clears it and wakes superseded waiters. Each confirmed drain records its own monotonic three-second deadline. Exit may be claimed once. | Two original shutdown regressions were red; obsolete finisher/action tests are green. Fifty close/cancel/close cycles test unique tokens, independent grace and waiter termination using channels, with no scheduling sleeps. |
| P2-2 Blocked after terminal work | Shutdown was reconciled only by a one-shot timeout callback; later worker completion did not finish the pending close. | Last-worker terminal processing reconciles Draining/Blocked to Ready. One off-UI-thread condition-variable waiter remains after timeout and claims normal exit once cleanup/primitive execution has returned. Keep working invalidates its token and prevents later auto-exit. Recovery errors and unknown outcomes stay on jobs; Ready means no work remains executing, not clean staging or rollback. | Original Blocked-after-completion regression was red. Green tests cover completion before/after timeout, actual copy cancellation with exact retained stage bytes, queued cancellation, panic/unknown outcome and a successful copy already past the publication gate. Native timeout-to-cancellation now actually exits; Keep working leaves the process usable. |
| P2-3 stale renamed/moved directory | Jobs invalidated only exact parent directories, so another pane inside the old source subtree was missed. | Immutable directory rename/move/Trash jobs add `invalidatedSubtrees`. A bounded pure Rust classifier decodes native IDs and compares whole native path components, including native root semantics. It never uses lossy labels or string-prefix ancestry. Both displayed and in-flight pane targets are classified; navigation revisions reject stale classifier/listing replies. Existing edit/loading/sort deferral is preserved. Vanished current directories expose the existing unavailable state at the same path. | Open-ancestor renderer regression was red. Native tests rename an open directory/ancestor, move an open descendant in the opposite direction, verify exact moved bytes and preserve a similarly prefixed sibling. Browser tests cover stale replies, newer navigation, queued immutable intent, path drafts, blocked listings and sorting. Unix tests include non-UTF-8 IDs; Windows drive/UNC tests compile conditionally. |
| P2-4 preparation source resize | Total bytes came from earlier source metadata while stream limits came from a later metadata read; a growth could be written before the counter rejected it. | After the preparation callback, validate metadata against the same opened-file version used for totals, before creating/writing that item's payload. Recursive children capture/validate their own preparation metadata. Detected changes return SourceChanged; recursive totals stay unknown. Later validation failure preserves every successful write count and retained payload. No prescan or weaker source-change check was introduced. | Three original real-filesystem regressions were red: root shrink published, root growth retained 65,536 uncounted bytes, recursive child shrink published. All are green. Eight new tests additionally cover child growth, streaming shrink/growth, unknown totals, real seven-byte partial writes and exact retained/source bytes. Existing cancellation/publication tests remain green. |
| P3-1 false reconnect warning | Action errors shared the connection warning, and restored connectivity was acknowledged only when a newer registry revision arrived. | Successful snapshot reads acknowledge health independently of revision advancement, without replaying equal/older operation data. Action errors have a separate visible message and explicit Dismiss. Reconnect clears only connectivity failure. | Equal-revision Node regression was red and now passes; renderer red tests exposed conflated action health/error handling. Successful reconnect, retained action error and existing snapshot/listener races all pass. |
| P3-2 disappearing Cancel focus | External terminal updates removed the focused button; explicit action handlers could not handle that path. | A scoped Svelte pre-update effect inspects actual focus ownership and the next job state. If the owned action disappears/becomes unavailable, it focuses the persistent dock toggle. Progress and focus outside this dock do nothing. | Trusted Chromium keyboard regressions were red for Completed, Cancelled and Failed (BODY). All now retain a usable button focus. Ordinary progress and another pane's focus remain unchanged. |

Red evidence is preserved in ignored `test-results/slice-003-hardening-{shutdown,progress,health,renderer}-red.log`; assertions were retained or strengthened. Tests were added before each confirmed defect's production correction. Supplemental race/fixture coverage was then added. The new native driver initially failed on an inspector-expression quoting error, which was corrected; the completed rerun passed. No product failure was hidden or assertion weakened.

### Lifecycle and path invariants

The manager/FIFO, synchronization primitives, no-replace publication, cancellation gate, duplicate-submission protection, retry eligibility and staging policy remain in place. No generic state-machine/scheduler library, dependency, unsafe Rust or production configuration/capability change was introduced.

A normal confirmed close transitions Draining → Ready, or Draining → Blocked → Ready. Blocked exposes Force exit only for the current attempt. The worker and shutdown watcher never hold the registry mutex during filesystem I/O. The watcher uses condition-variable wakeups, including after Keep working; there is no polling timer or accumulating obsolete waiter. Ready is reconciled under the same lock as job terminal transitions. The final exit claimant rechecks identity and marks exit claimed before calling Tauri. A naturally finished **unconfirmed** prompt stays open with an accurate “All operations have finished” message and explicit Close QPanes action. The user can keep working until exit is claimed.

Native listing canonicalization remains the path-normalization boundary. Ancestry comparison preserves native component bytes/code units and case instead of guessing a volume's case-folding rules; it also works after the old path has vanished. Alias/case behavior on target-native Windows/macOS volumes still needs runtime QA. JavaScript never reconstructs a path from its display label. A failed refresh retains the existing last-good preview under an explicit unavailable banner, and mutation submission rejects that unavailable pane; it does not silently redirect navigation.

### Executed hardening verification

Environment: WSL2/Linux `6.18.54.1-microsoft-standard-WSL2`, Rust 1.99.1, Node 24.22.2, pnpm 12.18.0. Filesystem mutations used generated temporary fixtures only. Native Trash ran in a validated private D-Bus/Portal session with disposable XDG data. The external Linux-only test shim targets generated staging paths, signals entry into a blocked write, and bounds the artificial block; no production test hook was added.

| Actual command/check | Outcome |
| --- | --- |
| `mise run ui-check` | PASS: 0 errors, 0 warnings. |
| `mise run ui-build` | PASS: static frontend build. |
| `mise run ui-test` | PASS: 7 window + 9 operation-state tests. |
| `mise run rust-fmt` | PASS: both manifests. |
| `mise run rust-clippy` | PASS: both manifests, all targets, warnings denied. |
| `mise run rust-test` | PASS: 84 core + 6 desktop tests. The isolated Trash-failure subprocess is not counted twice. |
| `mise exec -- cargo test --manifest-path crates/qpanes-core/Cargo.toml --release --offline` | PASS: 84 optimized core tests. |
| Playwright CLI `run-code --filename=tests/ui/{readonly,hardening,acceptance-fixes,window-chrome,operations,background-operations}.cli.mjs` | PASS: all 379 existing renderer assertions. Mocked IPC, trusted Chromium input. |
| Playwright CLI `run-code --filename=tests/ui/slice003-hardening.cli.mjs` | PASS: 31 new renderer assertions; total 410. Screenshot inspected. |
| Official Svelte MCP autofixer | PASS: zero issues in the four analyzed changed components; advisory suggestions reviewed. |
| `mise exec -- pnpm tauri build --debug --no-bundle` | PASS: Linux native debug executable. |
| `QPANES_NATIVE_PORT=19510 QPANES_NATIVE_BACKGROUND=1 bash tests/native/run-operations.sh` | PASS: 32 navigation + 35 mutation/Trash + 20 background checks. Real Tauri/Rust IPC and actual filesystem bytes; UI input is DOM-dispatched. Final rerun uses the explicit write-entry barrier. |
| `QPANES_NATIVE_PORT=19511 QPANES_NATIVE_BACKGROUND=1 QPANES_NATIVE_PHASE=hardening bash tests/native/run-operations.sh` | PASS: 10 new native checks, including actual process exit after grace timeout, stale force rejection and old-subtree invalidation. |
| `mise exec -- cargo clippy --manifest-path crates/qpanes-core/Cargo.toml --target x86_64-pc-windows-gnu --all-targets --offline -- -D warnings` | PASS: core/test compile and lint only; no target-native execution. |
| Same core Clippy command with `--target aarch64-apple-darwin` | PASS: core/test compile and lint only; no target-native execution. |
| `git diff --check` | PASS. |

Browser suites used `LD_LIBRARY_PATH=/tmp/qpanes-browser-libs/usr/lib/x86_64-linux-gnu XDG_CACHE_HOME=/tmp/qpanes-003-hardening-hj7zmock/browser-cache playwright-cli -s=qpanes-hardening --raw run-code --filename=<suite>` after `open --config=/tmp/qpanes-playwright-slice003.json`. The official Svelte analyzer results are in the tool transcript (no separate analyzer file was saved). Command logs: `test-results/slice-003-hardening-*.log`. Native JSON reports: `slice-001-native.json`, `slice-002-native.json`, `slice-003-native.json`, `slice-003-hardening-native.json`. Renderer evidence includes `slice-003-hardening-renderer.png` and the new suite report. Mise's inability to update an optional external cache in the sandbox produced warnings; verification commands themselves passed.

The latest native delayed-write run measured navigation during a 32 MiB copy at **27 ms**, with 105 observations seeing 26 distinct progress values over 2,699 ms. Writes were deliberately delayed 6 ms/chunk. This measures responsiveness/progress observability, not throughput or a robust performance guarantee. No new storage throughput or memory benchmark is claimed; existing bounds/virtualization/large-fixture tests pass. Earlier implementation measurements above are historical.

### Critical self-review, files and remaining limits

No new P0/P1/P2 defect was found in the integrated self-review. Confirmed hardening findings are covered by red/green evidence. Shared ownership weaknesses were addressed explicitly: shutdown attempt identity plus terminal reconciliation, native subtree invalidation, one metadata version for totals/limits, independent health acknowledgement and scoped focus ownership. The reusable core remains free of Tauri/Svelte dependencies; the adapter owns events, UI-thread exit handling and the off-thread waiter. All mutation commands still use the single worker.

Hardening files: core `operation_manager.rs`, `operation_manager/tests.rs`, `operations.rs`, `operations/tests.rs`, `lib.rs`, new `invalidation.rs`; adapter `src-tauri/src/lib.rs`; renderer `operations.ts`, `OperationsPanel.svelte`, `ShutdownDialog.svelte`, `FilePane.svelte`, `src/routes/+page.svelte`; `tests/operations-state.test.mjs`, new `tests/ui/slice003-hardening.cli.mjs`, native launcher/background suite/shim and new `tests/native/hardening.mjs`; this record, architecture and roadmap. Dependencies and lockfiles are unchanged. Baseline/delta evidence in `/tmp/qpanes-003-hardening-hj7zmock` and ignored `test-results` confirms no initial source file was removed; unrelated dirty files were preserved.

Nonempty staging still intentionally remains for manual review after cancellation/failure. No automatic cleanup, rollback of published data, snapshot guarantee, crash/power-loss guarantee or recovery database was added. Source metadata checks cannot provide live-filesystem snapshot semantics; namespace/staging ownership limits remain those documented in Slice 002. Unknown/panicked outcomes remain Failed and non-retryable even though no call is still executing. Force exit can leave staging and unknown outcomes. Windows Trash remains unsupported; cross-filesystem moves still fail closed.

Windows/macOS native filesystem runtime, cancellation/publication, Trash, desktop IPC/UI, shutdown and physical OS keyboard/DPI behavior are **NOT VERIFIED**. Cross-target core linting is not desktop or runtime acceptance. Linux native input here is DOM-dispatched; trusted keyboard evidence comes from mocked Chromium suites. No previously deferred visual issue was changed.

Hardening is implementation-complete within the exercised Linux/WSLg scope. Recommend a new **independent, strictly read-only acceptance review**, especially around attempt-token races, late terminal reconciliation, subtree aliases/case, metadata validation and native fixture safety. Do not treat this self-review as acceptance or proceed automatically to Slice 004.


## Follow-up acceptance corrections — R003-01/02/03

A subsequent independent read-only review returned FAIL with one new P2 (history eviction loses pane invalidation) and two P3 focus findings (secondary alert controls; overlapping admission/shutdown return focus). No new P0/P1 was confirmed. Its detailed evidence is `/tmp/qpanes-003-final-acceptance-pl40nuze/acceptance-report.md`; original source/Git fingerprints were unchanged during that review.

Corrective plan: reproduce each failure with a repository regression before fixing; add a bounded completion-sequence contract independent of visible history; retain exact invalidation when no completions were missed and defer current-pane re-reads on a detected gap; repair scoped alert/modal focus ownership; run configured gates/native fixtures, then perform a new independent read-only review on a frozen copy. No manager replacement, new scheduler, polling, dependency, filesystem primitive or Slice 004.

Implemented contract: `OperationSnapshot.invalidationRevision` counts returned worker attempts, including failures/unknown outcomes that may leave filesystem changes. Each returned job carries its own nullable stamp. Assignment and terminal state are atomic under the existing registry mutex. Dismissal/pruning cannot reset the global counter; queued/preparing cancellation without execution has no stamp. A renderer compares the completion interval with unique retained stamps. A missing stamp triggers one conservative current/arriving-location refresh, preserving edit/loading/sort sequencing and current selection/focus. It also catches work never observed Queued/Running. Known complete intervals continue using affected native directories/subtrees; no unbounded invalidation log or tombstones are needed.

Red evidence: `test-results/slice-003-rereview-history-red.log` shows the copied file missing after 65 unrelated terminal jobs evict it; the original regression now passes. `slice-003-rereview-focus-red.log` shows exactly the three independent focus failures before production edits. Existing assertions were retained.

New regression coverage: two core tests verify completion stamps survive 70 real fixture mutations/history eviction/dismissal/failure and queued cancellation does not claim execution; two Node tests verify pruned/dismissed/entirely unseen gaps and ordinary complete intervals; `tests/ui/history-invalidation.cli.mjs` checks automatic refresh, exact unaffected intervals, entirely missed work, selection/focus, path drafts and newer navigation; `tests/ui/acceptance-focus.cli.mjs` checks trusted-keyboard alert/modal focus and non-stealing; `tests/native/history-invalidation.mjs` uses real Tauri/Rust bytes and a delayed debug snapshot callback to exercise actual history pruning. Its launcher phase is `QPANES_NATIVE_PHASE=history QPANES_NATIVE_BACKGROUND=1` and uses the existing isolated Trash/fixture policy.

The corrected history test passes 11 browser assertions. Core debug/release pass 86 tests; desktop tests pass 6. UI state tests pass 7 window + 11 operation tests. The six configured mise gates pass; the native debug build passes. Exact follow-up native and independent re-review outcomes are recorded separately after execution. Evidence prefix: `test-results/slice-003-rereview-*`. Windows/macOS runtime and physical OS input remain NOT VERIFIED. Safety/staging/crash limits above remain unchanged.


Follow-up implementation verification completed: history-gap suite **11/11**, focus suite **19/19**, all without renderer exceptions; official Svelte analyzer reports zero issues in all four changed components. Self-review additionally reproduced unusable BODY/root and disabled-submit return targets before correction (`slice-003-rereview-focus-adjacent-red.log`). The modal now synchronously validates the saved target, preserves a usable underlying dialog control, then falls back to the active pane; no timer or global focus recovery was added.

Native implementation checks: `python3 /tmp/qpanes-003-rereview-fixes-w9aijnd8/run-native.py 19710` passed 87 existing navigation/mutation/background checks; phase `hardening` at port 19712 passed 10; phase `history` at port 19711 passed 5 checks with actual no-overwrite copying, 65 subsequent jobs, real history pruning and automatic destination refresh. These wrappers set disposable HOME/XDG directories and use the existing private Trash Portal launcher. Native input is DOM-dispatched. The final native debug rebuild includes the final focus corrections. The requested independent read-only review follows on a fresh frozen source copy; its verdict is a separate acceptance result, not this implementation self-review.


The first requested read-only re-review passed all nine repository suites (440 assertions), thirteen independent snapshot/invalidation/remount checks, and the independent core audit (twelve probes, including 200 shutdown races). It found no new P0/P1/P2, but confirmed two adjacent P3 modal-focus cases: BODY with a surviving busy nameless dialog, and loss of focus when Cancel and close becomes disabled/replaced during Draining/Blocked. The original repository remained unchanged during that review (`/tmp/qpanes-003-rereview-sbb1py59/integrity-round1.json`).

After closing that read-only round, both P3 cases were reproduced by permanent regressions before correction. Shutdown now captures an existing native modal owner before opening itself even if the current child focus is BODY, and hands an owned action's focus to the dialog before disabling/removing the control. This remains synchronous and local; no listener, timer or global focus recovery was added. `dialog:modal` follows the [HTML modal-state contract](https://html.spec.whatwg.org/multipage/semantics-other.html#selector-modal) and is exercised in Chromium/WebKitGTK. The focus suite now passes **24/24**, keeping the original behavior assertions. A fixture precondition was made browser-independent: it verifies the submitting control remains connected and disabled rather than assuming every engine retains focus on a disabled button. Restoration assertions stay unchanged; the corrected fixture still reproduced the product failures before correction. Official Svelte analysis: zero issues. A final frozen-source delta review follows; no Rust mutation/cancellation/publication code changed in this final focus correction.


## Final acceptance record

The final independent read-only review on 2026-11-06 returned **PASS within the verified Linux/WSLg, single-application-instance scope**. R003-01 (lost history invalidation), R003-02/03 (alert and overlapping-dialog focus), and the subsequent busy-modal/draining-focus findings were closed. No open acceptance-blocking code defect remained in that verified scope.

Final review evidence recorded in the task handoff:

- All six configured mise quality gates passed: `ui-check`, `ui-build`, `ui-test`, `rust-fmt`, `rust-clippy`, `rust-test`.
- Rust: 86 core + 6 desktop tests; UI state: 7 window + 11 operation tests.
- Nine renderer suites: 445 assertions, mocked authoritative IPC with trusted Chromium input. Independent renderer probes: 13 invalidation/remount + 16 focus checks, all passing. Official Svelte analyzer: zero issues.
- Native verification: 87 navigation/mutation/background + 10 lifecycle/subtree + 5 history-invalidation + 5 modal-focus cases, using real Tauri/Rust IPC and isolated disposable filesystem/Trash fixtures. Native UI input was DOM-dispatched.
- Twelve independent core probes covered real write/fsync failures, source replacement, retry/publication, concurrent snapshots/admission, retention, cancellation and 200 shutdown-race rounds. The final focus-only delta preserved the audited core/adapter/state/pane files byte-for-byte.
- The final read-only review preserved all 117 original/frozen source fingerprints and Git state. Its source-manifest SHA-256 was `c3e62c7030eb6bbd19d1e33d727aabc0e4516b7945e93cbd6cc07a7c9efc83e6`. A later agent-tooling compatibility commit is separate from the reviewed application changes.

The detailed report was originally stored at `/tmp/qpanes-003-rereview-sbb1py59/final/acceptance-report.md`. That temporary review tree is no longer available as of 2026-11-11; this committed record preserves the reported verdict, evidence scope and limitations. Implementation red/green logs and reports use the ignored `test-results/slice-003-rereview-*` prefix where retained. The checks immediately before commit are recorded separately below rather than presented as a new full native acceptance review.

One native instance crashed during an early three-instance parallel test launch before operation submission. The cause was not established; its log contained EGL/DRI warnings. Sequential reruns with separate per-instance HOME/XDG/cache profiles passed without production/security workarounds. Concurrent multi-instance startup remains NOT VERIFIED. Windows/macOS runtime, physical OS input/DPI, unusual filesystems, retained-staging/crash recovery and the inherited Slice 002 namespace limits remain as documented. This acceptance is not a cross-platform production-readiness claim.


### Pre-commit verification — 2026-11-11

Fresh checks before the authorized Slice 003 commit/push: `mise run ui-check` PASS (0 errors/warnings), `mise run ui-build` PASS, `mise run ui-test` PASS (7 window + 11 operation tests), `mise run rust-fmt` PASS, `mise run rust-clippy` PASS (both crates, warnings denied), and `mise run rust-test` PASS (86 core + 6 desktop distinct tests). `git diff --check` PASS. Exact command logs are under ignored `test-results/slice-003-precommit-*`. No new native/browser acceptance run is claimed for this packaging step; the final review above is the 2026-11-06 record.
