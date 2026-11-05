---
name: qpane-slice-review
description: Verify a QPane desktop-app implementation slice before marking a Codex GOAL complete or merging. Use after implementation or when asked for a QPane quality gate, acceptance review, or cross-platform risk assessment; do not use for initial brainstorming.
---

# QPane slice quality gate

1. Read root `AGENTS.md`, `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, and the current slice specification. Extract each acceptance criterion.
2. Inspect the diff against the approved plan, and flag out-of-scope code or excessive dependencies.
3. Review Rust: error handling, filesystem boundaries, symlinks, path encoding, blocking I/O, independent testability, native-platform assumptions, and no accidental destructive behavior.
4. Review Svelte: component responsibility, proper Svelte 5 reactivity, keyboard focus, selection state, error/empty/loading states, and layout. When available run Svelte MCP autofixer and inspect results.
5. Run each appropriate configured `mise` verification task; save exact commands and pass/fail. Do not claim tests that were not executed.
6. For UI behavior, explicitly separate browser tests with mocked Tauri IPC from actual Tauri desktop tests; request manual checks if the desktop cannot be driven in this environment.
7. Produce a terse report with: PASS/FAIL/UNVERIFIED for each criterion; most serious bugs first; commands executed; evidence; release blockers; and whether to merge.
8. Do not automatically commit, merge, or close the Goal if any critical acceptance criterion is unverified or failing.
