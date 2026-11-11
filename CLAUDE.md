# QPanes — Claude Code

@AGENTS.md

`AGENTS.md` is the shared project policy for Codex and Claude Code. Read the
product, architecture, roadmap and active slice documents it names before
significant work. Honor explicit user authorization and slice-specific workflow
exceptions already recorded there.

## Tools

- Svelte: use the official Svelte Claude Code plugin for documentation, skills
  and `svelte-autofixer`. For Svelte work,
  discover relevant sections with `list-sections`, fetch them with
  `get-documentation`, and run the autofixer on changed components/modules until
  reported issues are resolved. Report any remaining limitations.
- Context7: use the installed `ctx7` CLI and documentation skill as requested in
  `AGENTS.md`; resolve a library with `ctx7 library` before fetching its docs with
  `ctx7 docs`.
- Playwright: use the installed `playwright-cli` and its project skill. Browser
  checks with mocked Tauri IPC do not establish native desktop behavior.

Use Claude Code's native tools and task/plan tracking. References to Codex GOAL
mean implementation against the approved slice with verified acceptance criteria;
they do not require running Codex commands in Claude Code. Install Superpowers
separately for Claude Code when the slice calls for it; see `README-SETUP.md`.

## Skills

Claude discovers the project skills under `.claude/skills/`. These entrypoints
delegate to the shared instructions in `.agents/skills/`; read the referenced
`SKILL.md` before following the workflow and resolve its relative references from
that shared skill's directory. Maintain the workflow there, keeping each Claude
entrypoint's name and description consistent with it.

Available project skills: `playwright-cli`, `qpanes-slice-review`, and
`web-design-guidelines`. Setup and verification commands are in `README-SETUP.md`.
