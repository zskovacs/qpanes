// Slice 003 R003-02/03 regressions. Mocked IPC; Chromium delivers trusted keys.
// Run with Playwright CLI against `pnpm dev` on port 1420.
async page => {
  const checks = [], errors = [];
  const check = (pass, name, detail) => checks.push({ pass: !!pass, name, detail });
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 780 });
  await page.addInitScript(() => {
    const callbacks = new Map(), listeners = new Map();
    let nextId = 0;
    const entry = (path, name) => ({ path, name, kind: 'file', identity: `id:${path}`, size: 1, modifiedMs: null, metadataError: null });
    const state = { revision: 0, invalidationRevision: 0, jobs: [], accepting: true, closeRequested: false, shutdownState: 'idle', shutdownAttempt: null };
    const snapshot = () => structuredClone(state);
    const notify = () => { for (const [id, listener] of listeners) if (listener.event === 'operations-changed') callbacks.get(listener.handler)?.({ id, event: listener.event, payload: state.revision }); };
    const change = () => { state.revision++; notify(); };
    const make = intent => {
      const job = { id: String(state.jobs.length + 1), intent: structuredClone(intent), state: 'running', sourceLabel: intent.parent ?? null, destinationLabel: intent.destination ?? null,
        affectedDirectories: [intent.parent ?? intent.destination], invalidatedSubtrees: [], invalidationRevision: null, submittedMs: Date.now(), startedMs: Date.now(), completedMs: null,
        progress: { currentItem: null, currentLabel: null, bytesProcessed: 0, totalBytes: null, completedFiles: 0, totalFiles: null, elapsedMs: 0, bytesPerSecond: null, remainingMs: null },
        cancellable: true, cancellationRequested: false, result: null, error: null, retryable: false, retryOf: null };
      state.jobs.push(job); change(); return structuredClone(job);
    };
    window.focusFixture = { state, change, make, failSnapshots: 0, failActions: false, holdSnapshot: false, holdAdmission: false, keys: [] };
    window.addEventListener('keydown', event => window.focusFixture.keys.push({ key: event.key, trusted: event.isTrusted }), true);
    window.focusFixture.close = () => { state.closeRequested = true; state.shutdownAttempt = String(++nextId); change(); };
    window.isTauri = true;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_, id) => listeners.delete(id) };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      transformCallback(callback) { callbacks.set(++nextId, callback); return nextId; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, payload = {}) {
        const fixture = window.focusFixture;
        if (command === 'plugin:event|listen') { listeners.set(++nextId, payload); return nextId; }
        if (command === 'plugin:event|unlisten') { listeners.delete(payload.eventId); return; }
        if (command.startsWith('plugin:window|')) return command.endsWith('|scale_factor') ? 1 : false;
        if (command === 'list_operations') {
          if (fixture.failSnapshots > 0) { fixture.failSnapshots--; throw { code: 'io', message: 'Focus test snapshot outage' }; }
          const captured = snapshot();
          if (fixture.holdSnapshot) { fixture.holdSnapshot = false; await new Promise(resolve => { fixture.releaseSnapshot = resolve; }); }
          return captured;
        }
        if (command === 'list_directory') {
          const request = payload.request;
          const path = request.target.kind === 'home' ? '/native/left' : request.target.value;
          return { path, label: path, parent: '/', entries: [entry(`${path}/file`, 'file.txt')], warnings: [], sort: request.sort, direction: request.direction };
        }
        if (command === 'sort_directory_entries') return payload.entries;
        if (command === 'classify_operation_invalidation') return payload.paths.map(path => payload.directories.includes(path));
        if (command === 'submit_operation') {
          if (fixture.holdAdmission) { fixture.holdAdmission = false; await new Promise(resolve => { fixture.releaseAdmission = resolve; }); }
          return make(payload.request.intent);
        }
        if (command === 'cancel_operation' && fixture.failActions) throw { code: 'invalidOperation', message: 'Focus test action failure' };
        if (command === 'shutdown_operations' && payload.action === 'keepWorking') {
          state.closeRequested = false; state.shutdownAttempt = null; state.shutdownState = 'idle'; state.accepting = true; change(); return;
        }
        if (command === 'shutdown_operations' && payload.action === 'cancelAndClose') { state.shutdownState = 'draining'; state.accepting = false; change(); return; }
        throw new Error(`Unexpected focus-fixture command ${command}`);
      },
    };
  });
  await page.goto('http://127.0.0.1:1420');
  const list = side => page.getByRole('listbox', { name: `${side} files`, exact: true });
  const path = side => page.getByRole('textbox', { name: `${side} directory path`, exact: true });
  const toggle = page.locator('.operations-toggle');
  const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true });
  const dismissError = page.getByRole('button', { name: 'Dismiss operation action error', exact: true });
  const shutdown = page.locator('.shutdown-dialog');
  const ready = () => page.waitForFunction(() => [...document.querySelectorAll('[role=listbox]')].length === 2 && [...document.querySelectorAll('[role=listbox]')].every(el => el.getAttribute('aria-busy') === 'false'));
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const focused = locator => locator.evaluate(el => el === document.activeElement);
  const focusDetail = () => page.evaluate(() => ({ tag: document.activeElement.tagName, label: document.activeElement.getAttribute('aria-label'), text: document.activeElement.textContent?.slice(0, 80) }));
  const outage = async () => { await page.evaluate(() => { window.focusFixture.failSnapshots++; window.focusFixture.change(); }); await reconnect.waitFor(); };
  const actionFailure = async () => {
    await page.evaluate(() => { window.focusFixture.failActions = true; window.focusFixture.make({ kind: 'create', parent: '/native/left', name: 'focus-error' }); });
    await page.getByRole('button', { name: 'Cancel focus-error', exact: true }).last().press('Enter');
    await dismissError.waitFor();
  };
  await ready();
  await path('right').fill('/native/right'); await path('right').press('Enter'); await ready();
  await toggle.press('Enter');

  await outage(); await reconnect.press('Enter'); await reconnect.waitFor({ state: 'detached' }); await frame();
  check(await focused(toggle), 'keyboard Reconnect returns focus to the persistent Operations toggle', await focusDetail());

  await outage(); await list('right').focus();
  await page.evaluate(() => window.focusFixture.change()); await reconnect.waitFor({ state: 'detached' }); await frame();
  check(await focused(list('right')), 'background connection recovery preserves another pane focus', await focusDetail());

  await outage(); await page.evaluate(() => { window.focusFixture.holdSnapshot = true; });
  await reconnect.press('Enter'); await page.waitForFunction(() => typeof window.focusFixture.releaseSnapshot === 'function');
  await page.keyboard.press('Control+l'); await page.keyboard.press('Escape');
  check(await focused(list('right')), 'trusted shortcut moves focus to the pane while Reconnect is pending');
  await page.evaluate(() => window.focusFixture.releaseSnapshot()); await reconnect.waitFor({ state: 'detached' }); await frame();
  check(await focused(list('right')), 'late Reconnect success does not steal intentional pane focus', await focusDetail());

  await actionFailure(); await dismissError.press('Enter'); await dismissError.waitFor({ state: 'detached' }); await frame();
  check(await focused(toggle), 'keyboard action-error Dismiss returns focus to the persistent Operations toggle', await focusDetail());
  await actionFailure(); await list('right').focus();
  // A non-focusing activation models a parent clearing its error while the pane owns focus.
  await dismissError.evaluate(button => button.click()); await dismissError.waitFor({ state: 'detached' }); await frame();
  check(await focused(list('right')), 'clearing an error outside its focus ownership preserves pane focus', await focusDetail());

  await toggle.focus(); await page.evaluate(() => window.focusFixture.close()); await shutdown.waitFor({ state: 'visible' });
  await shutdown.getByRole('button', { name: 'Keep working', exact: true }).press('Enter'); await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await focused(toggle), 'Keep working preserves a connected saved return target', await focusDetail());

  await page.evaluate(() => window.focusFixture.close()); await shutdown.waitFor({ state: 'visible' });
  await page.evaluate(() => {
    document.querySelector('.shutdown-dialog').close();
    document.querySelector('[role=listbox][aria-label="right files"]').focus();
    const fixture = window.focusFixture;
    fixture.state.closeRequested = false; fixture.state.shutdownAttempt = null; fixture.change();
  });
  await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await focused(list('right')), 'shutdown teardown preserves an existing external focus target', await focusDetail());

  await list('right').press('F7');
  const pendingDialog = page.locator('.operation-dialog');
  const pendingName = pendingDialog.getByRole('textbox', { name: 'Directory name', exact: true });
  await pendingName.fill('still-editing');
  await page.evaluate(() => window.focusFixture.close()); await shutdown.waitFor({ state: 'visible' });
  await shutdown.press('Escape'); await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await focused(pendingName), 'Escape restores a still-connected underlying operation dialog control', await focusDetail());
  await pendingName.press('Escape'); await pendingDialog.waitFor({ state: 'detached' });

  await list('right').focus();
  await page.evaluate(() => { document.activeElement.blur(); window.focusFixture.close(); });
  await shutdown.waitFor({ state: 'visible' });
  await shutdown.getByRole('button', { name: 'Keep working', exact: true }).press('Enter'); await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await focused(list('right')), 'a saved BODY target falls back to the active pane', await focusDetail());

  await page.evaluate(() => { document.documentElement.tabIndex = -1; document.documentElement.focus(); window.focusFixture.close(); });
  await shutdown.waitFor({ state: 'visible' });
  await shutdown.getByRole('button', { name: 'Keep working', exact: true }).press('Enter'); await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await focused(list('right')), 'a saved document root falls back to the active pane', await focusDetail());
  await page.evaluate(() => document.documentElement.removeAttribute('tabindex'));

  // Admission is still pending when shutdown closes, so the underlying modal survives.
  await list('right').focus(); await list('right').press('F7');
  const submittingDialog = page.locator('.operation-dialog');
  const submittingName = submittingDialog.getByRole('textbox', { name: 'Directory name', exact: true });
  await submittingName.fill('pending-return-focus');
  await page.evaluate(() => { window.focusFixture.holdAdmission = true; });
  await submittingDialog.getByRole('button', { name: 'Create directory', exact: true }).press('Enter');
  await page.waitForFunction(() => typeof window.focusFixture.releaseAdmission === 'function');
  const pendingTarget = await page.evaluate(() => ({ tag: document.activeElement.tagName, disabled: document.activeElement.matches(':disabled'), inside: !!document.activeElement.closest('.operation-dialog'), submitConnected: document.querySelector('.operation-dialog .confirm').isConnected, submitDisabled: document.querySelector('.operation-dialog .confirm').disabled }));
  check(pendingTarget.submitConnected && pendingTarget.submitDisabled, 'pending admission retains its connected disabled submit control', pendingTarget);
  await page.evaluate(() => window.focusFixture.close()); await shutdown.waitFor({ state: 'visible' });
  await shutdown.getByRole('button', { name: 'Keep working', exact: true }).press('Enter'); await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await focused(submittingName), 'Keep working during pending admission restores a usable underlying dialog control', await focusDetail());
  await page.evaluate(() => { window.focusFixture.releaseAdmission(); delete window.focusFixture.releaseAdmission; });
  await submittingDialog.waitFor({ state: 'detached' }); await frame();


  // With no name input, every Copy control can be disabled while admission is
  // pending. Trusted Tab may leave BODY, but the underlying modal still owns UI.
  await list('right').focus(); await list('right').press('F5');
  const busyCopy = page.locator('.operation-dialog');
  await page.evaluate(() => { window.focusFixture.holdAdmission = true; delete window.focusFixture.releaseAdmission; });
  await busyCopy.getByRole('button', { name: 'Copy', exact: true }).press('Enter');
  await page.waitForFunction(() => typeof window.focusFixture.releaseAdmission === 'function');
  await page.keyboard.press('Tab'); await frame();
  check(await page.evaluate(() => document.activeElement === document.body), 'busy nameless dialog reproduces loss of a concrete focus owner with trusted Tab');
  await page.evaluate(() => window.focusFixture.close()); await shutdown.waitFor({ state: 'visible' });
  await shutdown.getByRole('button', { name: 'Keep working', exact: true }).press('Enter'); await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await busyCopy.evaluate(el => el.contains(document.activeElement)), 'shutdown restores the surviving modal when its previous focus owner was BODY', await focusDetail());
  await page.evaluate(() => { window.focusFixture.releaseAdmission(); delete window.focusFixture.releaseAdmission; });
  await busyCopy.waitFor({ state: 'detached' }); await frame();

  // Reproduce the original overlap: the saved Submitting button disappears behind a modal.
  await list('right').focus(); await list('right').press('F7');
  const operation = page.locator('.operation-dialog');
  await operation.getByRole('textbox', { name: 'Directory name', exact: true }).fill('overlap-focus');
  await page.evaluate(() => { window.focusFixture.holdAdmission = true; });
  await operation.getByRole('button', { name: 'Create directory', exact: true }).press('Enter');
  await page.waitForFunction(() => typeof window.focusFixture.releaseAdmission === 'function');
  await page.evaluate(() => window.focusFixture.close()); await shutdown.waitFor({ state: 'visible' });
  await page.evaluate(() => window.focusFixture.releaseAdmission()); await operation.waitFor({ state: 'detached' }); await frame();
  check(await shutdown.evaluate(el => el.contains(document.activeElement)), 'shutdown retains modal focus when underlying admission completes', await focusDetail());
  await shutdown.getByRole('button', { name: 'Keep working', exact: true }).press('Enter'); await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await focused(list('right')), 'Keep working after completed admission falls back to the active pane', await focusDetail());
  await page.keyboard.press('Control+l'); await page.keyboard.press('Escape');
  check(await focused(list('right')), 'pane keyboard flow remains usable after overlapping dialogs');
  await list('left').focus(); await frame();
  check(await focused(list('left')), 'shutdown focus restoration has no delayed steal after an intentional move');

  await list('right').focus(); await page.evaluate(() => window.focusFixture.close()); await shutdown.waitFor({ state: 'visible' });
  await shutdown.getByRole('button', { name: 'Cancel and close', exact: true }).press('Enter');
  await page.waitForFunction(() => window.focusFixture.state.shutdownState === 'draining'); await frame();
  check(await shutdown.evaluate(el => el.contains(document.activeElement) && !document.activeElement.matches(':disabled')), 'shutdown retains usable modal focus while cancellation drains', await focusDetail());
  await page.evaluate(() => { window.focusFixture.state.shutdownState = 'blocked'; window.focusFixture.change(); });
  await shutdown.getByRole('button', { name: 'Force exit', exact: true }).waitFor(); await frame();
  check(await shutdown.evaluate(el => el.contains(document.activeElement) && !document.activeElement.matches(':disabled')), 'blocked shutdown retains focus when its initiating control is replaced', await focusDetail());
  await page.keyboard.press('Escape'); await shutdown.waitFor({ state: 'detached' }); await frame();
  check(await focused(list('right')), 'Escape restores active-pane focus after draining and blocked shutdown');

  const keys = await page.evaluate(() => window.focusFixture.keys);
  check(keys.length > 0 && keys.every(event => event.trusted), 'all regression keyboard events were trusted Chromium input', keys.length);
  check(errors.length === 0, 'no browser runtime errors', errors);
  await page.screenshot({ path: 'test-results/slice-003-rereview-focus.png' });
  const failures = checks.filter(check => !check.pass);
  if (failures.length) throw new Error(JSON.stringify({ checks, failures, errors }));
  return { passed: checks.length, mode: 'mocked Rust/Tauri IPC with trusted Chromium keyboard input; not native desktop E2E', checks, errors };
}
