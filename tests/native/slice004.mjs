// Slice 004 native checks: REAL Linux Tauri/WebKitGTK window, real Rust IPC,
// real filesystem and settings persistence across an actual window close and
// relaunch. Disposable fixtures and an isolated XDG_CONFIG_HOME only.
// Input is DOM-dispatched by default (labelled in the report). With
// QPANES_NATIVE_INPUT=xtest, tab shortcuts and one drag additionally use
// trusted X11/XTest keyboard and pointer events.
// Run: QPANES_NATIVE_PHASE=usability bash tests/native/run-operations.sh
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

assert.equal(process.platform, 'linux');
const root = process.env.QPANES_NATIVE_TRASH_ROOT;
const inspector = process.env.QPANES_INSPECTOR;
assert(root?.includes('qpanes-slice-002-native.'), 'requires the disposable native fixture root');
assert.equal(await readFile(join(root, 'qpanes-native-isolation'), 'utf8'), 'QPanes disposable native Trash fixtures\n');
assert.equal(process.env.XDG_CONFIG_HOME, join(root, 'config'), 'settings must use the disposable config directory');
const settingsDir = join(process.env.XDG_CONFIG_HOME, 'io.qpanes.app');
const settingsFile = join(settingsDir, 'settings.json');
const xtest = process.env.QPANES_NATIVE_INPUT === 'xtest';
const driver = join(root, 'qpanes-x11');
if (xtest) execFileSync('cc', ['tests/native/x11-window.c', '-o', driver, ...execFileSync('pkg-config', ['--cflags', '--libs', 'x11', 'xtst'], { encoding: 'utf8' }).trim().split(/\s+/)]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nativePath = (path) => `u:${Buffer.from(path).toString('hex')}`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(fn, timeout = 15000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(30); }
  throw new Error(`Native ${label} timed out`);
}

/** One inspector connection to the current app instance. */
async function connect() {
  await waitFor(async () => { try { return (await fetch(inspector)).ok; } catch { return false; } }, 20000, 'inspector');
  await sleep(2000); // WebKit publishes its inspector before the first page loads.
  const html = await (await fetch(inspector)).text();
  const socketPath = html.match(/\/socket\/[^']+/)?.[0];
  assert(socketPath, 'native QPanes must expose a debug WebKit target');
  const socket = new WebSocket(inspector.replace('http', 'ws') + socketPath);
  let nextId = 1, target;
  const pending = new Map();
  const ready = new Promise((resolve) => socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page') { target = message.params.targetInfo.targetId; resolve(); }
    if (message.method === 'Target.dispatchMessageFromTarget') { const result = JSON.parse(message.params.message); pending.get(result.id)?.(result); pending.delete(result.id); }
  }));
  await Promise.race([ready, sleep(15000).then(() => { throw new Error('No native page target'); })]);
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 20000);
    pending.set(id, (result) => { clearTimeout(timer); result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result); });
    socket.send(JSON.stringify({ id: nextId++, method: 'Target.sendMessageToTarget', params: { targetId: target, message: JSON.stringify({ id, method, params }) } }));
  });
  const evaluate = async (expression) => {
    const response = await command('Runtime.evaluate', { expression, returnByValue: true });
    assert(!response.wasThrown, JSON.stringify(response));
    return response.result.value;
  };
  const ipc = async (name, args = {}) => {
    await evaluate(`window.__s4=null;window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)}).then(value=>{window.__s4={value}},error=>{window.__s4={error}})`);
    await waitFor(() => evaluate('window.__s4!==null'), 20000, `ipc ${name}`);
    return evaluate('window.__s4');
  };
  await waitFor(() => evaluate(`document.querySelectorAll('.pane-view:not([hidden]) [role=listbox][aria-busy=false]').length === 2`), 20000, 'panes ready');
  // Test-only instrumentation through the debug inspector: count IPC commands.
  await evaluate(`(()=>{const internals=window.__TAURI_INTERNALS__;const original=internals.invoke.bind(internals);window.__ipcLog=[];internals.invoke=(command,payload,options)=>{window.__ipcLog.push(command);return original(command,payload,options);};window.__inputLog=[];for(const type of ['keydown','pointerdown','pointerup'])window.addEventListener(type,event=>window.__inputLog.push({type,key:event.key,code:event.code,ctrl:event.ctrlKey,shift:event.shiftKey,alt:event.altKey,trusted:event.isTrusted,prevented:event.defaultPrevented}),true);})()`);
  return { socket, evaluate, ipc };
}

const checks = [];
let app, page, instance = null, complete = false, crashed = null;
const check = (value, message, detail) => { assert(value, `${message}${detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`}`); checks.push(message); };
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const visible = (side, selector = '') => `.pane-view:not([hidden])[data-drop-side="${side}"] ${selector}`;
const listSel = (side) => visible(side, `[aria-label="${side} files"]`);
const busy = (side) => page.evaluate(`${q(listSel(side))}?.getAttribute('aria-busy') !== 'false'`);
const settled = (side) => waitFor(async () => !(await busy(side)), 20000, `${side} ready`);
async function go(side, path) {
  await page.evaluate(`(()=>{const input=${q(visible(side, `[aria-label="${side} directory path"]`))};input.value=${JSON.stringify(path)};input.dispatchEvent(new Event('input',{bubbles:true}));input.form.requestSubmit();})()`);
  await waitFor(() => page.evaluate(`${q(visible(side, `[aria-label="${side} directory path"]`))}.value===${JSON.stringify(path)} && ${q(listSel(side))}.getAttribute('aria-busy')==='false'`), 20000, `go ${path}`);
}
async function key(side, init) {
  await page.evaluate(`(()=>{const list=${q(listSel(side))};list.focus();list.dispatchEvent(new KeyboardEvent('keydown',Object.assign({bubbles:true,cancelable:true},${JSON.stringify(init)})));})()`);
}
const tabCount = (side) => page.evaluate(`document.querySelectorAll('[aria-label="${side} tabs"] [role=tab]').length`);
const path = (side) => page.evaluate(`${q(visible(side, `[aria-label="${side} directory path"]`))}.value`);
const names = (side) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(listSel(side) + ' .filename')})].map(e=>e.textContent)`);
const ipcCount = (command) => page.evaluate(`window.__ipcLog.filter(c=>c===${JSON.stringify(command)}).length`);
const settings = async () => JSON.parse(await readFile(settingsFile, 'utf8'));
const jobs = async () => (await page.ipc('list_operations')).value.jobs;
async function rowCenter(side, name) {
  return page.evaluate(`(()=>{const row=[...document.querySelectorAll(${JSON.stringify(listSel(side) + ' .file-row')})].find(r=>r.querySelector('.filename')?.textContent===${JSON.stringify(name)});if(!row)return null;row.scrollIntoView({block:'nearest'});const b=row.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
}
const listCenter = (side) => page.evaluate(`(()=>{const b=${q(listSel(side))}.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height-40};})()`);
/** DOM-dispatched pointer drag: real layout hit testing, real handlers, not OS input. */
async function domDrag(from, to, { release = true } = {}) {
  const fire = (type, point, buttons) => `(()=>{const p=${JSON.stringify(point)};const target=document.elementFromPoint(p.x,p.y)??document.body;target.dispatchEvent(new PointerEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,composed:true,pointerId:7,pointerType:'mouse',isPrimary:true,button:0,buttons:${buttons},clientX:p.x,clientY:p.y}));})()`;
  await page.evaluate(fire('pointerdown', from, 1));
  for (let i = 1; i <= 6; i++) await page.evaluate(fire('pointermove', { x: from.x + (to.x - from.x) * i / 6, y: from.y + (to.y - from.y) * i / 6 }, 1));
  // Separate round trip: Svelte applies drop feedback in a microtask after the move.
  const dropState = await page.evaluate(`document.querySelector('.pane-view.drop-valid')?'valid':document.querySelector('.pane-view.drop-invalid')?'invalid':null`);
  if (release) await page.evaluate(fire('pointerup', to, 0));
  return dropState;
}
const transferOpen = () => page.evaluate(`!!document.querySelector('dialog[open]')?.textContent.includes('Copy or move')`);
const clickDialog = (label) => page.evaluate(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
const noticeText = () => page.evaluate(`document.querySelector('.operation-notice')?.textContent ?? ''`);
const dismissNotice = () => page.evaluate(`document.querySelector('.operation-notice button')?.click()`);
async function finished(before) {
  return waitFor(async () => { const list = await jobs(); return list.length > before && ['completed', 'failed', 'cancelled'].includes(list.at(-1).state) && list.at(-1); }, 20000, 'job');
}
function launch(tag) {
  const log = openSync(join(root, `slice004-app-${tag}.log`), 'w');
  const child = spawn('src-tauri/target/debug/qpanes', [], { env: process.env, stdio: ['ignore', log, log] });
  child.on('exit', (code, signal) => { if (instance === child && code !== 0) crashed = { tag, code, signal }; });
  return child;
}
async function closeWindow(pid) {
  // The window and its page disappear, so no IPC reply can be awaited.
  // Schedule the close so this evaluation replies before the page is destroyed.
  await page.evaluate(`setTimeout(()=>void window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'}),100)`);
  await waitFor(() => !alive(pid), 15000, 'process exit after window close');
  page.socket.close();
}
async function relaunch(tag) {
  instance = launch(tag);
  page = await connect();
  return instance.pid;
}

const fixture = await mkdtemp(join(root, 'usability-'));
const dirs = Object.fromEntries(['left', 'right', 'big', 'gone'].map((name) => [name, join(fixture, name)]));
const report = { mode: '', input: xtest ? 'DOM-dispatched plus trusted XTest keys/pointer drag' : 'DOM-dispatched input (not trusted OS input)', passed: 0, checks, measurements: {} };
try {
  for (const directory of Object.values(dirs)) await mkdir(directory);
  await mkdir(join(dirs.left, 'folder', 'deep'), { recursive: true });
  await writeFile(join(dirs.left, 'a.txt'), 'exact alpha bytes');
  await writeFile(join(dirs.left, 'folder', 'inner.txt'), 'exact nested bytes');
  await writeFile(join(dirs.right, 'existing.txt'), 'destination stays');
  await Promise.all(Array.from({ length: 10000 }, (_, i) => writeFile(join(dirs.big, `file-${String(i).padStart(5, '0')}${i % 9 === 0 ? '-match' : ''}.dat`), '')));
  const real = Object.fromEntries(await Promise.all(Object.entries(dirs).map(async ([name, directory]) => [name, await realpath(directory)])));

  page = await connect();
  const firstPid = Number(process.env.QPANES_NATIVE_APP_PID);
  assert(firstPid > 1);
  check(await page.evaluate(`location.protocol === 'tauri:' && window.isTauri === true`), 'running inside the native Tauri webview');
  await waitFor(async () => { try { return (await settings()).version === 1; } catch { return false; } }, 10000, 'initial settings save');
  check((await stat(settingsFile)).isFile(), 'settings are written by Rust under the isolated XDG config directory');

  // Tabs.
  await go('left', dirs.left);
  await go('right', dirs.right);
  await key('left', { key: 't', code: 'KeyT', ctrlKey: true });
  await waitFor(async () => await tabCount('left') === 2 && !(await busy('left')));
  check(await tabCount('right') === 1 && await path('left') === real.left, 'Ctrl+T opens a native tab on the current directory');
  await go('left', dirs.big);
  const readsBefore = await ipcCount('list_directory');
  await key('left', { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
  await waitFor(async () => await path('left') === real.left);
  await key('left', { key: 'Tab', code: 'Tab', ctrlKey: true });
  await waitFor(async () => await path('left') === real.big);
  check(await ipcCount('list_directory') === readsBefore, 'switching native tabs does not re-read unchanged directories');

  // Quick Filter on a real 10,000-entry directory.
  const total = await page.evaluate(`document.querySelector(${JSON.stringify(visible('left', '.pane-status'))}).textContent`);
  check(/^10\D?000 items/.test(total), 'real 10,000-entry directory listed', total);
  await key('left', { key: 'f', code: 'KeyF', ctrlKey: true });
  await waitFor(() => page.evaluate(`document.activeElement?.getAttribute('aria-label') === 'left filter names'`));
  const listingsBeforeFilter = await ipcCount('list_directory');
  await page.evaluate(`window.__samples=null;(async()=>{const input=document.activeElement;const out=[];for(const value of ['m','ma','mat','matc','match','file-0','file-099','zzz','match']){const t=performance.now();input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));out.push(Math.round((performance.now()-t)*10)/10);}window.__samples=out;})()`);
  const samples = await waitFor(() => page.evaluate('window.__samples'), 15000, 'filter samples');
  report.measurements.nativeFilterUpdateMs = samples;
  const filterCount = await page.evaluate(`document.querySelector(${JSON.stringify(visible('left', '.filter-count'))}).textContent`);
  check(/^1\D?112 of 10\D?000$/.test(filterCount) && await ipcCount('list_directory') === listingsBeforeFilter, 'native Quick Filter matches in memory without re-reading the directory', { filterCount });
  check(Math.max(...samples) < 150, 'native WebKitGTK filter updates stay responsive at 10,000 entries', samples);
  const rendered = await page.evaluate(`document.querySelectorAll(${JSON.stringify(listSel('left') + ' [role=option]')}).length`);
  check(rendered > 0 && rendered < 60, 'virtualization remains effective while filtering natively', rendered);
  await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await waitFor(() => page.evaluate(`document.activeElement?.getAttribute('aria-label') === 'left files' && !document.querySelector(${JSON.stringify(visible('left', '.filter-bar'))})`));
  check(true, 'Escape clears the native filter and returns focus to the list');
  await key('left', { key: 'Tab', code: 'Tab', ctrlKey: true });
  await waitFor(async () => await path('left') === real.left);

  // Favorites: native identity only; the folder itself is never touched.
  await key('left', { key: 'd', code: 'KeyD', ctrlKey: true });
  await waitFor(async () => (await settings()).favorites.length === 1);
  let saved = await settings();
  check(saved.favorites[0].path === nativePath(real.left) && saved.favorites[0].location === real.left, 'a favorite stores the canonical native identifier', saved.favorites);
  await page.evaluate(`document.querySelector('[aria-label="left: favorites"]').click()`);
  await waitFor(() => page.evaluate(`!!document.querySelector('dialog[open] [aria-label="Rename left"]')`));
  await page.evaluate(`document.querySelector('dialog[open] [aria-label="Rename left"]').click()`);
  await waitFor(() => page.evaluate(`!!document.querySelector('.rename-input')`));
  await page.evaluate(`(()=>{const input=document.querySelector('.rename-input');input.value='Work área';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));})()`);
  await waitFor(async () => (await settings()).favorites[0].label === 'Work área');
  saved = await settings();
  check(saved.favorites[0].path === nativePath(real.left) && (await readdir(fixture)).sort().join() === 'big,gone,left,right', 'renaming a favorite changes only its label; no folder is renamed');
  await page.evaluate(`document.querySelector('dialog[open]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await waitFor(() => page.evaluate(`!document.querySelector('dialog[open]')`));
  const probe = await page.ipc('probe_directories', { paths: [nativePath(real.left), nativePath(join(real.left, 'missing')), nativePath(join(real.left, 'a.txt'))] });
  check(JSON.stringify(probe.value) === '["available","missing","notDirectory"]', 'real Rust availability probe for favorites', probe);

  // Drag and drop through the OperationManager.
  // A second right tab on the same directory stays hidden during the copy below.
  await key('right', { key: 't', code: 'KeyT', ctrlKey: true });
  await waitFor(async () => await tabCount('right') === 2 && !(await busy('right')));
  await key('right', { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
  await waitFor(() => page.evaluate(`document.querySelectorAll('[aria-label="right panel"] .pane-view[hidden]').length === 1`));
  const jobsBefore = (await jobs()).length;
  let state = await domDrag(await rowCenter('left', 'a.txt'), await listCenter('right'));
  await waitFor(transferOpen, 5000, 'transfer dialog');
  check(state === 'valid', 'the opposite native panel is highlighted as a valid drop target');
  await sleep(300);
  check((await jobs()).length === jobsBefore && !(await readdir(dirs.right)).includes('a.txt'), 'a native drop creates no job and changes no file before confirmation');
  await clickDialog('Cancel');
  await sleep(300);
  check((await jobs()).length === jobsBefore && !(await readdir(dirs.right)).includes('a.txt'), 'cancelling the drop confirmation changes nothing');
  await domDrag(await rowCenter('left', 'a.txt'), await listCenter('right'));
  await waitFor(transferOpen);
  await clickDialog('Copy');
  let job = await finished(jobsBefore);
  check(job.state === 'completed' && job.intent.kind === 'copy' && await readFile(join(dirs.right, 'a.txt'), 'utf8') === 'exact alpha bytes' && await readFile(join(dirs.left, 'a.txt'), 'utf8') === 'exact alpha bytes', 'confirmed Copy runs through the native OperationManager with exact bytes', job.state);
  await waitFor(async () => (await names('right')).includes('a.txt'));
  check(true, 'the destination panel refreshes after the dropped copy completes');
  await waitFor(() => page.evaluate(`[...document.querySelectorAll('[aria-label="right panel"] .pane-view[hidden] .filename')].some(e=>e.textContent==='a.txt')`), 10000, 'inactive tab refresh');
  check(true, 'the completed native operation also refreshes an affected inactive tab');
  await key('right', { key: 'Tab', code: 'Tab', ctrlKey: true });
  await key('right', { key: 'w', code: 'KeyW', ctrlKey: true });
  await waitFor(async () => await tabCount('right') === 1 && await path('right') === real.right);
  await domDrag(await rowCenter('left', 'a.txt'), await listCenter('right'));
  await waitFor(transferOpen);
  await clickDialog('Copy');
  job = await finished(jobsBefore + 1);
  check(job.state === 'failed' && job.error.code === 'conflict' && await readFile(join(dirs.right, 'a.txt'), 'utf8') === 'exact alpha bytes', 'a dropped copy never overwrites an existing destination', job.error);
  // Directory into its own descendant: rejected before the dialog by Rust ancestry.
  await go('right', join(dirs.left, 'folder', 'deep'));
  const jobsBeforeDescendant = (await jobs()).length;
  await domDrag(await rowCenter('left', 'folder'), await listCenter('right'));
  await waitFor(async () => (await noticeText()).includes('into itself or one of its subfolders'), 5000, 'descendant notice');
  check(!(await transferOpen()) && (await jobs()).length === jobsBeforeDescendant, 'a native folder cannot be dropped into its own descendant');
  await dismissNotice();
  await go('right', dirs.left);
  state = await domDrag(await rowCenter('left', 'a.txt'), await listCenter('right'));
  check(state === 'invalid' && !(await transferOpen()) && (await noticeText()).includes('already in this folder'), 'dropping into the same native directory is rejected');
  await dismissNotice();
  // Source disappears between drop and confirmation.
  await go('right', dirs.right);
  await writeFile(join(dirs.left, 'temp.txt'), 'temporary');
  await page.evaluate(`document.querySelector(${JSON.stringify(visible('left', '[aria-label="left: refresh directory"]'))}).click()`);
  await waitFor(async () => (await names('left')).includes('temp.txt'));
  await domDrag(await rowCenter('left', 'temp.txt'), await listCenter('right'));
  await waitFor(transferOpen);
  await rm(join(dirs.left, 'temp.txt'));
  await clickDialog('Copy');
  job = await finished(jobsBeforeDescendant);
  check(job.state === 'failed' && !(await readdir(dirs.right)).includes('temp.txt'), 'a source removed before confirmation fails in Rust without creating anything', job.error);
  // Move a directory.
  await domDrag(await rowCenter('left', 'folder'), await listCenter('right'));
  await waitFor(transferOpen);
  await clickDialog('Move');
  job = await finished(jobsBeforeDescendant + 1);
  check(job.state === 'completed' && job.intent.kind === 'move' && await readFile(join(dirs.right, 'folder', 'inner.txt'), 'utf8') === 'exact nested bytes' && !(await readdir(dirs.left)).includes('folder'), 'confirmed Move of a dropped folder preserves exact bytes', job.state);
  // Drop cancellation by Escape.
  const jobsBeforeEscape = (await jobs()).length;
  await domDrag(await rowCenter('left', 'a.txt'), await listCenter('right'), { release: false });
  await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  const ghost = await page.evaluate(`!!document.querySelector('.drag-ghost')`);
  await page.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(listSel('right'))}).getBoundingClientRect();document.elementFromPoint(b.x+20,b.y+20).dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,pointerType:'mouse',isPrimary:true,clientX:b.x+20,clientY:b.y+20}));})()`);
  await sleep(300);
  check(!ghost && !(await transferOpen()) && (await jobs()).length === jobsBeforeEscape, 'Escape cancels a native drag without a dialog or job');

  // Shortcut customization (persisted below).
  await page.evaluate(`document.querySelector('.shortcuts-button').click()`);
  await waitFor(() => page.evaluate(`!!document.querySelector('[aria-label="Change New tab shortcut"]')`));
  await page.evaluate(`(()=>{const b=document.querySelector('[aria-label="Change New tab shortcut"]');b.click();b.dispatchEvent(new KeyboardEvent('keydown',{key:'n',code:'KeyN',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}));})()`);
  await waitFor(async () => (await settings()).shortcuts?.newTab === 'Ctrl+Alt+N');
  await page.evaluate(`document.querySelector('dialog[open]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await waitFor(() => page.evaluate(`!document.querySelector('dialog[open]')`));
  check(true, 'a custom shortcut is saved by Rust');

  // Right panel: second tab on a directory that will disappear before restart.
  await key('right', { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
  await waitFor(async () => await tabCount('right') === 2 && !(await busy('right')));
  await go('right', dirs.gone);
  await key('right', { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
  await waitFor(async () => await path('right') === real.right);
  await waitFor(async () => { const value = await settings(); return value.session?.right?.tabs?.length === 2 && value.session.right.activeTab === 0 && value.session.left.tabs.length === 2; });
  saved = await settings();
  check(saved.session.right.tabs[1].path === nativePath(real.gone) && saved.session.left.tabs.map((tab) => tab.path).join() === [real.left, real.big].map(nativePath).join(), 'tab session is saved as native identifiers', saved.session);
  await rm(dirs.gone, { recursive: true });

  // Real close + relaunch.
  await closeWindow(firstPid);
  check(true, 'the native window closes normally with no active work');
  let pid = await relaunch('restart');
  check(await tabCount('left') === 2 && await tabCount('right') === 2 && await path('left') === real.left && await path('right') === real.right, 'tabs and locations are restored after an actual relaunch');
  await page.evaluate(`document.querySelectorAll('[aria-label="right tabs"] [role=tab]')[1].click()`);
  await waitFor(async () => !(await busy('right')));
  const unavailable = await page.evaluate(`({state:document.querySelector(${JSON.stringify(visible('right', '.list-state'))})?.textContent??'',alert:!!document.querySelector(${JSON.stringify(visible('right', '[role=alert]'))}),path:document.querySelector(${JSON.stringify(visible('right', '[aria-label="right directory path"]'))}).value})`);
  check(unavailable.state.includes('Directory unavailable') && unavailable.alert && unavailable.path === real.gone, 'a vanished restored directory shows an unavailable state at its own location', unavailable);
  await page.evaluate(`document.querySelector('[aria-label="left: favorites"]').click()`);
  await waitFor(() => page.evaluate(`!!document.querySelector('dialog[open] [aria-label="Open Work área"]')`));
  check(true, 'favorites persist across relaunch');
  await page.evaluate(`document.querySelector('dialog[open]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  await waitFor(() => page.evaluate(`!document.querySelector('dialog[open]')`));
  await key('left', { key: 't', code: 'KeyT', ctrlKey: true });
  await sleep(300);
  const afterDefault = await tabCount('left');
  await key('left', { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });
  await waitFor(async () => await tabCount('left') === afterDefault + 1);
  check(afterDefault === 2, 'custom shortcuts persist across relaunch (old default no longer bound)');

  if (xtest) {
    const x11 = (...args) => JSON.parse(execFileSync(driver, ['Qpanes', ...args.map(String)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    // XTest keys reach the WebView only while WSLg grants the X11 window OS
    // focus. Establish that explicitly so a host-focus problem is reported as
    // such instead of as an ambiguous shortcut timeout.
    let window;
    for (let attempt = 0; attempt < 5; attempt++) {
      window = x11('focus');
      if (await waitFor(() => page.evaluate('document.hasFocus()'), 1500, 'window focus').catch(() => false)) break;
    }
    if (!(await page.evaluate('document.hasFocus()'))) throw new Error('XTest input unavailable: the WSLg window did not receive OS keyboard focus (document.hasFocus() stayed false after 5 focus requests). This is an environment limitation, not a product result.');
    await page.evaluate(`${q(listSel('left'))}.focus(); window.__inputLog.length = 0`);
    const before = await tabCount('left');
    x11('key', 'Control_L', 'Alt_L', 'n');
    try { await waitFor(async () => await tabCount('left') === before + 1, 5000, 'XTest new tab'); }
    catch (error) { throw new Error(`${error.message}: ${JSON.stringify({ received: await page.evaluate('window.__inputLog'), active: await page.evaluate('document.activeElement?.getAttribute("aria-label")'), focused: await page.evaluate('document.hasFocus()') })}`); }
    const selectedTab = () => page.evaluate(`[...document.querySelectorAll('[aria-label="left tabs"] [role=tab]')].findIndex(t=>t.getAttribute('aria-selected')==='true')`);
    const selectedBefore = await selectedTab();
    x11('key', 'Control_L', 'Shift_L', 'Tab');
    try { await waitFor(async () => await selectedTab() === selectedBefore - 1, 5000, 'XTest previous tab'); }
    catch (error) { throw new Error(`${error.message}: ${JSON.stringify({ selectedBefore, selected: await selectedTab(), received: (await page.evaluate('window.__inputLog')).slice(-12), active: await page.evaluate('document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName') })}`); }
    const keys = await page.evaluate('window.__inputLog.filter(e=>e.type==="keydown")');
    check(keys.length > 0 && keys.every((event) => event.trusted), 'trusted XTest keys open and switch native tabs', keys);
    await key('left', { key: 'w', code: 'KeyW', ctrlKey: true });
    await go('left', dirs.left);
    await go('right', dirs.right);
    const ratio = await page.evaluate('devicePixelRatio');
    const from = await rowCenter('left', 'a.txt'), to = await listCenter('right');
    const jobsBeforePointer = (await jobs()).length;
    await page.evaluate('window.__inputLog.length = 0');
    x11('drag', Math.round(window.x + from.x * ratio), Math.round(window.y + from.y * ratio), Math.round((to.x - from.x) * ratio), Math.round((to.y - from.y) * ratio));
    try { await waitFor(transferOpen, 5000, 'XTest drop dialog'); }
    catch (error) { throw new Error(`${error.message}: ${JSON.stringify({ focused: await page.evaluate('document.hasFocus()'), window: x11('info'), from, to, ratio, received: (await page.evaluate('window.__inputLog')).slice(-12), notice: await noticeText() })}`); }
    const pointer = await page.evaluate('window.__inputLog.filter(e=>e.type!=="keydown")');
    check(pointer.length >= 2 && pointer.every((event) => event.trusted) && (await jobs()).length === jobsBeforePointer, 'a trusted XTest pointer drag opens the confirmation without submitting', pointer);
    await clickDialog('Cancel');
  }

  // Corrupt settings are preserved and replaced by defaults on the next launch.
  await closeWindow(pid);
  await writeFile(settingsFile, '{ "version": 1, "favorites": [');
  pid = await relaunch('corrupt');
  const recovered = await waitFor(async () => (await noticeText()).includes('settings.invalid.json') && await noticeText(), 10000, 'recovery notice');
  check(await readFile(join(settingsDir, 'settings.invalid.json'), 'utf8') === '{ "version": 1, "favorites": [' && await tabCount('left') === 1, 'corrupt native settings are preserved as settings.invalid.json and defaults are used', recovered);
  await waitFor(async () => { try { return (await settings()).version === 1; } catch { return false; } });
  check(true, 'recovered settings are saved again as a valid document');
  await closeWindow(pid);
  instance = null;
  check(!crashed, 'no relaunched instance exited abnormally', crashed);
  complete = true;
} finally {
  if (instance && alive(instance.pid)) instance.kill('SIGTERM');
  report.mode = 'REAL Linux Tauri/WebKitGTK + Rust IPC/filesystem under WSLg; isolated XDG config/data; disposable fixtures';
  report.passed = checks.length;
  report.complete = complete;
  report.limits = 'Windows/macOS runtime NOT VERIFIED. Physical OS input only where the XTest mode is reported.';
  await writeFile(`test-results/slice-004-native${complete ? '' : '-partial'}${xtest ? '-xtest' : ''}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await rm(fixture, { recursive: true, force: true });
  try { page?.socket.close(); } catch { /* already closed */ }
  await access(root);
}
