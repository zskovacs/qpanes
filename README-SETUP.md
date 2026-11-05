# QPanes Codex starter kit

These files are intended to be copied into the ROOT of an ALREADY GENERATED Tauri + Svelte project. They contain no application code and do not presume access to your local repository.

## Copy safely

1. Download the ZIP and copy it to the host or WSL filesystem.
2. At your QPanes repository root, extract without overwriting existing files:

   unzip -n /path/to/qpanes-codex-kit.zip -d .

3. Inspect the files before trusting the repository with Codex. If you already have an AGENTS.md, mise.toml or `.codex/config.toml`, manually merge them rather than overwriting.
4. If you already created a `mise.toml` or other project toolchain file, compare versions and tasks before adopting this one.
5. The source template may be SvelteKit-based: keep its existing structure and static adapter; do not migrate just to force a pure-Vite architecture.

## External tools to configure yourself

- Official Svelte Codex plugin: `codex plugin marketplace add sveltejs/ai-tools`, then `codex` → `/plugins` → install `svelte`.
- Superpowers: already installed? Check `ls -la ~/.agents/skills/superpowers`. Otherwise see https://github.com/obra/superpowers/blob/main/.codex/INSTALL.md
- Optional UI audit skill: `npx skills add vercel-labs/agent-skills --skill web-design-guidelines -a codex`
- Context7 and Playwright MCP: supplied in `.codex/config.toml`, installed on use via `npx`. Review trust and network prompts. Use `codex mcp list` to verify.

## First-run verification

   mise install
   pnpm install
   mise run ui-build
   mise run rust-fmt
   mise run rust-clippy
   mise run rust-test
   mise run dev

You may need Tauri's Linux system dependencies (WebKitGTK 4.1 etc.) before `mise run dev` succeeds. The initial Rust build might require package download/network authorization.

## First Codex pass: project reconnaissance (normal prompt, NOT GOAL)

Inspect the generated project and all QPanes instruction/docs files. Verify which Svelte/SvelteKit setup the scaffold actually generated, the package scripts, Tauri app identifier, pnpm and Rust toolchains, and that mise tasks match the installed project. Identify platform-specific blockers under WSLg. Do not implement product features or migrate frameworks. Make minimal corrections to the setup files, document verified results, then stop.

## Second Codex pass: design (normal prompt, NOT GOAL)

Use Superpowers brainstorming and writing-plans to design `docs/slices/001-readonly-dual-pane.md`. Inspect the current code and product spec first. Present only real open decisions; do not ask about facts in the repo. Create a reviewable, testable plan and get explicit approval before modifying product code.

## Third pass: implementation (GOAL)

Once the plan is approved, copy `docs/slices/001-goal.txt` into a Codex thread. Pause with `/goal pause`; resume with `/goal resume`; clear with `/goal clear` when appropriate.

## Shipping discipline

Git-commit the approved spec/plan before implementation. Use a branch or Git worktree per slice. Never test mutations on real user files. A passing Linux build does not prove a native Windows app behaves identically. Do not auto-merge based only on a successful Goal.
