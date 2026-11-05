// Linux WebKitGTK native integration check. No mocked IPC, no production hooks.
// First launch the debug binary with WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9222.
// Input events below are DOM-dispatched; trusted keyboard input is covered by Playwright.
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const inspector = process.env.QPANES_INSPECTOR ?? 'http://127.0.0.1:9222';
const html = await (await fetch(inspector)).text();
const socketPath = html.match(/\/socket\/[^']+/)?.[0];
assert(socketPath, 'native QPanes must expose a debug WebKit target');
const socket = new WebSocket(inspector.replace('http', 'ws') + socketPath);
let nextId = 1;
const pending = new Map();
let pageTarget;
const targetReady = new Promise((resolve) => {
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page') {
      pageTarget = message.params.targetInfo.targetId;
      resolve();
    }
    if (message.method === 'Target.dispatchMessageFromTarget') {
      const result = JSON.parse(message.params.message);
      const callback = pending.get(result.id);
      if (callback) { pending.delete(result.id); callback(result); }
    }
  });
});
async function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 10000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id: nextId++, method: 'Target.sendMessageToTarget',
      params: { targetId: pageTarget, message: JSON.stringify({ id, method, params }) } }));
  });
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, returnByValue: true });
  assert(!response.wasThrown, JSON.stringify(response));
  return response.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Native condition timed out: ${expression}`);
}
const query = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const pane = (side) => `[aria-label="${side} panel"]`;
const input = (side) => `[aria-label="${side} directory path"]`;
const list = (side) => `[aria-label="${side} files"]`;
async function go(side, path) {
  await evaluate(`(() => { const input = ${query(input(side))}; input.value = ${JSON.stringify(path)}; input.dispatchEvent(new Event('input', {bubbles:true})); input.form.requestSubmit(); })()`);
  await until(`${query(list(side))}.getAttribute('aria-busy') === 'false'`);
}
async function key(side, key) {
  await evaluate(`(() => { const list = ${query(list(side))}; list.focus(); list.dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)},bubbles:true,cancelable:true})); })()`);
  await until(`${query(list(side))}.getAttribute('aria-busy') === 'false'`);
}
const check = async (expression, message) => { assert(await evaluate(expression), message); passed.push(message); };
const passed = [];
const fixture = await mkdtemp(join(tmpdir(), 'qpanes-native-'));
await mkdir('test-results', { recursive: true });
try {
  await Promise.race([targetReady, new Promise((_, reject) => setTimeout(() => reject(new Error('No native page target')), 10000).unref())]);
  await check(`location.protocol === 'tauri:' && window.isTauri === true`, 'running inside the native Tauri webview');
  await evaluate(`${query('[aria-label="left: home directory"]')}.click(); ${query('[aria-label="right: home directory"]')}.click()`);
  await until(`${query(list('left'))}.getAttribute('aria-busy') === 'false' && ${query(list('right'))}.getAttribute('aria-busy') === 'false'`);
  await check(`${query(input('left'))}.value.startsWith('/') && ${query(input('right'))}.value.startsWith('/') && !document.querySelector('[role=alert]')`, 'both home directories loaded from real Rust IPC');
  await mkdir(join(fixture, 'left', 'Nested'), { recursive: true });
  await mkdir(join(fixture, 'right'), { recursive: true });
  await mkdir(join(fixture, 'restricted'));
  await chmod(join(fixture, 'restricted'), 0o000);
  await writeFile(join(fixture, 'left', 'a.txt'), 'hello');
  await writeFile(join(fixture, 'left', 'z.bin'), '0123456789');
  await writeFile(join(fixture, 'right', 'árvíz.txt'), 'unicode');
  await symlink('missing', join(fixture, 'left', 'broken-link'));
  await go('left', join(fixture, 'left'));
  await go('right', join(fixture, 'right'));
  await check(`${query(input('left'))}.value !== ${query(input('right'))}.value && document.querySelectorAll('${list('left')} [role=option]').length === 5`, 'two distinct real directories and virtual parent render independently');
  await check(`${query(pane('left'))}.textContent.includes('4 items')`, 'virtual parent is excluded from filesystem counts');
  await check(`${query(`${list('left')} [title="5 bytes"]`)}.textContent === '5 B'`, 'real Rust file metadata reaches the view');
  await check(`${query(`${list('right')} [aria-selected=true] .filename`)}.textContent === 'árvíz.txt'`, 'native Unicode filename renders');
  await check(`${query(`${list('left')} .entry-icon.symlink`)} !== null`, 'broken symlink is listed without following its target');
  await key('left', 'Enter');
  await check(`${query(input('left'))}.value.endsWith('/left/Nested') && ${query(input('right'))}.value.endsWith('/right')`, 'native Enter navigation leaves the other panel unchanged');
  await check(`${query(pane('left'))}.textContent.includes('This folder is empty')`, 'native empty state');
  await key('left', 'Backspace');
  await check(`${query(`${list('left')} [aria-selected=true] .filename`)}.textContent === 'Nested'`, 'native parent navigation restores child selection');
  await key('left', 'ArrowDown');
  await check(`${query(`${list('left')} [aria-selected=true] .filename`)}.textContent === 'a.txt'`, 'native selection handler');
  await key('left', 'Tab');
  await check(`document.activeElement === ${query(list('right'))} && ${query(pane('right'))}.classList.contains('active')`, 'native panel focus switch');
  await evaluate(`${query('[aria-label="Sort left by size, unsorted"]')}.click()`);
  await until(`${query(list('left'))}.getAttribute('aria-busy') === 'false'`);
  await evaluate(`${query('[aria-label="Sort left by size, ascending"]')}.click()`);
  await until(`${query(list('left'))}.getAttribute('aria-busy') === 'false'`);
  await check(`Array.from(document.querySelectorAll('${list('left')} .filename')).map(e=>e.textContent).join('|') === '[..]|Nested|z.bin|a.txt|broken-link'`, 'native Rust in-memory sort keeps virtual parent first and unknown last');
  await key('left', 'Home');
  await key('left', 'ArrowDown');
  await key('left', 'Enter');
  await key('left', 'Enter');
  await check(`${query(input('left'))}.value.endsWith('/left') && ${query(`${list('left')} [aria-selected=true] .filename`)}.textContent === 'Nested'`, 'native virtual parent Enter restores child selection');
  await go('right', '/');
  await check(`!document.querySelector('${list('right')} [aria-label="[..] Parent directory"]')`, 'native filesystem root has no virtual parent');
  await go('right', join(fixture, 'right'));
  await go('right', join(fixture, 'restricted'));
  await check(`${query(pane('right'))}.textContent.includes('Permission denied') && ${query(`${list('right')} [aria-selected=true] .filename`)}.textContent === 'árvíz.txt'`, 'native permission error preserves prior contents');
  await go('right', join(fixture, 'missing'));
  await check(`${query(`${pane('right')} [role=alert]`)} !== null`, 'native missing-directory error');
  await mkdir(join(fixture, 'missing'));
  await evaluate(`${query(`${pane('right')} [role=alert] button.retry`)}.focus(); ${query(`${pane('right')} [role=alert] button.retry`)}.click()`);
  await until(`${query(list('right'))}.getAttribute('aria-busy') === 'false'`);
  await check(`document.activeElement === ${query(list('right'))} && !document.querySelector('${pane('right')} [role=alert]')`, 'native successful Retry retains keyboard list focus');
  // Real permission recovery must replay the parent navigation's desired child,
  // rather than the selection in the still-displayed child listing.
  const parentFixture = join(fixture, 'parent-retry');
  await mkdir(join(parentFixture, 'Aardvark'), { recursive: true });
  await mkdir(join(parentFixture, 'Child'));
  for (const side of ['left', 'right']) {
    for (const method of ['Enter', 'Backspace']) {
      await go(side, join(parentFixture, 'Child'));
      if (method === 'Backspace') {
        await mkdir(join(parentFixture, 'Child', 'Nested'), { recursive: true });
        await go(side, join(parentFixture, 'Child'));
      } else await key(side, 'Home');
      await chmod(parentFixture, 0o000);
      try {
        await key(side, method);
        await check(`${query(`${pane(side)} [role=alert]`)} !== null`, `native ${side} ${method} parent permission error`);
        await evaluate(`${query(`${pane(side)} [role=alert] button.retry`)}.click()`);
        await until(`${query(list(side))}.getAttribute('aria-busy') === 'false'`);
        await check(`${query(`${pane(side)} [role=alert]`)} !== null`, `native ${side} ${method} repeated Retry failure`);
      } finally { await chmod(parentFixture, 0o700); }
      await evaluate(`${query(`${pane(side)} [role=alert] button.retry`)}.click()`);
      await until(`${query(list(side))}.getAttribute('aria-busy') === 'false'`);
      await check(`${query(`${list(side)} [aria-selected=true] .filename`)}.textContent === 'Child' && document.activeElement === ${query(list(side))}`, `native ${side} ${method} Retry restores exited child after permission recovery`);
    }
  }
  let deep = fixture;
  for (let i = 0; i < 10; i++) deep = join(deep, `segment-${i}-${'x'.repeat(50)}`);
  assert(deep.length >= 500);
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'visible.txt'), 'fixture');
  await go('left', deep);
  await go('left', join(deep, 'missing'));
  await check(`(() => { const p=${query(pane('left'))}.getBoundingClientRect(), l=${query(list('left'))}.getBoundingClientRect(), f=${query(`${pane('left')} .pane-status`)}.getBoundingClientRect(), e=${query(`${pane('left')} .error-banner`)}.getBoundingClientRect(); return e.height<=56 && l.height>=40 && f.bottom<=p.bottom && document.documentElement.scrollWidth<=innerWidth && document.documentElement.scrollHeight<=innerHeight; })()`, 'native 500-character current/error paths preserve list and footer');
  await evaluate(`${query(`${pane('left')} .error-details summary`)}.click()`);
  await check(`${query(`${pane('left')} .error-card`)}.textContent.includes(${JSON.stringify(deep)}) && ${query(`${pane('left')} .error-card`)}.clientHeight > 0`, 'native full path/error details remain accessible');
  await go('left', join(fixture, 'left'));
  await go('right', join(fixture, 'right'));
  await evaluate(`${query(list('left'))}.focus()`);
  const dimensions = await evaluate('({width:innerWidth,height:innerHeight})');
  const snapshot = await command('Page.snapshotRect', { x: 0, y: 0, ...dimensions, coordinateSystem: 'Viewport' });
  await writeFile('test-results/slice-001-native.png', Buffer.from(snapshot.dataURL.split(',')[1], 'base64'));
  const report = { mode: 'REAL Tauri/Rust IPC, WebKitGTK on WSLg; DOM-dispatched input events', passed: passed.length, checks: passed,
    screenshot: 'test-results/slice-001-native.png' };
  await writeFile('test-results/slice-001-native.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await chmod(join(fixture, 'restricted'), 0o700).catch(() => {});
  await rm(fixture, { recursive: true, force: true });
  socket.close();
}
