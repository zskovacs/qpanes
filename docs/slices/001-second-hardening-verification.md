# Slice 001 — Second acceptance hardening handoff

Project names in these historical command examples have been updated to the current branding. Disposable test paths are illustrative and may no longer exist.

Date: 2026-11-05. Four P2 findings from the second independent FAIL review were reproduced before implementation. They are corrected in the verified Linux/WSLg scope. This report recommends another independent acceptance review; it does not grant acceptance.

## Findings, causes and corrections

| Finding | Root cause | Correction and regression evidence |
| --- | --- | --- |
| Parent Retry selects `[..]` or the first unrelated directory | Only the retry destination was saved. Retry read the currently displayed selection instead of the original parent navigation's desired child. | A pane-local navigation intent retains destination and desired selection together. Failed retries retain it; newer navigation supersedes it. Trusted-input tests cover both panes, Enter/Backspace, repeated permission failures/recovery, inactive selection/focus, stale Retry completion, and restoring/revealing entry 9,999 in a 10,000-entry virtual list. Real native permission recovery also passes for both methods/panes. |
| Escape during a delayed navigation leaves the old address | The input revision protected edits but had no cancellation state. Escape replaced text without releasing that protection. | Track whether editing remains active alongside its revision. Escape releases editing and shows the committed path; pending completion can then update it. Tests cover both panes, genuine active input, Escape before/after completion, failure/Retry, stale success and stale failure. Canceled text never issues navigation. |
| Long current paths/errors collapse the list and clip the footer | The wrapping, nonshrinking banner had no height bound. | A 40px ellipsized preview keeps Retry and a full-details disclosure accessible. Full text wraps/scrolls in a nonmodal overlay; closing returns focus to the disclosure. Native details owns its open state, avoiding a fast Enter/Escape toggle race found during self-review. Browser tests use paths over 500 characters plus 600-character unbroken message text at 720×420 and 30/50/70% splits. Native fixtures also exceed 500 characters. |
| Responsive sort controls drop focus to BODY | CSS alternated between headers and compact controls while hiding the focused element. | A blur handler transfers focus only when the old control is hidden and no intentional destination owns the focus move. It selects the visible equivalent; ordinary moves remain untouched. Trusted-input tests cover shrink/growth, select/direction/header controls, window/splitter resizing, subsequent navigation and unrelated editor/splitter focus. Actual native X11 resizing verifies the same transfer in WebKitGTK. |

Before the changes, independent browser probes reproduced all four findings. The new automated suite also failed against the prior implementation: parent retries selected the wrong child, canceled editors retained `/home` over `/slow`, hidden sorting controls lost focus, and the long error had a zero-height list. The final suite passes. Early test runs also exposed a selector ambiguity caused by duplicated preview/full-detail text; existing assertions were retained with explicit preview/Retry selectors, rather than removed.

## Architecture and scope

Production changes are confined to `src/lib/FilePane.svelte`. Navigation intent, editing intent and focus ownership are explicit local transitions. Existing request sequence guards still protect every commit and failure; no completion callback moves focus. Sorting, parent semantics, opaque native identities, fixed-height virtualization and independent pane state remain intact.

Rust core, Tauri adapter, IPC interfaces, dependencies and application configuration were not changed in this hardening round. No file mutation functionality or later-slice feature was introduced. Test filesystem writes, permission changes and cleanup target generated temporary fixtures only. Existing uncommitted/untracked implementation work was preserved; no reset, clean, branch switch, commit, push or merge was performed.

## Verification executed

| Command | Result |
| --- | --- |
| `mise run ui-check` | PASS: zero Svelte/TypeScript errors and warnings |
| `mise run ui-build` | PASS: static production frontend |
| `mise run rust-fmt` | PASS: both manifests, check mode |
| `mise run rust-clippy` | PASS: both manifests, all local targets, warnings denied |
| `mise run rust-test` | PASS: 11 core tests and 1 desktop boundary test; binary/doc targets successful |
| `npx @sveltejs/mcp svelte-autofixer src/lib/FilePane.svelte --svelte-version 5.57.3` | PASS: no issues; optional suggestions to replace retained DOM handles remain |
| `pnpm tauri build --debug --no-bundle` | PASS: native Linux debug binary |
| `playwright-cli -s=qpanes-round2 --raw run-code --filename=tests/ui/readonly.cli.mjs` | PASS: all 35 original renderer assertions |
| `playwright-cli -s=qpanes-round2 --raw run-code --filename=tests/ui/hardening.cli.mjs` | PASS: all 95 previous hardening assertions |
| `playwright-cli -s=qpanes-round2 --raw run-code --filename=tests/ui/acceptance-fixes.cli.mjs` | PASS: 105 second-hardening assertions; all captured keyboard input trusted |
| `WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9225 GDK_BACKEND=x11 src-tauri/target/debug/qpanes` | PASS: production assets launched in the real Tauri webview under WSLg |
| `QPANES_INSPECTOR=http://127.0.0.1:9225 node tests/native/smoke.mjs` | PASS: 32 real filesystem/IPC checks, including repeated parent permission recovery in both panes and long paths |
| `QPANES_INSPECTOR=http://127.0.0.1:9225 node /tmp/qpanes-second-native-responsive.mjs` | PASS: 12 supplementary checks using actual X11 window resizing, both focus directions/panes and 720×420 long-path errors at all three splits |
| `playwright-cli -s=qpanes-round2 --raw run-code --filename=/var/tmp/qpanes-accept-qY8ezl/review-probes.cli.mjs` | PASS after inspecting/asserting results: exact original reproductions corrected; all 18 metadata/sorting layout cases pass at 720×420, 900×600 and 1280×800 with 30/50/70% splits |
| `node --check tests/ui/acceptance-fixes.cli.mjs` and `node --check tests/native/smoke.mjs` | PASS |
| `git diff --check` | PASS |

The supplementary native probe reused the smoke script's WebKit inspector helpers and a disposable X11 resize helper from the independent review. It changed runtime window size only, with no application permission/configuration changes. This environment-specific probe is local evidence; the committed browser suite provides repeatable window/splitter focus regressions. All builds/checks completed before the final browser suites to prevent generated SvelteKit files interrupting them.

## Acceptance checklist for the next reviewer

| Criteria in Slice 001 specification | Verified status |
| --- | --- |
| 1–4: configured quality gates, real filesystem tests, renderer interactions, native browsing | PASS in Linux/WSLg scope |
| 5–7: compact layout, no mutation API, documented handoff/platform limits | PASS |
| 8: Retry focus and intentional focus/edit ownership | PASS |
| 9: delayed navigation/sort destination, latest preferences and stale protection | PASS |
| 10: minimum-size/unequal sorting and selected metadata | PASS |
| 11: virtual parent, roots, counts, independent navigation, restored/visible selection | PASS in tested Linux and backend-supplied renderer root scope |
| 12: Windows lint expression corrected | Static inspection plus Linux Clippy only; Windows/macOS native checks UNVERIFIED |
| 13: original parent selection intent survives failed Retry/recovery | PASS |
| 14: canceled versus active address editing, including asynchronous races | PASS |
| 15: bounded long-path errors retain list/footer and full details | PASS |
| 16: responsive focus ownership in both directions/window/splitter | PASS in Chromium and actual native WebKitGTK window resize |

These are implementation verification results, not an independent acceptance verdict.

## Reproduction and local evidence

Start `pnpm dev`, open a Playwright CLI Chromium session, and run the three renderer commands sequentially. Each suite installs its own deterministic mocked IPC fixture; production contains no mock fallback. The new suite uses controlled promises, trusted `page.keyboard`/pointer input, visible focus/selection assertions and real rendered geometry. It fails the run if any probe fails. Native smoke setup is documented in its header; it reads real Rust filesystem listings, creates disposable fixtures, restores permissions and removes fixtures on exit.

Ignored artifacts in `test-results/` include:

- `slice-001-second-baseline.json`, `slice-001-second-original-hardening.json`, `slice-001-second-hardening.json`: final 35/95/105 browser assertion reports.
- `slice-001-second-before-probes.json`, `slice-001-second-before-regressions.txt`: original reproductions and failing pre-fix regression results.
- `slice-001-second-after-probes.json`: repeated exact reproductions and the 18-case layout matrix after correction.
- `slice-001-second-errors-50.png`, `-30.png`, `-70.png`: inspected minimum-size equal/unequal layouts with collapsed errors and usable list/footer.
- `slice-001-second-error-details.png`: full internally scrolling error details at minimum size.
- `slice-001-second-native.json`, `slice-001-second-native-responsive.json`, `slice-001-second-native-min-50.png`, `-30.png`, `-70.png`: real native results and inspected minimum-size screenshots.
- `second-ui-check.log`, `second-ui-build.log`, `second-rust-fmt.log`, `second-rust-clippy.log`, `second-rust-test.log`, `second-native-build.log`, `second-svelte-analyzer.log`: exact quality-gate output.

## Critical self-review and remaining risks

No new P0/P1/P2 defect is known in the exercised scope. The full previous renderer/hardening suites remain passing; their assertions were preserved. The new suite catches the original four defects and additionally guards stale Retry results and rapid error-detail closing. No generic state framework, resize observer, global focus tracker, frontend filesystem operation or new dependency was added.

Byte comparisons against the independent review's pre-hardening source snapshot confirmed 11 core/adapter/config/shared/shell/dependency files remain identical. The production diff is limited to the pane component; test and documentation changes support the four fixes.

- Only `x86_64-unknown-linux-gnu` is installed. Windows/macOS compilation, native roots/UNC paths, keyboard delivery and packaging were not executed. No cross-platform verification is claimed.
- Trusted keyboard behavior is verified in Chromium. Native tests use DOM-dispatched/focused controls, plus real OS window resizing; they do not establish native OS keyboard event delivery or screen-reader behavior.
- WSLg reports EGL/DRI hardware-access warnings but renders successfully. Hardware acceleration, release installers/signing and the existing bundle-identifier warning remain packaging/release QA.
- Directory enumeration/metadata and whole-list IPC still cost O(n); sorting is O(n log n). Superseded workers finish in the background. These pre-existing performance limits are unchanged.
- Full error details intentionally overlay the pane until closed; the bounded collapsed banner retains the list/footer. Native operating-system input and assistive-technology QA remain appropriate before release.

Recommendation: request another independent read-only Slice 001 acceptance review. Keep Slice 001.5/002 out of scope until acceptance.

## Application rename verification — 2026-11-05

The application is now QPanes: package/executable `qpanes`, Rust core `qpanes-core`, desktop library `qpanes_lib`, identifier `io.qpanes.app`, and review skill `qpanes-slice-review`. UI text, tests, environment-variable names, lockfiles, crate/skill directories and documentation references were updated together. Historical command examples use the current names; the checkout directory name is independent.

`mise run ui-check`, `ui-build`, `rust-fmt`, `rust-clippy` and `rust-test` passed, including all 12 Rust tests. The official Svelte analyzer reported no issues. The native debug build passed; the three existing renderer suites passed 35/95/105 checks and the native smoke suite passed 32 checks using `QPANES_INSPECTOR`. Actual native IPC confirmed `qpanes` and `io.qpanes.app`; the rendered heading/title use QPanes. Source/path searches found no outdated project name. Windows/macOS were not executed.

This was a naming-only change. Existing independent-review findings remain open; these results do not grant Slice 001 acceptance. Existing uncommitted work and the already-updated Git origin were preserved. No commit, push or merge was performed.
