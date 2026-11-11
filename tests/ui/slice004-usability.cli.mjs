// Slice 004 renderer acceptance: tabs, favorites, Quick Filter, internal drag and
// drop, configurable shortcuts and their persistence.
// MOCKED IPC (in-page fixture). Chromium delivers trusted keyboard/mouse input.
// Settings are simulated in localStorage so page reloads model restarts.
// Native filesystem safety is verified separately by tests/native/slice004.mjs.
// Run: playwright-cli -s=<session> --raw run-code --filename=tests/ui/slice004-usability.cli.mjs
async (page) => {
  const checks = [], errors = [], timings = {};
  page.on('pageerror', (error) => errors.push(error.message));
  const check = (pass, name, detail) => { checks.push({ pass: !!pass, name, ...(pass ? {} : { detail }) }); };
  await page.setViewportSize({ width: 1200, height: 780 });
  const fixture = () => {
    const entry = (path, name, kind = 'file', size = 10) => ({ path, name, kind, identity: `id:${path}`, size: kind === 'file' ? size : null, modifiedMs: 1700000000000 + size, metadataError: null });
    const dirs = {
      '/n': [entry('/n/home', 'home', 'directory'), entry('/n/alpha', 'alpha', 'directory'), entry('/n/beta', 'beta', 'directory'), entry('/n/big', 'big', 'directory')],
      '/n/home': [entry('/n/home/Docs', 'Docs', 'directory'), entry('/n/home/Media', 'Media', 'directory'), entry('/n/home/notes.txt', 'notes.txt', 'file', 30), entry('/n/home/report.pdf', 'report.pdf', 'file', 900), entry('/n/home/Árvíz.txt', 'Árvíz.txt', 'file', 5)],
      '/n/home/Docs': [entry('/n/home/Docs/Deep', 'Deep', 'directory'), entry('/n/home/Docs/a.txt', 'a.txt')],
      '/n/home/Docs/Deep': [],
      '/n/home/Media': [],
      '/n/alpha': [entry('/n/alpha/alpha.txt', 'alpha.txt'), entry('/n/alpha/Sub', 'Sub', 'directory')],
      '/n/alpha/Sub': [],
      '/n/beta': [entry('/n/beta/beta.txt', 'beta.txt')],
      '/n/big': Array.from({ length: 10000 }, (_, i) => entry(`/n/big/f${i}`, `item-${String(i).padStart(5, '0')}${i % 7 === 0 ? '-Report' : ''}.txt`, 'file', i)),
    };
    const parentOf = (path) => path === '/n' ? null : path.slice(0, path.lastIndexOf('/')) || '/n';
    const callbacks = new Map(), listeners = new Map();
    let next = 0;
    const ops = { revision: 0, invalidationRevision: 0, jobs: [], accepting: true, closeRequested: false, shutdownState: 'idle', shutdownAttempt: null };
    const fx = window.fx = {
      calls: [], dirs, missing: new Set(), delay: {}, failLoad: false, loadOverride: null, saveInFlight: 0, maxSaveInFlight: 0, saves: 0,
      keys: [], probeCalls: 0,
    };
    window.addEventListener('keydown', (event) => fx.keys.push({ key: event.key, trusted: event.isTrusted }), true);
    const emit = () => {
      for (const job of ops.jobs) if (['completed', 'failed', 'cancelled'].includes(job.state) && job.invalidationRevision == null) job.invalidationRevision = ++ops.invalidationRevision;
      ops.revision++;
      for (const [id, item] of listeners) if (item.event === 'operations-changed') callbacks.get(item.handler)?.({ id, event: item.event, payload: ops.revision });
    };
    fx.completeJob = (affected) => { ops.jobs.push({ id: `x${ops.jobs.length + 1}`, intent: { kind: 'create', parent: affected[0], name: 'external' }, sourceLabel: null, destinationLabel: null, affectedDirectories: affected, invalidatedSubtrees: [], invalidationRevision: null, submittedMs: 0, startedMs: 0, completedMs: 0, state: 'completed', progress: { currentItem: null, currentLabel: null, bytesProcessed: 0, totalBytes: null, completedFiles: 0, totalFiles: null, elapsedMs: 0, bytesPerSecond: null, remainingMs: null }, cancellationRequested: false, cancellable: false, result: { path: null, warnings: [] }, error: null, retryable: false, retryOf: null }); emit(); };
    const stored = () => JSON.parse(localStorage.getItem('fx-settings') ?? 'null');
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, id) => listeners.delete(id) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(callback) { callbacks.set(++next, callback); return next; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, payload = {}) {
        if (command.startsWith('plugin:window|')) return command.endsWith('|scale_factor') ? 1 : false;
        if (command === 'plugin:event|listen') { listeners.set(++next, payload); return next; }
        if (command === 'plugin:event|unlisten') { listeners.delete(payload.eventId); return; }
        if (command === 'list_operations') return structuredClone(ops);
        fx.calls.push({ command, payload: structuredClone(payload) });
        if (command === 'load_settings') {
          const loadDelay = Number(localStorage.getItem('fx-load-delay') ?? 0);
          if (loadDelay) await new Promise((resolve) => setTimeout(resolve, loadDelay));
          if (fx.failLoad || localStorage.getItem('fx-fail-load')) throw { code: 'io', message: 'Unexpected command load_settings' };
          const override = JSON.parse(localStorage.getItem('fx-load-override') ?? 'null');
          if (override) { localStorage.removeItem('fx-load-override'); return override; }
          const document = stored();
          return { document: document ?? { version: 1, favorites: [], shortcuts: {}, session: null }, status: document ? 'loaded' : 'missing', warnings: [] };
        }
        if (command === 'save_settings') {
          fx.saveInFlight++; fx.maxSaveInFlight = Math.max(fx.maxSaveInFlight, fx.saveInFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          fx.saveInFlight--; fx.saves++;
          localStorage.setItem('fx-settings', JSON.stringify(payload.document));
          return;
        }
        if (command === 'probe_directories') { fx.probeCalls++; return payload.paths.map((path) => fx.missing.has(path) || !dirs[path] ? 'missing' : 'available'); }
        if (command === 'classify_operation_invalidation') {
          // Mock-only ancestry over fixture paths; native code compares components in Rust.
          return payload.paths.map((path) => payload.directories.includes(path) || payload.subtrees.some((root) => path === root || path.startsWith(`${root}/`)));
        }
        if (command === 'sort_directory_entries') {
          const sign = payload.direction === 'ascending' ? 1 : -1;
          const value = (item) => payload.sort === 'size' ? item.size ?? -1 : payload.sort === 'modified' ? item.modifiedMs : 0;
          return payload.entries.slice().sort((a, b) => (a.kind !== 'directory') - (b.kind !== 'directory') || (value(a) - value(b)) * sign || a.name.localeCompare(b.name) * (payload.sort === 'name' ? sign : 1));
        }
        if (command === 'list_directory') {
          const request = payload.request;
          const path = request.target.kind === 'home' ? '/n/home' : request.target.value;
          if (fx.delay[path]) await new Promise((resolve) => setTimeout(resolve, fx.delay[path]));
          if (fx.missing.has(path) || !dirs[path]) throw { code: 'notFound', message: `No such directory: ${path}` };
          const sign = request.direction === 'ascending' ? 1 : -1;
          const value = (item) => request.sort === 'size' ? item.size ?? -1 : request.sort === 'modified' ? item.modifiedMs : 0;
          const entries = dirs[path].map((item) => ({ ...item })).sort((a, b) => (a.kind !== 'directory') - (b.kind !== 'directory') || (value(a) - value(b)) * sign || a.name.localeCompare(b.name) * (request.sort === 'name' ? sign : 1));
          return { path, label: path.replace('/n', '/display'), name: path.slice(path.lastIndexOf('/') + 1), parent: parentOf(path), entries, warnings: [], sort: request.sort, direction: request.direction };
        }
        if (command === 'submit_operation') {
          const intent = structuredClone(payload.request.intent);
          const parent = intent.kind === 'create' ? intent.parent : Object.keys(dirs).find((key) => dirs[key].some((item) => item.path === intent.source.path));
          const job = { id: String(ops.jobs.length + 1), intent, sourceLabel: parent ?? null, destinationLabel: intent.destination ?? null, affectedDirectories: [intent.destination ?? parent, parent].filter(Boolean), invalidatedSubtrees: [], invalidationRevision: null, submittedMs: Date.now(), startedMs: Date.now(), completedMs: Date.now(), state: 'completed', progress: { currentItem: null, currentLabel: null, bytesProcessed: 0, totalBytes: null, completedFiles: 0, totalFiles: null, elapsedMs: 0, bytesPerSecond: null, remainingMs: null }, cancellationRequested: false, cancellable: false, result: null, error: null, retryable: false, retryOf: null };
          const source = parent && dirs[parent].find((item) => item.path === intent.source?.path && item.identity === intent.source?.identity);
          if ((intent.kind === 'copy' || intent.kind === 'move') && !source) { job.state = 'failed'; job.error = { code: 'notFound', message: 'The source entry no longer exists.' }; }
          else if (intent.kind === 'copy' || intent.kind === 'move') {
            const path = `${intent.destination}/${source.name}`;
            if (dirs[intent.destination].some((item) => item.name === source.name)) { job.state = 'failed'; job.error = { code: 'conflict', message: 'Destination exists.' }; }
            else {
              dirs[intent.destination].push({ ...source, path, identity: `id:${path}` });
              if (intent.kind === 'move') dirs[parent] = dirs[parent].filter((item) => item !== source);
              job.result = { path, warnings: [] };
            }
          } else job.result = { path: null, warnings: [] };
          ops.jobs.push(job); emit(); return structuredClone(job);
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  };
  await page.addInitScript(fixture);
  await page.goto('http://127.0.0.1:1420');
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const list = (side) => page.getByRole('listbox', { name: `${side} files`, exact: true });
  const path = (side) => page.getByRole('textbox', { name: `${side} directory path`, exact: true });
  const tabs = (side) => page.getByRole('tablist', { name: `${side} tabs`, exact: true }).getByRole('tab');
  const selectedTab = (side) => page.getByRole('tablist', { name: `${side} tabs`, exact: true }).locator('[aria-selected="true"]');
  const filterInput = (side) => page.getByRole('textbox', { name: `${side} filter names`, exact: true });
  const notice = page.locator('.operation-notice');
  const favoritesDialog = page.getByRole('dialog', { name: 'Favorites' });
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const ready = () => page.waitForFunction(() => {
    const lists = [...document.querySelectorAll('[role=listbox]')].filter((element) => element.closest('.pane-view:not([hidden])'));
    return lists.length === 2 && lists.every((element) => element.getAttribute('aria-busy') === 'false');
  }, null, { timeout: 15000 });
  const focus = () => page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') }));
  const calls = (command, predicate = '') => page.evaluate(({ command, predicate }) => window.fx.calls.filter((call) => call.command === command && (!predicate || JSON.stringify(call.payload).includes(predicate))).length, { command, predicate });
  const settings = () => page.evaluate(() => JSON.parse(localStorage.getItem('fx-settings') ?? 'null'));
  const go = async (side, value) => { await path(side).fill(value); await path(side).press('Enter'); await ready(); };
  const names = (side) => list(side).locator('.filename').allTextContents();
  const selectedName = (side) => list(side).locator('[aria-selected="true"] .filename').textContent();
  const row = (side, name) => list(side).locator('.file-row', { has: page.locator('.filename', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
  const settle = async () => { await page.waitForFunction(() => window.fx.saveInFlight === 0); await frame(); await page.waitForFunction(() => window.fx.saveInFlight === 0); };
  const restart = async () => { await settle(); await page.reload(); await ready(); };
  const dismissNotice = async () => { if (await notice.count()) await notice.getByRole('button').click(); };
  const setSort = async (side, key, direction) => {
    const button = page.locator(`[aria-label="${side} panel"] .pane-view:not([hidden]) [data-sort="${key}"]`);
    for (let attempt = 0; attempt < 3 && await button.getAttribute('aria-label') !== `Sort ${side} by ${key}, ${direction}`; attempt++) { await button.click(); await ready(); }
  };
  const section = async (name, body) => {
    try { await body(); }
    catch (error) { check(false, `${name} section completed`, String(error?.message ?? error).split('\n').slice(0, 6).join(' | ')); await page.keyboard.press('Escape').catch(() => {}); await page.mouse.up().catch(() => {}); }
  };

  await ready();
  // ---------------------------------------------------------------- Tabs
  await section('tabs', async () => {
  check(await tabs('left').count() === 1 && await tabs('right').count() === 1, 'each panel starts with one tab');
  check((await focus()).label === 'left files', 'initial focus lands in the left list after settings restore', await focus());
  await list('left').press('ArrowDown');
  await list('left').press('ArrowDown');
  await list('left').press('ArrowDown');
  const firstSelection = await selectedName('left');
  await page.keyboard.press('Control+t');
  await ready();
  check(await tabs('left').count() === 2 && await tabs('right').count() === 1, 'Ctrl+T opens a tab only in the active panel');
  check((await focus()).label === 'left files' && await path('left').inputValue() === '/display/home', 'new tab opens the current directory with its list focused', { focus: await focus(), path: await path('left').inputValue() });
  await go('left', '/n/alpha');
  check(await selectedTab('left').getAttribute('aria-label') === 'alpha', 'tab label follows its committed directory name');
  await list('left').focus();
  await setSort('left', 'size', 'ascending');
  const readsBeforeSwitch = await calls('list_directory');
  await page.keyboard.press('Control+Shift+Tab');
  await frame();
  check(await path('left').inputValue() === '/display/home' && await selectedName('left') === firstSelection, 'switching back restores the first tab directory and selection', { path: await path('left').inputValue(), selected: await selectedName('left'), firstSelection });
  check(await page.getByRole('button', { name: 'Sort left by name, ascending', exact: true }).count() === 1, 'sort state is independent per tab');
  await page.keyboard.press('Control+Tab');
  await frame();
  check(await path('left').inputValue() === '/display/alpha' && await page.getByRole('button', { name: 'Sort left by size, ascending', exact: true }).count() === 1, 'Ctrl+Tab restores the second tab with its own sort');
  check(await calls('list_directory') === readsBeforeSwitch, 'switching tabs does not re-read unchanged directories');
  check((await focus()).label === 'left files', 'tab switching keeps keyboard focus in the visible list', await focus());

  // Scroll and filter are per tab.
  await go('left', '/n/big');
  await list('left').press('End');
  await frame();
  const bigScroll = await list('left').evaluate((element) => element.scrollTop);
  await page.keyboard.press('Control+f');
  await page.keyboard.type('report');
  await frame();
  const filteredCount = await page.locator('.pane-view:not([hidden]) .filter-count').first().textContent();
  await page.keyboard.press('Tab');
  await list('left').focus();
  await page.keyboard.press('Control+Tab');
  await frame();
  check(await filterInput('left').count() === 0, 'another tab does not inherit the filter');
  await page.keyboard.press('Control+Tab');
  await frame();
  check(await filterInput('left').inputValue() === 'report' && await page.locator('.pane-view:not([hidden]) .filter-count').first().textContent() === filteredCount, 'the filter survives switching tabs', filteredCount);
  await filterInput('left').press('Escape');
  await frame();
  await list('left').press('End');
  const restoredBefore = await list('left').evaluate((element) => element.scrollTop);
  await page.keyboard.press('Control+Shift+Tab');
  await page.keyboard.press('Control+Tab');
  await frame();
  const restoredScroll = await list('left').evaluate((element) => element.scrollTop);
  check(bigScroll > 300000 && restoredScroll === restoredBefore && await list('left').locator('[aria-selected="true"]').count() === 1, 'scroll position and rendered selection are restored after switching', { bigScroll, restoredBefore, restoredScroll });

  // Right panel independence and closing.
  await page.keyboard.press('Tab');
  check((await focus()).label === 'right files', 'Tab still switches panels');
  await page.keyboard.press('Control+t');
  await ready();
  await go('right', '/n/beta');
  check(await tabs('right').count() === 2 && await tabs('left').count() === 2, 'right tabs are independent of left tabs');
  await list('right').focus();
  await page.keyboard.press('Control+w');
  await frame();
  check(await tabs('right').count() === 1 && await path('right').inputValue() === '/display/home' && (await focus()).label === 'right files', 'Ctrl+W closes the current tab, activates its neighbour and keeps list focus', { count: await tabs('right').count(), focus: await focus() });
  await page.keyboard.press('Control+w');
  await frame();
  check(await tabs('right').count() === 1 && (await notice.textContent())?.includes('at least one tab') && (await focus()).label === 'right files', 'the last tab cannot be closed into an invalid state');
  await dismissNotice();

  // Pointer tab interactions on the left.
  await tabs('left').nth(0).click();
  await frame();
  check(await path('left').inputValue() === '/display/home' && (await focus()).label === 'left files', 'clicking a tab activates it and focuses its list');
  await tabs('left').nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await frame();
  check(await selectedTab('left').getAttribute('aria-label') === 'big' && (await focus()).tag === 'BUTTON', 'arrow keys move between tabs in the tab strip');
  await list('left').focus();
  await page.keyboard.press('Control+t');
  await ready();
  await go('left', '/n/beta');
  await tabs('left').nth(0).click({ button: 'middle' });
  await frame();
  check(await tabs('left').count() === 2 && await path('left').inputValue() === '/display/beta', 'middle-click closes an inactive tab without changing the visible tab');
  await page.keyboard.press('Control+t');
  await ready();
  await tabs('left').nth(1).click();
  await tabs('left').nth(2).hover();
  await tabs('left').nth(2).locator('[data-close-tab]').click();
  await frame();
  check(await tabs('left').count() === 2 && await path('left').inputValue() === '/display/beta' && (await focus()).label === 'left files', 'closing an inactive tab with its × keeps focus usable in the visible list', await focus());

  // Invalidation reaches inactive tabs only when affected.
  // Left tabs: [big, beta]; show big, so beta is inactive.
  await tabs('left').nth(0).click();
  await ready();
  const betaReads = await calls('list_directory', '/n/beta');
  const bigReads = await calls('list_directory', '/n/big');
  const homeReads = await calls('list_directory', '/n/home');
  await page.evaluate(() => window.fx.completeJob(['/n/beta']));
  await page.waitForFunction((before) => window.fx.calls.filter((call) => call.command === 'list_directory' && JSON.stringify(call.payload).includes('/n/beta')).length > before, betaReads);
  await frame();
  check(await calls('list_directory', '/n/big') === bigReads && await calls('list_directory', '/n/home') === homeReads, 'operation completion refreshes the affected inactive tab and no unrelated tab');
  check(await path('left').inputValue() === '/display/big', 'inactive-tab invalidation never switches or redirects the visible tab');

  // Persistence and restart.
  await settle();
  const saved = await settings();
  check(saved?.session?.left?.tabs?.length === 2 && saved.session.left.tabs.map((tab) => tab.path).join() === '/n/big,/n/beta' && saved.session.left.activeTab === 0, 'tabs and active tab are saved as native identities', saved?.session);
  check(await page.evaluate(() => window.fx.maxSaveInFlight) === 1, 'settings saves are serialized (never two writes in flight)');
  await restart();
  check(await tabs('left').count() === 2 && await path('left').inputValue() === '/display/big' && await tabs('right').count() === 1, 'tabs and locations are restored after restart');
  check(await calls('list_directory', '/n/beta') === 0, 'restored inactive tabs load lazily on first display');
  await tabs('left').nth(1).click();
  await ready();
  check(await path('left').inputValue() === '/display/beta' && await names('left').then((value) => value.includes('beta.txt')), 'a restored inactive tab loads when first shown');

  // Unavailable restored directory.
  await settle();
  await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem('fx-settings'));
    value.session.right = { activeTab: 0, tabs: [{ path: '/n/gone', location: '/display/gone', name: 'gone', sort: 'name', direction: 'ascending' }] };
    localStorage.setItem('fx-settings', JSON.stringify(value));
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.pane-view:not([hidden]) [aria-label="right files"]')?.getAttribute('aria-busy') === 'false');
  check(await page.locator('[aria-label="right panel"] .list-state').textContent().then((text) => text.includes('Directory unavailable')) && await path('right').inputValue() === '/display/gone', 'an unavailable restored directory shows an unavailable state at its own location');
  check(await calls('list_directory', '"home"') === 0 || !(await page.evaluate(() => window.fx.calls.some((call) => call.command === 'list_directory' && call.payload.request.target.kind === 'home'))), 'an unavailable restored tab is never silently replaced by home');
  check(await selectedTab('right').getAttribute('aria-label') === 'gone', 'the unavailable tab keeps its remembered label');
  await path('right').press('Enter');
  await page.waitForFunction(() => document.querySelector('.pane-view:not([hidden]) [aria-label="right files"]')?.getAttribute('aria-busy') === 'false');
  const resubmitted = await page.evaluate(() => window.fx.calls.filter((call) => call.command === 'list_directory').at(-1).payload.request.target);
  check(resubmitted.kind === 'path' && resubmitted.value === '/n/gone', 'an unedited unavailable location is retried by native identity, never as a typed display label', resubmitted);
  await page.getByRole('button', { name: 'right: home directory', exact: true }).click();
  await ready();

  });
  // ------------------------------------------------------------ Favorites
  await section('favorites', async () => {
  await list('left').focus();
  await tabs('left').nth(0).click();
  await ready();
  await go('left', '/n/home');
  await page.keyboard.press('Control+d');
  await settle();
  check((await notice.textContent())?.includes('Added “home” to Favorites') && (await settings()).favorites.length === 1 && (await settings()).favorites[0].path === '/n/home', 'Ctrl+D adds the current directory by native identity and persists it');
  await page.keyboard.press('Control+d');
  check((await notice.textContent())?.includes('already in Favorites') && (await settings()).favorites.length === 1, 'adding the same directory again is reported, not duplicated');
  await dismissNotice();
  await go('left', '/n/alpha');
  await page.keyboard.press('Control+d');
  await dismissNotice();
  const submitsBeforeFavorites = await calls('submit_operation');
  await page.keyboard.press('Tab');
  await go('right', '/n/beta');
  await page.keyboard.press('Control+b');
  await favoritesDialog.waitFor();
  check((await focus()).label === 'Open home', 'Favorites opens with focus on the first favorite', await focus());
  await page.keyboard.press('ArrowDown');
  check((await focus()).label === 'Open alpha', 'arrow keys move between favorites');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await ready();
  check(await favoritesDialog.count() === 0 && await path('right').inputValue() === '/display/home' && (await focus()).label === 'right files', 'Enter opens a favorite in the current panel and returns focus to its list');
  await page.keyboard.press('Control+b');
  await favoritesDialog.waitFor();
  await page.keyboard.press('Shift+Enter');
  await ready();
  check(await tabs('right').count() === 2 && await path('right').inputValue() === '/display/home', 'Shift+Enter opens a favorite in a new tab');
  await page.keyboard.press('Control+b');
  await favoritesDialog.waitFor();
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('   ');
  await page.keyboard.press('Enter');
  check(await favoritesDialog.getByRole('alert').textContent() === 'Enter a name.', 'an empty favorite name is rejected');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Home base');
  await page.keyboard.press('Enter');
  await settle();
  const renamed = await settings();
  check(renamed.favorites[0].label === 'Home base' && renamed.favorites[0].path === '/n/home' && (await focus()).label === 'Open Home base', 'rename changes only the label, never the native target', renamed.favorites);
  await page.keyboard.press('Escape');
  check(await favoritesDialog.count() === 0 && (await focus()).label === 'right files', 'Escape closes Favorites and returns focus to the list');
  // Unavailable favorite.
  await page.evaluate(() => window.fx.missing.add('/n/alpha'));
  await page.getByRole('button', { name: 'right: favorites', exact: true }).click();
  await favoritesDialog.waitFor();
  await page.getByRole('button', { name: 'Open alpha, Missing', exact: true }).waitFor();
  check(await favoritesDialog.locator('.favorite-status').textContent() === 'Missing', 'an unavailable favorite is marked without being removed');
  await page.getByRole('button', { name: 'Open alpha, Missing', exact: true }).click();
  await ready();
  check(await path('right').inputValue() === '/display/home' && await page.locator('[aria-label="right panel"] .error-banner').count() === 1, 'opening an unavailable favorite reports an error without redirecting the panel');
  await page.evaluate(() => window.fx.missing.delete('/n/alpha'));
  await page.getByRole('button', { name: 'right: favorites', exact: true }).click();
  await favoritesDialog.waitFor();
  await page.keyboard.press('End');
  await page.keyboard.press('Delete');
  await settle();
  check((await settings()).favorites.length === 1 && (await focus()).label === 'Open Home base', 'Delete removes a favorite and keeps focus inside the list');
  check(await calls('submit_operation') === submitsBeforeFavorites, 'favorite management never submits filesystem operations');
  await page.keyboard.press('Escape');
  await restart();
  await page.keyboard.press('Control+b');
  await favoritesDialog.waitFor();
  check(await favoritesDialog.getByRole('button', { name: 'Open Home base', exact: true }).count() === 1, 'favorites persist across restart');
  await page.keyboard.press('Escape');
  await settle();
  const beforeLimit = await page.evaluate(() => localStorage.getItem('fx-settings'));
  await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('fx-settings')); value.session.activeSide = 'left'; value.session.left = { activeTab: 0, tabs: Array.from({ length: 32 }, () => ({ path: '/n/home', location: '/display/home', name: 'home', sort: 'name', direction: 'ascending' })) }; localStorage.setItem('fx-settings', JSON.stringify(value)); });
  await page.reload(); await ready();
  await page.keyboard.press('Control+b');
  await favoritesDialog.waitFor();
  await page.keyboard.press('Shift+Enter');
  await frame();
  check(await tabs('left').count() === 32 && (await notice.textContent()).includes('at most 32 tabs') && (await focus()).label === 'left files', 'opening a favorite in a new tab at the tab limit keeps focus in the list', await focus());
  await dismissNotice();
  await settle();
  await page.evaluate((value) => localStorage.setItem('fx-settings', value), beforeLimit);
  await page.reload(); await ready();

  });
  // ---------------------------------------------------------- Quick Filter
  await section('filter', async () => {
  await list('left').focus();
  await go('left', '/n/big');
  await setSort('left', 'name', 'ascending');
  const readsBeforeFilter = await calls('list_directory');
  const sortsBeforeFilter = await calls('sort_directory_entries');
  await page.keyboard.press('Control+f');
  check((await focus()).label === 'left filter names', 'Ctrl+F opens and focuses Quick Filter');
  const keystrokes = [];
  for (const character of 'report') {
    const started = Date.now();
    await page.keyboard.press(character);
    await frame();
    keystrokes.push(Date.now() - started);
  }
  const inPage = await page.evaluate(async () => {
    const input = document.querySelector('.pane-view:not([hidden]) [aria-label="left filter names"]');
    const samples = [];
    for (const value of ['r', 're', 'rep', 'repo', 'item-0', 'item-09', '-report', 'zzz', '']) {
      const started = performance.now();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      samples.push(performance.now() - started);
    }
    input.value = 'report'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return samples;
  });
  timings.filterTrustedKeystrokeMs = keystrokes;
  timings.filterInPageUpdateMs = inPage.map((value) => Math.round(value * 10) / 10);
  check(Math.max(...inPage) < 100, '10,000-entry filter updates render within 100 ms per keystroke', timings);
  check(await page.locator('.pane-view:not([hidden]) .filter-count').first().textContent() === '1,429 of 10,000', 'filter shows matching and total counts', await page.locator('.pane-view:not([hidden]) .filter-count').first().textContent());
  check((await page.locator('[aria-label="left panel"] .pane-view:not([hidden]) .pane-status').textContent()).startsWith('1,429 of 10,000 items'), 'the footer shows filtered and total item counts');
  const renderedRows = await list('left').locator('[role=option]').count();
  check(renderedRows > 0 && renderedRows < 50, 'virtualization stays effective while filtering', renderedRows);
  check((await list('left').locator('[role=option]').first().getAttribute('aria-label')) === '[..] Parent directory', '[..] remains available above filtered results');
  check(await calls('list_directory') === readsBeforeFilter && await calls('sort_directory_entries') === sortsBeforeFilter, 'typing a filter performs no directory enumeration or sorting IPC');
  const firstMatch = await list('left').locator('.filename').nth(1).textContent();
  check(firstMatch === 'item-00000-Report.txt' && await selectedName('left') === firstMatch, 'the first match is selected in sorted order', firstMatch);
  await page.keyboard.press('ArrowDown');
  check(await selectedName('left') === 'item-00007-Report.txt' && (await focus()).label === 'left filter names', 'ArrowDown moves the filtered selection while typing continues');
  await setSort('left', 'name', 'descending');
  const sortedSelection = await list('left').locator('[aria-selected="true"]').evaluate((element) => ({ position: element.getAttribute('aria-posinset'), size: element.getAttribute('aria-setsize'), name: element.querySelector('.filename').textContent }));
  check(sortedSelection.name === 'item-00007-Report.txt' && sortedSelection.position === '1429' && sortedSelection.size === '1430' && await filterInput('left').inputValue() === 'report', 'sorting keeps the filter and the selected match in its new sorted position', sortedSelection);
  await list('left').press('Home'); await list('left').press('ArrowDown');
  check(await selectedName('left') === 'item-09996-Report.txt', 'filtered rows follow the new sort order');
  await filterInput('left').fill('zzz');
  await frame();
  check(await page.locator('[aria-label="left panel"] .list-state').textContent().then((text) => text.includes('No names match')) && await list('left').locator('[role=option]').count() === 1, 'an empty result shows a useful state and keeps [..]');
  await filterInput('left').press('Escape');
  await frame();
  check(await filterInput('left').count() === 0 && (await focus()).label === 'left files' && await page.locator('[aria-label="left panel"] .pane-view:not([hidden]) .pane-status').textContent().then((text) => text.startsWith('10,000 items')), 'Escape clears the filter, restores the full listing and focuses the list (never BODY)');
  check(await selectedName('left') === '[..]', 'with no match left selected, clearing keeps a valid selection');
  await go('left', '/n/home');
  await page.keyboard.press('Control+f');
  await page.keyboard.type('doc');
  await page.keyboard.press('Enter');
  await ready();
  check(await path('left').inputValue() === '/display/home/Docs' && await filterInput('left').count() === 0 && (await focus()).label === 'left files', 'Enter opens a filtered folder; navigation clears the filter and focuses the list');
  await list('left').press('Backspace');
  await ready();
  await page.keyboard.press('Control+f');
  await page.keyboard.type('ÁRV');
  check(await selectedName('left') === 'Árvíz.txt', 'filtering is case-insensitive for non-ASCII names');
  await page.keyboard.press('Tab');
  check((await focus()).label === 'left files', 'Tab from the filter moves to its list');
  await row('left', 'Árvíz.txt').dblclick();
  check(await list('left').locator('..').locator('.selection-detail').textContent().then((text) => text.includes('Select a folder')), 'double-click on a filtered file behaves as before');
  await page.keyboard.press('F2');
  const renameDialog = page.getByRole('dialog', { name: 'Rename' });
  await renameDialog.waitFor();
  check(await page.getByRole('textbox', { name: 'New name' }).inputValue() === 'Árvíz.txt', 'operations use the selected filtered entry');
  await page.keyboard.press('Escape');
  const homeReadsBefore = await calls('list_directory', '/n/home"');
  await page.evaluate(() => window.fx.completeJob(['/n/home']));
  await page.waitForFunction((before) => window.fx.calls.filter((call) => call.command === 'list_directory' && JSON.stringify(call.payload).includes('/n/home"')).length > before, homeReadsBefore);
  await ready();
  check(await filterInput('left').inputValue() === 'ÁRV' && await selectedName('left') === 'Árvíz.txt' && await path('left').inputValue() === '/display/home', 'a refresh of the same directory keeps the filter and selection');
  await page.getByRole('button', { name: 'left: clear filter', exact: true }).click();
  check((await focus()).label === 'left files' && await filterInput('left').count() === 0, 'the clear button never strands focus');
  check(await filterInput('right').count() === 0, 'filters are independent between panels');
  await path('left').focus();
  await page.keyboard.press('Control+f');
  check((await focus()).label === 'left filter names', 'Ctrl+F also works from the path field');
  await page.keyboard.press('Escape');

  });
  // -------------------------------------------------------- Drag and drop
  await section('drag', async () => {
  await dismissNotice();
  await go('left', '/n/home');
  await list('right').focus();
  await go('right', '/n/beta');
  const center = async (locator) => { const box = await locator.boundingBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const dragTo = async (from, to, finish = true) => {
    const a = await center(from), b = typeof to.x === 'number' ? to : await center(to);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    for (let step = 1; step <= 8; step++) await page.mouse.move(a.x + (b.x - a.x) * step / 8, a.y + (b.y - a.y) * step / 8);
    if (finish) await page.mouse.up();
  };
  const transfer = page.getByRole('dialog', { name: 'Copy or move' });
  const submitsBeforeDrag = await calls('submit_operation');
  await dragTo(row('left', 'notes.txt'), list('right'), false);
  check(await page.locator('.drag-ghost').count() === 1 && await page.locator('.drag-ghost strong').textContent() === 'notes.txt', 'the dragged entry is clearly indicated');
  check(await page.locator('[aria-label="right panel"] .pane-view.drop-valid').count() === 1 && await row('left', 'notes.txt').evaluate((element) => element.classList.contains('dragging')), 'the valid drop target and source row are highlighted');
  await page.mouse.up();
  await transfer.waitFor();
  check(await calls('submit_operation') === submitsBeforeDrag, 'a drop alone never submits a mutation');
  check(await transfer.textContent().then((text) => text.includes('notes.txt') && text.includes('/display/home') && text.includes('/display/beta')), 'the confirmation shows the captured source and destination');
  check((await focus()).tag === 'BUTTON' && (await page.evaluate(() => document.activeElement.textContent.trim())) === 'Copy', 'Copy is focused; Move and Cancel are explicit alternatives');
  await page.keyboard.press('Control+Tab');
  await page.keyboard.press('Control+t');
  check(await tabs('right').count() === 2 && await transfer.count() === 1, 'tab shortcuts cannot change panels while the drop confirmation is open');
  await transfer.getByRole('button', { name: 'Cancel', exact: true }).click();
  check(await calls('submit_operation') === submitsBeforeDrag && (await focus()).label === 'left files', 'Cancel submits nothing and returns focus to the source list');
  await dragTo(row('left', 'notes.txt'), list('right'));
  await transfer.waitFor();
  await transfer.getByRole('button', { name: 'Copy', exact: true }).dblclick();
  await ready();
  const copies = await page.evaluate(() => window.fx.calls.filter((call) => call.command === 'submit_operation').slice(-1).map((call) => call.payload.request.intent));
  check(await calls('submit_operation') === submitsBeforeDrag + 1 && copies[0].kind === 'copy' && copies[0].source.path === '/n/home/notes.txt' && copies[0].source.identity === 'id:/n/home/notes.txt' && copies[0].destination === '/n/beta', 'Copy submits exactly one manager operation with the captured identities', copies);
  await page.waitForFunction(() => [...document.querySelectorAll('.pane-view:not([hidden]) [aria-label="right files"] .filename')].some((element) => element.textContent === 'notes.txt'));
  check(await page.locator('.operations-toggle').textContent().then((text) => text.includes('in history')), 'the dropped operation appears in the Operations panel and refreshes the destination');
  await dragTo(row('left', 'report.pdf'), list('right'));
  await transfer.waitFor();
  await transfer.getByRole('button', { name: 'Move', exact: true }).click();
  await ready();
  const moved = await page.evaluate(() => window.fx.calls.filter((call) => call.command === 'submit_operation').at(-1).payload.request.intent);
  check(moved.kind === 'move' && moved.source.path === '/n/home/report.pdf' && moved.destination === '/n/beta', 'Move submits a move intent through the manager');
  // Invalid targets.
  await list('right').focus();
  await go('right', '/n/home');
  await dragTo(row('left', 'notes.txt'), list('right'), false);
  check(await page.locator('[aria-label="right panel"] .pane-view.drop-invalid').count() === 1 && await page.locator('.drag-ghost.invalid').count() === 1, 'the same directory is highlighted as an invalid target');
  await page.mouse.up();
  check(await transfer.count() === 0 && (await notice.textContent())?.includes('already in this folder'), 'dropping into the same directory is rejected');
  await dismissNotice();
  await go('right', '/n/home/Docs/Deep');
  await dragTo(row('left', 'Docs'), list('right'));
  await notice.waitFor();
  check(await transfer.count() === 0 && (await notice.textContent()).includes('into itself or one of its subfolders'), 'a folder cannot be dropped into its own descendant');
  await dismissNotice();
  await go('right', '/n/beta');
  await dragTo(list('left').locator('[role=option]').first(), list('right'));
  check(await transfer.count() === 0 && await page.locator('.drag-ghost').count() === 0, 'the [..] row cannot be dragged');
  await dragTo(row('left', 'notes.txt'), list('right'), false);
  await page.keyboard.press('Escape');
  check(await page.locator('.drag-ghost').count() === 0 && await tabs('right').count() === 2, 'Escape cancels a drag');
  check((await focus()).label === 'left files', 'a cancelled drag leaves focus on the source list, not on a row', await focus());
  // Codex review R004-02: the focused dragged row disappears during an invalidation.
  await page.evaluate(() => { window.fx.dirs['/n/home'].push({ path: '/n/home/vanishing.txt', name: 'vanishing.txt', kind: 'file', identity: 'id:/n/home/vanishing.txt', size: 2, modifiedMs: 2, metadataError: null }); });
  await page.getByRole('button', { name: 'left: refresh directory', exact: true }).click();
  await ready();
  const submitsBeforeVanish = await calls('submit_operation');
  await dragTo(row('left', 'vanishing.txt'), list('right'), false);
  await page.evaluate(() => { window.fx.dirs['/n/home'] = window.fx.dirs['/n/home'].filter((item) => item.name !== 'vanishing.txt'); window.fx.completeJob(['/n/home']); });
  await page.waitForFunction(() => ![...document.querySelectorAll('.pane-view:not([hidden]) [aria-label="left files"] .filename')].some((element) => element.textContent === 'vanishing.txt'));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await frame();
  check((await focus()).label === 'left files' && await page.locator('.drag-ghost').count() === 0 && await calls('submit_operation') === submitsBeforeVanish, 'cancelling a drag whose row vanished returns focus to the source list (not BODY) and submits nothing', await focus());
  await page.mouse.up();
  check(await transfer.count() === 0, 'releasing after cancellation does nothing');
  await dragTo(row('left', 'notes.txt'), list('right'), false);
  const tabsBefore = await tabs('left').count();
  await page.keyboard.press('Control+t');
  await page.mouse.up();
  await ready();
  check(await transfer.count() === 0 && await tabs('left').count() === tabsBefore + 1, 'any key cancels a drag first; the key then keeps its normal meaning');
  await page.keyboard.press('Control+w');
  await ready();
  // Closing activates the right neighbour; return the left panel to home.
  await go('left', '/n/home');
  await dragTo(row('left', 'notes.txt'), page.locator('.app-header'));
  check(await transfer.count() === 0, 'dropping on the window header (drag region) does nothing');
  await dragTo(row('left', 'notes.txt'), page.getByRole('tablist', { name: 'right tabs' }));
  check(await transfer.count() === 0, 'dropping on the tab strip does nothing');
  await dragTo(row('left', 'notes.txt'), row('left', 'Media'));
  check(await transfer.count() === 0, 'dropping back on the source panel does nothing');
  await dragTo(row('left', 'notes.txt'), list('right'), false);
  await page.mouse.move(5, -40);
  await page.mouse.up();
  check(await transfer.count() === 0 && await page.locator('.drag-ghost').count() === 0, 'releasing outside the window cancels');
  await dragTo(row('left', 'notes.txt'), list('right'), false);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  check(await transfer.count() === 0, 'window blur cancels a drag');
  const box = await row('left', 'Media').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 33, box.y + 12); await page.mouse.up();
  check(await page.locator('.drag-ghost').count() === 0 && await selectedName('left') === 'Media', 'a small pointer movement remains a click selection');
  await page.evaluate(() => { window.fx.delay['/n/beta'] = 600; });
  await page.getByRole('button', { name: 'right: refresh directory', exact: true }).click();
  await dragTo(row('left', 'notes.txt'), list('right'), false);
  check(await page.locator('.drag-ghost.invalid').textContent().then((text) => text.includes('busy')), 'a loading destination is not a valid target');
  await page.mouse.up();
  await dismissNotice();
  await page.evaluate(() => { window.fx.delay['/n/beta'] = 0; });
  await ready();
  // Source disappears before confirmation: the backend rejects the stale identity.
  await page.evaluate(() => { window.fx.dirs['/n/home'].push({ path: '/n/home/temp.txt', name: 'temp.txt', kind: 'file', identity: 'id:/n/home/temp.txt', size: 1, modifiedMs: 1, metadataError: null }); });
  await page.getByRole('button', { name: 'left: refresh directory', exact: true }).click();
  await ready();
  await dragTo(row('left', 'temp.txt'), list('right'));
  await transfer.waitFor();
  await page.evaluate(() => { window.fx.dirs['/n/home'] = window.fx.dirs['/n/home'].filter((item) => item.name !== 'temp.txt'); });
  await transfer.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.operations-toggle')?.textContent.includes('failed'));
  check(!(await names('right')).includes('temp.txt'), 'a source that disappears before confirmation fails in the manager without creating anything');
  // Tab switch after drop but before confirmation cannot redirect.
  await list('right').focus();
  await page.keyboard.press('Control+t');
  await ready();
  await go('right', '/n/alpha');
  await page.keyboard.press('Control+Shift+Tab');
  await frame();
  check(await path('right').inputValue() === '/display/beta', 'right panel shows beta in its first tab');
  await dragTo(row('left', 'Árvíz.txt'), list('right'));
  await transfer.waitFor();
  await page.keyboard.press('Control+Tab');
  await transfer.getByRole('button', { name: 'Copy', exact: true }).click();
  await ready();
  const redirected = await page.evaluate(() => window.fx.calls.filter((call) => call.command === 'submit_operation').at(-1).payload.request.intent);
  check(redirected.destination === '/n/beta' && await path('right').inputValue() === '/display/beta', 'the confirmed destination is the directory captured at drop time', redirected);

  });
  // ------------------------------------------------------------ Shortcuts
  await section('shortcuts', async () => {
  await list('left').focus();
  await page.keyboard.press('Control+,');
  const shortcutsDialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await shortcutsDialog.waitFor();
  check((await focus()).label === 'Change Copy shortcut', 'shortcut settings open with focus on the first action');
  await page.keyboard.press('Enter');
  check((await focus()).label === 'Press new shortcut for Copy', 'Change starts key capture');
  await page.keyboard.press('Control+t');
  check(await shortcutsDialog.getByRole('alert').textContent() === 'Ctrl+T is already used by New tab.', 'conflicts name the existing action');
  await page.keyboard.press('Enter');
  check((await shortcutsDialog.getByRole('alert').textContent()).includes('reserved'), 'navigation keys are reserved');
  await page.keyboard.press('x');
  check((await shortcutsDialog.getByRole('alert').textContent()).includes('typing is never captured'), 'bare typing keys are rejected');
  await page.keyboard.press('Escape');
  check(await shortcutsDialog.count() === 1 && await shortcutsDialog.getByLabel('Copy shortcut', { exact: true }).textContent() === 'F5', 'Escape cancels capture without closing the dialog');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Shift+C');
  await settle();
  check(await shortcutsDialog.getByLabel('Copy shortcut', { exact: true }).textContent() === 'Ctrl+Shift+C' && JSON.stringify((await settings()).shortcuts) === '{"copy":"Ctrl+Shift+C"}', 'a custom shortcut is applied and only the override is persisted', (await settings()).shortcuts);
  await page.keyboard.press('Escape');
  check(await shortcutsDialog.count() === 0 && (await focus()).label === 'left files', 'closing shortcut settings returns focus to the list');
  check(await page.getByRole('button', { name: 'Copy', exact: true }).getAttribute('title') === 'Copy (Ctrl+Shift+C)', 'toolbar hints follow custom bindings');
  await list('left').press('ArrowDown');
  await page.keyboard.press('F5');
  check(await page.getByRole('dialog', { name: 'Copy' }).count() === 0, 'the replaced default no longer triggers Copy');
  await page.keyboard.press('Control+Shift+C');
  await page.getByRole('dialog', { name: 'Copy' }).waitFor();
  check(true, 'the custom shortcut opens the Copy confirmation (never copies directly)');
  await page.keyboard.press('Escape');
  await restart();
  await page.keyboard.press('Control+Shift+C');
  check(await page.getByRole('dialog', { name: 'Copy' }).count() === 1, 'custom shortcuts persist across restart');
  await page.keyboard.press('Escape');
  // Duplicate submission and key repeat.
  await list('left').press('ArrowDown');
  const submitsBeforeRepeat = await calls('submit_operation');
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.down('C'); await page.keyboard.down('C'); await page.keyboard.up('C'); await page.keyboard.up('Shift'); await page.keyboard.up('Control');
  check(await page.getByRole('dialog', { name: 'Copy' }).count() === 1, 'a held shortcut opens one confirmation');
  await page.keyboard.press('Escape');
  check(await calls('submit_operation') === submitsBeforeRepeat, 'no operation is submitted without confirmation');
  await page.keyboard.press('Control+t'); await ready();
  await page.keyboard.press('Control+t'); await ready();
  const heldBefore = await tabs('left').count();
  await page.keyboard.down('Control'); await page.keyboard.down('w'); await page.keyboard.down('w'); await page.keyboard.down('w'); await page.keyboard.up('w'); await page.keyboard.up('Control');
  await frame();
  check(await tabs('left').count() === heldBefore - 1, 'holding Close tab closes exactly one tab');
  // Text inputs and dialogs suppress shortcuts.
  await path('left').focus();
  const tabsInInput = await tabs('left').count();
  for (const key of ['F7', 'F2', 'Control+t', 'Control+w', 'Control+Tab', 'Control+d', 'Control+Shift+C']) await page.keyboard.press(key);
  check(await page.locator('dialog').count() === 0 && await tabs('left').count() === tabsInInput && (await focus()).label === 'left directory path', 'shortcuts never fire while typing in a text field');
  await path('left').fill('/display/home');
  await page.keyboard.press('Delete');
  check(await path('left').inputValue() === '/display/home', 'Delete edits text instead of trashing a file');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+b');
  await favoritesDialog.waitFor();
  await page.keyboard.press('Control+t');
  await page.keyboard.press('Control+Shift+C');
  check(await tabs('left').count() === tabsInInput && await page.getByRole('dialog', { name: 'Copy' }).count() === 0, 'shortcuts are suppressed while a dialog is open');
  await page.keyboard.press('Escape');
  // Reset and restore defaults.
  await page.keyboard.press('Control+,');
  await shortcutsDialog.waitFor();
  await shortcutsDialog.getByRole('button', { name: 'Change Close tab shortcut', exact: true }).click();
  await page.keyboard.press('Control+Shift+W');
  await shortcutsDialog.getByRole('button', { name: 'Reset Copy shortcut', exact: true }).click();
  check(await shortcutsDialog.getByLabel('Copy shortcut', { exact: true }).textContent() === 'F5' && await shortcutsDialog.getByLabel('Close tab shortcut', { exact: true }).textContent() === 'Ctrl+Shift+W', 'one shortcut can be reset individually');
  await shortcutsDialog.getByRole('button', { name: 'Change New tab shortcut', exact: true }).click();
  await page.keyboard.press('Control+y');
  await shortcutsDialog.getByRole('button', { name: 'Change Quick Filter shortcut', exact: true }).click();
  await page.keyboard.press('Control+t');
  await shortcutsDialog.getByRole('button', { name: 'Reset New tab shortcut', exact: true }).click();
  check(await shortcutsDialog.getByLabel('New tab shortcut', { exact: true }).textContent() === 'Ctrl+Y' && (await shortcutsDialog.getByRole('alert').textContent()).includes('already used by Quick Filter'), 'resetting a shortcut never creates a duplicate binding');
  await shortcutsDialog.getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await settle();
  check(await shortcutsDialog.getByLabel('Close tab shortcut', { exact: true }).textContent() === 'Ctrl+W' && JSON.stringify((await settings()).shortcuts) === '{}', 'Restore defaults clears every override');
  await page.keyboard.press('Escape');
  // Invalid persisted shortcuts fall back safely.
  await settle();
  await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('fx-settings')); value.shortcuts = { copy: 'Enter', move: 'Ctrl+T', bogus: 'F9', rename: 'Alt+R' }; localStorage.setItem('fx-settings', JSON.stringify(value)); });
  await page.reload(); await ready();
  check((await notice.textContent())?.includes('default is used') && await page.getByRole('button', { name: 'Copy', exact: true }).getAttribute('title') === 'Copy (F5)' && await page.getByRole('button', { name: 'Rename', exact: true }).getAttribute('title') === 'Rename (Alt+R)', 'invalid or conflicting persisted shortcuts fall back to defaults individually with a visible warning');
  await dismissNotice();
  // Codex review R004-01: entries from another version survive a full round trip.
  await settle();
  await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('fx-settings')); value.shortcuts = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`future${String(i).padStart(2, '0')}`, 'F9'])); localStorage.setItem('fx-settings', JSON.stringify(value)); });
  await page.reload(); await ready();
  await page.keyboard.press('Control+t'); await ready();
  await settle();
  check(Object.keys((await settings()).shortcuts).length === 64, 'all 64 stored shortcut entries from another version survive saving', Object.keys((await settings()).shortcuts).length);
  await dismissNotice();
  await page.keyboard.press('Control+,');
  await shortcutsDialog.waitFor();
  await shortcutsDialog.getByRole('button', { name: 'Change Copy shortcut', exact: true }).click();
  await page.keyboard.press('Control+Shift+C');
  await settle();
  check((await shortcutsDialog.getByRole('alert').textContent()).includes('64') && await shortcutsDialog.getByLabel('Copy shortcut', { exact: true }).textContent() === 'F5' && Object.keys((await settings()).shortcuts).length === 64, 'a new override beyond the 64-entry limit is refused visibly instead of deleting stored entries');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+w'); await ready();
  await settle();
  // Codex re-review R004-03: a JSON key named __proto__ is an ordinary stored entry.
  await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('fx-settings')); value.shortcuts = {}; localStorage.setItem('fx-settings', JSON.stringify(value).replace('"shortcuts":{}', '"shortcuts":{"__proto__":"F9","constructor":"F10"}')); });
  await page.reload(); await ready();
  await page.keyboard.press('Control+t'); await ready();
  await settle();
  const specialSaved = await page.evaluate(() => { const shortcuts = JSON.parse(localStorage.getItem('fx-settings')).shortcuts; return { proto: Object.hasOwn(shortcuts, '__proto__') ? shortcuts.__proto__ : null, keys: Object.keys(shortcuts).sort() }; });
  check(specialSaved.proto === 'F9' && specialSaved.keys.join() === '__proto__,constructor', 'stored entries named like object properties (__proto__) survive a save', specialSaved);
  await dismissNotice();
  await page.keyboard.press('Control+w'); await ready();
  await settle();
  await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('fx-settings')); value.shortcuts = {}; localStorage.setItem('fx-settings', JSON.stringify(value)); });
  await page.reload(); await ready();
  // Settings dialogs wait for settings to load, so early edits cannot be overwritten.
  await settle();
  await page.evaluate(() => localStorage.setItem('fx-load-delay', '700'));
  await page.reload();
  await page.waitForSelector('.shortcuts-button');
  check(await page.locator('.shortcuts-button').isDisabled(), 'shortcut settings cannot be edited before settings finish loading');
  await page.evaluate(() => localStorage.removeItem('fx-load-delay'));
  await ready();
  check(await page.locator('.shortcuts-button').isEnabled(), 'shortcut settings become available after loading');
  // Settings load failure disables saving.
  await settle();
  await page.evaluate(() => localStorage.setItem('fx-fail-load', '1'));
  await page.reload(); await ready();
  await page.keyboard.press('Control+t'); await ready();
  await page.keyboard.press('Control+d');
  await frame();
  check(await calls('save_settings') === 0 && (await notice.textContent()).includes('for this session'), 'an unreadable settings boundary disables saving so the file cannot be overwritten');
  await page.evaluate(() => localStorage.removeItem('fx-fail-load'));
  // Recovered settings report warnings from Rust.
  await page.evaluate(() => localStorage.setItem('fx-load-override', JSON.stringify({ document: { version: 1, favorites: [], shortcuts: {}, session: null }, status: 'recovered', warnings: ['Settings were reset because settings.json is not valid JSON.', 'The previous file was preserved as settings.invalid.json.'] })));
  await page.reload(); await ready();
  check((await notice.textContent()).includes('settings.invalid.json'), 'recovered settings warnings are shown');
  await page.keyboard.press('Control+t'); await ready();
  await settle();
  check(await calls('save_settings') > 0, 'recovered settings may be saved again');

  });
  // macOS conventions in a separate context.
  await section('macos', async () => {
  const browser = page.context().browser();
  const mac = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15', viewport: { width: 1200, height: 780 } });
  const macPage = await mac.newPage();
  await macPage.addInitScript(fixture);
  await macPage.goto('http://127.0.0.1:1420');
  await macPage.waitForFunction(() => document.querySelectorAll('.pane-view:not([hidden]) [role=listbox][aria-busy=false]').length === 2);
  await macPage.keyboard.press('Meta+t');
  await macPage.waitForFunction(() => document.querySelectorAll('[aria-label="left tabs"] [role=tab]').length === 2);
  await macPage.keyboard.press('Meta+Shift+W');
  await macPage.waitForFunction(() => document.querySelectorAll('[aria-label="left tabs"] [role=tab]').length === 1);
  check(await macPage.getByRole('button', { name: 'left: new tab' }).getAttribute('title') === 'New tab (⌘T)', 'macOS uses Command conventions and symbols (⌘T, ⇧⌘W)');
  await macPage.keyboard.press('Meta+,');
  await macPage.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  await macPage.getByRole('button', { name: 'Change New tab shortcut' }).click();
  await macPage.keyboard.press('Meta+w');
  check((await macPage.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByRole('alert').textContent()).includes('macOS'), '⌘W is reserved for the macOS application menu');
  await mac.close();

  });
  await page.screenshot({ path: 'test-results/slice-004-renderer.png' });
  const failed = checks.filter((item) => !item.pass);
  check(errors.length === 0, `no browser runtime errors (${errors.join('; ')})`);
  return JSON.stringify({ mode: 'MOCKED IPC renderer, trusted Chromium input', passed: checks.filter((item) => item.pass).length, failed, timings, checks: checks.map((item) => `${item.pass ? 'PASS' : 'FAIL'} ${item.name}`) }, null, 1);
}
