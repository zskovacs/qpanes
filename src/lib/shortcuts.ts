/**
 * Centralized keyboard shortcut definitions, validation and resolution.
 * Pure module: no DOM, IPC or Svelte state, so it can be tested directly.
 *
 * Combos are canonical strings: modifiers in the fixed order Ctrl, Alt, Shift,
 * Meta, then one key (`Ctrl+Shift+Tab`, `Shift+Meta+W`, `F5`). Modifiers are
 * physical keys; on macOS `Meta` is ⌘ and `Ctrl` is the Control key.
 */
export type Platform = 'mac' | 'other';
export type ShortcutAction =
  | 'copy' | 'move' | 'createDirectory' | 'rename' | 'trash'
  | 'newTab' | 'closeTab' | 'nextTab' | 'previousTab'
  | 'quickFilter' | 'addFavorite' | 'openFavorites' | 'openShortcuts';
export type Bindings = Record<ShortcutAction, string>;
export interface ShortcutDefinition { action: ShortcutAction; label: string; group: 'Files' | 'Tabs' | 'Navigation'; repeatable: boolean }
export interface KeyCombo { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string }
export interface KeyEventLike { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
export interface ShortcutProblem { kind: 'invalid' | 'reserved' | 'conflict'; message: string; action?: ShortcutAction }

export const shortcutDefinitions: readonly ShortcutDefinition[] = [
  { action: 'copy', label: 'Copy', group: 'Files', repeatable: false },
  { action: 'move', label: 'Move', group: 'Files', repeatable: false },
  { action: 'createDirectory', label: 'New folder', group: 'Files', repeatable: false },
  { action: 'rename', label: 'Rename', group: 'Files', repeatable: false },
  { action: 'trash', label: 'Move to Trash', group: 'Files', repeatable: false },
  { action: 'newTab', label: 'New tab', group: 'Tabs', repeatable: false },
  { action: 'closeTab', label: 'Close tab', group: 'Tabs', repeatable: false },
  { action: 'nextTab', label: 'Next tab', group: 'Tabs', repeatable: true },
  { action: 'previousTab', label: 'Previous tab', group: 'Tabs', repeatable: true },
  { action: 'quickFilter', label: 'Quick Filter', group: 'Navigation', repeatable: false },
  { action: 'addFavorite', label: 'Add folder to Favorites', group: 'Navigation', repeatable: false },
  { action: 'openFavorites', label: 'Open Favorites', group: 'Navigation', repeatable: false },
  { action: 'openShortcuts', label: 'Keyboard shortcuts', group: 'Navigation', repeatable: false },
];
const actions = new Set<string>(shortcutDefinitions.map((definition) => definition.action));
export const isShortcutAction = (value: string): value is ShortcutAction => actions.has(value);

const defaults: Record<Platform, Bindings> = {
  other: {
    copy: 'F5', move: 'F6', createDirectory: 'F7', rename: 'F2', trash: 'Delete',
    newTab: 'Ctrl+T', closeTab: 'Ctrl+W', nextTab: 'Ctrl+Tab', previousTab: 'Ctrl+Shift+Tab',
    quickFilter: 'Ctrl+F', addFavorite: 'Ctrl+D', openFavorites: 'Ctrl+B', openShortcuts: 'Ctrl+,',
  },
  // ⌘W belongs to the native macOS Window ▸ Close Window menu item.
  mac: {
    copy: 'F5', move: 'F6', createDirectory: 'F7', rename: 'F2', trash: 'Delete',
    newTab: 'Meta+T', closeTab: 'Shift+Meta+W', nextTab: 'Ctrl+Tab', previousTab: 'Ctrl+Shift+Tab',
    quickFilter: 'Meta+F', addFavorite: 'Meta+D', openFavorites: 'Meta+B', openShortcuts: 'Meta+,',
  },
};
export const defaultBindings = (platform: Platform): Bindings => ({ ...defaults[platform] });

export function detectPlatform(userAgent = globalThis.navigator?.userAgent ?? ''): Platform {
  return /Macintosh|Mac OS X/.test(userAgent) ? 'mac' : 'other';
}

const modifierKeys = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'NumLock', 'ScrollLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock', 'OS']);
const punctuationCodes: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
};
const punctuation = new Set(Object.values(punctuationCodes));
const functionKeys = Array.from({ length: 24 }, (_, index) => `F${index + 1}`);
/** Fundamental navigation keys stay fixed in the list, dialogs and focus traversal. */
const navigationKeys = new Set(['Enter', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space']);
const namedKeys = new Set([...functionKeys, 'Delete', 'Insert', 'Tab', ...navigationKeys]);
const printable = (key: string) => /^[A-Z0-9]$/.test(key) || punctuation.has(key);

/**
 * The key a user means, independent of Shift/Option/AltGr character variants.
 * ASCII letters/digits use `key` so non-QWERTY Latin layouts keep their labels;
 * other characters (Cyrillic, ⌥-symbols, shifted digits/punctuation) fall back
 * to the physical `code`.
 */
export function normalizeKey(key: string, code = ''): string | null {
  if (!key || modifierKeys.has(key) || key === 'Dead' || key === 'Process') return null;
  // WebKitGTK reports e.g. Shift+Tab (keysym ISO_Left_Tab) as "Unidentified";
  // the physical code still identifies the key.
  if (key === 'Unidentified') {
    if (namedKeys.has(code)) return code;
    return /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1] ?? punctuationCodes[code] ?? null;
  }
  if (key === ' ' || key === 'Spacebar') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key === 'Del') return 'Delete';
  if ([...key].length === 1) {
    const upper = key.toUpperCase();
    if (/^[A-Z0-9]$/.test(upper)) return upper;
    if (punctuation.has(key)) return key;
    return /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1] ?? punctuationCodes[code] ?? null;
  }
  return namedKeys.has(key) ? key : null;
}

export function canonicalCombo(combo: KeyCombo): string {
  return [combo.ctrl && 'Ctrl', combo.alt && 'Alt', combo.shift && 'Shift', combo.meta && 'Meta', combo.key].filter(Boolean).join('+');
}

/** `null` for modifier-only presses and keys that can never be shortcuts. */
export function comboFromEvent(event: KeyEventLike): string | null {
  const key = normalizeKey(event.key, event.code);
  if (!key) return null;
  return canonicalCombo({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey, key });
}

export function parseCombo(text: unknown): KeyCombo | null {
  if (typeof text !== 'string' || !text || text.length > 64) return null;
  const parts = text.split('+');
  const key = parts.pop()!;
  if (!key || !(namedKeys.has(key) || printable(key))) return null;
  const has = (name: string) => parts.includes(name);
  const combo = { ctrl: has('Ctrl'), alt: has('Alt'), shift: has('Shift'), meta: has('Meta'), key };
  // Rejects unknown, repeated and out-of-order modifiers.
  return canonicalCombo(combo) === text ? combo : null;
}

const macReserved = new Set([
  'Meta+Q', 'Meta+W', 'Meta+H', 'Alt+Meta+H', 'Meta+M', 'Meta+`', 'Ctrl+Meta+F', 'Ctrl+Meta+Q',
  'Shift+Meta+3', 'Shift+Meta+4', 'Shift+Meta+5', 'Meta+C', 'Meta+V', 'Meta+X', 'Meta+A', 'Meta+Z', 'Shift+Meta+Z',
]);

/** Validation independent of other bindings. Conflicts are checked separately. */
export function validateCombo(text: string, platform: Platform): ShortcutProblem | null {
  const combo = parseCombo(text);
  if (!combo) return { kind: 'invalid', message: 'This key cannot be used as a shortcut.' };
  const { ctrl, alt, meta, key } = combo;
  if (navigationKeys.has(key)) return { kind: 'reserved', message: `${keyName(key, platform)} is reserved for list navigation and dialogs.` };
  if (key === 'L' && (ctrl || meta)) return { kind: 'reserved', message: `${formatCombo(platform === 'mac' ? 'Meta+L' : 'Ctrl+L', platform)} edits the panel path.` };
  if (key === 'Tab' && (!ctrl || alt || meta)) return { kind: 'reserved', message: 'Tab moves focus; only Ctrl+Tab combinations can be assigned.' };
  if (platform === 'mac' && macReserved.has(text)) return { kind: 'reserved', message: `${formatCombo(text, platform)} belongs to the macOS application menu or system.` };
  if (platform === 'other') {
    if (meta) return { kind: 'reserved', message: 'Combinations with the Windows/Super key belong to the operating system.' };
    if ((alt && key === 'F4') || (ctrl && alt && (key === 'Delete' || /^F([1-9]|1[0-2])$/.test(key)))) {
      return { kind: 'reserved', message: `${formatCombo(text, platform)} belongs to the operating system.` };
    }
  }
  if (printable(key) && !ctrl && !alt && !meta) {
    return { kind: 'invalid', message: `Add ${platform === 'mac' ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'} so typing is never captured.` };
  }
  return null;
}

export function findConflict(bindings: Bindings, action: ShortcutAction, combo: string): ShortcutAction | null {
  for (const definition of shortcutDefinitions) {
    if (definition.action !== action && bindings[definition.action] === combo) return definition.action;
  }
  return null;
}

/** Full check for assigning `combo` to `action`. */
export function checkAssignment(bindings: Bindings, action: ShortcutAction, combo: string, platform: Platform): ShortcutProblem | null {
  const problem = validateCombo(combo, platform);
  if (problem) return problem;
  const other = findConflict(bindings, action, combo);
  return other ? { kind: 'conflict', action: other, message: `${formatCombo(combo, platform)} is already used by ${labelOf(other)}.` } : null;
}

export const labelOf = (action: ShortcutAction) => shortcutDefinitions.find((definition) => definition.action === action)!.label;

const storable = /^[\x21-\x7e]{1,64}$/;

/**
 * Persisted overrides are untrusted. Unknown actions and invalid, reserved or
 * conflicting combinations fall back to defaults individually.
 */
export function resolveBindings(overrides: Record<string, unknown> | null | undefined, platform: Platform): { bindings: Bindings; warnings: string[]; preserved: Record<string, string> } {
  const bindings = defaultBindings(platform);
  const warnings: string[] = [];
  // Actions from another QPanes version are kept verbatim so saving never deletes them.
  // Collected as entries: assigning a key such as `__proto__` on a plain object
  // would invoke its prototype setter instead of storing the entry.
  const kept: [string, string][] = [];
  const custom = new Set<ShortcutAction>();
  for (const [action, combo] of Object.entries(overrides ?? {})) {
    if (!isShortcutAction(action)) {
      // Only entries Rust's strict save accepts (1–64 printable ASCII characters).
      // Rust already bounds a loaded map to 64 entries, so all of them fit;
      // new overrides are refused at assignment if they would exceed it.
      if (typeof combo === 'string' && storable.test(action) && storable.test(combo)) kept.push([action, combo]);
      warnings.push(`Shortcut action “${action.slice(0, 40)}” is not used by this version; it is kept unchanged.`);
      continue;
    }
    if (typeof combo !== 'string' || validateCombo(combo, platform)) { warnings.push(`The saved shortcut for ${labelOf(action)} is not valid here; the default is used.`); continue; }
    bindings[action] = combo;
    custom.add(action);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const action of custom) {
      const other = findConflict(bindings, action, bindings[action]);
      if (!other) continue;
      // Restore the custom side of the conflict; defaults never conflict.
      const restore = custom.has(other) && !custom.has(action) ? other : action;
      bindings[restore] = defaults[platform][restore];
      custom.delete(restore);
      warnings.push(`The saved shortcut for ${labelOf(restore)} conflicted with ${labelOf(restore === action ? other : action)}; the default is used.`);
      changed = true;
      break;
    }
  }
  // Object.fromEntries defines own data properties, including `__proto__`.
  return { bindings, warnings, preserved: Object.fromEntries(kept) };
}

/** Rust's strict save accepts at most this many shortcut entries. */
export const MAX_SHORTCUT_ENTRIES = 64;

/** The persisted map: other versions' entries plus this version's overrides. */
export function persistedShortcuts(preserved: Record<string, string>, bindings: Bindings, platform: Platform): Record<string, string> {
  return { ...preserved, ...overridesOf(bindings, platform) };
}

/** Only persist differences from the platform defaults. */
export function overridesOf(bindings: Bindings, platform: Platform): Record<string, string> {
  const result: Record<string, string> = {};
  for (const definition of shortcutDefinitions) {
    if (bindings[definition.action] !== defaults[platform][definition.action]) result[definition.action] = bindings[definition.action];
  }
  return result;
}

export function actionFor(bindings: Bindings, combo: string | null): ShortcutAction | null {
  if (!combo) return null;
  return shortcutDefinitions.find((definition) => bindings[definition.action] === combo)?.action ?? null;
}

export const isRepeatable = (action: ShortcutAction) => shortcutDefinitions.some((definition) => definition.action === action && definition.repeatable);

const keyLabels: Record<string, string> = {
  Delete: 'Del', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn', Escape: 'Esc', Insert: 'Ins',
};
function keyName(key: string, platform: Platform) {
  if (platform === 'mac' && key === 'Backspace') return '⌫';
  return keyLabels[key] ?? key;
}

export function formatCombo(text: string, platform: Platform): string {
  const combo = parseCombo(text);
  if (!combo) return text;
  const key = keyName(combo.key, platform);
  if (platform === 'mac') return `${combo.ctrl ? '⌃' : ''}${combo.alt ? '⌥' : ''}${combo.shift ? '⇧' : ''}${combo.meta ? '⌘' : ''}${key}`;
  return [combo.ctrl && 'Ctrl', combo.alt && 'Alt', combo.shift && 'Shift', key].filter(Boolean).join('+');
}

/**
 * WebView defaults that would reload, open browser find/print UI or toggle caret
 * browsing. They are suppressed even where shortcuts are not dispatched.
 */
export function suppressesWebviewDefault(text: string | null, platform: Platform): boolean {
  const combo = parseCombo(text);
  if (!combo) return false;
  // Every F5 variant and Ctrl/⌘(+Shift)+R can reload the renderer.
  if (combo.key === 'F5') return true;
  if ((combo.key === 'F3' || combo.key === 'F7') && !combo.ctrl && !combo.meta && !combo.alt) return true;
  const primary = platform === 'mac' ? combo.meta && !combo.ctrl : combo.ctrl && !combo.meta;
  return primary && !combo.alt && ['F', 'G', 'P', 'R'].includes(combo.key);
}
