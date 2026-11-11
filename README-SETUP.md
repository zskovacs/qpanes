# QPanes agent setup — Codex and Claude Code

For an existing checkout, use the agent setup below. The starter-kit extraction
instructions apply only when bootstrapping another generated project.

## Claude Code

Start `claude` in the repository root after installing the project toolchains.
`CLAUDE.md` imports the shared `AGENTS.md`; `.claude/skills/` exposes the three
repository skills without symlinks or duplicate workflow bodies. Relative links
in a shared skill resolve from its `.agents/skills/<name>/` directory.

Install the official Svelte plugin inside a Claude session:

```text
/plugin marketplace add sveltejs/ai-tools
/plugin install svelte
```

The plugin supplies Svelte documentation, skills, the autofixer and a specialized
editing agent. Use Context7 and Playwright through their CLIs and skills. For
Context7 authentication or quota limits, use `ctx7 login`; keep credentials in
the CLI's local configuration.

The repository skills should appear as `/playwright-cli`, `/qpanes-slice-review`
and `/web-design-guidelines` in Claude's command menu. Restart an existing session
after adding these files so its project instructions and tools are reloaded.

Install CLI tools if they are missing:

```bash
npm install -g ctx7 @playwright/cli
playwright-cli --help
```

Use the Playwright browser-install flow if it reports a missing browser. Both
`npx` and the installed CLIs must be available on the PATH of the terminal that
starts Claude. Under WSL use the Linux Node/Claude installations.

Superpowers and other user-installed Codex plugins are not automatically shared
with Claude. When a slice requires Superpowers, install its Claude version inside
a Claude session, then restart the session:

```text
/plugin install superpowers@claude-plugins-official
```

Claude uses its own task/plan tracking for an approved implementation; the Codex
GOAL commands below apply only to Codex. Slice-specific user authorizations still
take precedence. No global agent settings or hooks need to be copied into this
repository.

Configuration references: [Claude memory imports](https://code.claude.com/docs/en/memory#import-additional-files),
[Claude skills](https://code.claude.com/docs/en/skills),
[Svelte plugin](https://svelte.dev/docs/ai/claude-plugin),
[Context7](https://context7.com/docs/installation),
[Playwright CLI](https://github.com/microsoft/playwright-cli), and
[Superpowers installation](https://github.com/obra/superpowers#claude-code).

## Original Codex starter kit

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
- Playwright CLI and the UI audit skill are already shared in `.agents/skills/`; Claude entrypoints are in `.claude/skills/`. No separate skill installation is needed for this checkout.
- Context7 CLI: install `ctx7` if missing and use the installed documentation skill. Run `ctx7 login` for authentication or higher rate limits.

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
