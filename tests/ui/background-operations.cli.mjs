// Playwright CLI, trusted Chromium input and MOCKED Tauri IPC. No native filesystem claim.
async (page) => {
  const passed = [], errors = [];
  const check = (value, message) => { if (!value) throw new Error(message); passed.push(message); };
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.addInitScript(() => {
    const callbacks = new Map(), listeners = new Map(); let callbackId = 0;
    const entry = (path, name, kind = 'file') => ({ path, name, kind, identity: `id:${path}`, size: kind === 'file' ? 8192 : null, modifiedMs: null, metadataError: null });
    const stored = sessionStorage.getItem('slice003-fixture');
    const state = stored ? JSON.parse(stored) : { revision: 0, invalidationRevision: 0, jobs: [], accepting: true, closeRequested: false, shutdownState: 'idle', submissions: 0,
      dirs: { '/native/left': [entry('/native/left/folder', 'Folder', 'directory'), entry('/native/left/alpha', 'alpha.bin'), entry('/native/left/zero', 'zero.bin')], '/native/right': [entry('/native/right/original', 'original.txt')], '/native/elsewhere': [entry('/native/elsewhere/other', 'other.txt')] } };
    const save = () => sessionStorage.setItem('slice003-fixture', JSON.stringify(state));
    const snapshot = () => structuredClone({ revision: state.revision, invalidationRevision: state.invalidationRevision, jobs: state.jobs, accepting: state.accepting, closeRequested: state.closeRequested, shutdownState: state.shutdownState });
    const notify = () => { for (const job of state.jobs) if (['completed','failed','cancelled'].includes(job.state) && job.invalidationRevision == null) job.invalidationRevision = ++state.invalidationRevision; save(); for (const [id, item] of listeners) if (item.event === 'operations-changed') callbacks.get(item.handler)?.({ id, event: item.event, payload: state.revision }); };
    const change = () => { state.revision++; notify(); };
    const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.state);
    const make = (intent, retryOf = null) => {
      const sourceParent = intent.kind === 'create' ? intent.parent : Object.keys(state.dirs).find(path => state.dirs[path].some(item => item.path === intent.source.path));
      const job = { id: String(state.jobs.length + 1), intent: structuredClone(intent), sourceLabel: sourceParent, destinationLabel: intent.destination ?? null,
        affectedDirectories: intent.kind === 'copy' ? [intent.destination] : intent.kind === 'move' ? [sourceParent, intent.destination] : [sourceParent],
        submittedMs: Date.now(), startedMs: null, completedMs: null, state: state.jobs.some(job => !terminal(job)) ? 'queued' : 'running',
        progress: { currentItem: null, currentLabel: null, bytesProcessed: 0, totalBytes: null, completedFiles: 0, totalFiles: null, elapsedMs: 0, bytesPerSecond: null, remainingMs: null },
        cancellable: true, cancellationRequested: false, invalidationRevision: null, result: null, error: null, retryable: false, retryOf };
      if (job.state === 'running') job.startedMs = Date.now(); state.jobs.push(job); change(); return structuredClone(job);
    };
    window.ops = {
      state, reads: 0, calls: [], holdSnapshot: false,
      notify,
      listenerCount: () => [...listeners.values()].filter(item => item.event === 'operations-changed').length,
      advance(id, patch) { const job = state.jobs.find(job => job.id === id); Object.assign(job.progress, patch); job.startedMs = Date.now() - job.progress.elapsedMs; change(); },
      finish(id, failure = null) {
        const job = state.jobs.find(job => job.id === id); job.state = failure ? 'failed' : 'completed'; job.cancellable = false; job.completedMs = Date.now();
        job.error = failure; job.retryable = !!failure && job.intent.kind !== 'trash';
        if (!failure) {
          const intent = job.intent; const parent = job.affectedDirectories[0];
          const path = intent.kind === 'create' ? `${parent}/created-${id}` : `${intent.destination}/copied-${id}`;
          if (intent.kind === 'copy') { state.dirs[intent.destination].push(entry(path, intent.source.name)); if (job.progress.totalBytes !== null) job.progress.bytesProcessed = job.progress.totalBytes; if (job.progress.totalFiles !== null) job.progress.completedFiles = job.progress.totalFiles; }
          if (intent.kind === 'create') state.dirs[parent].push(entry(path, intent.name, 'directory'));
          job.result = { path, warnings: [] };
        }
        change();
      },
      close() { state.closeRequested = true; change(); },
      blockShutdown() { state.shutdownState = 'blocked'; change(); },
    };
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, id) => listeners.delete(id) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, payload = {}) {
        window.ops.calls.push({ command, payload: structuredClone(payload) });
        if (command === 'plugin:event|listen') { listeners.set(++callbackId, payload); return callbackId; }
        if (command === 'plugin:event|unlisten') { listeners.delete(payload.eventId); return; }
        if (command.startsWith('plugin:window|')) { if (command.endsWith('|close')) window.ops.close(); return command.endsWith('|scale_factor') ? 1 : false; }
        if (command === 'list_operations') {
          window.ops.reads++; const captured = snapshot();
          if (window.ops.holdSnapshot) { window.ops.holdSnapshot = false; await new Promise(resolve => { window.ops.releaseSnapshot = resolve; }); }
          return captured;
        }
        if (command === 'sort_directory_entries') {
          const ordered = payload.entries.slice().sort((a, b) => (a.kind !== 'directory') - (b.kind !== 'directory') || (payload.direction === 'ascending' ? 1 : -1) * a.name.localeCompare(b.name));
          if (window.ops.holdSort) { window.ops.holdSort = false; await new Promise(resolve => { window.ops.releaseSort = resolve; }); }
          return ordered;
        }
        if (command === 'list_directory') {
          const request = payload.request; const path = request.target.kind === 'home' ? '/native/left' : request.target.value;
          const entries = structuredClone(state.dirs[path] ?? []);
          if (window.ops.holdListingPath === path) { window.ops.holdListingPath = null; await new Promise(resolve => { window.ops.releaseListing = resolve; }); }
          return { path, label: path.replace('/native', '/display'), parent: '/', entries, warnings: [], sort: request.sort, direction: request.direction };
        }
        if (command === 'submit_operation') { state.submissions++; return make(payload.request.intent); }
        if (command === 'cancel_operation') {
          const job = state.jobs.find(job => job.id === payload.id); job.cancellationRequested = true;
          job.state = job.state === 'queued' ? 'cancelled' : 'cancelling'; job.cancellable = false; change(); return structuredClone(job);
        }
        if (command === 'retry_operation') {
          state.retryTokens ??= {};
          const token = `${payload.clientId}:${payload.sequence}`;
          if (state.retryTokens[token]) return structuredClone(state.jobs.find(job => job.id === state.retryTokens[token]));
          const original = state.jobs.find(job => job.id === payload.id); const job = make(original.intent, original.id); state.retryTokens[token] = job.id; save(); return job;
        }
        if (command === 'dismiss_operation') { const index = state.jobs.findIndex(job => job.id === payload.id); if (!terminal(state.jobs[index])) throw new Error('Cannot dismiss an active job'); state.jobs.splice(index, 1); change(); return; }
        if (command === 'shutdown_operations') {
          if (payload.action === 'keepWorking') { state.closeRequested = false; state.shutdownState = 'idle'; state.accepting = true; }
          else { state.shutdownState = 'draining'; state.accepting = false; }
          change(); return;
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });
  await page.goto('http://127.0.0.1:1420');
  await page.evaluate(() => sessionStorage.removeItem('slice003-fixture'));
  await page.reload();
  const list = side => page.getByRole('listbox', { name: `${side} files`, exact: true });
  const path = side => page.getByRole('textbox', { name: `${side} directory path`, exact: true });
  const toggle = () => page.getByRole('button', { name: /Operations/ });
  const ready = async () => page.waitForFunction(() => [...document.querySelectorAll('[role=listbox]')].length === 2 && [...document.querySelectorAll('[role=listbox]')].every(el => el.getAttribute('aria-busy') === 'false'));
  const select = async (side, name) => list(side).locator('.file-row').filter({ has: page.locator('.filename', { hasText: name }) }).click();
  const go = async (side, value) => { await path(side).fill(value); await path(side).press('Enter'); await ready(); };
  const focused = locator => locator.evaluate(el => el === document.activeElement);
  const job = id => page.locator(`[data-operation-id="${id}"]`);
  const dialog = () => page.getByRole('dialog', { name: /^(Copy|Create directory)$/ });
  const closed = () => page.waitForFunction(() => !document.querySelector('.operation-dialog[open]'));
  await ready();
  // Reset persistence only for the first run, allowing reload below to test reattachment.
  check(await toggle().getAttribute('aria-expanded') === 'false', 'Operations starts compact and collapsed');
  await toggle().focus(); await page.keyboard.press('Enter');
  check((await page.getByRole('region', { name: 'Operations', exact: true }).textContent()).includes('Confirmed file operations appear here'), 'keyboard expansion exposes a useful empty state');
  await toggle().press('Enter');
  await go('right', '/native/right'); await select('left', 'alpha.bin'); await list('left').press('F5');
  await dialog().waitFor(); await dialog().press('Escape');
  check(await page.evaluate(() => window.ops.state.submissions) === 0, 'shortcut and cancelled confirmation never submit work');
  await list('left').press('F5'); await dialog().getByRole('button', { name: 'Copy', exact: true }).press('Enter'); await closed();
  check(await focused(list('left')), 'confirmed background admission closes the dialog and returns focus immediately');
  await toggle().click(); await job('1').waitFor();
  check((await job('1').textContent()).includes('Running') && (await job('1').textContent()).includes('/native/right'), 'running operation displays immutable intent and backend state');
  check(await job('1').getByRole('progressbar').getAttribute('value') === null, 'unknown totals use indeterminate copy progress');
  check(await job('1').getByRole('button', { name: 'Dismiss alpha.bin' }).count() === 0, 'active jobs cannot be dismissed');
  await select('left', 'zero.bin'); await list('left').focus();
  await page.evaluate(() => window.ops.advance('1', { currentItem: '/native/left/alpha', currentLabel: 'alpha.bin', bytesProcessed: 4096, totalBytes: 8192, totalFiles: 1, elapsedMs: 1000, bytesPerSecond: 4096, remainingMs: 1000 }));
  await page.waitForFunction(() => document.querySelector('[data-operation-id="1"] progress')?.value === 50);
  check(await focused(list('left')), 'realistic progress updates preserve list focus and current selection');
  check((await job('1').textContent()).includes('4 KB / 8 KB') && (await job('1').textContent()).includes('/s') && (await job('1').textContent()).includes('About 1s left'), 'known bytes, measured speed and available ETA are rendered');
  await page.waitForFunction(() => !document.querySelector('[data-operation-id="1"] .metrics')?.textContent.includes('/s'));
  check(!(await job('1').textContent()).includes('About 1s left'), 'speed and ETA expire when new transfer measurements stop');
  await go('right', '/native/elsewhere');
  check(await path('right').inputValue() === '/display/elsewhere', 'users can navigate the destination pane while a copy runs');
  await list('left').focus(); await list('left').press('F7');
  await dialog().getByRole('textbox', { name: 'Directory name' }).fill('queued-folder'); await dialog().getByRole('textbox', { name: 'Directory name' }).press('Enter'); await closed(); await job('2').waitFor();
  check((await job('2').textContent()).includes('Queued'), 'additional confirmed operations appear queued');
  await job('2').getByRole('button', { name: 'Cancel queued-folder' }).press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-operation-id="2"]')?.classList.contains('cancelled'));
  check((await job('2').textContent()).includes('Cancelled'), 'queued cancellation is visibly distinct from failure');
  check(await focused(toggle()), 'user-initiated cancellation returns focus to a persistent control before its action disappears');
  await list('left').focus(); await list('left').press('F5');
  await dialog().getByRole('button', { name: 'Copy', exact: true }).press('Enter'); await closed(); await job('3').waitFor();
  check(await page.evaluate(() => window.ops.state.jobs[0].intent.destination) === '/native/right' && await page.evaluate(() => window.ops.state.jobs[2].intent.destination) === '/native/elsewhere', 'navigation changes only new submissions, never a queued or running destination');
  await list('left').focus();
  await page.evaluate(() => window.ops.advance('1', { bytesProcessed: 8192, elapsedMs: 1200, bytesPerSecond: null, remainingMs: null }));
  await page.waitForFunction(() => document.querySelector('[data-operation-id="1"] progress')?.getAttribute('value') === null);
  check((await job('1').textContent()).includes('8 KB / 8 KB') && (await job('1').textContent()).includes('Finalizing copy…'), 'all copied bytes remain truthful while pending publication uses an indeterminate indicator');
  await page.evaluate(() => { window.ops.holdSnapshot = true; window.ops.advance('1', { bytesProcessed: 8192, elapsedMs: 1300 }); });
  await page.waitForFunction(() => typeof window.ops.releaseSnapshot === 'function');
  await page.evaluate(() => { window.ops.finish('1'); window.ops.releaseSnapshot(); });
  await page.waitForFunction(() => document.querySelector('[data-operation-id="1"]')?.classList.contains('completed'));
  check(await job('1').getByRole('progressbar').getAttribute('value') === '100', 'terminal snapshot wins when completion occurs during snapshot reconciliation');
  check(await path('right').inputValue() === '/display/elsewhere' && await focused(list('left')), 'completion neither navigates back to the captured destination nor steals focus');
  check(await list('left').locator('[aria-selected="true"] .filename').textContent() === 'zero.bin', 'completion does not restore a selection from operation submission');
  await page.evaluate(() => { window.ops.finish('3', { code: 'conflict', message: 'The destination already exists. Original bytes remain intact.', recovery: '/native/elsewhere/.qpanes-copy-retained' }); });
  await page.waitForFunction(() => document.querySelector('[data-operation-id="3"]')?.classList.contains('failed'));
  check(await job('3').getByRole('progressbar').count() === 0, 'terminal failure with indeterminate work never shows an ongoing progress indicator');
  check((await job('3').textContent()).includes('Original bytes remain intact.') && (await job('3').textContent()).includes('Staging was retained'), 'failed operation retains structured errors and recovery guidance');
  await job('3').getByRole('button', { name: 'Retry zero.bin' }).press('Enter'); await job('4').waitFor();
  check(await page.evaluate(() => window.ops.state.jobs.find(job => job.id === '4').retryOf) === '3', 'explicit retry appears as a new operation with its original reference');
  check(await focused(toggle()), 'user-initiated Retry leaves focus on a stable panel control');
  await job('3').getByRole('button', { name: 'Retry zero.bin' }).press('Enter');
  check(await page.evaluate(() => window.ops.state.jobs.length) === 4 && await page.evaluate(() => { const calls = window.ops.calls.filter(call => call.command === 'retry_operation'); return calls.length === 2 && calls[0].payload.sequence === calls[1].payload.sequence; }), 'repeated Retry actions reuse the original admission token and cannot enqueue duplicates');
  await job('4').getByRole('button', { name: 'Cancel zero.bin' }).press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-operation-id="4"]')?.classList.contains('cancelling'));
  check((await job('4').textContent()).includes('Cancelling'), 'running cancellation shows the backend Cancelling state');
  await list('left').focus(); await list('left').press('F7');
  await dialog().getByRole('textbox', { name: 'Directory name' }).fill('fresh-after-race'); await dialog().getByRole('textbox', { name: 'Directory name' }).press('Enter'); await closed(); await job('5').waitFor();
  await page.evaluate(() => { window.ops.holdListingPath = '/native/left'; });
  await page.getByRole('button', { name: 'left: refresh directory', exact: true }).click();
  await page.waitForFunction(() => typeof window.ops.releaseListing === 'function');
  await page.evaluate(() => { window.ops.finish('5'); window.ops.releaseListing(); });
  await ready();
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="left files"] .filename')].some(item => item.textContent === 'fresh-after-race'));
  check(true, 'completion during an in-flight listing triggers a second read of the current directory');
  await list('left').focus(); await list('left').press('F7');
  await dialog().getByRole('textbox', { name: 'Directory name' }).fill('fresh-after-sort'); await dialog().getByRole('textbox', { name: 'Directory name' }).press('Enter'); await closed(); await job('6').waitFor();
  await page.evaluate(() => { window.ops.holdSort = true; });
  await page.getByRole('button', { name: 'Sort left by name, ascending', exact: true }).click();
  await page.waitForFunction(() => typeof window.ops.releaseSort === 'function');
  const readsBeforeSortCompletion = await page.evaluate(() => window.ops.calls.filter(call => call.command === 'list_directory').length);
  await page.evaluate(() => { window.ops.finish('6'); window.ops.releaseSort(); });
  await ready();
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="left files"] .filename')].some(item => item.textContent === 'fresh-after-sort'));
  check(await page.evaluate(() => window.ops.calls.filter(call => call.command === 'list_directory').length) > readsBeforeSortCompletion, 'completion during pure sorting re-reads the affected directory after the sort settles');
  await toggle().focus(); await toggle().press('Enter');
  check(await toggle().getAttribute('aria-expanded') === 'false' && (await toggle().textContent()).includes('active'), 'collapsed summary retains active and queued counts');
  const beforeReload = await page.evaluate(() => window.ops.state.submissions);
  await page.reload(); await ready(); await toggle().click(); await job('4').waitFor();
  check(await page.evaluate(() => window.ops.state.submissions) === beforeReload && (await job('4').textContent()).includes('Cancelling'), 'frontend reload reattaches to current jobs without resubmitting or restarting');
  check(await page.evaluate(() => window.ops.listenerCount()) === 1, 'reattachment owns exactly one operations listener');
  await job('2').getByRole('button', { name: 'Dismiss queued-folder' }).press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-operation-id="2"]'));
  check(await focused(toggle()), 'terminal dismissal returns focus to a stable keyboard control');
  await list('left').focus(); await page.getByRole('button', { name: 'Close window', exact: true }).click();
  const shutdown = page.getByRole('dialog', { name: 'Close QPanes?' }); await shutdown.waitFor();
  check((await shutdown.textContent()).includes('cannot continue after QPanes exits'), 'close explains that process-owned jobs stop on exit');
  await shutdown.getByRole('button', { name: 'Keep working' }).press('Enter'); await shutdown.waitFor({ state: 'detached' });
  check(await focused(list('left')), 'keeping the application open restores the prior focus');
  await page.evaluate(() => window.ops.close()); await shutdown.waitFor();
  await shutdown.getByRole('button', { name: 'Cancel and close' }).press('Enter');
  await shutdown.getByRole('status').waitFor();
  check((await shutdown.textContent()).includes('stopping the current copy safely'), 'shutdown drain remains observable and permits keeping the window open');
  await page.evaluate(() => window.ops.blockShutdown()); await shutdown.getByRole('button', { name: 'Force exit' }).waitFor();
  check((await shutdown.textContent()).includes('unknown operation outcome'), 'bounded shutdown exposes explicit force-exit consequences');
  await shutdown.getByRole('button', { name: 'Keep working' }).press('Enter'); await shutdown.waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 720, height: 420 });
  await page.screenshot({ path: 'test-results/slice-003-operations-compact-mocked.png' });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), 'expanded panel preserves compact whole-window bounds');
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.screenshot({ path: 'test-results/slice-003-operations-mocked.png' });
  check(errors.length === 0, `no renderer exceptions (${errors.join(', ')})`);
  return { mode: 'MOCKED manager IPC/events with trusted Chromium input', passed: passed.length, checks: passed };
}
