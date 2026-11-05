# QPane — UI direction

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

## Deferred decisions
Detailed colors, spacing scale, iconography, and density settings should be settled after an early screenshot/mockup of the dual-panel layout. Record the decision here when agreed.
