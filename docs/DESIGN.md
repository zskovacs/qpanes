# QPanes — UI direction

## Character
Modern desktop utility, not a web dashboard. Dense enough for power users, calm enough for daily work. Minimal ornament, strong typography, crisp dividers, excellent keyboard feedback.

## Initial desktop layout
- A compact app chrome (title/toolbar/path area); do not replicate the classic TC chrome pixel-for-pixel.
- Two resizable panels, each with current path, column headers, directory rows, and independent selection.
- Clear visual indication of active panel without requiring a bright background on every row.
- Explicit empty, loading, error, and no-permission states.

## Interaction rules
- Use semantic focus management, visible focus rings, keyboard operation without pointer reliance.
- Support light/dark themes at a later slice; build with design tokens from day 1.
- Use tabular numerals for file sizes and dates; truncate long names gracefully while allowing inspection.
- Do not add gradients, overbuilt animations, or large icon packs to every row by default.

## Slice 001 implementation

- Dark initial palette: charcoal canvas/surfaces, mint active/focus accents, warm folder icons, and muted metadata. Tokens live in `src/lib/app.css`.
- File rows are 32px high, with tabular sizes/dates, inline SVG icons, truncated names and full-name/tooltips. Native screenshot inspection confirmed the same layout in WebKitGTK.
- Compact pane headers and editable paths sit above independent lists; status bars retain counts and selection information. Selected rows stay visible in the inactive pane with a quieter treatment.
- At narrow pane widths, type and then date columns collapse to retain useful filenames. A compact keyboard-accessible sort select and direction button replace hidden headers. The footer's selection-details control (also Alt+Enter) exposes the full name, type, exact size and modification timestamp at every width. The supported native minimum window is 720×420, including unequal 30–70% splits.
- The split is limited to 30–70%; arrow keys resize and Home or double-click resets to equal widths. Initial focus is assigned after SvelteKit navigation completes.
- `[..]` is a virtual up-navigation row above all real entries when a native parent exists. It has an up icon and navigation label, and participates in ordinary keyboard selection. It is distinct from a real file named `[..]`. Returning to a parent restores and reveals the directory just exited.
- Retry focus moves immediately to the pane before its error banner disappears; request completion never refocuses controls.
