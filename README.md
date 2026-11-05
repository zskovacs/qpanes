# QPanes

A keyboard-first, read-only dual-pane desktop file manager, built with Tauri 2, SvelteKit/Svelte 5, TypeScript and Rust.

Both panes browse real local directories independently, with metadata, sorting, editable paths, selection and resizable widths. The initial theme is dark. File mutations, file launching, terminals, remote filesystems, plugins and AI/MCP are outside Slice 001.

The display name is **QPanes**; the package and executable are `qpanes`, the reusable Rust crate is `qpanes-core`, and the desktop library is `qpanes_lib`. The Tauri application identifier is `io.qpanes.app`, which also determines its application-specific storage directories. The checkout directory name is independent of these application names.

## Develop and verify

Install the toolchains and platform prerequisites described in [README-SETUP.md](README-SETUP.md), then run `pnpm install --frozen-lockfile` and `mise run dev`.

- `mise run ui-check` — Svelte and TypeScript diagnostics.
- `mise run ui-build` — static frontend build.
- `mise run rust-fmt`, `mise run rust-clippy`, `mise run rust-test` — check both Rust crates.
- `pnpm tauri build --debug --no-bundle` — build the native application without installers.

Tab switches panels from the list. Arrows select, Enter opens folders or `[..]`, Backspace goes to the parent, and Ctrl/Cmd+L edits the active path. Returning to a parent selects the folder just exited. Shift+Tab reaches toolbar controls. Home/End and Page Up/Down navigate large lists. Focus the divider and use Left/Right to resize, or drag it. Narrow panes retain all sort keys through a compact select; Alt+Enter or the footer details control exposes complete selected metadata.

See [Slice 001](docs/slices/001-readonly-dual-pane.md) for scope, [current acceptance status](docs/slices/001-acceptance-status.md) for the remaining review findings, and the [second hardening verification report](docs/slices/001-second-hardening-verification.md) for test reproduction and platform limits. Slice 001 is not yet accepted.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).

## Repository conventions

Commit source files, documentation, shared settings, and both `pnpm-lock.yaml` and
`src-tauri/Cargo.lock`. Build output, dependencies, local credentials, environment
files, and browser test artifacts are ignored. Only placeholder values belong in
tracked `.env.example` or `.env.*.example` files.

Project instructions and skills in `AGENTS.md` and `.agents/` are shared. Local
Codex configuration in `.codex/` stays on the developer's machine.
`.gitattributes` keeps text line endings consistent across platforms, and
`.editorconfig` defines the common editor defaults.
