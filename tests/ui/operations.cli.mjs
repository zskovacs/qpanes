// Run: playwright-cli -s=qpanes-operations run-code --filename=tests/ui/operations.cli.mjs
// MOCKED IPC renderer tests. Native mutation semantics are verified separately.
async (page) => {
  const passed = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const check = (value, message) => { if (!value) throw new Error(message); passed.push(message); };
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.addInitScript(() => {
    const entry = (path, name, kind = 'file') => ({ path, name, kind, identity: `identity:${path}`, size: kind === 'file' ? 17 : null, modifiedMs: 1700000000000, metadataError: null });
    const dirs = {
      '/native/left': [entry('/native/left/directory-id', 'Folder', 'directory'), entry('/native/left/file-id', 'lossy �.txt'), entry('/native/left/brackets-id', '[..]')],
      '/native/right': [entry('/native/right/right-id', 'right.txt')],
      '/native/new': [entry('/native/new/new-id', 'new.txt')],
    };
    window.isTauri = true;
    window.calls = [];
    window.holdMutation = false;
    window.failMutation = null;
    window.holdListing = null;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } }, transformCallback: () => 0, unregisterCallback: () => {},
      invoke: async (command, payload) => {
        if (command.startsWith('plugin:window|')) return command.endsWith('|scale_factor') ? 1 : false;
        if (command.startsWith('plugin:event|')) return 1;
        window.calls.push({ command, payload: structuredClone(payload) });
        if (command === 'sort_directory_entries') {
          const sign = payload.direction === 'ascending' ? 1 : -1;
          return payload.entries.slice().sort((a, b) => (a.kind !== 'directory') - (b.kind !== 'directory') || a.name.localeCompare(b.name) * sign);
        }
        const request = payload.request;
        if (command === 'list_directory') {
          const path = request.target.kind === 'home' ? '/native/left' : request.target.value;
          const entries = (dirs[path] ?? []).map((item) => ({ ...item }));
          if (window.holdListing === path) {
            window.holdListing = null;
            await new Promise((resolve) => { window.finishListing = resolve; });
          }
          return { path, label: path.replace('/native/', '/display/'), parent: '/', entries, warnings: [], sort: request.sort, direction: request.direction };
        }
        if (window.holdMutation) {
          window.holdMutation = false;
          await new Promise((resolve) => { window.finishMutation = resolve; });
        }
        if (window.failMutation) { const error = window.failMutation; window.failMutation = null; throw error; }
        if (command === 'create_directory') {
          const path = `${request.parent}/created-id`;
          dirs[request.parent].push(entry(path, request.name, 'directory'));
          return { path, warnings: [] };
        }
        const parent = Object.keys(dirs).find((key) => dirs[key].some((item) => item.path === request.source.path));
        const selected = dirs[parent]?.find((item) => item.path === request.source.path);
        if (!selected) throw { code: 'notFound', message: 'Entry disappeared.' };
        if (command === 'rename_entry') {
          const path = `${parent}/renamed-id${dirs[parent].some((item) => item.path === `${parent}/renamed-id`) ? '-directory' : ''}`;
          dirs[parent] = dirs[parent].map((item) => item === selected ? entry(path, request.name, item.kind) : item);
          return { path, warnings: [] };
        }
        if (command === 'trash_entry') {
          dirs[parent] = dirs[parent].filter((item) => item !== selected);
          return { path: null, warnings: [] };
        }
        if (command === 'copy_entry' || command === 'move_entry') {
          if (request.destination === parent) throw { code: 'sameEntry', message: 'Source and destination are the same entry.' };
          const path = `${request.destination}/${command === 'copy_entry' ? 'copied' : 'moved'}-id${dirs[request.destination].some((item) => item.path === `${request.destination}/copied-id`) ? '-again' : ''}`;
          dirs[request.destination].push(entry(path, selected.name, selected.kind));
          if (command === 'move_entry') dirs[parent] = dirs[parent].filter((item) => item !== selected);
          return { path, warnings: [] };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto('http://127.0.0.1:1420');
  const panel = (side) => page.getByRole('region', { name: `${side} panel`, exact: true });
  const list = (side) => page.getByRole('listbox', { name: `${side} files`, exact: true });
  const path = (side) => page.getByRole('textbox', { name: `${side} directory path`, exact: true });
  const ready = async (side) => page.waitForFunction((s) => document.querySelector(`[aria-label="${s} files"]`)?.getAttribute('aria-busy') === 'false', side);
  const selected = (side) => list(side).locator('[aria-selected="true"] .filename').textContent();
  const focused = (locator) => locator.evaluate((el) => el === document.activeElement);
  const dialog = () => page.getByRole('dialog', { name: /^(Create directory|Rename|Copy|Move|Move to Trash)$/ });
  const mutationCount = () => page.evaluate(() => window.calls.filter(({ command }) => !['list_directory', 'sort_directory_entries'].includes(command)).length);
  const lastMutation = () => page.evaluate(() => window.calls.filter(({ command }) => !['list_directory', 'sort_directory_entries'].includes(command)).at(-1));
  const go = async (side, value) => { await path(side).fill(value); await path(side).press('Enter'); await ready(side); };
  const select = async (side, name) => { await list(side).locator('.file-row').filter({ has: page.locator('.filename', { hasText: name }) }).click(); };
  const closed = async () => { await page.waitForFunction(() => !document.querySelector('dialog[open]')); };
  const cancel = async () => { await dialog().press('Escape'); await closed(); };
  const start = async (side, key) => { await list(side).focus(); await list(side).press(key); await dialog().waitFor(); };
  await ready('left'); await ready('right');
  await go('right', '/native/right');

  await list('left').press('Home');
  for (const key of ['F2', 'F5', 'F6', 'Delete']) {
    await list('left').press(key);
    check(await dialog().count() === 0, `${key} cannot open a mutation for the virtual parent`);
  }
  check(await mutationCount() === 0, 'virtual parent never enters mutation IPC');
  await path('left').focus();
  for (const key of ['F2', 'F5', 'F6', 'F7', 'Delete']) await path('left').press(key);
  check(await dialog().count() === 0 && await mutationCount() === 0, 'mutation shortcuts are ignored while editing a path');
  await path('left').press('Escape');
  await list('left').press('Shift+Delete');
  check(await dialog().count() === 0 && await mutationCount() === 0, 'Shift+Delete performs no permanent deletion');

  await list('left').locator('.file-row:has(.entry-icon.file)').filter({ has: page.locator('.filename', { hasText: '[..]' }) }).click();
  await start('left', 'F2');
  check(await dialog().getByRole('textbox', { name: 'New name' }).inputValue() === '[..]', 'a real entry named [..] remains distinct from the protected parent action');
  await cancel();

  await start('left', 'F7');
  const createName = dialog().getByRole('textbox', { name: 'Directory name' });
  check(await focused(createName) && await createName.inputValue() === '', 'F7 opens a focused empty name input');
  await createName.press('Tab');
  check(await focused(dialog().getByRole('button', { name: 'Cancel', exact: true })), 'Tab moves through dialog controls');
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).press('Shift+Tab');
  check(await focused(createName), 'Shift+Tab keeps focus inside the native modal');
  check((await dialog().textContent()).includes('/display/left'), 'create dialog shows the current directory label');
  await createName.press('Enter');
  check(await dialog().getByRole('alert').isVisible() && await mutationCount() === 0, 'empty name shows validation feedback without IPC');
  await createName.fill('árvíz 🦀'); await createName.press('Enter'); await closed(); await ready('left');
  check((await lastMutation()).command === 'create_directory' && (await lastMutation()).payload.request.parent === '/native/left', 'create sends opaque active parent identity');
  check(await selected('left') === 'árvíz 🦀' && await focused(list('left')), 'create refreshes, selects new directory and restores list focus');
  check(await selected('right') === 'right.txt', 'create leaves the independent opposite pane selection alone');

  await select('left', 'lossy �.txt');
  await start('left', 'F2');
  const renameName = dialog().getByRole('textbox', { name: 'New name' });
  check(await renameName.inputValue() === 'lossy �.txt' && await focused(renameName), 'F2 prepopulates and focuses the current name');
  check(await renameName.evaluate((el) => el.selectionStart === 0 && el.selectionEnd === el.value.length), 'rename input initially selects the whole name');
  await renameName.press('F5');
  check(await dialog().getByRole('heading', { name: 'Rename', exact: true }).isVisible(), 'function keys while naming do not trigger another operation or reload');
  await renameName.fill('renamed 🦀.txt'); await renameName.press('Enter'); await closed(); await ready('left');
  const rename = await lastMutation();
  check(rename.payload.request.source.path === '/native/left/file-id' && rename.payload.request.source.identity === 'identity:/native/left/file-id', 'rename preserves native source and identity despite lossy display name');
  check(await selected('left') === 'renamed 🦀.txt', 'rename refresh selects the returned native identity');

  const beforeCancel = await mutationCount();
  await start('left', 'F5');
  check((await dialog().textContent()).includes('renamed 🦀.txt') && (await dialog().textContent()).includes('/display/left') && (await dialog().textContent()).includes('/display/right'), 'copy dialog shows operation, source name and both locations');
  check(await focused(dialog().getByRole('button', { name: 'Copy', exact: true })), 'copy confirmation receives keyboard focus');
  await cancel();
  check(await mutationCount() === beforeCancel && await focused(list('left')), 'Escape cancels copy without IPC and restores source focus');
  await start('left', 'Delete');
  check((await dialog().textContent()).includes('operating system’s Trash') && (await dialog().textContent()).includes('renamed 🦀.txt'), 'Delete explains Trash and names the selected entry');
  await dialog().getByRole('button', { name: 'Cancel', exact: true }).click(); await closed();
  check(await mutationCount() === beforeCancel, 'Trash cancellation never calls the core');

  await page.evaluate(() => { window.holdMutation = true; });
  await start('left', 'F5');
  await dialog().getByRole('button', { name: 'Copy', exact: true }).press('Enter');
  await page.waitForFunction(() => typeof window.finishMutation === 'function');
  await dialog().locator('form').evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await dialog().press('Escape');
  check(await dialog().isVisible() && await dialog().getByRole('status').isVisible() && await dialog().getByRole('button', { name: 'Cancel' }).isDisabled(), 'busy state is visible and cannot be dismissed during execution');
  check(await mutationCount() === beforeCancel + 1, 'repeated submission cannot execute a duplicate mutation');
  await page.evaluate(() => { window.finishMutation(); delete window.finishMutation; });
  await closed(); await ready('right');
  const copy = await lastMutation();
  check(copy.command === 'copy_entry' && copy.payload.request.source.path === '/native/left/renamed-id' && copy.payload.request.destination === '/native/right', 'F5 copies active real source into the opposite native directory');
  check(await selected('right') === 'renamed 🦀.txt' && await selected('left') === 'renamed 🦀.txt', 'copy selects the destination and preserves the source selection');
  check(await focused(list('left')), 'copy completion restores the source list focus');

  await page.evaluate(() => { window.failMutation = { code: 'permissionDenied', message: 'Permission denied. Source remains intact.' }; });
  await start('right', 'F6'); await dialog().getByRole('button', { name: 'Move', exact: true }).press('Enter');
  await dialog().getByRole('alert').waitFor();
  check((await dialog().getByRole('alert').textContent()).includes('Source remains intact.'), 'structured operation errors remain visible in the confirmation dialog');
  check(await focused(dialog().getByRole('button', { name: 'Move', exact: true })), 'failure restores focus to the enabled confirmation control');
  const failedMove = await lastMutation();
  check(failedMove.command === 'move_entry' && failedMove.payload.request.source.path === '/native/right/copied-id' && failedMove.payload.request.destination === '/native/left', 'right-active move reverses source and destination correctly');
  await cancel();
  check(await focused(list('right')) && await path('right').inputValue() === '/display/right', 'error cancellation returns focus without losing directory navigation');

  await start('right', 'F6'); await dialog().getByRole('button', { name: 'Move', exact: true }).press('Enter');
  await closed(); await ready('left'); await ready('right');
  check(await selected('left') === 'renamed 🦀.txt' && !(await list('right').locator('.filename').allTextContents()).includes('renamed 🦀.txt'), 'move refreshes both panels and selects its returned destination identity');
  await start('right', 'Delete'); await dialog().getByRole('button', { name: 'Move to Trash', exact: true }).press('Enter');
  await closed(); await ready('right');
  check((await lastMutation()).command === 'trash_entry' && await selected('right') === '[..]', 'confirmed Trash refreshes the source and gives an empty pane a valid parent selection');

  await select('left', 'Folder');
  await page.evaluate(() => { window.holdMutation = true; });
  await start('left', 'F5'); await dialog().getByRole('button', { name: 'Copy', exact: true }).press('Enter');
  await page.waitForFunction(() => typeof window.finishMutation === 'function');
  // A programmatic navigation simulates an external/newer navigation while the modal owns input.
  await page.evaluate(() => { const input = document.querySelector('[aria-label="right directory path"]'); input.value = '/native/new'; input.dispatchEvent(new Event('input', { bubbles: true })); input.form.requestSubmit(); });
  await ready('right');
  const listCallsBefore = await page.evaluate(() => window.calls.filter(({ command }) => command === 'list_directory').length);
  await page.evaluate(() => { window.finishMutation(); delete window.finishMutation; }); await closed();
  check(await path('right').inputValue() === '/display/new' && await selected('right') === 'new.txt', 'stale operation completion never returns a pane to its captured destination');
  check(await page.evaluate(() => window.calls.filter(({ command }) => command === 'list_directory').length) === listCallsBefore, 'stale operation completion avoids unnecessary enumeration after navigation');

  await go('right', '/native/right');
  await page.evaluate(() => { window.holdListing = '/native/right'; });
  await start('left', 'F5'); await dialog().getByRole('button', { name: 'Copy', exact: true }).press('Enter');
  await closed(); await page.waitForFunction(() => typeof window.finishListing === 'function');
  await go('right', '/native/new');
  await page.evaluate(() => { window.finishListing(); delete window.finishListing; });
  check(await path('right').inputValue() === '/display/new' && await selected('right') === 'new.txt', 'stale operation refresh response cannot replace newer navigation');

  await go('right', '/native/left');
  await select('left', 'Folder'); await start('left', 'F2');
  await dialog().getByRole('textbox', { name: 'New name' }).fill('Renamed folder');
  await dialog().getByRole('textbox', { name: 'New name' }).press('Enter');
  await closed(); await ready('left'); await ready('right');
  check(await selected('left') === 'Renamed folder' && await selected('right') === 'Renamed folder', 'rename refreshes both panels when both display the affected directory');
  await panel('left').getByRole('button', { name: 'Sort left by name, ascending', exact: true }).click(); await ready('left');
  check(await panel('left').getByRole('button', { name: 'Sort left by name, descending', exact: true }).getAttribute('aria-pressed') === 'true', 'sorting still works after operations');
  await list('left').press('Home'); await list('left').press('ArrowDown');
  check(await selected('left') === 'Renamed folder', 'keyboard navigation retains the virtual parent offset after operations');

  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  check(await dialog().getByRole('textbox', { name: 'Directory name' }).isVisible(), 'operation controls remain accessible without function keys');
  await page.screenshot({ path: 'test-results/slice-002-create-mocked.png' });
  await page.setViewportSize({ width: 720, height: 420 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'compact operation dialog has no whole-app horizontal overflow');
  await page.screenshot({ path: 'test-results/slice-002-compact-mocked.png' });
  await cancel();
  check(errors.length === 0, `no renderer runtime errors (${errors.join(', ')})`);
  return { mode: 'MOCKED IPC Slice 002 renderer verification', passed: passed.length, checks: passed };
}
