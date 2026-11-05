// Node's built-in TypeScript stripping; no test dependency or production hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { observeWindow } from '../src/lib/window-state.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((r, e) => { resolve = r; reject = e; }); return { promise, resolve, reject }; };
function fixture() {
  const source = {
    maximized: false, factor: 1, removed: [],
    async isMaximized() { return this.maximized; },
    async scaleFactor() { return this.factor; },
    async onResized(callback) { this.resize = callback; return () => this.removed.push('resize'); },
    async onScaleChanged(callback) { this.scale = callback; return () => this.removed.push('scale'); },
  };
  const updates = [], errors = [];
  const observer = observeWindow(source, state => updates.push(state), error => errors.push(error));
  return { source, updates, errors, observer };
}

test('initial, external maximize and restore use current native state', async () => {
  const { source, updates, observer, errors } = fixture();
  await tick();
  assert.deepEqual(updates.at(-1), { maximized: false, scaleFactor: 1 });
  source.maximized = true; await source.resize();
  assert.equal(updates.at(-1).maximized, true);
  source.maximized = false; await observer.refresh();
  assert.equal(updates.at(-1).maximized, false);
  assert.deepEqual(errors, []);
  observer.dispose();
});

test('repeated 100/125/150/200% native scale notifications are absolute observations only', async () => {
  const { source, updates, observer } = fixture();
  await tick();
  for (let round = 0; round < 4; round++) {
    for (const factor of [1, 1.25, 1.5, 2, 1.5, 1.25, 1]) {
      source.factor = factor;
      await source.scale({ payload: { scaleFactor: factor, size: { width: 1200 * factor, height: 780 * factor } } });
      assert.equal(updates.at(-1).scaleFactor, factor);
    }
  }
  assert.equal(updates.at(-1).scaleFactor, 1);
  // The source deliberately has no size, zoom, focus or CSS mutation methods.
  observer.dispose();
});

test('stale initial/native queries cannot overwrite a later transition', async () => {
  const { source, updates, observer } = fixture();
  await tick();
  const old = deferred();
  source.isMaximized = () => old.promise;
  const first = observer.refresh();
  source.isMaximized = async () => true;
  source.factor = 2;
  await source.scale();
  old.resolve(false); await first;
  assert.deepEqual(updates.at(-1), { maximized: true, scaleFactor: 2 });
  observer.dispose();
});

test('dispose removes both listeners once and ignores pending reads/events', async () => {
  const { source, updates, observer } = fixture();
  await tick();
  const pending = deferred();
  source.isMaximized = () => pending.promise;
  const reading = observer.refresh();
  const count = updates.length;
  observer.dispose(); observer.dispose();
  pending.resolve(true); await reading; await source.scale();
  source.isMaximized = () => assert.fail('disposed observers must not query native state');
  await observer.refresh(); await source.resize();
  assert.equal(updates.length, count);
  assert.deepEqual(source.removed.sort(), ['resize', 'scale']);
});

test('an older failed read cannot surface an error over newer successful state', async () => {
  const { source, updates, errors, observer } = fixture();
  await tick();
  const old = deferred();
  source.isMaximized = () => old.promise;
  const reading = observer.refresh();
  source.isMaximized = async () => true;
  await observer.refresh();
  old.reject(new Error('old request'));
  await reading;
  assert.equal(updates.at(-1).maximized, true); assert.deepEqual(errors, []);
  observer.dispose();
});

test('listeners resolving after teardown are immediately released; errors are contained', async () => {
  const resize = deferred(), scale = deferred(), state = deferred();
  const removed = [], updates = [], errors = [];
  const observer = observeWindow({
    onResized: () => resize.promise, onScaleChanged: () => scale.promise,
    isMaximized: () => state.promise, scaleFactor: async () => 1,
  }, value => updates.push(value), error => errors.push(error));
  observer.dispose();
  resize.resolve(() => removed.push('resize')); scale.resolve(() => removed.push('scale')); state.resolve(false);
  await tick();
  assert.deepEqual(removed.sort(), ['resize', 'scale']);
  assert.deepEqual(updates, []); assert.deepEqual(errors, []);
  const broken = observeWindow({
    onResized: async () => { throw new Error('listen'); }, onScaleChanged: async () => () => {},
    isMaximized: async () => { throw new Error('read'); }, scaleFactor: async () => 1,
  }, () => assert.fail('failed read must not publish state'), error => errors.push(error.message));
  await tick();
  assert.deepEqual(errors.sort(), ['listen', 'read']);
  broken.dispose();
});

test('platform config and chrome ACL preserve dimensions, native macOS controls, and minimal authority', async () => {
  const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const base = await json('../src-tauri/tauri.conf.json');
  const mac = await json('../src-tauri/tauri.macos.conf.json');
  const drag = await json('../src-tauri/capabilities/window-chrome.json');
  const buttons = await json('../src-tauri/capabilities/window-controls.json');
  const win = base.app.windows[0], apple = mac.app.windows[0];
  assert.equal(base.identifier, 'io.qpanes.app');
  assert.equal(win.decorations, false); assert.equal(win.resizable, true);
  for (const key of ['width', 'height', 'minWidth', 'minHeight', 'resizable', 'backgroundColor', 'title']) assert.equal(apple[key], win[key]);
  assert.equal(apple.decorations, true); assert.equal(apple.titleBarStyle, 'Overlay'); assert.equal(apple.hiddenTitle, true);
  assert(apple.trafficLightPosition.x >= 12 && apple.trafficLightPosition.y >= 12);
  assert.deepEqual(drag.windows, ['main']); assert.deepEqual(buttons.windows, ['main']);
  assert.deepEqual(drag.permissions, ['core:window:allow-start-dragging']);
  assert.deepEqual(buttons.platforms, ['windows', 'linux']);
  assert.deepEqual(buttons.permissions, ['core:window:allow-minimize', 'core:window:allow-toggle-maximize', 'core:window:allow-close']);
});
