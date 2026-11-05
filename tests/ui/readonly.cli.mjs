// Run with: playwright-cli -s=qpanes run-code --filename=tests/ui/readonly.cli.mjs
// Renderer acceptance tests with MOCKED IPC. Does not verify native filesystem I/O.
async (page) => {
  const passed = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const check = (value, message) => { if (!value) throw new Error(message); passed.push(message); };
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.addInitScript(() => {
    const entry = (name, kind, size = null, modifiedMs = 1700000000000) => ({
      path: `/fixture/${name}`, name, kind, size, modifiedMs, metadataError: null,
    });
    const root = [entry('Empty', 'directory'), entry('Projects', 'directory'), entry('Restricted', 'directory'),
      entry('.hidden', 'file', 0), entry('a.txt', 'file', 12), entry('z.bin', 'file', 2048, 1800000000000),
      entry('linked-folder', 'symlink'), entry('árvíz 🦀.txt', 'file', 24),
      { ...entry('vanished', 'unknown'), metadataError: 'Metadata unavailable: entry disappeared' },
      entry('a-very-long-filename-that-should-truncate-without-overflowing-the-panel.md', 'file', 128)];
    window.isTauri = true;
    window.ipcRequests = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback: () => 0,
      unregisterCallback: () => {},
      invoke: async (command, payload) => {
        if (command.startsWith('plugin:window|')) return command.endsWith('|scale_factor') ? 1 : false;
        if (command.startsWith('plugin:event|')) return 1;
        if (!['list_directory', 'sort_directory_entries'].includes(command)) throw new Error(`Unexpected command ${command}`);
        const request = command === 'list_directory' ? payload.request : payload;
        window.ipcRequests.push(request);
        const path = command === 'list_directory' ? request.target.kind === 'home' ? '/fixture' : request.target.value : '';
        if (path === '/slow') await new Promise((resolve) => { window.finishSlow = resolve; });
        else await new Promise((resolve) => setTimeout(resolve, 35));
        if (path === '/missing' || path === '/fixture/Restricted') {
          throw { code: path === '/missing' ? 'notFound' : 'permissionDenied', message: path === '/missing' ? 'Directory not found' : 'Permission denied' };
        }
        let entries = command === 'sort_directory_entries' ? request.entries.slice() : path === '/fixture' ? root.slice() : path === '/fixture/Projects' ? [
          { ...entry('src', 'directory'), path: '/fixture/Projects/src' },
          { ...entry('README.md', 'file', 100), path: '/fixture/Projects/README.md' },
        ] : path === '/large' ? Array.from({ length: 10000 }, (_, i) => ({ ...entry(`file-${String(i).padStart(5, '0')}.txt`, 'file', i), path: `/large/${i}` })) : [];
        const name = (a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.path.localeCompare(b.path);
        entries.sort((a, b) => {
          if ((a.kind === 'directory') !== (b.kind === 'directory')) return a.kind === 'directory' ? -1 : 1;
          const sign = request.direction === 'ascending' ? 1 : -1;
          if (request.sort === 'name') return name(a, b) * sign;
          const key = request.sort === 'size' ? 'size' : 'modifiedMs';
          if (a[key] === null || b[key] === null) return a[key] === b[key] ? name(a, b) : a[key] === null ? 1 : -1;
          return (a[key] - b[key]) * sign || name(a, b);
        });
        if (command === 'sort_directory_entries') return entries;
        return { path, label: path, parent: path === '/' ? null : path === '/fixture/Projects/src' ? '/fixture/Projects' : path.startsWith('/fixture/') ? '/fixture' : '/',
          entries, warnings: path === '/warning' ? ['Some entries could not be read'] : [], sort: request.sort, direction: request.direction };
      },
    };
  });
  await page.goto('http://127.0.0.1:1420');
  const panel = (side) => page.getByRole('region', { name: `${side} panel`, exact: true });
  const list = (side) => page.getByRole('listbox', { name: `${side} files`, exact: true });
  const path = (side) => page.getByRole('textbox', { name: `${side} directory path`, exact: true });
  const ready = async (side) => { await page.waitForFunction((s) => document.querySelector(`[aria-label="${s} files"]`)?.getAttribute('aria-busy') === 'false', side); };
  const selected = async (side) => list(side).locator('[aria-selected="true"] .filename').textContent();
  const go = async (side, value) => { await path(side).fill(value); await path(side).press('Enter'); await ready(side); };
  await ready('left'); await ready('right');
  check(await path('left').inputValue() === '/fixture' && await path('right').inputValue() === '/fixture', 'both panels load directory fixtures');
  check(await list('left').evaluate((el) => el === document.activeElement), 'initial keyboard focus is in left panel');
  check(await selected('left') === 'Empty', 'directory-first initial selection');
  await list('left').press('Enter'); await ready('left');
  check(await path('left').inputValue() === '/fixture/Empty' && await path('right').inputValue() === '/fixture', 'Enter navigates only the active panel');
  check(await panel('left').getByText('This folder is empty').isVisible(), 'empty state is visible');
  await list('left').press('Backspace'); await ready('left');
  check(await selected('left') === 'Empty', 'Backspace restores parent and selects child');
  await list('left').press('ArrowDown');
  check(await selected('left') === 'Projects', 'ArrowDown moves selection');
  await list('left').press('ArrowUp');
  check(await selected('left') === 'Empty', 'ArrowUp moves selection');
  await list('left').press('ArrowDown'); await list('left').press('Enter'); await ready('left');
  await list('left').press('Tab');
  check(await list('right').evaluate((el) => el === document.activeElement) && await panel('right').evaluate((el) => el.classList.contains('active')), 'Tab switches focus and active panel');
  check(await selected('left') === 'src' && await selected('right') === 'Empty', 'panels retain independent selection');
  await list('right').press('Control+l');
  check(await path('right').evaluate((el) => el === document.activeElement), 'Ctrl+L focuses active path');
  await path('right').fill('/missing'); await path('right').press('Enter'); await ready('right');
  check(await panel('right').getByRole('alert').isVisible() && await selected('right') === 'Empty', 'missing directory error preserves last successful contents');
  await go('right', '/fixture/Restricted');
  check(await panel('right').getByRole('alert').locator('.error-preview').getByText('Permission denied', { exact: true }).isVisible(), 'permission error is visible');
  await panel('right').getByRole('button', { name: 'Retry', exact: true }).click(); await ready('right');
  check(await panel('right').getByRole('alert').locator('.error-preview').getByText('Permission denied', { exact: true }).isVisible(), 'retry repeats the failed request');
  await go('right', '/fixture');
  await panel('right').getByRole('button', { name: 'Sort right by size, unsorted', exact: true }).click(); await ready('right');
  check(await panel('right').getByRole('button', { name: 'Sort right by size, ascending', exact: true }).getAttribute('aria-pressed') === 'true', 'size sort state reaches IPC');
  await panel('right').getByRole('button', { name: 'Sort right by size, ascending', exact: true }).click(); await ready('right');
  check((await list('right').locator('.filename').allTextContents())[4] === 'z.bin', 'descending size keeps virtual parent and folders first');
  check(await panel('left').getByRole('button', { name: 'Sort left by name, ascending', exact: true }).getAttribute('aria-pressed') === 'true', 'sorting is independent');
  await panel('right').getByRole('button', { name: 'Sort right by modified, unsorted', exact: true }).click(); await ready('right');
  check(await page.evaluate(() => window.ipcRequests.at(-1).sort) === 'modified', 'modification sort reaches IPC');
  await panel('right').getByRole('button', { name: 'Sort right by name, unsorted', exact: true }).click(); await ready('right');
  await list('right').getByRole('option').filter({ hasText: 'linked-folder' }).click();
  const count = await page.evaluate(() => window.ipcRequests.length);
  await list('right').press('Enter');
  check(await page.evaluate(() => window.ipcRequests.length) === count, 'Enter does not traverse symlinks');
  await list('right').getByRole('option').filter({ hasText: 'Projects' }).dblclick(); await ready('right');
  check(await path('right').inputValue() === '/fixture/Projects', 'double-click opens a folder');
  await path('right').fill('/slow'); await path('right').press('Enter');
  await page.waitForFunction(() => typeof window.finishSlow === 'function');
  check(await panel('right').getByText('Reading directory…').isVisible(), 'loading state is visible');
  await go('right', '/fast');
  await page.evaluate(() => window.finishSlow());
  await page.waitForFunction(() => document.querySelector('[aria-label="right directory path"]').value === '/fast');
  check(await path('right').inputValue() === '/fast', 'older asynchronous responses cannot replace newer navigation');
  await go('right', '/warning');
  check(await panel('right').getByText('Some entries could not be read').isVisible(), 'partial enumeration warning is visible');
  await go('right', '/large');
  const rendered = await list('right').getByRole('option').count();
  check(rendered < 50, `10,000 entries render only ${rendered} rows`);
  await list('right').press('End');
  check(await selected('right') === 'file-09999.txt', 'End reaches and renders the last virtual row');
  await list('right').press('ArrowUp');
  check(await selected('right') === 'file-09998.txt', 'keyboard navigation works at virtual list boundary');
  await list('right').press('Home');
  check(await selected('right') === '[..]', 'Home returns to virtual parent row');
  await list('right').press('ArrowDown');
  check(await selected('right') === 'file-00000.txt', 'ArrowDown reaches first real row after virtual parent');
  await go('right', '/');
  check(await panel('right').getByRole('button', { name: 'right: parent directory', exact: true }).isDisabled(), 'parent is disabled at root');
  await go('right', '/fixture');
  const slider = page.getByRole('slider', { name: 'Resize panels' });
  await slider.focus(); await slider.press('ArrowRight');
  check(await slider.getAttribute('aria-valuenow') === '52', 'panel resize works with keyboard');
  const bounds = await slider.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(760, bounds.y + 100); await page.mouse.up();
  check(Number(await slider.getAttribute('aria-valuenow')) > 60, 'panel resize works with pointer');
  await slider.press('Home');
  await list('left').focus();
  await page.screenshot({ path: 'test-results/slice-001-desktop-mocked.png' });
  await page.setViewportSize({ width: 720, height: 480 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '720px layout has no whole-app horizontal overflow');
  await slider.focus(); for (let i = 0; i < 20; i++) await slider.press('ArrowLeft');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'minimum-width split has no whole-app overflow');
  await slider.press('Home');
  await page.screenshot({ path: 'test-results/slice-001-compact-mocked.png' });
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.evaluate(() => { window.isTauri = false; });
  await panel('left').getByRole('button', { name: 'left: refresh directory', exact: true }).click(); await ready('left');
  check(await panel('left').getByRole('alert').locator('.error-preview').getByText('Open QPanes in its desktop window to browse your files.', { exact: true }).isVisible(), 'browser without desktop IPC shows explicit unavailable state');
  check(errors.length === 0, `no browser runtime errors (${errors.join(', ')})`);
  return { mode: 'MOCKED IPC renderer acceptance', passed: passed.length, checks: passed };
}
