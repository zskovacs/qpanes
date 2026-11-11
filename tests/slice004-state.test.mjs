import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionFor, checkAssignment, comboFromEvent, defaultBindings, detectPlatform, formatCombo, isRepeatable, MAX_SHORTCUT_ENTRIES, normalizeKey,
  overridesOf, parseCombo, persistedShortcuts, resolveBindings, shortcutDefinitions, suppressesWebviewDefault, validateCombo,
} from '../src/lib/shortcuts.ts';
import { filterKey, matchesFilter, matchingIndices } from '../src/lib/filter.ts';
import { cycleIndex, indexAfterClose, MAX_TABS, restorePanel, tabLabel } from '../src/lib/tabs.ts';
import { addFavorite, cleanLabel, MAX_FAVORITES, removeFavorite, renameFavorite } from '../src/lib/favorites.ts';
import { createSettingsWriter, loadSettings } from '../src/lib/settings.ts';

const event = (key, options = {}) => ({ key, code: options.code ?? '', ctrlKey: !!options.ctrl, altKey: !!options.alt, shiftKey: !!options.shift, metaKey: !!options.meta });

test('default bindings are valid, unique and preserve existing F-key behavior on both platforms', () => {
  for (const platform of ['other', 'mac']) {
    const bindings = defaultBindings(platform);
    const combos = Object.values(bindings);
    assert.equal(new Set(combos).size, combos.length, `${platform} defaults are conflict-free`);
    for (const [action, combo] of Object.entries(bindings)) assert.equal(validateCombo(combo, platform), null, `${platform} ${action} ${combo}`);
    assert.deepEqual([bindings.copy, bindings.move, bindings.createDirectory, bindings.rename, bindings.trash], ['F5', 'F6', 'F7', 'F2', 'Delete']);
    assert.equal(Object.keys(bindings).length, shortcutDefinitions.length);
  }
  assert.equal(defaultBindings('other').newTab, 'Ctrl+T');
  assert.equal(defaultBindings('other').closeTab, 'Ctrl+W');
  assert.equal(defaultBindings('mac').newTab, 'Meta+T');
  assert.equal(defaultBindings('mac').closeTab, 'Shift+Meta+W', '⌘W is owned by the native macOS Close Window menu item');
  assert.equal(defaultBindings('mac').nextTab, 'Ctrl+Tab', 'macOS tab cycling uses the physical Control key');
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'mac');
  assert.equal(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)'), 'other');
});

test('key events canonicalize across Shift, layouts, Option symbols and modifier-only presses', () => {
  assert.equal(comboFromEvent(event('t', { ctrl: true, code: 'KeyT' })), 'Ctrl+T');
  assert.equal(comboFromEvent(event('T', { ctrl: true, shift: true, code: 'KeyT' })), 'Ctrl+Shift+T');
  assert.equal(comboFromEvent(event('е', { ctrl: true, code: 'KeyT' })), 'Ctrl+T', 'Cyrillic layout falls back to the physical key');
  assert.equal(comboFromEvent(event('†', { alt: true, meta: true, code: 'KeyT' })), 'Alt+Meta+T', 'macOS Option characters fall back to the physical key');
  assert.equal(comboFromEvent(event('q', { ctrl: true, code: 'KeyA' })), 'Ctrl+Q', 'AZERTY keeps the label the user sees');
  assert.equal(comboFromEvent(event('!', { ctrl: true, shift: true, code: 'Digit1' })), 'Ctrl+Shift+1');
  assert.equal(comboFromEvent(event('<', { ctrl: true, shift: true, code: 'Comma' })), 'Ctrl+Shift+,');
  assert.equal(comboFromEvent(event('Tab', { ctrl: true, shift: true })), 'Ctrl+Shift+Tab');
  assert.equal(comboFromEvent(event(' ')), 'Space');
  // WebKitGTK reports Shift+Tab (X keysym ISO_Left_Tab) as key "Unidentified" with code "Tab".
  assert.equal(comboFromEvent(event('Unidentified', { ctrl: true, shift: true, code: 'Tab' })), 'Ctrl+Shift+Tab', 'native WebKitGTK Ctrl+Shift+Tab resolves through the physical code');
  assert.equal(comboFromEvent(event('Unidentified', { code: 'F5' })), 'F5');
  assert.equal(comboFromEvent(event('Unidentified', { ctrl: true, code: 'KeyT' })), 'Ctrl+T');
  assert.equal(comboFromEvent(event('Unidentified', { code: 'IntlRo' })), null, 'unknown physical keys stay unbindable');
  for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified', 'Process', '']) assert.equal(comboFromEvent(event(key)), null, key);
  assert.equal(normalizeKey('é', ''), null, 'non-ASCII characters without a physical fallback cannot be bound');
  assert.equal(parseCombo('Shift+Ctrl+T'), null, 'modifier order is canonical');
  assert.equal(parseCombo('Ctrl+Ctrl+T'), null);
  assert.equal(parseCombo('Hyper+T'), null);
  assert.equal(parseCombo('Ctrl+'), null);
  assert.deepEqual(parseCombo('Ctrl+Alt+Shift+Meta+F12'), { ctrl: true, alt: true, shift: true, meta: true, key: 'F12' });
});

test('validation rejects typing keys, navigation keys and platform-reserved combinations', () => {
  const problem = (combo, platform = 'other') => validateCombo(combo, platform)?.kind ?? null;
  assert.equal(problem('T'), 'invalid', 'bare letters would capture typing');
  assert.equal(problem('Shift+T'), 'invalid');
  assert.equal(problem('Alt+T'), null);
  assert.equal(problem('F9'), null);
  assert.equal(problem('Shift+F6'), null);
  assert.equal(problem('Insert'), null);
  for (const combo of ['Enter', 'Alt+Enter', 'Escape', 'Ctrl+Escape', 'Backspace', 'ArrowUp', 'Shift+ArrowDown', 'Home', 'End', 'PageDown', 'Space', 'Ctrl+Space', 'Tab', 'Shift+Tab', 'Alt+Tab', 'Ctrl+L', 'Ctrl+Shift+L']) {
    assert.equal(problem(combo), 'reserved', combo);
  }
  for (const combo of ['Meta+E', 'Alt+F4', 'Ctrl+Alt+Delete', 'Ctrl+Alt+F2']) assert.equal(problem(combo), 'reserved', combo);
  assert.equal(problem('Ctrl+Alt+F2', 'mac'), null);
  for (const combo of ['Meta+W', 'Meta+Q', 'Meta+H', 'Alt+Meta+H', 'Meta+M', 'Meta+C', 'Meta+V', 'Shift+Meta+Z', 'Ctrl+Meta+F', 'Shift+Meta+4', 'Meta+Tab', 'Meta+L']) {
    assert.equal(problem(combo, 'mac'), 'reserved', combo);
  }
  assert.equal(problem('Ctrl+W', 'mac'), null, 'physical Control+W is free on macOS');
  assert.equal(problem('Meta+T'), 'reserved', 'Super/Windows key combinations are not offered on Windows/Linux');
  assert.equal(problem('Ctrl+Tab'), null);
  assert.equal(problem('Ctrl+Shift+Tab'), null);
});

test('assignments report conflicts by action and persisted overrides fall back individually', () => {
  const bindings = defaultBindings('other');
  assert.deepEqual(checkAssignment(bindings, 'copy', 'Ctrl+T', 'other'), { kind: 'conflict', action: 'newTab', message: 'Ctrl+T is already used by New tab.' });
  assert.equal(checkAssignment(bindings, 'copy', 'F5', 'other'), null, 'reassigning the same key is not a conflict');
  assert.equal(checkAssignment(bindings, 'copy', 'Ctrl+Shift+C', 'other'), null);
  const resolved = resolveBindings({ copy: 'Ctrl+Shift+C', move: 'Ctrl+T', bogus: 'F9', trash: 'Enter', rename: 42, closeTab: 'Ctrl+Shift+W' }, 'other');
  assert.equal(resolved.bindings.copy, 'Ctrl+Shift+C');
  assert.equal(resolved.bindings.move, 'F6', 'override conflicting with a default is dropped');
  assert.equal(resolved.bindings.trash, 'Delete');
  assert.equal(resolved.bindings.rename, 'F2');
  assert.equal(resolved.bindings.closeTab, 'Ctrl+Shift+W');
  assert.equal(resolved.warnings.length, 4, resolved.warnings.join('\n'));
  const mutual = resolveBindings({ copy: 'Ctrl+Shift+X', move: 'Ctrl+Shift+X' }, 'other');
  assert.equal(new Set(Object.values(mutual.bindings)).size, shortcutDefinitions.length, 'two overrides using one combo are reconciled');
  const swapped = resolveBindings({ copy: 'F6', move: 'F5' }, 'other');
  assert.equal(new Set(Object.values(swapped.bindings)).size, shortcutDefinitions.length, 'never yields duplicate bindings');
  assert.deepEqual(resolveBindings(null, 'mac').bindings, defaultBindings('mac'));
  const future = resolveBindings({ futureAction: 'Ctrl+Y', copy: 'Enter', 'bad action': 'F4' }, 'other');
  assert.deepEqual(future.preserved, { futureAction: 'Ctrl+Y' }, 'unknown actions from another version are kept for saving, not deleted');
  const many = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`future${String(i).padStart(2, '0')}`, 'F9']));
  const full = resolveBindings(many, 'other');
  assert.equal(Object.keys(full.preserved).length, 64, 'every stored entry from another version survives the next save');
  assert.equal(Object.keys(persistedShortcuts(full.preserved, full.bindings, 'other')).length, 64);
  assert.equal(Object.keys(persistedShortcuts(full.preserved, { ...full.bindings, copy: 'Ctrl+Shift+C' }, 'other')).length, 65, 'a new override would exceed the limit and must be refused, not silently trimmed');
  assert.equal(MAX_SHORTCUT_ENTRIES, 64);
  // Codex re-review R004-03: object-property names from JSON must stay ordinary entries.
  const special = JSON.parse('{"__proto__":"F9","constructor":"F10","toString":"F11","hasOwnProperty":"F12"}');
  const kept = resolveBindings(special, 'other');
  const savedSpecial = JSON.parse(JSON.stringify(persistedShortcuts(kept.preserved, kept.bindings, 'other')));
  assert.ok(Object.hasOwn(savedSpecial, '__proto__') && savedSpecial.__proto__ === 'F9', 'an unknown __proto__ entry survives load and save');
  assert.deepEqual(Object.keys(savedSpecial).sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'toString']);
  assert.deepEqual(overridesOf({ ...defaultBindings('other'), copy: 'Ctrl+Shift+C' }, 'other'), { copy: 'Ctrl+Shift+C' });
  assert.deepEqual(overridesOf(defaultBindings('mac'), 'mac'), {});
});

test('resolution, repeat policy, display and WebView default suppression', () => {
  const bindings = defaultBindings('other');
  assert.equal(actionFor(bindings, 'F5'), 'copy');
  assert.equal(actionFor(bindings, 'Ctrl+Shift+Tab'), 'previousTab');
  assert.equal(actionFor(bindings, 'Shift+F5'), null);
  assert.equal(actionFor(bindings, null), null);
  assert.equal(isRepeatable('nextTab'), true);
  assert.equal(isRepeatable('copy'), false);
  assert.equal(isRepeatable('closeTab'), false, 'holding the key cannot close every tab');
  assert.equal(formatCombo('Ctrl+Shift+Tab', 'other'), 'Ctrl+Shift+Tab');
  assert.equal(formatCombo('Delete', 'other'), 'Del');
  assert.equal(formatCombo('Shift+Meta+W', 'mac'), '⇧⌘W');
  assert.equal(formatCombo('Ctrl+Alt+Shift+Meta+F', 'mac'), '⌃⌥⇧⌘F');
  assert.equal(suppressesWebviewDefault('F5', 'other'), true);
  assert.equal(suppressesWebviewDefault('Ctrl+F', 'other'), true);
  assert.equal(suppressesWebviewDefault('Meta+F', 'mac'), true);
  assert.equal(suppressesWebviewDefault('Ctrl+C', 'other'), false, 'clipboard editing in text fields is untouched');
  for (const combo of ['Shift+F5', 'Ctrl+F5', 'Ctrl+Shift+R']) assert.equal(suppressesWebviewDefault(combo, 'other'), true, `${combo} cannot reload the WebView`);
  assert.equal(suppressesWebviewDefault('Shift+Meta+R', 'mac'), true);
});

test('quick filter policy: case-insensitive, NFC, documented Unicode limits, literal query', () => {
  assert.ok(matchesFilter('README.md', 'readme'));
  assert.ok(matchesFilter('Árvíz.txt', 'árv'));
  assert.ok(matchesFilter('árvíz.txt', 'árvíz'), 'decomposed (NFD) names match composed input');
  assert.ok(matchesFilter('ÁRVÍZ', 'árvíz'));
  assert.ok(matchesFilter('Документ.pdf', 'докум'));
  assert.ok(matchesFilter('ΣΟΦΙΑ', 'σοφ'));
  assert.ok(matchesFilter('crab 🦀 notes', '🦀'));
  assert.ok(matchesFilter('lossy � name', '�'));
  assert.ok(!matchesFilter('Straße', 'strasse'), 'no full case folding (ß ≠ ss)');
  assert.ok(!matchesFilter('cafe', 'café'), 'accents remain significant');
  assert.ok(matchesFilter('my file.txt', 'y f'));
  assert.ok(!matchesFilter('myfile.txt', 'y f'), 'query is literal');
  assert.ok(matchesFilter('anything', ''));
  assert.equal(filterKey('İ').includes('i'), true, 'default (non-Turkish) mapping is used');
});

test('filtering 10,000 precomputed names stays well within an interactive budget', () => {
  const names = Array.from({ length: 10_000 }, (_, index) => `File ${String(index).padStart(5, '0')} ${index % 7 === 0 ? 'Report' : 'data'}.txt`);
  let started = performance.now();
  const keys = names.map(filterKey);
  const keying = performance.now() - started;
  const samples = [];
  for (const query of ['r', 're', 'rep', 'repo', 'report', '0999', 'zzz']) {
    started = performance.now();
    const result = matchingIndices(keys, query);
    samples.push(performance.now() - started);
    for (let index = 1; index < result.length; index++) assert.ok(result[index] > result[index - 1], 'original sorted order is preserved');
  }
  assert.equal(matchingIndices(keys, 'report').length, Math.ceil(10_000 / 7));
  assert.equal(matchingIndices(keys, 'zzz').length, 0);
  const worst = Math.max(...samples);
  console.log(`10,000 names: key preparation ${keying.toFixed(2)} ms; worst per-keystroke match ${worst.toFixed(2)} ms`);
  assert.ok(worst < 25, `per-keystroke filtering took ${worst} ms`);
});

test('tab helpers wrap, close to a neighbour and restore a bounded valid session', () => {
  assert.equal(cycleIndex(3, 2, 1), 0);
  assert.equal(cycleIndex(3, 0, -1), 2);
  assert.equal(cycleIndex(1, 0, 1), 0);
  assert.equal(indexAfterClose(3, 0), 0, 'right neighbour moves into place');
  assert.equal(indexAfterClose(3, 2), 1, 'last tab falls back to its left neighbour');
  assert.equal(indexAfterClose(1, 0), -1, 'the last remaining tab is never closed');
  const seed = (path, name) => ({ path, location: `/display/${name}`, name, sort: 'size', direction: 'descending' });
  assert.deepEqual(restorePanel(null).tabs.length, 1);
  assert.equal(restorePanel(null).tabs[0].path, null, 'missing session opens home');
  const restored = restorePanel({ activeTab: 5, tabs: [seed('u:61', 'a'), { path: 7 }, seed('u:62', 'b'), { ...seed('u:63', 'c'), sort: 'chaos' }] });
  assert.deepEqual(restored.tabs.map(tabLabel), ['a', 'b']);
  assert.equal(restored.activeTab, 0);
  assert.equal(restorePanel({ activeTab: 1, tabs: [seed('u:61', 'a'), seed('u:62', 'b')] }).activeTab, 1);
  assert.equal(restorePanel({ activeTab: 0, tabs: Array.from({ length: 40 }, (_, i) => seed(`u:${i}`, String(i))) }).tabs.length, MAX_TABS);
  assert.equal(tabLabel({ path: null, location: '', name: '', sort: 'name', direction: 'ascending' }), 'Home');
});

test('favorites detect exact duplicates, clean labels and never rewrite their native target', () => {
  const candidate = { path: 'u:2f70726f6a65637473', location: '/projects', name: 'projects' };
  const first = addFavorite([], candidate, 'id-1');
  assert.equal(first.added, true);
  assert.deepEqual(first.favorite, { id: 'id-1', label: 'projects', path: candidate.path, location: '/projects' });
  const duplicate = addFavorite(first.list, { ...candidate, name: 'other label' }, 'id-2');
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.list.length, 1);
  assert.equal(duplicate.favorite.id, 'id-1');
  assert.equal(addFavorite(first.list, { ...candidate, path: 'u:2f50726f6a65637473' }, 'id-3').added, true, 'identities are exact; no guessed case folding');
  const renamed = renameFavorite(first.list, 'id-1', '  Work\tprojects  ');
  assert.deepEqual(renamed.list[0], { ...first.favorite, label: 'Work projects' });
  assert.equal(renamed.list[0].path, candidate.path);
  assert.deepEqual(renameFavorite(first.list, 'id-1', '   '), { error: 'Enter a name.' });
  assert.ok('error' in renameFavorite(first.list, 'id-1', 'x'.repeat(201)));
  assert.ok('error' in renameFavorite(first.list, 'missing', 'Name'));
  assert.deepEqual(removeFavorite(renamed.list, 'id-1'), []);
  assert.equal(cleanLabel('line\nbreak'), 'line break');
  assert.equal(addFavorite([], { path: 'u:2f', location: '/', name: '' }, 'root').favorite.label, '/', 'roots fall back to their display location');
  const full = Array.from({ length: MAX_FAVORITES }, (_, i) => ({ id: `f${i}`, label: 'x', path: `u:${i}`, location: 'x' }));
  assert.ok('error' in addFavorite(full, candidate, 'overflow'));
});

test('settings writer serializes saves and coalesces bursts into the latest state', async () => {
  const saved = [];
  const releases = [];
  const results = [];
  const writer = createSettingsWriter((document) => new Promise((resolve, reject) => {
    saved.push(document.favorites.length);
    releases.push({ resolve, reject });
  }), (error) => results.push(error === null ? 'ok' : 'error'));
  let state = 1;
  const build = () => ({ version: 1, favorites: Array.from({ length: state }), shortcuts: {}, session: null });
  writer.schedule(build);
  state = 2; writer.schedule(build);
  state = 3; writer.schedule(build);
  assert.deepEqual(saved, [1], 'only one save is in flight');
  releases[0].reject(new Error('disk full'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, [1, 3], 'intermediate states coalesce; the latest state is written next');
  releases[1].resolve();
  await writer.idle();
  assert.deepEqual(results, ['error', 'ok']);
});

test('settings load never rejects and disables saving when the boundary fails', async () => {
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async () => { throw new Error('Unexpected command load_settings'); } } };
  globalThis.isTauri = true;
  try {
    const failed = await loadSettings(50);
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.quiet, true);
    assert.deepEqual(failed.document, { version: 1, favorites: [], shortcuts: {}, session: null });
    globalThis.window.__TAURI_INTERNALS__.invoke = () => new Promise(() => {});
    const hung = await loadSettings(20);
    assert.equal(hung.status, 'unavailable', 'an unanswered load cannot enable a later overwrite');
    assert.equal(hung.quiet, false, 'a timed-out load is reported visibly');
    globalThis.window.__TAURI_INTERNALS__.invoke = async (command) => ({ document: { version: 1, favorites: [], shortcuts: { copy: 'F9' }, session: null }, status: 'loaded', warnings: [], command });
    const loaded = await loadSettings(50);
    assert.equal(loaded.status, 'loaded');
    assert.equal(loaded.quiet, false);
    assert.equal(loaded.document.shortcuts.copy, 'F9');
  } finally {
    delete globalThis.window;
    delete globalThis.isTauri;
  }
});
