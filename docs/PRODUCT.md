# QPanes — Product definition (v0)

## Vision
A fast, minimal, keyboard-first, cross-platform dual-pane file manager for developers and power users. Modern desktop UX without giving up precise filesystem controls.

## Product promises
- A real desktop application, built with Tauri 2, not a hosted website.
- Independent left and right panels, fast keyboard navigation, predictable file operations.
- Core filesystem behavior implemented in Rust; frontend implemented in Svelte 5/TypeScript.
- Ships on Windows, Linux, and macOS; WSL is the initial development environment, not the sole production platform.
- Lightweight bundle, fast startup, readable design, and accessible keyboard interaction.
- Extensible enough for a later integrated terminal and optional AI/MCP control, without implementing them in the MVP.

## MVP scope
A read-only local filesystem browser with two independent panes. After that, safe file operations and progress/error handling.

## Out of scope for Slice 001
- File creation, rename, deletion, copy or move
- Shell/terminal, AI, MCP, remote storage, plugins, archive browsing
- Theme customization, tabbed panels, advanced search, Windows shell integration

## Design principles
- Work like a familiar dual-pane file manager, look like a new product.
- Every important interaction should be keyboard-accessible.
- Clear active panel, selected row, status and error feedback.
- Prefer responsive utility and density over decorative animation.
- Avoid unbounded memory/DOM growth with large directories.
