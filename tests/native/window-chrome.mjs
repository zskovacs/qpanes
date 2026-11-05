// REAL Linux Tauri/GTK window test. XTest input + localhost WebKit debug inspector.
// Build driver as described in x11-window.c. Launch debug app with:
// WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9236 GDK_BACKEND=x11 src-tauri/target/debug/qpanes
// QPANES_INSPECTOR=http://127.0.0.1:9236 node tests/native/window-chrome.mjs
// Closes the tested window at the end. Does not change system display settings.
// Set QPANES_EXPECT_SCALE=2 for metrics/screenshot only after a GDK_SCALE=2 launch.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const inspector = process.env.QPANES_INSPECTOR ?? 'http://127.0.0.1:9236';
const driver = process.env.QPANES_X11_DRIVER ?? '/tmp/qpanes-x11';
const html = await (await fetch(inspector)).text();
const path = html.match(/\/socket\/[^']+/)?.[0];
assert(path, 'debug WebKit target required');
const socket = new WebSocket(inspector.replace('http', 'ws') + path);
let nextId = 1, target;
const pending = new Map();
const ready = new Promise(resolve => socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page') { target = message.params.targetInfo.targetId; resolve(); }
  if (message.method === 'Target.dispatchMessageFromTarget') {
    const result = JSON.parse(message.params.message);
    pending.get(result.id)?.(result); pending.delete(result.id);
  }
}));
async function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 10000);
    pending.set(id, result => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); });
    socket.send(JSON.stringify({ id: nextId++, method: 'Target.sendMessageToTarget', params: { targetId: target, message: JSON.stringify({ id, method, params }) } }));
  });
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, returnByValue: true });
  assert(!response.wasThrown, JSON.stringify(response));
  return response.result.value;
}
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Native condition timed out: ${expression}`);
}
async function native(expression) {
  await evaluate(`window.__chromeReply = null; Promise.resolve(${expression}).then(value => { window.__chromeReply = {value}; }, error => { window.__chromeReply = {error:String(error)}; });`);
  await until('window.__chromeReply !== null');
  const response = await evaluate('window.__chromeReply');
  assert(!response.error, response.error);
  return response.value;
}
const invoke = name => `window.__TAURI_INTERNALS__.invoke('plugin:window|${name}',{label:'main'})`;
const x11 = (...args) => JSON.parse(execFileSync(driver, ['Qpanes', ...args.map(String)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const hostPointer = process.env.QPANES_WSLG_POINTER === '1';
function hostCommand(mode, values = {}) {
  assert(Object.values(values).every(Number.isFinite), 'finite pointer coordinates required');
  const title = process.env.QPANES_WSLG_TITLE ?? `Qpanes (${process.env.WSL_DISTRO_NAME})`;
  const prefix = `$qpanesMode='${mode}';\n$qpanesTitle='${title.replaceAll("'", "''")}';\n` + Object.entries(values).map(([key,value]) => `$qpanes${key}=${value};\n`).join('');
  return execFileSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', prefix + readFileSync(new URL('./wslg-pointer.ps1', import.meta.url), 'utf8')], { encoding: 'utf8' });
}
function drive(...args) {
  if (!hostPointer || args[0] !== 'drag') return x11(...args);
  const info = x11('info');
  hostCommand('drag', { X: args[1] - info.x, Y: args[2] - info.y, Dx: args[3], Dy: args[4], Width: info.width, Height: info.height });
  return x11('info');
}
const passed = [], transitions = [];
let completed = false;
const check = async (expression, message) => { assert(await evaluate(expression), message); passed.push(message); };
async function metrics() {
  return native(`Promise.all([${['current_monitor','scale_factor','inner_size','outer_position','is_maximized','is_decorated','is_resizable'].map(invoke).join(',')}]).then(([monitor,scaleFactor,size,position,maximized,decorated,resizable]) => ({monitor,scaleFactor,size,position,maximized,decorated,resizable,dpr:devicePixelRatio,zoom:getComputedStyle(document.documentElement).zoom,rowHeight:document.querySelector('.file-row')?.getBoundingClientRect().height,focus:document.activeElement?.getAttribute('aria-label')}))`);
}
async function click(name) {
  const rect = await evaluate(`(() => { const r=document.querySelector('[aria-label="${name} window"]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  const info = drive('info');
  drive('click', info.x + rect.x, info.y + rect.y, 1);
}
await mkdir('test-results', { recursive: true });
if (process.env.QPANES_EXPECT_SCALE) {
  try {
    await ready;
    await until(`document.querySelector('.file-row') && document.querySelector('.window-controls')`);
    const expected = Number(process.env.QPANES_EXPECT_SCALE);
    assert(Number.isFinite(expected) && expected > 0);
    const actual = await metrics();
    const web = await evaluate('({width:innerWidth,height:innerHeight})');
    assert.equal(actual.scaleFactor, expected); assert.equal(actual.dpr, expected);
    assert.equal(actual.rowHeight, 32); assert.equal(actual.zoom, '1');
    assert.deepEqual(actual.size, { width: web.width * expected, height: web.height * expected });
    const prefix = `test-results/slice-001.5-dpi-startup-${expected * 100}-native`;
    const screenshot = await command('Page.snapshotRect', { x: 0, y: 0, ...web, coordinateSystem: 'Viewport' });
    await writeFile(`${prefix}.png`, Buffer.from(screenshot.dataURL.split(',')[1], 'base64'));
    const report = { mode: 'REAL native GTK startup scaling; global test environment override, not a per-monitor transition', passed: 5, expected, actual, web, screenshot: `${prefix}.png` };
    await writeFile(`${prefix}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { socket.close(); }
} else {
try {
  await ready;
  await until(`document.querySelector('.window-controls') && [...document.querySelectorAll('[role=listbox]')].every(el=>el.getAttribute('aria-busy')==='false')`);
  if (hostPointer) hostCommand('restore');
  if (await native(invoke('is_maximized'))) {
    await native(invoke('toggle_maximize'));
    await until(`!!document.querySelector('[aria-label="Maximize window"]')`);
  }
  drive('focus'); drive('move', 800, 2400);
  await evaluate(`document.querySelector('[aria-label="left files"]').focus(); window.__nativeKeys=[]; document.addEventListener('keydown',event=>window.__nativeKeys.push({key:event.key,trusted:event.isTrusted}),true);`);
  const baseline = await metrics();
  assert.equal(baseline.decorated, false); assert.equal(baseline.resizable, true);
  passed.push('native title bar removed, window remains resizable');
  await check(`document.querySelectorAll('header.app-header').length===1 && document.querySelector('header').getBoundingClientRect().height===61`, 'one preserved 61px application header in real WebKit');
  await click('Maximize');
  await until(`!!document.querySelector('[aria-label="Restore window"]')`);
  assert.equal((await metrics()).maximized, true); passed.push('real pointer maximize changes native window state and restore icon');
  await check(`document.activeElement.getAttribute('aria-label')==='left files'`, 'native pointer maximize preserves pane focus');
  await click('Restore'); await until(`!!document.querySelector('[aria-label="Maximize window"]')`);
  assert.equal((await metrics()).maximized, false); passed.push('real pointer restore changes native window state');
  const restored = await metrics();
  assert.deepEqual(restored.size, baseline.size); passed.push('maximize/restore retains user window dimensions');
  drive('move', 800, 2400);
  let info = drive('info');
  drive('drag', info.x + 500, info.y + 30, 140, 80);
  const dragged = drive('info');
  assert(dragged.x !== info.x || dragged.y !== info.y); passed.push('real pointer drag on noninteractive header moves native window');
  drive('click', dragged.x + 500, dragged.y + 30, 2);
  await until(`!!document.querySelector('[aria-label="Restore window"]')`);
  assert.equal((await metrics()).maximized, true); passed.push('real header double-click maximizes');
  info = drive('info'); drive('click', info.x + 500, info.y + 30, 2);
  await until(`!!document.querySelector('[aria-label="Maximize window"]')`);
  passed.push('real header double-click restores');
  drive('move', 800, 2400);
  info = drive('info');
  drive('drag', info.x + info.width - 2, info.y + info.height / 2, 90, 0);
  const edge = drive('info');
  assert(edge.width > info.width); passed.push('native undecorated right-edge resizing works');
  drive('drag', edge.x + edge.width - 2, edge.y + edge.height - 2, 45, 45);
  const corner = drive('info');
  assert(corner.width > edge.width && corner.height > edge.height); passed.push('native undecorated corner resizing works');
  drive('resize', 900, 600);
  await until('innerWidth===900 && innerHeight===600');
  await evaluate(`document.querySelector('[aria-label="left files"]').focus()`);
  drive('key', 'Tab');
  await until(`document.activeElement.getAttribute('aria-label')==='right files'`);
  drive('key', 'Down'); drive('key', 'Up');
  await check(`window.__nativeKeys.some(e=>e.key==='Tab') && window.__nativeKeys.every(e=>e.trusted)`, 'actual XTest keyboard delivery: Tab switches pane and arrows remain trusted');
  const monitors = await native(invoke('available_monitors'));
  assert(monitors.length >= 2, 'two real compositor outputs required for transition probe');
  for (let round = 0; round < 3; round++) for (const monitor of monitors) {
    drive('move', monitor.position.x + 200, monitor.position.y + 250);
    await until(`screen.width===${monitor.size.width}`);
    const current = await metrics(); transitions.push({ round, ...current });
    assert.equal(current.monitor.name, monitor.name);
    assert.equal(current.zoom, '1'); assert.equal(current.rowHeight, 32);
    assert.deepEqual(current.size, { width: 900, height: 600 });
    assert.equal(current.focus, 'right files');
  }
  passed.push('six real native output transitions preserve window size, row geometry, zoom and active pane');
  // These outputs currently both expose scale 1. No physical fractional-DPI claim.
  await click('Maximize'); await until(`!!document.querySelector('[aria-label="Restore window"]')`);
  transitions.push({ phase: 'maximized-on-last-output', ...await metrics() });
  await click('Restore'); await until(`!!document.querySelector('[aria-label="Maximize window"]')`);
  drive('move', 800, 2400); drive('resize', 1200, 780);
  await click('Minimize');
  if (hostPointer) {
    const hostState = JSON.parse(hostCommand('state'));
    assert.equal(hostState.minimized, true); passed.push('real minimize control minimizes WSLg host window (Win32 IsIconic)');
    transitions.push({ phase: 'minimized', hostState, gtkMinimized: await native(invoke('is_minimized')) });
    assert.equal(JSON.parse(hostCommand('restore')).minimized, false);
  } else {
    assert.equal(await native(invoke('is_minimized')), true); passed.push('real minimize control minimizes native window');
  }
  drive('focus');
  await until(`document.activeElement.getAttribute('aria-label')==='right files'`);
  assert.equal(await native(invoke('is_minimized')), false); passed.push('external restore from minimize retains pane focus');
  await check(`!document.querySelector('.window-error')`, 'native chrome operations produce no visible IPC errors');
  const dimensions = await evaluate('({width:innerWidth,height:innerHeight})');
  const screenshot = await command('Page.snapshotRect', { x: 0, y: 0, ...dimensions, coordinateSystem: 'Viewport' });
  await writeFile('test-results/slice-001.5-native.png', Buffer.from(screenshot.dataURL.split(',')[1], 'base64'));
  const report = { mode: `REAL Linux Tauri/GTK/WebKitGTK under WSLg; XTest OS input${hostPointer ? ', Windows host pointer for move/resize loops' : ''}`, passed: passed.length, checks: passed, baseline, monitors, transitions,
    limits: 'Both compositor outputs report scale 1. Fractional/200% monitor DPI, native Windows and macOS remain unverified.', screenshot: 'test-results/slice-001.5-native.png' };
  // Close last: subsequent inspector/driver commands would target a destroyed window.
  try { await click('Close'); } catch { /* X11 may destroy the window before the driver's final geometry read. */ }
  let closed = false;
  try { drive('info'); } catch { closed = true; }
  assert(closed, 'normal close must destroy the tested native window');
  report.checks.push('real close control destroys the native window'); report.passed++;
  await writeFile('test-results/slice-001.5-native.json', JSON.stringify(report, null, 2));
  completed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (!completed) await writeFile('test-results/slice-001.5-native-partial.json', JSON.stringify({ mode: 'INCOMPLETE native run; see stderr for failed assertion', passed: passed.length, checks: passed, transitions }, null, 2));
  socket.close();
}
}
