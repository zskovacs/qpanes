// Slice 003 hardening regressions. MOCKED Rust/Tauri IPC with trusted Chromium input.
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
    const notify = () => { for (const job of state.jobs) if (['completed','failed','cancelled'].includes(job.state) && job.invalidationRevision == null) job.invalidationRevision = ++state.invalidationRevision; save(); for (const [id, item] of listeners) if (item.event === 'operations-changed') callbacks.get(item.handler)?.({ id, event: item.event, payload: state.revision }); };
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

  await page.goto('http://127.0.0.1:1420');
  await page.evaluate(() => sessionStorage.removeItem('slice003-fixture')); await page.reload();
  const list = side => page.getByRole('listbox',{name:`${side} files`,exact:true});
  const path = side => page.getByRole('textbox',{name:`${side} directory path`,exact:true});
  const toggle = () => page.locator('.operations-toggle');
  const dialog = () => page.locator('.operation-dialog');
  const ready = () => page.waitForFunction(() => [...document.querySelectorAll('[role=listbox]')].length === 2 && [...document.querySelectorAll('[role=listbox]')].every(el => el.getAttribute('aria-busy')==='false'));
  const go = async(side,value) => { await path(side).fill(value); await path(side).press('Enter'); await ready(); };
  const closed = () => page.waitForFunction(() => !document.querySelector('.operation-dialog[open]'));
  const focus = locator => locator.evaluate(el => el === document.activeElement);
  const create = async(name) => { await list('left').focus(); await list('left').press('F7'); const input=dialog().getByRole('textbox',{name:'Directory name'});await input.fill(name);await input.press('Enter');await closed();return page.evaluate(() => window.ops.state.jobs.at(-1).id); };
  const settle = async(id,state) => page.waitForFunction(({id,state}) => document.querySelector(`[data-operation-id="${id}"]`)?.classList.contains(state),{id,state});
  await ready(); await go('right','/native/right'); await toggle().click();
  for (const terminal of ['completed','cancelled','failed']) {
    const id=await create(`focus-${terminal}`);const cancel=page.getByRole('button',{name:`Cancel focus-${terminal}`,exact:true});await cancel.focus();
    // Tab is trusted browser input; move out and back before external completion.
    await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
    check(await focus(cancel),`trusted keyboard focuses Cancel before ${terminal}`);
    await page.evaluate(({id,terminal}) => { const job=window.ops.state.jobs.find(job=>job.id===id);job.state=terminal;job.cancellable=false;job.completedMs=Date.now();window.ops.state.revision++;window.ops.notify(); },{id,terminal});
    await settle(id,terminal);
    check(await focus(toggle()),`${terminal} removal of focused Cancel recovers to the panel toggle`,await page.evaluate(() => document.activeElement.tagName));
  }
  const progressId=await create('progress-focus');
  const progressCancel=page.getByRole('button',{name:'Cancel progress-focus',exact:true});await progressCancel.focus();
  await page.evaluate(id => window.ops.advance(id,{elapsedMs:1000}),progressId);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  check(await focus(progressCancel),'ordinary progress preserves focused Cancel');
  await list('right').focus();
  await page.evaluate(id => {const job=window.ops.state.jobs.find(job=>job.id===id);job.state='completed';job.cancellable=false;window.ops.state.revision++;window.ops.notify();},progressId);
  await settle(progressId,'completed');
  check(await focus(list('right')),'external completion never steals another pane focus');
  const actionId=await create('action-error');
  await page.evaluate(() => {const original=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=async(command,payload)=>{if(command==='cancel_operation')throw{code:'invalidOperation',message:'Cancellation is no longer available.'};return original(command,payload);};});
  await page.getByRole('button',{name:'Cancel action-error',exact:true}).press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('[role=alert]')].some(el=>el.textContent.includes('Cancellation is no longer available.')));
  check(!(await toggle().textContent()).includes('Updates unavailable'),'action failure does not claim connection loss');
  const alertBefore=await page.locator('.operations-panel [role=alert]').allTextContents();
  await page.evaluate(() => {const original=window.__TAURI_INTERNALS__.invoke;let fail=true;window.__TAURI_INTERNALS__.invoke=async(command,payload)=>{if(command==='list_operations'&&fail){fail=false;throw new Error('Temporary snapshot outage');}return original(command,payload);};window.ops.state.revision++;window.ops.notify();});
  await page.getByRole('button',{name:'Reconnect',exact:true}).waitFor();
  await page.getByRole('button',{name:'Reconnect',exact:true}).press('Enter');
  await page.waitForFunction(() => window.ops.reads >= 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check(!(await toggle().textContent()).includes('Updates unavailable'),'successful reconnect clears false health warning');
  check((await page.locator('.operations-panel [role=alert]').allTextContents()).some(text=>text.includes('Cancellation is no longer available.')),'healthy reconnect retains meaningful action error',alertBefore);
  // Prepare an actual source directory and two canonical descendants in the mock backend.
  await page.evaluate(() => {
    window.ops.state.dirs['/native/left/folder']=[{path:'/native/left/folder/nested',name:'Nested',kind:'directory',identity:'nested',size:null,modifiedMs:null,metadataError:null}];
    window.ops.state.dirs['/native/left/folder/nested']=[{path:'/native/left/folder/nested/inside',name:'inside.txt',kind:'file',identity:'inside',size:1,modifiedMs:null,metadataError:null}];
    window.ops.ancestors['/native/left/folder']=['/native/left/folder'];window.ops.ancestors['/native/left/folder/nested']=['/native/left/folder','/native/left/folder/nested'];
  });
  await go('right','/native/left/folder/nested');
  await list('left').locator('.file-row').filter({has:page.locator('.filename',{hasText:'Folder'})}).first().click();
  await list('left').press('F2');const renamed=dialog().getByRole('textbox',{name:'New name'});await renamed.fill('Renamed');await renamed.press('Enter');await closed();
  const renameId=await page.evaluate(() => window.ops.state.jobs.at(-1).id);
  await page.evaluate(id => {
    const job=window.ops.state.jobs.find(job=>job.id===id);job.state='completed';job.cancellable=false;
    window.ops.unavailable.push('/native/left/folder','/native/left/folder/nested');
    window.ops.state.dirs['/native/left'].find(entry=>entry.name==='Folder').name='Renamed';
    window.ops.state.revision++;window.ops.notify();
  },renameId);
  await settle(renameId,'completed');
  let unavailable=false;try {await page.getByRole('region',{name:'right panel',exact:true}).getByRole('alert').waitFor({timeout:1500});unavailable=true;}catch{}
  check(unavailable,'renamed ancestor invalidates its open descendant and shows unavailable state');
  check(await path('right').inputValue()==='/display/left/folder/nested','invalidation does not silently navigate to a new path');
  // Build fixture-native ancestry explicitly. Production code never parses IDs.
  await page.evaluate(() => {
    const entry=(path,name,kind='file')=>({path,name,kind,identity:`id:${path}`,size:kind==='file'?1:null,modifiedMs:null,metadataError:null});
    window.ops.prepareTree=(parent,name)=>{
      const root=`${parent}/${name}`;const nested=`${root}/nested`;
      window.ops.state.dirs[parent]??=[];window.ops.state.dirs[parent].push(entry(root,name,'directory'));
      window.ops.state.dirs[root]=[entry(nested,'Nested','directory')];window.ops.state.dirs[nested]=[entry(`${nested}/inside`,'inside.txt')];
      window.ops.ancestors[root]=[root];window.ops.ancestors[nested]=[root,nested];
      return {root,nested};
    };
    window.ops.completeMutation=(id)=>{
      const job=window.ops.state.jobs.find(job=>job.id===id);job.state='completed';job.cancellable=false;job.completedMs=Date.now();
      for(const root of job.invalidatedSubtrees){for(const [path,ancestors] of Object.entries(window.ops.ancestors)){if(ancestors.includes(root))window.ops.unavailable.push(path);}}
      window.ops.state.revision++;window.ops.notify();
    };
  });
  const select=async(side,name)=>list(side).locator('.file-row').filter({has:page.locator('.filename',{hasText:name})}).first().click();
  const rename=async(name)=>{await go('left','/native/left');await select('left',name);await list('left').press('F2');const input=dialog().getByRole('textbox',{name:'New name'});await input.fill(`${name}-renamed`);await input.press('Enter');await closed();return page.evaluate(()=>window.ops.state.jobs.at(-1).id);};
  const noError=side=>page.getByRole('region',{name:`${side} panel`,exact:true}).getByRole('alert').count().then(count=>count===0);
  const reads=sidePath=>page.evaluate(value=>window.ops.calls.filter(call=>call.command==='list_directory'&&call.payload.request.target.value===value).length,sidePath);
  await go('left','/native/left');
  const exact=await page.evaluate(()=>window.ops.prepareTree('/native/left','exact-source'));
  await go('right',exact.root);const exactId=await rename('exact-source');await page.evaluate(id=>window.ops.completeMutation(id),exactId);
  await page.getByRole('region',{name:'right panel',exact:true}).getByRole('alert').waitFor();
  check(await path('right').inputValue()===exact.root.replace('/native','/display'),'renamed directory open in opposite pane reports unavailable without navigation');

  const sibling=await page.evaluate(()=>{
    const tree=window.ops.prepareTree('/native/left','similar');
    window.ops.state.dirs['/native/left/similar-extra']=[{path:'sibling-id',name:'unaffected.txt',kind:'file',identity:'sibling',size:1,modifiedMs:null,metadataError:null}];
    window.ops.ancestors['/native/left/similar-extra']=['/native/left/similar-extra'];return tree;
  });
  await go('right','/native/left/similar-extra');const beforeSibling=await reads('/native/left/similar-extra');const siblingId=await rename('similar');
  await page.evaluate(id=>window.ops.completeMutation(id),siblingId);await settle(siblingId,'completed');await ready();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check(await reads('/native/left/similar-extra')===beforeSibling&&await noError('right'),'unaffected similarly prefixed sibling is neither refreshed nor invalidated');

  const delayed=await page.evaluate(()=>window.ops.prepareTree('/native/left','delayed-source'));
  await go('right',delayed.nested);const delayedId=await rename('delayed-source');
  await page.evaluate(({id,path})=>{window.ops.releaseInvalidation=null;window.ops.holdInvalidationPath=path;window.ops.completeMutation(id);},{id:delayedId,path:delayed.nested});
  await page.waitForFunction(()=>typeof window.ops.releaseInvalidation==='function');
  await go('right','/native/elsewhere');const oldReads=await reads(delayed.nested);await page.evaluate(()=>window.ops.releaseInvalidation());
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check(await path('right').inputValue()==='/display/elsewhere'&&await noError('right')&&await reads(delayed.nested)===oldReads,'delayed ancestry reply cannot refresh or restore a superseded directory');

  const delayedRead=await page.evaluate(()=>window.ops.prepareTree('/native/left','delayed-read-source'));
  await go('right',delayedRead.nested);const delayedReadId=await rename('delayed-read-source');
  await page.evaluate(({id,path})=>{window.ops.releaseListing=null;window.ops.holdListingPath=path;window.ops.completeMutation(id);},{id:delayedReadId,path:delayedRead.nested});
  await page.waitForFunction(()=>typeof window.ops.releaseListing==='function');await go('right','/native/elsewhere');await page.evaluate(()=>window.ops.releaseListing());
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check(await path('right').inputValue()==='/display/elsewhere'&&await noError('right'),'delayed unavailable response cannot replace a newer valid navigation');

  const moving=await page.evaluate(()=>window.ops.prepareTree('/native/right','move-source'));
  await go('left','/native/elsewhere');await go('right','/native/right');await select('right','move-source');await list('right').press('F6');
  await dialog().getByRole('button',{name:'Move',exact:true}).press('Enter');await closed();const moveId=await page.evaluate(()=>window.ops.state.jobs.at(-1).id);
  await go('left',moving.nested);await page.evaluate(id=>window.ops.completeMutation(id),moveId);
  await page.getByRole('region',{name:'left panel',exact:true}).getByRole('alert').waitFor();
  check(await path('left').inputValue()===moving.nested.replace('/native','/display'),'right-to-left directory move invalidates the old source descendants open after submission');
  check(await page.evaluate(id=>window.ops.state.jobs.find(job=>job.id===id).intent.destination,moveId)==='/native/elsewhere','navigation into a queued source never changes the confirmed destination');
  const editing=await page.evaluate(()=>window.ops.prepareTree('/native/left','editing-source'));
  await go('right',editing.nested);const editingId=await rename('editing-source');
  const editingReads=await reads(editing.nested);await path('right').fill('/draft/keep');
  await page.evaluate(id=>window.ops.completeMutation(id),editingId);await settle(editingId,'completed');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  check(await path('right').inputValue()==='/draft/keep'&&await reads(editing.nested)===editingReads,'subtree invalidation defers refresh while a new path draft is being edited');
  await path('right').press('Escape');await page.getByRole('region',{name:'right panel',exact:true}).getByRole('alert').waitFor();
  check(await path('right').inputValue()===editing.nested.replace('/native','/display'),'leaving path editing drains subtree invalidation without changing the location');

  const loading=await page.evaluate(()=>window.ops.prepareTree('/native/left','loading-source'));
  await go('right',loading.root);const loadingId=await rename('loading-source');const loadingReads=await reads(loading.nested);
  await page.evaluate(path=>{window.ops.releaseListing=null;window.ops.holdListingPath=path;},loading.nested);
  await select('right','Nested');await list('right').press('Enter');await page.waitForFunction(()=>typeof window.ops.releaseListing==='function');
  await page.evaluate(id=>window.ops.completeMutation(id),loadingId);await settle(loadingId,'completed');
  await page.waitForFunction(path=>window.ops.calls.some(call=>call.command==='classify_operation_invalidation'&&call.payload.paths.includes(path)),loading.nested);
  await page.evaluate(()=>window.ops.releaseListing());await page.getByRole('region',{name:'right panel',exact:true}).getByRole('alert').waitFor();
  check(await reads(loading.nested)===loadingReads+2&&await path('right').inputValue()===loading.nested.replace('/native','/display'),'subtree completion during a blocked old listing re-reads its arriving native directory');

  const sorting=await page.evaluate(()=>window.ops.prepareTree('/native/left','sorting-source'));
  await go('right',sorting.nested);const sortingId=await rename('sorting-source');const sortingReads=await reads(sorting.nested);
  await page.evaluate(()=>{window.ops.releaseSort=null;window.ops.holdSort=true;});
  await page.getByRole('button',{name:'Sort right by size, unsorted',exact:true}).press('Enter');await page.waitForFunction(()=>typeof window.ops.releaseSort==='function');
  await page.evaluate(id=>window.ops.completeMutation(id),sortingId);await settle(sortingId,'completed');
  await page.evaluate(()=>window.ops.releaseSort());await page.getByRole('region',{name:'right panel',exact:true}).getByRole('alert').waitFor();
  check(await reads(sorting.nested)===sortingReads+1&&await path('right').inputValue()===sorting.nested.replace('/native','/display'),'subtree invalidation drains after pure sorting rather than leaving cached descendants visible');
  await page.evaluate(()=>window.ops.close());
  const shutdown=page.locator('.shutdown-dialog');await shutdown.waitFor({state:'visible'});
  const firstAttempt=await page.evaluate(()=>window.ops.state.shutdownAttempt);
  await shutdown.getByRole('button',{name:'Cancel and close',exact:true}).press('Enter');
  await page.waitForFunction(()=>document.querySelector('.shutdown-dialog [role=status]')?.textContent.includes('Cancelling queued'));
  check(await page.evaluate(attempt=>window.ops.calls.some(call=>call.command==='shutdown_operations'&&call.payload.action==='cancelAndClose'&&call.payload.attempt===attempt),firstAttempt),'shutdown action carries the initiating backend attempt identity');
  await page.evaluate(()=>{for(const job of window.ops.state.jobs)if(!['completed','failed','cancelled'].includes(job.state)){job.state='cancelled';job.cancellable=false;}window.ops.state.shutdownState='ready';window.ops.state.revision++;window.ops.notify();});
  await shutdown.getByRole('status').filter({hasText:'Closing QPanes'}).waitFor();
  check(!(await shutdown.textContent()).includes('operations are still queued or running')&&await shutdown.getByRole('button',{name:'Force exit',exact:true}).count()===0&&await shutdown.getByRole('button',{name:'Cancel and close',exact:true}).count()===0,'ready shutdown truthfully reports no running work and offers no force action');
  await shutdown.getByRole('button',{name:'Keep working',exact:true}).press('Enter');await shutdown.waitFor({state:'detached'});
  check(await page.evaluate(attempt=>window.ops.calls.some(call=>call.command==='shutdown_operations'&&call.payload.action==='keepWorking'&&call.payload.attempt===attempt),firstAttempt),'Keep working carries the same current shutdown identity');
  await page.evaluate(()=>window.ops.close());await shutdown.waitFor({state:'visible'});
  check(await page.evaluate(attempt=>window.ops.state.shutdownAttempt!==attempt,firstAttempt),'a new shutdown prompt receives a fresh attempt identity');
  await shutdown.getByRole('button',{name:'Keep working',exact:true}).press('Enter');await shutdown.waitFor({state:'detached'});
  await page.evaluate(()=>{window.ops.make({kind:'create',parent:'/native/left',name:'close-prompt-finish'});window.ops.close();});await shutdown.waitFor({state:'visible'});
  await shutdown.getByRole('button',{name:'Cancel and close',exact:true}).waitFor();
  await page.evaluate(()=>{for(const job of window.ops.state.jobs){job.state='completed';job.cancellable=false;}window.ops.state.revision++;window.ops.notify();});
  await shutdown.getByRole('button',{name:'Close QPanes',exact:true}).waitFor();
  check((await shutdown.textContent()).includes('All operations have finished.')&&!(await shutdown.textContent()).includes('operations are still queued or running'),'idle close prompt updates truthfully when the final operation finishes');
  check(await page.evaluate(()=>window.ops.state.shutdownState==='idle'),'natural completion does not confirm an idle close prompt');
  await shutdown.getByRole('button',{name:'Close QPanes',exact:true}).press('Enter');
  await shutdown.getByRole('status').filter({hasText:'Closing QPanes'}).waitFor();
  check(await page.evaluate(()=>window.ops.state.shutdownState==='ready'),'ordinary close after natural completion retains explicit user confirmation');
  await shutdown.getByRole('button',{name:'Keep working',exact:true}).press('Enter');await shutdown.waitFor({state:'detached'});
  check(errors.length===0,'no renderer exceptions',errors);
  const report={mode:'MOCKED native classifier/IPC, trusted Chromium keyboard input',passed:checks.filter(test=>test.pass).length,failed:checks.filter(test=>!test.pass),checks};
  await page.screenshot({path:'test-results/slice-003-hardening-renderer.png'});
  if(report.failed.length)throw new Error(JSON.stringify(report));
  return report;
}
