// MOCKED Tauri IPC. Native dragging/resizing and physical DPI require native tests.
// playwright-cli -s=qpanes-chrome --raw run-code --filename=tests/ui/window-chrome.cli.mjs
async (page) => {
  const passed = [], errors = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); passed.push(message); };
  page.on('pageerror', error => errors.push(error.message));
  const installMock = () => {
    const callbacks = new Map(), listeners = new Map();
    let id = 0;
    const c = window.chromeTest = { requests: [], maximized: false, minimized: false, scale: 1, fail: '',
      emit(event, payload = { width: 1200, height: 780 }) {
        for (const [eventId, entry] of listeners) if (entry.event === event) callbacks.get(entry.handler)?.({ event, id: eventId, payload });
      },
    };
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, eventId) => listeners.delete(eventId) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(callback) { callbacks.set(++id, callback); return id; },
      unregisterCallback(callbackId) { callbacks.delete(callbackId); },
      async invoke(command, payload) {
        c.requests.push({ command, payload });
        if (command === 'plugin:event|listen') { listeners.set(++id, payload); return id; }
        if (command === 'plugin:event|unlisten') return;
        if (command.startsWith('plugin:window|')) {
          const name = command.split('|')[1];
          if (c.fail === name) throw new Error('Simulated native action failure');
          if (name === 'is_maximized') return c.maximized;
          if (name === 'scale_factor') return c.scale;
          if (name === 'toggle_maximize') { c.maximized = !c.maximized; c.emit('tauri://resize'); return; }
          if (name === 'minimize') { c.minimized = true; return; }
          if (name === 'close') return;
          throw new Error(`Unexpected window command ${name}`);
        }
        const path = payload.request?.target.kind === 'home' ? '/fixture' : payload.request?.target.value;
        const entries = path === '/fixture' ? [
          { path: '/fixture/Folder', name: 'Folder', kind: 'directory', size: null, modifiedMs: null, metadataError: null },
          { path: '/fixture/file', name: 'file', kind: 'file', size: 7, modifiedMs: null, metadataError: null },
        ] : [];
        if (command === 'sort_directory_entries') return payload.entries;
        if (command === 'list_directory') return { path, label: path, parent: path === '/' ? null : '/', entries, warnings: [], sort: payload.request.sort, direction: payload.request.direction };
        throw new Error(`Unexpected command ${command}`);
      },
    };
  };
  await page.addInitScript(installMock);
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.goto('http://127.0.0.1:1420');
  const button = name => page.getByRole('button', { name: `${name} window`, exact: true });
  const list = side => page.getByRole('listbox', { name: `${side} files`, exact: true });
  const ready = async () => { await page.waitForFunction(() => [...document.querySelectorAll('[role=listbox]')].length === 2 && [...document.querySelectorAll('[role=listbox]')].every(el => el.getAttribute('aria-busy') === 'false')); };
  const focused = locator => locator.evaluate(el => document.activeElement === el);
  await ready(); await button('Maximize').waitFor();
  check(await page.locator('header.app-header').count() === 1, 'one application header');
  check(await page.locator('header.app-header').evaluate(el => el.getBoundingClientRect().height === 61), 'existing header height preserved');
  check(await page.locator('header.app-header').getAttribute('data-tauri-drag-region') === '', 'header uses built-in Tauri drag/double-click region');
  check(await page.locator('.brand').evaluate(el => getComputedStyle(el).pointerEvents === 'none'), 'brand text and icons hit the header drag region');
  check(await page.locator('.window-controls button').evaluateAll(els => els.every(el => !el.hasAttribute('data-tauri-drag-region') && getComputedStyle(el).pointerEvents !== 'none')), 'interactive controls are excluded from drag regions');
  check(await focused(list('left')), 'initial focus preserved');
  await button('Maximize').click(); await button('Restore').waitFor();
  check(await focused(list('left')), 'pointer maximize retains pane focus');
  await button('Restore').click(); await button('Maximize').waitFor();
  check(await focused(list('left')), 'pointer restore retains pane focus');
  await button('Minimize').click();
  check(await page.evaluate(() => window.chromeTest.minimized), 'minimize action invokes native API');
  check(await focused(list('left')), 'minimize does not move DOM focus');
  await button('Close').click();
  check(await page.evaluate(() => window.chromeTest.requests.some(r => r.command === 'plugin:window|close')), 'close uses normal close request API');
  await page.evaluate(() => { window.chromeTest.maximized = true; window.chromeTest.emit('tauri://resize'); });
  await button('Restore').waitFor(); check(true, 'external maximize updates restore control');
  await page.evaluate(() => { window.chromeTest.maximized = false; window.chromeTest.emit('tauri://resize'); });
  await button('Maximize').waitFor(); check(true, 'external restore updates maximize control');
  await list('left').press('Tab'); check(await focused(list('right')), 'Tab still switches panels');
  await button('Maximize').focus(); await page.keyboard.press('Enter'); await button('Restore').waitFor();
  check(await focused(button('Restore')), 'keyboard maximize retains control focus');
  await page.keyboard.press('Escape'); check(await focused(list('right')), 'Escape from controls returns to active pane');
  await button('Restore').click(); await button('Maximize').waitFor();
  await list('right').press('ArrowDown');
  check(await list('right').locator('[aria-selected=true] .filename').textContent() === 'file', 'arrows continue after window controls');
  const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, row: document.querySelector('.file-row').getBoundingClientRect().height }));
  for (let round = 0; round < 3; round++) for (const scale of [1, 1.25, 1.5, 2, 1.5, 1]) {
    await page.evaluate(scale => { window.chromeTest.scale = scale; window.chromeTest.emit('tauri://scale-change', { scaleFactor: scale, size: { width: 1200 * scale, height: 780 * scale } }); }, scale);
    await page.waitForFunction(scale => window.chromeTest.requests.filter(r => r.command === 'plugin:window|scale_factor').length > 2 && window.chromeTest.scale === scale, scale);
    check(await focused(list('right')), `scale event ${round}/${scale} preserves focus`);
  }
  check(await page.evaluate(before => innerWidth === before.width && innerHeight === before.height && document.querySelector('.file-row').getBoundingClientRect().height === before.row && getComputedStyle(document.documentElement).zoom === '1' && !document.documentElement.style.transform, before), 'repeated simulated transitions do not accumulate scaling or reset dimensions');
  check(await page.evaluate(() => window.chromeTest.requests.every(r => !/set_zoom|set_size|set_position/.test(r.command))), 'no application zoom/size/position commands');
  await page.screenshot({ path: 'test-results/slice-001.5-chrome-mocked.png' });
  for (const width of [720, 900, 1200, 2560, 3840]) {
    await page.setViewportSize({ width, height: width >= 2560 ? 1440 : 420 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), `${width}px renderer layout has no whole-window overflow`);
    check(await button('Close').isVisible(), `${width}px close control remains visible`);
  }
  await page.setViewportSize({ width: 720, height: 420 });
  await page.screenshot({ path: 'test-results/slice-001.5-compact-mocked.png' });
  await page.evaluate(() => { window.chromeTest.fail = 'minimize'; });
  await button('Minimize').click();
  check(await page.getByRole('alert').getByText('Window action unavailable. Try again.').isVisible(), 'failed native action has accessible feedback');
  await page.evaluate(() => { window.chromeTest.fail = ''; }); await button('Minimize').click();
  check(await page.getByRole('alert').count() === 0, 'successful retry clears window error');
  const browser = page.context().browser();
  for (const dpr of [1, 1.25, 1.5, 2]) for (const resolution of [{ width: 2560, height: 1440 }, { width: 3840, height: 2160 }]) {
    const context = await browser.newContext({ deviceScaleFactor: dpr, viewport: { width: Math.floor(resolution.width / dpr), height: Math.floor(resolution.height / dpr) } });
    try {
      const probe = await context.newPage(); await probe.addInitScript(installMock); await probe.goto('http://127.0.0.1:1420');
      await probe.getByRole('button', { name: 'Maximize window', exact: true }).waitFor();
      check(await probe.evaluate(dpr => devicePixelRatio === dpr && document.querySelector('.file-row').getBoundingClientRect().height === 32 && getComputedStyle(document.documentElement).zoom === '1' && document.documentElement.scrollWidth <= innerWidth, dpr), `EMULATED ${resolution.width}×${resolution.height} at ${dpr * 100}% retains logical geometry without extra zoom`);
    } finally { await context.close(); }
  }
  const mac = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', viewport: { width: 720, height: 420 } });
  try {
    const probe = await mac.newPage(); await probe.addInitScript(installMock); await probe.goto('http://127.0.0.1:1420');
    await probe.locator('header.macos').waitFor();
    check(await probe.getByRole('group', { name: 'Window controls' }).count() === 0, 'macOS presentation reserves native controls instead of rendering duplicate buttons');
    check(await probe.locator('.brand').evaluate(el => el.getBoundingClientRect().left >= 88) && await probe.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'macOS traffic-light space remains clear at minimum width');
    await probe.screenshot({ path: 'test-results/slice-001.5-macos-layout-mocked.png' });
  } finally { await mac.close(); }
  check(errors.length === 0, `no renderer exceptions (${errors.join(', ')})`);
  return { mode: 'MOCKED window IPC/events, trusted Chromium input; no physical DPI claim', passed: passed.length, checks: passed };
}
