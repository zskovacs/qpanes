// Real Linux Tauri/WebKitGTK IPC and XTest keyboard checks. No mocked IPC.
// Build tests/native/x11-window.c as /tmp/qpanes-x11 (-lX11 -lXtst).
// Launch the debug app with WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:9242.
// Successful Trash testing additionally requires an isolated D-Bus/Portal session:
// QPANES_NATIVE_TRASH_ROOT=<generated temporary root>, XDG_DATA_HOME=<root>/data,
// QPANES_NATIVE_APP_PID=<debug app PID>. See the slice verification document.
// The script verifies both app and Portal process environments before trashing.
// Input defaults to explicitly labeled DOM-dispatched events; filesystem/IPC
// remain real. Set QPANES_NATIVE_INPUT=xtest for trusted OS keyboard delivery.
// QPANES_WSLG_POINTER=1 can additionally activate the exact WSLg host surface.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

assert.equal(process.platform, 'linux', 'this suite exercises Linux native semantics only');
const inspector = process.env.QPANES_INSPECTOR ?? 'http://127.0.0.1:9242';
const driver = process.env.QPANES_X11_DRIVER ?? '/tmp/qpanes-x11';
const phase = process.env.QPANES_NATIVE_PHASE === 'trash' ? 'trash' : 'all';
const hostPointer = process.env.QPANES_WSLG_POINTER === '1';
const domInput = process.env.QPANES_NATIVE_INPUT !== 'xtest';
if (!domInput) await access(driver);
const passed = [], skipped = [];
const html = await (await fetch(inspector)).text();
const socketPath = html.match(/\/socket\/[^']+/)?.[0];
assert(socketPath, 'native QPanes must expose a debug WebKit target');
const socket = new WebSocket(inspector.replace('http', 'ws') + socketPath);
let nextId = 1, target;
const pending = new Map();
const ready = new Promise(resolve => socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page') {
    target = message.params.targetInfo.targetId;
    resolve();
  }
  if (message.method === 'Target.dispatchMessageFromTarget') {
    const result = JSON.parse(message.params.message);
    pending.get(result.id)?.(result);
    pending.delete(result.id);
  }
}));
async function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 15000);
    pending.set(id, result => {
      clearTimeout(timer);
      result.error ? reject(new Error(JSON.stringify(result.error))) : resolve(result.result);
    });
    socket.send(JSON.stringify({ id: nextId++, method: 'Target.sendMessageToTarget',
      params: { targetId: target, message: JSON.stringify({ id, method, params }) } }));
  });
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, returnByValue: true });
  assert(!response.wasThrown, JSON.stringify(response));
  return response.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  throw new Error(`Native condition timed out: ${expression}`);
}
async function invoke(name, request) {
  await evaluate(`window.__operationReply = null; window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)}, {request:${JSON.stringify(request)}}).then(value => { window.__operationReply = {value}; }, error => { window.__operationReply = {error}; });`);
  await until('window.__operationReply !== null');
  return evaluate('window.__operationReply');
}
async function success(name, request) {
  const reply = await invoke(name, request);
  assert(!reply.error, JSON.stringify(reply.error));
  return reply.value;
}
async function rejection(name, request, code) {
  const reply = await invoke(name, request);
  assert.equal(reply.error?.code, code, JSON.stringify(reply));
  return reply.error;
}
const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
const list = side => `[aria-label="${side} files"]`;
const input = side => `[aria-label="${side} directory path"]`;
const selected = side => `${list(side)} [aria-selected=true] .filename`;
const dialog = 'dialog.operation-dialog';
const nativePath = path => `u:${Buffer.from(path).toString('hex')}`;
async function listing(path) {
  return success('list_directory', { target: { kind: 'typed', value: path }, sort: 'name', direction: 'ascending' });
}
async function entry(path, name) {
  const found = (await listing(path)).entries.find(item => item.name === name);
  assert(found, `native fixture entry ${name} must exist`);
  assert(found.identity, 'real listing must return a native source identity');
  return found;
}
async function go(side, path) {
  await evaluate(`(() => { const el=${q(input(side))}; el.value=${JSON.stringify(path)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.form.requestSubmit(); })()`);
  await until(`${q(list(side))}.getAttribute('aria-busy') === 'false' && ${q(input(side))}.value === ${JSON.stringify(path)}`);
}
const x11 = (...args) => execFileSync(driver, [process.env.QPANES_NATIVE_TITLE ?? 'Qpanes', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function hostActivate(point, frame) {
  const values = { X: point.x, Y: point.y, Dx: 0, Dy: 0, Width: frame.width, Height: frame.height };
  assert(Object.values(values).every(Number.isFinite));
  const title = process.env.QPANES_WSLG_TITLE ?? `Qpanes (${process.env.WSL_DISTRO_NAME})`;
  const prefix = `$qpanesMode='drag';\n$qpanesTitle='${title.replaceAll("'", "''")}';\n` + Object.entries(values).map(([name,value]) => `$qpanes${name}=${value};\n`).join('');
  execFileSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', prefix + readFileSync(new URL('./wslg-pointer.ps1', import.meta.url), 'utf8')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function key(name) {
  const before = await evaluate('window.__nativeOperationKeys.length');
  if (domInput) {
    const keyName = { Return: 'Enter', Down: 'ArrowDown', Up: 'ArrowUp', BackSpace: 'Backspace' }[name] ?? name;
    await evaluate(`(() => { const target=document.activeElement; const event=new KeyboardEvent('keydown',{key:${JSON.stringify(keyName)},bubbles:true,cancelable:true}); target.dispatchEvent(event); if(event.key==='Enter' && !event.defaultPrevented && target.closest('dialog.operation-dialog')) target.closest('form')?.requestSubmit(); })()`);
    await until(`window.__nativeOperationKeys.length > ${before}`);
    return;
  }
  // Fail before sending another key if a different desktop window received it.
  // In particular, a misplaced shortcut must never be followed by confirmation.
  x11('focus');
  const frame = JSON.parse(x11('info'));
  const point = await evaluate(`(() => { window.__nativeOperationFocus=document.activeElement; const el=document.querySelector('dialog.operation-dialog h2') ?? document.querySelector('.pane.active .pane-heading'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  // Neutral heading clicks activate the WSLg host surface without selecting a
  // row, submitting, dismissing or changing any operation. Restore DOM focus.
  if (hostPointer) hostActivate(point, frame);
  else x11('click', String(frame.x + point.x), String(frame.y + point.y), '1');
  await evaluate('window.__nativeOperationFocus?.focus()');
  x11('key', name);
  await until(`window.__nativeOperationKeys.length > ${before}`);
  assert(await evaluate('window.__nativeOperationKeys.at(-1).trusted'), 'native key must be trusted');
}
async function select(side, name) {
  await evaluate(`${q(list(side))}.focus()`);
  await key('Home');
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`${q(selected(side))}?.textContent === ${JSON.stringify(name)}`)) return;
    await key('Down');
  }
  assert.fail(`Could not select fixture ${name} in ${side}`);
}
async function open(side, name, shortcut, title) {
  if (name !== null) await select(side, name);
  else await evaluate(`${q(list(side))}.focus()`);
  await key(shortcut);
  await until(`${q(dialog)}?.open && ${q('#operation-title')}.textContent === ${JSON.stringify(title)}`);
}
async function cancel(side) {
  await key('Escape');
  await until(`!${q(dialog)} && document.activeElement === ${q(list(side))}`);
}
async function fillName(value) {
  await evaluate(`(() => { const el=${q('#operation-name')}; el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
}
async function confirm() {
  await key('Return');
  await until(`!${q(dialog)} && Array.from(document.querySelectorAll('[role=listbox]')).every(el=>el.getAttribute('aria-busy')==='false')`);
}
async function check(expression, message) {
  assert(await evaluate(expression), message);
  passed.push(message);
}
function checked(message) { passed.push(message); }
async function absent(path) { await assert.rejects(lstat(path), error => error.code === 'ENOENT'); }

// A private launcher must provide the existing generated root explicitly. Never
// infer permission to exercise Trash merely from an existing session daemon.
let isolatedRoot = null;
if (process.env.QPANES_NATIVE_TRASH_ROOT) {
  const configured = process.env.QPANES_NATIVE_TRASH_ROOT;
  assert(isAbsolute(configured), 'isolated root must be absolute');
  isolatedRoot = await realpath(configured);
  const tempRoot = await realpath(tmpdir());
  const child = relative(tempRoot, isolatedRoot);
  assert(child && !child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child), 'Trash root must be generated below the system temporary directory');
  assert.equal(await readFile(join(isolatedRoot, 'qpanes-native-isolation'), 'utf8'), 'QPanes disposable native Trash fixtures\n');
  assert.equal(process.env.XDG_DATA_HOME, join(isolatedRoot, 'data'));
}
const fixture = await mkdtemp(join(isolatedRoot ?? tmpdir(), 'qpanes-native-operations-'));
const sourceDir = join(fixture, 'source'), destinationDir = join(fixture, 'destination');
let completed = false;
let nativeTrash = 'success not exercised';
await mkdir('test-results', { recursive: true });
try {
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('No native page target')), 15000).unref())]);
  await check(`location.protocol === 'tauri:' && window.isTauri === true`, 'real native Tauri webview, no mocked IPC');
  await mkdir(sourceDir); await mkdir(destinationDir);
  await mkdir(join(sourceDir, 'tree', 'nested'), { recursive: true });
  const bytes = Buffer.from(Array.from({ length: 256 * 1024 + 17 }, (_, i) => (i * 37) % 256));
  await writeFile(join(sourceDir, 'bytes.bin'), bytes);
  await writeFile(join(sourceDir, 'tree', 'nested', 'contents.bin'), bytes);
  await writeFile(join(sourceDir, 'move.txt'), 'move identity');
  await writeFile(join(sourceDir, 'rename.txt'), 'rename identity');
  await symlink('tree', join(sourceDir, 'link'));
  if (!domInput) x11('focus');
  await evaluate(`window.__nativeOperationKeys=[]; document.addEventListener('keydown',event=>window.__nativeOperationKeys.push({key:event.key,trusted:event.isTrusted}),true);`);

  if (phase !== 'trash') {
    const sourceListing = await listing(sourceDir), destinationListing = await listing(destinationDir);
    assert.equal(sourceListing.path, nativePath(sourceDir));
    const created = await success('create_directory', { parent: sourceListing.path, name: 'Árvíz 日本語' });
    assert.equal(created.path, nativePath(join(sourceDir, 'Árvíz 日本語')));
    assert((await lstat(join(sourceDir, 'Árvíz 日本語'))).isDirectory());
    await rejection('create_directory', { parent: sourceListing.path, name: 'Árvíz 日本語' }, 'conflict');
    await rejection('create_directory', { parent: sourceListing.path, name: '../outside' }, 'invalidName');
    checked('real create-directory IPC: Unicode creation, exclusive conflict and invalid-name rejection');

    const beforeRename = await lstat(join(sourceDir, 'rename.txt'));
    await success('rename_entry', { source: await entry(sourceDir, 'rename.txt'), name: 'renamed 日本語.txt' });
    assert.equal((await lstat(join(sourceDir, 'renamed 日本語.txt'))).ino, beforeRename.ino);
    await absent(join(sourceDir, 'rename.txt'));
    await rejection('rename_entry', { source: await entry(sourceDir, 'renamed 日本語.txt'), name: 'move.txt' }, 'conflict');
    assert.equal(await readFile(join(sourceDir, 'move.txt'), 'utf8'), 'move identity');
    checked('real rename IPC preserves inode and Unicode; conflicting entry remains intact');

    const binary = await entry(sourceDir, 'bytes.bin');
    await success('copy_entry', { source: binary, destination: destinationListing.path });
    assert.deepEqual(await readFile(join(destinationDir, 'bytes.bin')), bytes);
    await rejection('copy_entry', { source: binary, destination: destinationListing.path }, 'conflict');
    await rejection('copy_entry', { source: binary, destination: sourceListing.path }, 'sameEntry');
    assert.deepEqual(await readFile(join(sourceDir, 'bytes.bin')), bytes);
    checked('real copy IPC preserves every binary byte and rejects conflicts and copying onto itself');

    const tree = await entry(sourceDir, 'tree');
    await success('copy_entry', { source: tree, destination: destinationListing.path });
    assert.deepEqual(await readFile(join(destinationDir, 'tree', 'nested', 'contents.bin')), bytes);
    await rejection('copy_entry', { source: tree, destination: nativePath(join(sourceDir, 'tree', 'nested')) }, 'descendant');
    await rejection('copy_entry', { source: await entry(sourceDir, 'link'), destination: destinationListing.path }, 'unsupportedEntry');
    await mkdir(join(sourceDir, 'partial'));
    await writeFile(join(sourceDir, 'partial', 'first.txt'), 'do not publish incomplete trees');
    await symlink('../tree', join(sourceDir, 'partial', 'later-link'));
    const partialFailure = await rejection('copy_entry', { source: await entry(sourceDir, 'partial'), destination: destinationListing.path }, 'unsupportedEntry');
    await absent(join(destinationDir, 'partial'));
    const retainedStages = (await readdir(destinationDir)).filter(name => name.startsWith('.qpanes-copy-'));
    assert.equal(retainedStages.length, 1, 'failed copy must retain nonempty staging for review');
    const recoveryPath = join(destinationDir, retainedStages[0]);
    assert((await lstat(join(recoveryPath, 'payload'))).isDirectory());
    assert(partialFailure.message.includes(recoveryPath), 'failure must identify the reserved staging location');
    assert(partialFailure.message.includes('nonempty staging is never deleted automatically'));
    assert.equal(await readFile(join(sourceDir, 'partial', 'first.txt'), 'utf8'), 'do not publish incomplete trees');
    checked('real recursive copy, descendant rejection, symlink policy and unpublished partial failure with retained staging');

    const moving = await entry(sourceDir, 'move.txt');
    const movingInode = (await lstat(join(sourceDir, 'move.txt'))).ino;
    await success('move_entry', { source: moving, destination: destinationListing.path });
    await absent(join(sourceDir, 'move.txt'));
    assert.equal((await lstat(join(destinationDir, 'move.txt'))).ino, movingInode);
    await writeFile(join(sourceDir, 'move.txt'), 'conflicting original');
    await rejection('move_entry', { source: await entry(sourceDir, 'move.txt'), destination: destinationListing.path }, 'conflict');
    assert.equal(await readFile(join(sourceDir, 'move.txt'), 'utf8'), 'conflicting original');
    await mkdir(join(sourceDir, 'move-tree', 'child'), { recursive: true });
    await writeFile(join(sourceDir, 'move-tree', 'child', 'file'), 'native directory move');
    const directoryInode = (await lstat(join(sourceDir, 'move-tree'))).ino;
    await success('move_entry', { source: await entry(sourceDir, 'move-tree'), destination: destinationListing.path });
    assert.equal((await lstat(join(destinationDir, 'move-tree'))).ino, directoryInode);
    await absent(join(sourceDir, 'move-tree'));
    checked('real native file/directory moves preserve inode; failure preserves original and conflicting destination');

    const binaryName = Buffer.concat([Buffer.from(`${sourceDir}/non-utf8-`), Buffer.from([0xff])]);
    await writeFile(binaryName, 'native byte identity');
    const nonUtf8 = (await listing(sourceDir)).entries.find(item => item.path === `u:${binaryName.toString('hex')}`);
    assert(nonUtf8?.identity);
    await success('rename_entry', { source: nonUtf8, name: 'formerly-non-utf8.txt' });
    assert.equal(await readFile(join(sourceDir, 'formerly-non-utf8.txt'), 'utf8'), 'native byte identity');
    await absent(binaryName);
    checked('real IPC renames a non-UTF-8 Unix source through its opaque native identity');

    await writeFile(join(sourceDir, 'stale.txt'), 'original selected entry');
    const stale = await entry(sourceDir, 'stale.txt');
    await writeFile(join(sourceDir, 'replacement.txt'), 'unrelated replacement');
    await rename(join(sourceDir, 'stale.txt'), join(sourceDir, 'original-retained.txt'));
    await rename(join(sourceDir, 'replacement.txt'), join(sourceDir, 'stale.txt'));
    await rejection('rename_entry', { source: stale, name: 'must-not-rename.txt' }, 'sourceChanged');
    assert.equal(await readFile(join(sourceDir, 'stale.txt'), 'utf8'), 'unrelated replacement');
    assert.equal(await readFile(join(sourceDir, 'original-retained.txt'), 'utf8'), 'original selected entry');
    await absent(join(sourceDir, 'must-not-rename.txt'));
    checked('real IPC rejects stale source identity and preserves original plus unrelated replacement');

    if (process.getuid() !== 0) {
      const restricted = join(fixture, 'permission-denied');
      await mkdir(restricted);
      await chmod(restricted, 0o500);
      try {
        await rejection('create_directory', { parent: nativePath(restricted), name: 'cannot-create' }, 'permissionDenied');
        await rejection('copy_entry', { source: binary, destination: nativePath(restricted) }, 'permissionDenied');
        assert.deepEqual(await readFile(join(sourceDir, 'bytes.bin')), bytes);
        await absent(join(restricted, 'bytes.bin'));
        checked('real native create/copy permission failures preserve source and publish no destination');
      } finally { await chmod(restricted, 0o700); }
    } else skipped.push('Permission checks require a non-root native process.');

    await go('left', sourceDir); await go('right', destinationDir);
    // A real pointer click also activates the WSLg host surface. XSetInputFocus
    // alone need not transfer the Windows host's keyboard focus into that surface.
    if (!domInput) {
      const frame = JSON.parse(x11('info'));
      const point = await evaluate(`(() => { const r=${q(list('left'))}.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+Math.min(20,r.height/2)}; })()`);
      x11('click', String(frame.x + point.x), String(frame.y + point.y), '1');
    }
    await open('left', null, 'F7', 'Create directory');
    await check(`document.activeElement === ${q('#operation-name')} && ${q('#operation-name')}.value === ''`, 'F7 opens compact directory dialog with focused empty name');
    await fillName('created by native UI');
    await confirm();
    assert((await lstat(join(sourceDir, 'created by native UI'))).isDirectory());
    await check(`${q(selected('left'))}.textContent === 'created by native UI' && document.activeElement === ${q(list('left'))}`, 'native Enter creates, refreshes and selects new directory with list focus restored');
    await open('left', 'created by native UI', 'F2', 'Rename');
    await check(`${q('#operation-name')}.value === 'created by native UI' && document.activeElement === ${q('#operation-name')}`, 'F2 prepopulates selected real name and focuses the input');
    await fillName('renamed by native UI');
    await confirm();
    await absent(join(sourceDir, 'created by native UI'));
    await check(`${q(selected('left'))}.textContent === 'renamed by native UI'`, 'native rename refresh selects returned entry identity');

    await open('left', 'renamed by native UI', 'F5', 'Copy');
    await check(`${q(dialog)}.textContent.includes('renamed by native UI') && ${q(dialog)}.textContent.includes(${JSON.stringify(sourceDir)}) && ${q(dialog)}.textContent.includes(${JSON.stringify(destinationDir)})`, 'F5 confirmation displays actual source and opposite-panel destination');
    await cancel('left');
    await absent(join(destinationDir, 'renamed by native UI'));
    checked('native Escape cancels Copy without mutation and restores pane focus');
    await open('left', 'renamed by native UI', 'F5', 'Copy');
    await confirm();
    assert((await lstat(join(destinationDir, 'renamed by native UI'))).isDirectory());
    await check(`${q(selected('right'))}.textContent === 'renamed by native UI'`, 'native Copy confirmation invokes Rust and refreshes opposite panel selection');
    await open('left', 'renamed by native UI', 'F5', 'Copy');
    await key('Return');
    await until(`${q('#operation-error')} !== null`);
    await check(`${q('#operation-error')}.textContent.includes('conflict') && ${q(dialog)}.open && ${q(dialog)}.contains(document.activeElement)`, 'native Rust conflict stays visible in focused operation dialog');
    await cancel('left');

    await writeFile(join(destinationDir, 'right-to-left.txt'), 'opposite direction');
    await go('right', destinationDir);
    await open('right', 'right-to-left.txt', 'F6', 'Move');
    await confirm();
    assert.equal(await readFile(join(sourceDir, 'right-to-left.txt'), 'utf8'), 'opposite direction');
    await absent(join(destinationDir, 'right-to-left.txt'));
    await check(`${q(selected('left'))}.textContent === 'right-to-left.txt' && document.activeElement === ${q(list('right'))}`, 'F6 uses active right source and left destination, refreshes both and restores source focus');

    await select('left', '[..]');
    for (const shortcut of ['F2', 'F5', 'F6', 'Delete']) {
      await key(shortcut);
      await check(`!${q(dialog)}`, `native ${shortcut} rejects the virtual parent before confirmation or IPC`);
    }
    await evaluate(`${q(input('left'))}.focus()`);
    for (const shortcut of ['F2', 'F5', 'F6', 'F7', 'Delete']) {
      await key(shortcut);
      await check(`!${q(dialog)}`, `native ${shortcut} does not open operations while path input is focused`);
    }
    await key('Escape');
  }

  await writeFile(join(sourceDir, 'trash-cancel.txt'), 'cancellation preserves me');
  await go('left', sourceDir); await go('right', destinationDir);
  await open('left', 'trash-cancel.txt', 'Delete', 'Move to Trash');
  await check(`${q(dialog)}.textContent.includes('trash-cancel.txt') && ${q(dialog)}.textContent.includes('operating system')`, 'Delete displays explicit operating-system Trash confirmation');
  const dimensions = await evaluate('({width:innerWidth,height:innerHeight})');
  const screenshot = await command('Page.snapshotRect', { x: 0, y: 0, ...dimensions, coordinateSystem: 'Viewport' });
  await writeFile('test-results/slice-002-native-dialog.png', Buffer.from(screenshot.dataURL.split(',')[1], 'base64'));
  await cancel('left');
  assert.equal(await readFile(join(sourceDir, 'trash-cancel.txt'), 'utf8'), 'cancellation preserves me');
  checked('native Trash cancellation leaves original bytes intact');

  // A disappearing disposable source must fail visibly and never be retried or
  // replaced with another operation by the renderer.
  await open('left', 'trash-cancel.txt', 'Delete', 'Move to Trash');
  await rm(join(sourceDir, 'trash-cancel.txt'));
  await key('Return');
  await until(`${q('#operation-error')} !== null`);
  await check(`${q(dialog)}.open && ${q('#operation-error')}.textContent.length > 0`, 'real Trash missing-source failure is reported and dialog remains cancellable');
  await cancel('left');

  if (isolatedRoot) {
    const pid = Number(process.env.QPANES_NATIVE_APP_PID);
    assert(Number.isInteger(pid) && pid > 1, 'isolated Trash requires the native app PID');
    const environment = async processId => Object.fromEntries((await readFile(`/proc/${processId}/environ`, 'utf8')).split('\0').filter(Boolean).map(value => {
      const separator = value.indexOf('='); return [value.slice(0, separator), value.slice(separator + 1)];
    }));
    const appEnvironment = await environment(pid);
    assert.equal(appEnvironment.XDG_DATA_HOME, join(isolatedRoot, 'data'));
    assert.equal(appEnvironment.DBUS_SESSION_BUS_ADDRESS, process.env.DBUS_SESSION_BUS_ADDRESS);
    // Resolve the isolated Portal's actual daemon PID without printing its env.
    const owner = execFileSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.GetConnectionUnixProcessID', 'org.freedesktop.portal.Desktop'], { encoding: 'utf8' });
    const portalPid = Number(owner.match(/uint32\s+(\d+)/)?.[1]);
    assert(Number.isInteger(portalPid) && portalPid > 1, 'isolated Portal must be running');
    const portalEnvironment = await environment(portalPid);
    assert.equal(portalEnvironment.XDG_DATA_HOME, join(isolatedRoot, 'data'), 'never use the developer session Trash daemon');
    assert.equal(portalEnvironment.DBUS_SESSION_BUS_ADDRESS, process.env.DBUS_SESSION_BUS_ADDRESS);
    assert.equal((await lstat(sourceDir)).dev, (await lstat(join(isolatedRoot, 'data'))).dev, 'generated source and home Trash data must share a filesystem');
    const trashFiles = join(isolatedRoot, 'data', 'Trash', 'files');
    const trashInfo = join(isolatedRoot, 'data', 'Trash', 'info');
    async function findTrashedFixture(originalPath) {
      // Native Trash may insert a numeric suffix before a filename extension.
      // Its restore metadata, rather than a guessed basename, identifies ours.
      for (const name of await readdir(trashInfo)) {
        if (!name.endsWith('.trashinfo')) continue;
        const metadata = await readFile(join(trashInfo, name), 'utf8');
        const encodedPath = metadata.split('\n').find(line => line.startsWith('Path='))?.slice(5);
        if (encodedPath && decodeURIComponent(encodedPath) === originalPath) {
          return join(trashFiles, name.slice(0, -'.trashinfo'.length));
        }
      }
      assert.fail('isolated native Trash must contain restore metadata for our exact disposable fixture');
    }
    if (process.getuid() !== 0) {
      const readOnlyPath = join(sourceDir, 'trash-readonly.txt');
      await writeFile(readOnlyPath, bytes);
      await chmod(readOnlyPath, 0o400);
      try {
        await rejection('trash_entry', { source: await entry(sourceDir, 'trash-readonly.txt') }, 'trashFailed');
        assert.deepEqual(await readFile(readOnlyPath), bytes);
        checked('real Trash backend failure on read-only fixture leaves source bytes intact and has no deletion fallback');
      } finally { await chmod(readOnlyPath, 0o600); }
    }
    const trashName = `qpanes-native-trash-${process.pid}.txt`;
    await writeFile(join(sourceDir, trashName), bytes);
    await go('left', sourceDir);
    await open('left', trashName, 'Delete', 'Move to Trash');
    await confirm();
    await absent(join(sourceDir, trashName));
    const trashed = await findTrashedFixture(join(sourceDir, trashName));
    assert.deepEqual(await readFile(trashed), bytes);
    await check(`!Array.from(document.querySelectorAll('${list('left')} .filename')).some(el=>el.textContent===${JSON.stringify(trashName)}) && document.activeElement === ${q(list('left'))}`, 'native Delete moves exact fixture bytes to isolated OS Trash and refreshes source focus');
    await mkdir(join(sourceDir, 'trash-native-directory'));
    await writeFile(join(sourceDir, 'trash-native-directory', 'contents.bin'), bytes);
    await success('trash_entry', { source: await entry(sourceDir, 'trash-native-directory') });
    await absent(join(sourceDir, 'trash-native-directory'));
    const trashedDirectory = await findTrashedFixture(join(sourceDir, 'trash-native-directory'));
    assert.deepEqual(await readFile(join(trashedDirectory, 'contents.bin')), bytes);
    checked('real Trash IPC moves directory structure and contents to isolated native Trash');
    nativeTrash = 'verified private D-Bus/Portal process environments and disposable OS Trash';
  } else skipped.push('Native Trash success: no verified disposable D-Bus/Portal environment was supplied; confirmation/cancellation/failure exercised.');

  await check(`window.__nativeOperationKeys.length > 0 && window.__nativeOperationKeys.every(event=>event.trusted === ${!domInput})`, domInput ? 'operation shortcut and dialog input explicitly uses DOM-dispatched events in the real native WebView' : 'all operation shortcut and dialog keys came from trusted native XTest input');
  await go('left', sourceDir); await go('right', destinationDir);
  await select('left', 'tree'); await key('Return');
  await until(`${q(input('left'))}.value === ${JSON.stringify(join(sourceDir, 'tree'))}`);
  await key('BackSpace');
  await until(`${q(input('left'))}.value === ${JSON.stringify(sourceDir)}`);
  await check(`${q(selected('left'))}.textContent === 'tree' && ${q(input('right'))}.value === ${JSON.stringify(destinationDir)}`, 'existing native Enter/Backspace navigation and independent panes survive mutations');
  completed = true;
} finally {
  const report = { mode: `REAL Linux Tauri/Rust IPC + WebKitGTK + ${domInput ? 'DOM-dispatched input (not trusted OS key delivery)' : `trusted XTest operation keys${hostPointer ? ' + WSLg host pointer activation' : ''}`}; disposable mutation fixtures only`, phase,
    completed, passed: passed.length, checks: passed, skipped,
    screenshot: 'test-results/slice-002-native-dialog.png',
    nativeTrash,
    limits: 'Linux/WSLg only. Windows/macOS native behavior is unverified.' };
  await writeFile(`test-results/slice-002-native${phase === 'trash' ? '-trash' : ''}${completed ? '' : '-partial'}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  // This directory was created by this script; no cleanup visits other paths.
  await chmod(sourceDir, 0o700).catch(() => {});
  await rm(fixture, { recursive: true, force: true });
  socket.close();
}
