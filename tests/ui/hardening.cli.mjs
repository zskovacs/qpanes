// Additional Slice 001 regressions. MOCKED IPC; input uses real Playwright keyboard/mouse events.
// Run after starting Vite: playwright-cli -s=qpanes --raw run-code --filename=tests/ui/hardening.cli.mjs
async (page) => {
  const passed = [];
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const check = (value, message) => { if (!value) throw new Error(message); passed.push(message); };
  await page.addInitScript(() => {
    const file = (path, name, kind = 'file', size = 2048, modifiedMs = 1700000000000) => ({ path, name, kind, size: kind === 'file' ? size : null, modifiedMs, metadataError: null });
    const child = file('/home/Child', 'Child', 'directory');
    const sample = file('/home/Sample.bin', 'Sample.bin');
    const c = window.qpanesTest = {
      requests: [], pending: [], deferredPaths: [], deferSort: false, errors: {}, keys: [],
      directories: {
        '/': { parent: null, entries: [file('/root.txt', 'root.txt')] },
        '/home': { parent: '/', entries: [child, sample, file('/home/literal', '[..]')] },
        '/home/Child': { parent: '/home', entries: [] },
        '/retry': { parent: '/', entries: [] },
        '/other': { parent: '/', entries: [file('/other/other.txt', 'other.txt')] },
        '/slow': { parent: '/', entries: [file('/slow/new', 'new', 'file', 50, 1800000000000), file('/slow/old', 'old', 'file', 1, 1600000000000)] },
        '/winroot': { parent: null, label: 'C:\\', entries: [] },
        '/uncroot': { parent: null, label: '\\\\server\\share\\', entries: [] },
        '/many': { parent: '/', entries: Array.from({ length: 10000 }, (_, i) => file(`/many/folder-${String(i).padStart(5, '0')}`, `folder-${String(i).padStart(5, '0')}`, 'directory')) },
        '/many/folder-09999': { parent: '/many', entries: [] },
      },
      release(path) { const index = this.pending.findIndex((p) => p.path === path); if (index < 0) throw new Error(`No pending ${path}`); this.pending.splice(index, 1)[0].resolve(); },
    };
    window.addEventListener('keydown', (event) => c.keys.push({ key: event.key, trusted: event.isTrusted }), true);
    const sorted = (entries, key, direction) => entries.slice().sort((a, b) => {
      if ((a.kind === 'directory') !== (b.kind === 'directory')) return a.kind === 'directory' ? -1 : 1;
      const name = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.path.localeCompare(b.path);
      const sign = direction === 'ascending' ? 1 : -1;
      if (key === 'name') return name * sign;
      const property = key === 'size' ? 'size' : 'modifiedMs';
      if (a[property] === null || b[property] === null) return a[property] === b[property] ? name : a[property] === null ? 1 : -1;
      return (a[property] - b[property]) * sign || name;
    });
    const hold = (path) => new Promise((resolve) => c.pending.push({ path, resolve }));
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 0,
      unregisterCallback: () => {},
      invoke: async (command, payload) => {
      if (command.startsWith('plugin:window|')) return command.endsWith('|scale_factor') ? 1 : false;
      if (command.startsWith('plugin:event|')) return 1;
        if (command === 'list_operations') return { revision: 0, invalidationRevision: 0, jobs: [], accepting: true, closeRequested: false, shutdownState: 'idle' };
      const request = command === 'list_directory' ? payload.request : payload;
      c.requests.push({ command, ...request });
      if (command === 'sort_directory_entries') {
        if (request.entries.some((entry) => entry.kind === 'parent')) throw new Error('Virtual parent leaked into filesystem IPC');
        if (c.deferSort) { c.deferSort = false; await hold('sort'); }
        return sorted(request.entries, request.sort, request.direction);
      }
      if (command !== 'list_directory') throw new Error(`Unexpected ${command}`);
      const path = request.target.kind === 'home' ? '/home' : request.target.value;
      const deferred = c.deferredPaths.indexOf(path);
      if (deferred >= 0) { c.deferredPaths.splice(deferred, 1); await hold(path); }
      if (c.errors[path]) throw c.errors[path];
      const directory = c.directories[path];
      if (!directory) throw { code: 'notFound', message: 'Directory not found' };
      return { path, label: directory.label ?? path, parent: directory.parent,
        entries: sorted(directory.entries, request.sort, request.direction), warnings: [], sort: request.sort, direction: request.direction };
    } };
  });
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.goto('http://127.0.0.1:1420');
  const list = (side) => page.getByRole('listbox', { name: `${side} files`, exact: true });
  const pane = (side) => page.getByRole('region', { name: `${side} panel`, exact: true });
  const path = (side) => page.getByRole('textbox', { name: `${side} directory path`, exact: true });
  const parentRow = (side) => list(side).getByRole('option', { name: '[..] Parent directory', exact: true });
  const ready = (side) => page.waitForFunction((side) => document.querySelector(`[aria-label="${side} files"]`)?.getAttribute('aria-busy') === 'false', side);
  const selected = (side) => list(side).locator('[aria-selected="true"] .filename').textContent();
  const focused = (locator) => locator.evaluate((element) => element === document.activeElement);
  const go = async (side, target) => { await path(side).fill(target); await path(side).press('Enter'); await ready(side); };
  const pending = (target) => page.waitForFunction((target) => window.qpanesTest.pending.some((p) => p.path === target), target);
  const release = (target) => page.evaluate((target) => window.qpanesTest.release(target), target);
  const sortButton = (side, key) => pane(side).getByRole('button', { name: new RegExp(`^Sort ${side} by ${key},`) });
  const reads = () => page.evaluate(() => window.qpanesTest.requests.filter((r) => r.command === 'list_directory').length);
  await ready('left'); await ready('right');

  check(await list('left').locator('.filename').first().textContent() === '[..]', 'parent is the first logical row');
  check(await selected('left') === 'Child', 'initial selection preserves the first real-entry convention');
  check((await pane('left').locator('.pane-status').textContent()).includes('3 items'), 'virtual parent is excluded from real counts');
  await list('left').getByRole('option').filter({ hasText: 'File' }).filter({ hasText: '[..]' }).click();
  const literalReads = await reads();
  await page.keyboard.press('Enter');
  check(await reads() === literalReads && await path('left').inputValue() === '/home', 'a real file named [..] remains distinct from the parent action');
  await page.keyboard.press('Home');
  check(await selected('left') === '[..]', 'Home selects virtual parent');
  await page.keyboard.press('ArrowDown');
  check(await selected('left') === 'Child', 'ArrowDown moves from parent to first real entry');
  await page.keyboard.press('Enter'); await ready('left');
  check(await parentRow('left').isVisible() && await selected('left') === '[..]', 'empty child selects its navigable virtual parent');
  await page.keyboard.press('Enter'); await ready('left');
  check(await path('left').inputValue() === '/home' && await selected('left') === 'Child', 'parent Enter restores the exited child selection');
  await page.keyboard.press('Enter'); await ready('left');
  await parentRow('left').dblclick(); await ready('left');
  check(await selected('left') === 'Child', 'parent double-click restores child selection');
  await page.keyboard.press('Enter'); await ready('left');
  await page.keyboard.press('Backspace'); await ready('left');
  check(await selected('left') === 'Child', 'Backspace matches parent-entry navigation');
  check(await path('right').inputValue() === '/home' && await selected('right') === 'Child', 'parent navigation leaves inactive pane unchanged');
  const beforeSortReads = await reads();
  for (const key of ['name', 'size', 'modified']) {
    for (let direction = 0; direction < 2; direction++) {
      await sortButton('left', key).click(); await ready('left');
      check(await list('left').locator('.filename').first().textContent() === '[..]', `parent remains first for ${key}, direction ${direction + 1}`);
    }
  }
  check(await reads() === beforeSortReads, 'sorting loaded data performs no filesystem listing requests');
  check(await selected('left') === 'Child', 'sorting preserves selection by real native identity');
  check(await page.evaluate(() => window.qpanesTest.requests.filter((r) => r.command === 'sort_directory_entries').every((r) => r.entries.every((e) => e.kind !== 'parent'))), 'parent action never enters real-entry sorting IPC');
  for (const root of ['/', '/winroot', '/uncroot']) {
    await go('left', root);
    check(await parentRow('left').count() === 0 && await pane('left').getByRole('button', { name: 'left: parent directory', exact: true }).isDisabled(), `no parent for backend-supplied root ${root}`);
  }

  await go('left', '/home');
  await page.evaluate(() => window.qpanesTest.deferredPaths.push('/slow'));
  await path('left').fill('/slow'); await path('left').press('Enter'); await pending('/slow');
  const pendingReadCount = await reads();
  for (const key of ['name', 'size', 'modified', 'size', 'modified']) await sortButton('left', key).click();
  await sortButton('right', 'modified').click(); await ready('right');
  check(await reads() === pendingReadCount, 'repeated sort changes do not issue a request for the old directory');
  await release('/slow'); await ready('left');
  check(await path('left').inputValue() === '/slow', 'sort changes preserve pending navigation destination');
  check((await list('left').locator('.filename').allTextContents()).join('|') === '[..]|old|new', 'arriving destination uses the latest modification sort');
  check(await path('right').inputValue() === '/home', 'pending sorting/navigation is pane-local');
  check(await sortButton('right', 'modified').getAttribute('aria-pressed') === 'true', 'both panels keep independent sort preferences during pending navigation');
  const memoryReads = await reads();
  await page.evaluate(() => { window.qpanesTest.deferSort = true; });
  await sortButton('left', 'size').click(); await pending('sort');
  for (const key of ['name', 'modified', 'modified']) await sortButton('left', key).click();
  await release('sort'); await ready('left');
  check((await list('left').locator('.filename').allTextContents()).join('|') === '[..]|new|old', 'sort changes during a deferred memory sort settle to the latest preference');
  check(await reads() === memoryReads, 'repeated memory sorts do not re-enumerate the filesystem');
  await page.evaluate(() => window.qpanesTest.deferredPaths.push('/slow'));
  await path('left').fill('/slow'); await path('left').press('Enter'); await pending('/slow');
  await go('left', '/other'); await release('/slow');
  check(await path('left').inputValue() === '/other', 'old navigation response cannot replace a newer destination');
  await page.evaluate(() => { window.qpanesTest.deferSort = true; });
  await sortButton('left', 'name').click(); await pending('sort');
  await go('left', '/home'); await release('sort');
  check(await path('left').inputValue() === '/home', 'old memory-sort response cannot replace newer navigation');

  await page.evaluate(() => { window.qpanesTest.errors['/retry'] = { code: 'permissionDenied', message: 'Permission denied' }; });
  await go('left', '/retry');
  await list('left').focus(); await page.keyboard.press('Shift+Tab');
  check(await focused(pane('left').getByRole('button', { name: 'Retry', exact: true })), 'Retry is reachable with normal reverse-tab navigation');
  await page.evaluate(() => { delete window.qpanesTest.errors['/retry']; window.qpanesTest.deferredPaths.push('/retry'); });
  await page.keyboard.press('Enter'); await pending('/retry');
  check(await focused(list('left')), 'keyboard Retry transfers focus before the banner disappears');
  await release('/retry'); await ready('left');
  check(await focused(list('left')) && await selected('left') === '[..]', 'successful Retry into an empty directory keeps usable list focus');
  await page.keyboard.press('Enter'); await ready('left');
  check(await path('left').inputValue() === '/', 'Enter works immediately after successful Retry without refocusing');
  await go('left', '/home');
  await page.evaluate(() => { window.qpanesTest.errors['/retry'] = { code: 'permissionDenied', message: 'Permission denied' }; });
  await go('left', '/retry');
  await pane('left').getByRole('button', { name: 'Retry', exact: true }).click(); await ready('left');
  check(await focused(list('left')), 'failed pointer Retry also retains list focus');
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
  check(await selected('left') === 'Child', 'arrows work after failed Retry without a focus helper');
  await page.evaluate(() => { delete window.qpanesTest.errors['/retry']; window.qpanesTest.deferredPaths.push('/retry'); });
  await list('left').focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter'); await pending('/retry');
  await page.keyboard.press('Tab');
  check(await focused(list('right')), 'user can switch panels while Retry is pending');
  await release('/retry'); await ready('left');
  check(await focused(list('right')), 'successful Retry never steals focus back from the other panel');
  await page.evaluate(() => { window.qpanesTest.errors['/retry'] = { code: 'permissionDenied', message: 'Permission denied' }; });
  await go('left', '/retry');
  await page.evaluate(() => window.qpanesTest.deferredPaths.push('/retry'));
  await pane('left').getByRole('button', { name: 'Retry', exact: true }).click(); await pending('/retry');
  await path('right').fill('/intentional-edit'); await release('/retry'); await ready('left');
  check(await focused(path('right')) && await path('right').inputValue() === '/intentional-edit', 'failed Retry never steals focus from an intentionally edited control');
  await page.evaluate(() => { delete window.qpanesTest.errors['/retry']; window.qpanesTest.deferredPaths.push('/retry'); });
  await pane('left').getByRole('button', { name: 'Retry', exact: true }).click(); await pending('/retry');
  await path('left').fill('/next-intentional-path'); await release('/retry'); await ready('left');
  check(await focused(path('left')) && await path('left').inputValue() === '/next-intentional-path', 'successful Retry preserves focus and an intentional edit in the same panel');

  await go('left', '/home'); await go('right', '/home');
  const slider = page.getByRole('slider', { name: 'Resize panels', exact: true });
  await page.setViewportSize({ width: 720, height: 420 });
  for (const split of [50, 30, 70]) {
    await slider.focus(); await page.keyboard.press('Home');
    for (let i = 0; i < Math.abs(split - 50) / 2; i++) await page.keyboard.press(split < 50 ? 'ArrowLeft' : 'ArrowRight');
    for (const side of ['left', 'right']) {
      const compact = pane(side).getByRole('combobox', { name: `${side} sort by`, exact: true });
      for (const key of ['name', 'size', 'modified']) {
        if (await compact.isVisible()) {
          await compact.focus();
          await page.keyboard.press(key === 'name' ? 'Home' : key === 'modified' ? 'End' : 'Home');
          if (key === 'size') await page.keyboard.press('ArrowDown');
          await ready(side);
          check(await compact.inputValue() === key, `${split}% split: ${side} compact ${key} sorting works with keyboard`);
        } else {
          await sortButton(side, key).click(); await ready(side);
          check(await sortButton(side, key).getAttribute('aria-pressed') === 'true', `${split}% split: ${side} ${key} header remains available`);
        }
      }
      if (await compact.isVisible()) {
        const reverse = pane(side).getByRole('button', { name: `${side}: reverse sort direction`, exact: true });
        const previousDirection = await reverse.getAttribute('title');
        await reverse.focus(); await page.keyboard.press('Enter'); await ready(side);
        check(await reverse.getAttribute('title') !== previousDirection && await list(side).locator('.filename').first().textContent() === '[..]', `${split}% split: ${side} compact direction button works with keyboard and keeps parent first`);
      }
      await list(side).getByRole('option').filter({ hasText: 'Sample.bin' }).click();
      await page.keyboard.press('Alt+Enter');
      const details = pane(side).getByRole('region', { name: `${side} selection details`, exact: true });
      check(await details.isVisible() && (await details.textContent()).includes('2,048 bytes') && (await details.textContent()).includes('Modified') && (await details.textContent()).includes('File'), `${split}% split: ${side} complete selected metadata remains accessible`);
      check(await focused(pane(side).locator('summary')), `${split}% split: ${side} selection details have keyboard focus`);
      await page.keyboard.press('Escape');
      check(await focused(list(side)), `${split}% split: ${side} Escape returns to list`);
    }
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${split}% split has no whole-window horizontal scrolling at 720×420`);
  }
  await slider.focus(); await page.keyboard.press('Home');
  await list('left').focus(); await page.keyboard.press('Alt+Enter');
  await page.screenshot({ path: 'test-results/slice-001-hardening-compact.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1200, height: 780 });
  await slider.focus(); await page.keyboard.press('Home');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  const desktopCompact = pane('left').getByRole('combobox', { name: 'left sort by', exact: true });
  check(await desktopCompact.isVisible() && await sortButton('right', 'modified').isVisible() && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '1200×780 unequal panes retain compact and full controls without window overflow');
  await desktopCompact.focus(); await page.keyboard.press('Home'); await ready('left');
  await page.keyboard.press('End'); await ready('left');
  check(await desktopCompact.inputValue() === 'modified', 'desktop unequal compact pane retains keyboard modification sorting');
  await list('left').getByRole('option').filter({ hasText: 'Sample.bin' }).click(); await page.keyboard.press('Alt+Enter');
  check(await pane('left').getByRole('region', { name: 'left selection details', exact: true }).isVisible(), 'desktop unequal compact pane retains selected metadata');
  await page.screenshot({ path: 'test-results/slice-001-hardening-unequal.png' });
  await page.keyboard.press('Escape'); await slider.focus(); await page.keyboard.press('Home');
  await go('left', '/many');
  // Ensure name ascending before the offscreen child-restoration exercise.
  await sortButton('left', 'name').click(); await ready('left');
  if (await sortButton('left', 'name').getAttribute('aria-label') === 'Sort left by name, descending') { await sortButton('left', 'name').click(); await ready('left'); }
  await list('left').focus(); await page.keyboard.press('End');
  check(await selected('left') === 'folder-09999', 'virtualized list reaches last real entry with parent offset');
  await page.keyboard.press('Enter'); await ready('left'); await page.keyboard.press('Enter'); await ready('left');
  check(await selected('left') === 'folder-09999' && await list('left').evaluate((el) => el.scrollTop > 0), 'returning from an offscreen child restores selection and scrolls it into view');
  check(await list('left').getByRole('option').count() < 60 && (await pane('left').locator('.pane-status').textContent()).includes('10,000 items'), 'virtual parent does not defeat virtualization or inflate counts');
  await page.keyboard.press('Home');
  check(await selected('left') === '[..]', 'virtual parent can be selected again after offscreen restoration');
  await go('left', '/home/Child');
  await page.evaluate(() => { window.qpanesTest.directories['/home'].entries = window.qpanesTest.directories['/home'].entries.filter((e) => e.name !== 'Child'); });
  await page.keyboard.press('Enter'); await ready('left');
  check(await path('left').inputValue() === '/home' && await list('left').locator('[aria-selected="true"]').count() === 1 && await selected('left') !== 'Child', 'missing exited child falls back to a valid real selection');
  await page.screenshot({ path: 'test-results/slice-001-hardening-desktop.png' });
  check(await page.evaluate(() => window.qpanesTest.keys.length > 20 && window.qpanesTest.keys.every((key) => key.trusted)), 'focus/navigation regressions used trusted browser keyboard events');
  check(runtimeErrors.length === 0, `no renderer runtime errors (${runtimeErrors.join(', ')})`);
  return { mode: 'MOCKED IPC hardening regressions with trusted browser input', passed: passed.length, checks: passed };
}
