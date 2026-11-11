// Regression: delayed snapshots must preserve invalidation after terminal history eviction.
// MOCKED Tauri/filesystem; trusted Chromium input. The native suite verifies real bytes.
async page => {
  const checks = [], errors = [];
  const check = (pass, name, detail) => checks.push({ pass: !!pass, name, detail });
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:1200,height:780});
  await page.addInitScript(() => {
    const callbacks = new Map(), listeners = new Map(); let callbackId = 0;
    const entry = (path, name, kind = 'file') => ({ path, name, kind, identity: `id:${path}`, size: kind === 'file' ? 8192 : null, modifiedMs: null, metadataError: null });
    const stored = sessionStorage.getItem('slice003-fixture');
    const state = stored ? JSON.parse(stored) : { revision: 0, invalidationRevision: 0, jobs: [], accepting: true, closeRequested: false, shutdownState: 'idle', shutdownAttempt: null, shutdownCount: 0, submissions: 0,
      dirs: { '/native/left': [entry('/native/left/folder', 'Folder', 'directory'), entry('/native/left/alpha', 'alpha.bin'), entry('/native/left/zero', 'zero.bin')], '/native/right': [entry('/native/right/original', 'original.txt')], '/native/elsewhere': [entry('/native/elsewhere/other', 'other.txt')] } };
    const save = () => sessionStorage.setItem('slice003-fixture', JSON.stringify(state));
    const snapshot = () => structuredClone({ revision: state.revision, invalidationRevision: state.invalidationRevision, jobs: state.jobs, accepting: state.accepting, closeRequested: state.closeRequested, shutdownState: state.shutdownState, shutdownAttempt: state.shutdownAttempt });
    const notify = () => { save(); for (const [id, item] of listeners) if (item.event === 'operations-changed') callbacks.get(item.handler)?.({ id, event: item.event, payload: state.revision }); };
    const change = () => { state.revision++; notify(); };
    const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.state);
    const make = (intent, retryOf = null) => {
      const sourceParent = intent.kind === 'create' ? intent.parent : Object.keys(state.dirs).find(path => state.dirs[path].some(item => item.path === intent.source.path));
      const job = { id: String(state.jobs.length + 1), intent: structuredClone(intent), sourceLabel: sourceParent, destinationLabel: intent.destination ?? null,
        invalidatedSubtrees: intent.source?.kind === 'directory' && ['rename','move','trash'].includes(intent.kind) ? [intent.source.path] : [],
        affectedDirectories: intent.kind === 'copy' ? [intent.destination] : intent.kind === 'move' ? [sourceParent, intent.destination] : [sourceParent],
        submittedMs: Date.now(), startedMs: null, completedMs: null, state: state.jobs.some(job => !terminal(job)) ? 'queued' : 'running',
        progress: { currentItem: null, currentLabel: null, bytesProcessed: 0, totalBytes: null, completedFiles: 0, totalFiles: null, elapsedMs: 0, bytesPerSecond: null, remainingMs: null },
        cancellable: true, cancellationRequested: false, invalidationRevision: null, result: null, error: null, retryable: false, retryOf };
      if (job.state === 'running') job.startedMs = Date.now(); state.jobs.push(job); change(); return structuredClone(job);
    };
    window.ops = {
      state, make, reads: 0, calls: [], holdSnapshot: false, unavailable: [], ancestors: {},
      notify,
      listenerCount: () => [...listeners.values()].filter(item => item.event === 'operations-changed').length,
      advance(id, patch) { const job = state.jobs.find(job => job.id === id); Object.assign(job.progress, patch); job.startedMs = Date.now() - job.progress.elapsedMs; change(); },
      finish(id, failure = null) {
        const job = state.jobs.find(job => job.id === id); job.state = failure ? 'failed' : 'completed'; job.cancellable = false; job.completedMs = Date.now(); job.invalidationRevision = ++state.invalidationRevision;
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
      close() { state.closeRequested = true; state.shutdownAttempt ??= String(++state.shutdownCount); change(); },
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
        if (command === 'classify_operation_invalidation') {
          const answer = payload.paths.map(path => payload.directories.includes(path) || payload.subtrees.some(root => (window.ops.ancestors[path] ?? []).includes(root)));
          if (window.ops.holdInvalidation || payload.paths.includes(window.ops.holdInvalidationPath)) { window.ops.holdInvalidation = false; window.ops.holdInvalidationPath = null; await new Promise(resolve => { window.ops.releaseInvalidation = () => resolve(); }); }
          return answer;
        }
        if (command === 'list_directory') {
          const request = payload.request; const path = request.target.kind === 'home' ? '/native/left' : request.target.value;
          const unavailable = window.ops.unavailable.includes(path);
          const entries = structuredClone(state.dirs[path] ?? []);
          if (window.ops.holdListingPath === path) { window.ops.holdListingPath = null; await new Promise(resolve => { window.ops.releaseListing = resolve; }); }
          if (unavailable) throw { code: 'notFound', message: 'The displayed directory no longer exists.' };
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
          if (payload.action === 'keepWorking') { state.closeRequested = false; state.shutdownState = 'idle'; state.shutdownAttempt = null; state.accepting = true; }
          else { state.shutdownState = state.jobs.every(terminal) ? 'ready' : 'draining'; state.accepting = false; }
          change(); return;
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };
  });


  await page.goto('http://127.0.0.1:1420');await page.evaluate(()=>sessionStorage.removeItem('slice003-fixture'));await page.reload();
  const list=side=>page.getByRole('listbox',{name:`${side} files`,exact:true});
  const path=side=>page.getByRole('textbox',{name:`${side} directory path`,exact:true});
  const ready=()=>page.waitForFunction(()=>[...document.querySelectorAll('[role=listbox]')].length===2&&[...document.querySelectorAll('[role=listbox]')].every(el=>el.getAttribute('aria-busy')==='false'));
  await ready();await path('right').fill('/native/right');await path('right').press('Enter');await ready();await page.locator('.operations-toggle').click();
  await list('left').locator('.file-row').filter({has:page.locator('.filename',{hasText:'alpha.bin'})}).click();await list('left').press('F5');await page.locator('.operation-dialog').getByRole('button',{name:'Copy',exact:true}).press('Enter');await page.locator('.operation-dialog').waitFor({state:'detached'});await page.locator('[data-operation-id="1"].running').waitFor();
  const before=await page.evaluate(()=>window.ops.calls.filter(call=>call.command==='list_directory'&&call.payload.request.target.value==='/native/right').length);
  await page.evaluate(()=>{window.ops.holdSnapshot=true;window.ops.advance('1',{elapsedMs:1000})});await page.waitForFunction(()=>typeof window.ops.releaseSnapshot==='function');
  const backend=await page.evaluate(()=>{
    window.ops.finish('1');
    const source=structuredClone(window.ops.state.jobs[0]);
    for(let n=2;n<=66;n++){
      const intent={kind:'create',parent:'/native/left',name:`unrelated-${n}`};
      const job={...structuredClone(source),id:String(n),intent,sourceLabel:'/native/left',destinationLabel:null,affectedDirectories:['/native/left'],invalidatedSubtrees:[],state:'completed',invalidationRevision:++window.ops.state.invalidationRevision,result:{path:`/native/left/generated-${n}`,warnings:[]}};
      window.ops.state.jobs.push(job);
      while(window.ops.state.jobs.filter(job=>['completed','failed','cancelled'].includes(job.state)).length>64){const index=window.ops.state.jobs.findIndex(job=>['completed','failed','cancelled'].includes(job.state));window.ops.state.jobs.splice(index,1)}
      window.ops.state.revision++;window.ops.notify();
    }
    const result={jobs:window.ops.state.jobs.length,copyRetained:window.ops.state.jobs.some(job=>job.id==='1'),destinationNames:window.ops.state.dirs['/native/right'].map(entry=>entry.name),revision:window.ops.state.revision};
    window.ops.releaseSnapshot();return result;
  });
  await page.locator('[data-operation-id="66"].completed').waitFor();await page.locator('[data-operation-id="1"]').waitFor({state:'detached'});await ready();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const ui={names:await list('right').locator('.filename').allTextContents(),path:await path('right').inputValue(),reads:await page.evaluate(()=>window.ops.calls.filter(call=>call.command==='list_directory'&&call.payload.request.target.value==='/native/right').length)};
  await page.screenshot({path:'test-results/slice-003-rereview-history.png'});
  await page.getByRole('button',{name:'right: refresh directory',exact:true}).press('Enter');await ready();
  const refreshed=await list('right').locator('.filename').allTextContents();
  const report={mode:'MOCKED authoritative bounded history, trusted Chromium copy confirmation; backend eviction validity subject to core corroboration',before,backend,ui,refreshed,stale:!ui.names.includes('alpha.bin')&&refreshed.includes('alpha.bin'),errors};

  const results=[];
  const verify=(pass,name,detail)=>results.push({pass:!!pass,name,detail});
  verify(ui.names.includes('alpha.bin'),'evicted completion refreshes the displayed destination automatically',report);
  verify(ui.path==='/display/right','history-gap reconciliation preserves the current location');
  // With an intact completion interval, an unrelated job must still use exact
  // invalidations instead of needlessly re-reading either displayed directory.
  const readsBefore=await page.evaluate(()=>window.ops.calls.filter(call=>call.command==='list_directory').length);
  await page.evaluate(()=>{
    const template=structuredClone(window.ops.state.jobs.at(-1));
    const job={...template,id:'known-next',intent:{kind:'create',parent:'/native/elsewhere',name:'known-next'},sourceLabel:'/native/elsewhere',affectedDirectories:['/native/elsewhere'],invalidatedSubtrees:[],invalidationRevision:++window.ops.state.invalidationRevision};
    window.ops.state.jobs.push(job);window.ops.state.revision++;window.ops.notify();
  });
  await page.locator('[data-operation-id="known-next"]').waitFor();
  verify(await page.evaluate(()=>window.ops.calls.filter(call=>call.command==='list_directory').length)===readsBefore,'fully observed unrelated completion preserves unaffected pane listings');

  const holdRead=async()=>{
    await page.evaluate(()=>{window.ops.holdSnapshot=true;const old=window.ops.state.jobs.shift();window.ops.state.revision++;window.ops.notify();});
    await page.waitForFunction(()=>typeof window.ops.releaseSnapshot==='function');
  };
  const unseenChange=async(name)=>page.evaluate(name=>{
    // A genuine completion occurred but its terminal row was dismissed before
    // this reader saw it. Its global completion sequence must still survive.
    window.ops.state.dirs['/native/right'].push({path:'/native/right/'+name,name,kind:'file',identity:'id:'+name,size:3,modifiedMs:null,metadataError:null});
    window.ops.state.invalidationRevision++;window.ops.state.revision++;window.ops.notify();
  },name);
  const releaseRead=async()=>{await page.evaluate(()=>{const release=window.ops.releaseSnapshot;delete window.ops.releaseSnapshot;release();});};
  await list('right').focus();
  const selection=await list('right').locator('[aria-selected="true"] .filename').textContent();
  await holdRead();await unseenChange('never-observed.txt');await releaseRead();
  await list('right').locator('.filename').filter({hasText:'never-observed.txt'}).waitFor();await ready();
  verify(await list('right').locator('[aria-selected="true"] .filename').textContent()===selection,'entirely missed completion preserves native selection');
  verify(await list('right').evaluate(el=>el===document.activeElement),'gap-triggered refresh never steals pane focus');

  await holdRead();await unseenChange('draft-update.txt');
  const beforeDraftReads=await page.evaluate(()=>window.ops.calls.filter(call=>call.command==='list_directory'&&call.payload.request.target.value==='/native/right').length);
  await path('right').fill('/native/elsewhere');await releaseRead();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  verify(await path('right').inputValue()==='/native/elsewhere','history-gap refresh preserves an unsubmitted path draft');
  verify(await page.evaluate(()=>window.ops.calls.filter(call=>call.command==='list_directory'&&call.payload.request.target.value==='/native/right').length)===beforeDraftReads,'history-gap refresh waits while the user edits a path');
  await path('right').press('Escape');await list('right').locator('.filename').filter({hasText:'draft-update.txt'}).waitFor();await ready();
  verify(await path('right').inputValue()==='/display/right','leaving path editing drains the pending refresh in place');

  await holdRead();await unseenChange('old-location-change.txt');
  await path('right').fill('/native/elsewhere');await path('right').press('Enter');await ready();
  await releaseRead();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await ready();
  verify(await path('right').inputValue()==='/display/elsewhere','late gap reconciliation does not restore an obsolete navigation');
  verify((await list('right').locator('.filename').allTextContents()).includes('other.txt'),'the newest destination remains visible after reconciliation');
  verify(errors.length===0,'no renderer exceptions',errors);
  const failures=results.filter(result=>!result.pass);
  if(failures.length)throw new Error(JSON.stringify({results,failures}));
  return {mode:'mocked authoritative snapshots/history; trusted Chromium input',passed:results.length,results};
}
