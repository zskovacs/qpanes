// Second acceptance fixes. MOCKED IPC, trusted Playwright keyboard/pointer input.
// Standalone: playwright-cli -s=qpanes --raw run-code --filename=tests/ui/acceptance-fixes.cli.mjs
async (page) => {
  page.setDefaultTimeout(5000);
  const passed = [], failed = [], runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const check = (ok, message) => { if (!ok) throw new Error(message); passed.push(message); };
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
  const list = side => page.getByRole('listbox', { name: `${side} files`, exact: true });
  const pane = side => page.getByRole('region', { name: `${side} panel`, exact: true });
  const path = side => page.getByRole('textbox', { name: `${side} directory path`, exact: true });
  const sort = (side, key) => pane(side).getByRole('button', { name: new RegExp(`^Sort ${side} by ${key},`) });
  const compact = side => pane(side).getByRole('combobox', { name: `${side} sort by`, exact: true });
  const retry = side => pane(side).getByRole('button', { name: 'Retry', exact: true });
  const ready = side => page.waitForFunction(s => document.querySelector(`[aria-label="${s} files"]`)?.getAttribute('aria-busy') === 'false', side, {timeout:3000});
  const selected = side => list(side).locator('[aria-selected="true"] .filename').textContent();
  const focused = locator => locator.evaluate(el => el === document.activeElement);
  const go = async (side, target) => { await path(side).fill(target); await page.keyboard.press('Enter'); await ready(side); };
  const pending = target => page.waitForFunction(target => window.qpanesTest.pending.some(p => p.path === target), target, {timeout:3000});
  const release = target => page.evaluate(target => window.qpanesTest.release(target), target);
  const reset = async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://127.0.0.1:1420'); await ready('left'); await ready('right');
  };
  const probe = async (name, run) => {
    await reset();
    try { await run(); } catch (error) { failed.push(`${name}: ${error.message}`); }
  };
  for (const side of ['left', 'right']) {
    const other = side === 'left' ? 'right' : 'left';
    for (const method of ['Enter', 'Backspace']) await probe(`${side} parent Retry ${method}`, async () => {
      await go(side, '/many'); await list(side).focus(); await page.keyboard.press('End');
      check(await selected(side) === 'folder-09999', `${side} ${method}: select offscreen child`);
      await page.keyboard.press('Enter'); await ready(side);
      await page.evaluate(() => {
        window.qpanesTest.errors['/many'] = { code: 'permissionDenied', message: 'Permission denied' };
        // Backspace must carry the exited directory identity, not this ordinary selection.
        window.qpanesTest.directories['/many/folder-09999'].entries = [
          { path:'/many/folder-09999/nested', name:'nested', kind:'directory', size:null, modifiedMs:null, metadataError:null }
        ];
      });
      if (method === 'Backspace') await go(side, '/many/folder-09999');
      await page.keyboard.press(method); await ready(side);
      check(await retry(side).isVisible(), `${side} ${method}: parent permission failure is displayed`);
      await retry(side).focus(); await page.keyboard.press('Enter'); await ready(side);
      check(await retry(side).isVisible() && await focused(list(side)), `${side} ${method}: another failed Retry retains usable list focus`);
      await page.evaluate(() => { delete window.qpanesTest.errors['/many']; window.qpanesTest.deferredPaths.push('/many'); });
      await retry(side).focus(); await page.keyboard.press('Enter'); await pending('/many');
      await page.keyboard.press('Tab');
      await release('/many'); await ready(side);
      check(await selected(side) === 'folder-09999', `${side} ${method}: Retry restores exited child after permission recovery`);
      check(await list(side).evaluate(el => el.scrollTop > 300000) && await list(side).getByRole('option').count() < 60,
        `${side} ${method}: Retry reveals restored child without defeating virtualization`);
      check(await focused(list(other)) && await path(other).inputValue() === '/home' && await selected(other) === 'Child',
        `${side} ${method}: Retry leaves inactive selection and intentionally moved focus intact`);
      await go(side, '/many/folder-09999');
      await page.evaluate(() => { window.qpanesTest.errors['/many'] = {code:'permissionDenied',message:'Permission denied'}; });
      if (method === 'Enter') { await list(side).focus(); await page.keyboard.press('Home'); }
      await page.keyboard.press(method); await ready(side);
      await page.evaluate(() => { delete window.qpanesTest.errors['/many']; window.qpanesTest.deferredPaths.push('/many'); });
      await retry(side).click(); await pending('/many');
      await go(side, '/other'); await release('/many');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(await path(side).inputValue() === '/other' && await selected(side) === 'other.txt', `${side} ${method}: superseded Retry cannot restore stale path/selection`);
    });
    await probe(`${side} canceled edit`, async () => {
      const start = async () => {
        await page.evaluate(() => window.qpanesTest.deferredPaths.push('/slow'));
        await path(side).fill('/slow'); await page.keyboard.press('Enter'); await pending('/slow');
        await page.keyboard.press('Control+l'); await path(side).fill('/unsubmitted');
      };
      await start(); await page.keyboard.press('Escape');
      check(await path(side).inputValue() === '/home' && await focused(list(side)), `${side}: Escape immediately discards pending edit`);
      await release('/slow'); await ready(side);
      check(await path(side).inputValue() === '/slow', `${side}: completed navigation updates canceled editor`);
      check(await page.evaluate(() => !window.qpanesTest.requests.some(r => r.target?.value === '/unsubmitted')), `${side}: canceled text never navigates`);
      await go(side, '/home'); await start(); await release('/slow'); await ready(side);
      check(await path(side).inputValue() === '/unsubmitted' && await focused(path(side)), `${side}: active genuine edit survives completion`);
      await page.keyboard.press('Escape');
      check(await path(side).inputValue() === '/slow', `${side}: Escape after completion shows committed path`);
      await go(side, '/home'); await start(); await page.keyboard.press('Escape');
      await page.evaluate(() => { window.qpanesTest.errors['/slow'] = { code:'permissionDenied', message:'Permission denied' }; });
      await release('/slow'); await ready(side);
      check(await path(side).inputValue() === '/home' && await retry(side).isVisible(), `${side}: canceled edit remains committed path on failure`);
      await page.evaluate(() => { delete window.qpanesTest.errors['/slow']; });
      await retry(side).click(); await ready(side);
      check(await path(side).inputValue() === '/slow', `${side}: Retry updates canceled editor`);
      await go(side, '/home'); await start(); await page.keyboard.press('Escape');
      await go(side, '/other'); await release('/slow');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(await path(side).inputValue() === '/other' && (await list(side).locator('.filename').allTextContents()).includes('other.txt'), `${side}: stale completion cannot replace newer path/listing`);
      await go(side, '/home'); await start(); await page.keyboard.press('Escape');
      await go(side, '/other');
      await page.evaluate(() => { window.qpanesTest.errors['/slow'] = {code:'permissionDenied',message:'Permission denied'}; });
      await release('/slow');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      check(await path(side).inputValue() === '/other' && await retry(side).count() === 0, `${side}: stale failure cannot corrupt canceled edit or newer navigation`);
      check(await path(other).inputValue() === '/home', `${side}: address races remain pane-local`);
    });
    await probe(`${side} responsive focus`, async () => {
      await list(side).focus(); await page.keyboard.press('Shift+Tab');
      check(await focused(sort(side, 'modified')), `${side}: keyboard reaches desktop sort header`);
      await page.setViewportSize({ width:720, height:420 });
      await page.waitForFunction(s => document.activeElement?.getAttribute('aria-label') === `${s} sort by`, side, {timeout:3000});
      check(await focused(compact(side)) && await selected(side) === 'Child', `${side}: shrinking transfers sort focus without changing selection`);
      await page.keyboard.press('End'); await ready(side);
      check(await compact(side).inputValue() === 'modified', `${side}: compact sort still responds to trusted keyboard`);
      await page.setViewportSize({ width:1280, height:800 });
      await page.waitForFunction(s => document.activeElement?.getAttribute('aria-label')?.startsWith(`Sort ${s} by modified,`), side, {timeout:3000});
      check(await focused(sort(side, 'modified')), `${side}: growth transfers compact focus to equivalent header`);
      await page.keyboard.press('Tab');
      check(await focused(list(side)), `${side}: Tab reaches list immediately after responsive transfer`);
      await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await ready(side);
      check(await path(side).inputValue() === '/home/Child', `${side}: arrows and Enter work after responsive transfer`);
      await page.keyboard.press('Backspace'); await ready(side);
      check(await selected(side) === 'Child', `${side}: Backspace restores selection after responsive transfer`);
      await path(other).fill('/intentional'); await page.setViewportSize({ width:720, height:420 });
      check(await focused(path(other)) && await path(other).inputValue() === '/intentional', `${side}: resize does not steal unrelated editor focus`);
      await page.setViewportSize({ width:1280, height:800 });
      await path(side).focus(); await page.keyboard.press('Escape');
      await page.setViewportSize({width:1200,height:780});
      const slider = page.getByRole('slider', {name:'Resize panels'});
      const b = await slider.boundingBox();
      await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down();
      // Keep the splitter's pointer capture, but deliberately return keyboard ownership to a sort control.
      await sort(side,'size').focus();
      await page.mouse.move(side === 'left' ? 300 : 1000,b.y+b.height/2,{steps:8}); await page.mouse.up();
      await page.waitForFunction(s => document.activeElement?.getAttribute('aria-label') === `${s} sort by`, side, {timeout:3000});
      check(await focused(compact(side)) && await selected(side) === 'Child', `${side}: splitter shrink preserves sort ownership and selection`);
      const b2 = await slider.boundingBox();
      await page.mouse.move(b2.x+b2.width/2,b2.y+b2.height/2); await page.mouse.down(); await compact(side).focus();
      await page.mouse.move(640,b2.y+b2.height/2,{steps:8}); await page.mouse.up();
      await page.waitForFunction(s => document.activeElement?.getAttribute('aria-label')?.startsWith(`Sort ${s} by modified,`), side, {timeout:3000});
      check(await focused(sort(side,'modified')), `${side}: splitter growth preserves sort ownership`);
      await slider.focus(); await page.keyboard.press('Home');
      await page.setViewportSize({width:720,height:420});
      await pane(side).getByRole('button',{name:`${side}: reverse sort direction`}).focus();
      await page.setViewportSize({width:1280,height:800});
      await page.waitForFunction(s => document.activeElement?.getAttribute('aria-label')?.startsWith(`Sort ${s} by modified,`), side, {timeout:3000});
      check(await focused(sort(side,'modified')), `${side}: hidden direction control also transfers focus`);
      await slider.focus(); await page.keyboard.press(side === 'left' ? 'ArrowLeft' : 'ArrowRight');
      check(await focused(slider), `${side}: ordinary splitter interaction keeps splitter focus`);
    });
  }
  await probe('bounded errors', async () => {
    await page.setViewportSize({width:720,height:420});
    const long = '/fixture/' + Array.from({length:10}, (_,i) => `segment${i}${'x'.repeat(50)}`).join('/');
    check(long.length >= 500, 'deep path fixture exceeds 500 characters');
    await page.evaluate(p => { window.qpanesTest.directories[p] = {parent:'/',entries:window.qpanesTest.directories['/home'].entries};
      window.qpanesTest.errors['/missing'] = {code:'notFound',message:`Directory not found: ${p}/${'z'.repeat(600)}`}; }, long);
    const slider = page.getByRole('slider',{name:'Resize panels'});
    for (const split of [50,30,70]) {
      await slider.focus(); await page.keyboard.press('Home');
      for (let i=0;i<Math.abs(split-50)/2;i++) await page.keyboard.press(split<50?'ArrowLeft':'ArrowRight');
      for (const side of ['left','right']) {
        await go(side,long); await go(side,'/missing');
        const g = await pane(side).evaluate(el => {
          const p=el.getBoundingClientRect(), l=el.querySelector('.file-list').getBoundingClientRect(), f=el.querySelector('.pane-status').getBoundingClientRect(), e=el.querySelector('.error-banner').getBoundingClientRect();
          return {list:l.height, error:e.height, footerInside:f.bottom<=p.bottom, overflow:document.documentElement.scrollWidth>innerWidth||document.documentElement.scrollHeight>innerHeight};
        });
        check(g.list >= 40 && g.error <= 56 && g.footerInside && !g.overflow, `${split}% ${side}: long error preserves list/footer without window overflow (${JSON.stringify(g)})`);
        await list(side).focus(); await page.keyboard.press('Shift+Tab');
        check(await focused(retry(side)), `${split}% ${side}: Retry remains in keyboard order`);
        await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Enter');
        const details = pane(side).getByRole('dialog',{name:`${side} error details`,exact:true});
        check(await details.isVisible() && (await details.textContent()).includes(long) && (await details.textContent()).includes('z'.repeat(600)), `${split}% ${side}: full path and error remain accessible`);
        check(await details.evaluate(el => el.scrollHeight > el.clientHeight && el.clientHeight>0), `${split}% ${side}: full error details scroll internally`);
        if (split === 50 && side === 'left') await page.screenshot({path:'test-results/slice-001-second-error-details.png'});
        await details.focus(); await page.keyboard.press('End'); await page.keyboard.press('Escape');
        check(await focused(pane(side).locator('.error-details summary')) && !(await details.isVisible()), `${split}% ${side}: Escape closes details with usable focus`);
      }
      await page.screenshot({path:`test-results/slice-001-second-errors-${split}.png`});
    }
  });
  check(runtimeErrors.length === 0, `no renderer runtime errors (${runtimeErrors.join('; ')})`);
  check(await page.evaluate(() => window.qpanesTest.keys.length > 0 && window.qpanesTest.keys.every(e => e.trusted)), 'all regression keyboard events were trusted');
  const report = {mode:'MOCKED IPC second acceptance regressions with trusted input',passed:passed.length,checks:passed,failed};
  if (failed.length) throw new Error(JSON.stringify(report));
  return report;
}
