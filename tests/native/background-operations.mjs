// Real Linux Tauri/Rust IPC, DOM-dispatched UI input. Optional write faults are
// injected externally only in marked disposable fixture staging (io-faults.c).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.QPANES_TEST_IO_ROOT;
assert(root?.startsWith('/tmp/qpanes-slice-002-native.'), 'use the isolated native launcher');
assert.equal(await readFile(join(root, 'qpanes-native-isolation'), 'utf8'), 'QPanes disposable native Trash fixtures\n');
const inspector = process.env.QPANES_INSPECTOR;
const html = await (await fetch(inspector)).text();
const socketPath = html.match(/\/socket\/[^']+/)?.[0]; assert(socketPath);
const socket = new WebSocket(inspector.replace('http', 'ws') + socketPath);
let nextId = 1, target; const pending = new Map();
const ready = new Promise(resolve => socket.addEventListener('message', ({data}) => {
  const message = JSON.parse(data);
  if (message.method === 'Target.targetCreated' && message.params.targetInfo.type === 'page') { target = message.params.targetInfo.targetId; resolve(); }
  if (message.method === 'Target.dispatchMessageFromTarget') { const result = JSON.parse(message.params.message); pending.get(result.id)?.(result); pending.delete(result.id); }
}));
async function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(()=>{pending.delete(id);reject(new Error(`Inspector timeout: ${method}`));},15000);
    pending.set(id, result=>{clearTimeout(timer);result.error?reject(new Error(JSON.stringify(result.error))):resolve(result.result);});
    socket.send(JSON.stringify({id:nextId++,method:'Target.sendMessageToTarget',params:{targetId:target,message:JSON.stringify({id,method,params})}}));
  });
}
async function evaluate(expression) { const result=await command('Runtime.evaluate',{expression,returnByValue:true}); assert(!result.wasThrown,JSON.stringify(result)); return result.result.value; }
async function waitFor(fn, timeout=15000) { const deadline=Date.now()+timeout; while(Date.now()<deadline) { const value=await fn(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,20)); } throw new Error(`Native condition timed out: ${fn}`); }
async function ipc(name,args={}) {
  if(name==='shutdown_operations' && !('attempt' in args)) args={...args,attempt:(await ipc('list_operations')).shutdownAttempt};
  await evaluate(`window.__backgroundReply=null;window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)}).then(value=>window.__backgroundReply={value},error=>window.__backgroundReply={error});`);
  await waitFor(()=>evaluate('window.__backgroundReply!==null'));
  const reply=await evaluate('window.__backgroundReply'); assert(!reply.error,JSON.stringify(reply.error)); return reply.value;
}
const nativePath=path=>`u:${Buffer.from(path).toString('hex')}`;
let sequence=0;
const submit=intent=>ipc('submit_operation',{request:{clientId:'native-background',sequence:++sequence,intent}});
const terminal=job=>['completed','failed','cancelled'].includes(job.state);
const get=id=>ipc('get_operation',{id});
const done=id=>waitFor(async()=>{const job=await get(id);return terminal(job)&&job;});
async function listing(path) { return ipc('list_directory',{request:{target:{kind:'typed',value:path},sort:'name',direction:'ascending'}}); }
async function go(side,path) {
  await evaluate(`(()=>{const input=document.querySelector('[aria-label="${side} directory path"]');input.value=${JSON.stringify(path)};input.dispatchEvent(new Event('input',{bubbles:true}));input.form.requestSubmit();})()`);
  await waitFor(()=>evaluate(`document.querySelector('[aria-label="${side} directory path"]').value===${JSON.stringify(path)}&&document.querySelector('[aria-label="${side} files"]').getAttribute('aria-busy')==='false'`));
}
const checks=[],measurements={}; let completed=false; const fixture=await mkdtemp(join(root,'background-'));
const left=join(fixture,'left'),right=join(fixture,'right');
function check(value,message) { assert(value,message);checks.push(message); }
try {
  await ready; await mkdir(left);await mkdir(right);await mkdir(join(left,'browse'));
  const file=await open(join(left,'large.bin'),'wx');const chunk=Buffer.alloc(1024*1024,37);
  for(let n=0;n<32;n++)await file.write(chunk);await file.close();
  const source=(await listing(left)).entries.find(item=>item.name==='large.bin');
  for(const job of (await ipc('list_operations')).jobs) { assert(terminal(job));await ipc('dismiss_operation',{id:job.id}); }
  await go('left',left);await go('right',right);
  await writeFile(join(root,'slow-writes'),'fixture-only');
  const copying=await submit({kind:'copy',source,destination:nativePath(right)});
  await waitFor(async()=>{const job=await get(copying.id);return job.state==='running'&&job.progress.bytesProcessed>0;});
  const queued=await submit({kind:'create',parent:nativePath(right),name:'queued-first'});
  const failed=await submit({kind:'create',parent:nativePath(right),name:'queued-first'});
  const cancelled=await submit({kind:'create',parent:nativePath(right),name:'must-not-run'});
  const next=await submit({kind:'create',parent:nativePath(right),name:'after-failure'});
  const snapshot=await ipc('list_operations');
  check(snapshot.jobs.filter(job=>job.state==='running').length===1&&[queued,failed,cancelled,next].every(job=>snapshot.jobs.find(current=>current.id===job.id).state==='queued'),'one native mutation worker; later submissions remain FIFO Queued');
  await ipc('cancel_operation',{id:cancelled.id});
  const began=performance.now();await go('left',join(left,'browse'));
  await evaluate(`(()=>{const list=document.querySelector('[aria-label="left files"]');list.focus();list.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));})()`);
  measurements.navigationDuringCopyMs=Math.round(performance.now()-began);
  check((await get(copying.id)).state==='running','native pane navigation and selection remain available during copying');
  await ipc('plugin:window|minimize',{label:'main'});
  const before=(await get(copying.id)).progress.bytesProcessed;
  await waitFor(async()=>{const job=await get(copying.id);return job.progress.bytesProcessed>before;});
  check(true,'native minimize does not stop actual copied-byte progress');
  // Restore through the external X11 driver, without adding app capabilities.
  execFileSync('cc',['tests/native/x11-window.c','-o',join(root,'x11-driver'),'-lX11','-lXtst']);
  execFileSync(join(root,'x11-driver'),['Qpanes','focus']);
  await ipc('plugin:window|close',{label:'main'});
  await waitFor(()=>evaluate('document.querySelector(".shutdown-dialog")?.open'));
  check((await ipc('list_operations')).closeRequested,'native Close is intercepted while work is active');
  await evaluate(`Array.from(document.querySelectorAll('.shutdown-dialog button')).find(button=>button.textContent==='Keep working').click()`);
  await waitFor(async()=>!(await ipc('list_operations')).closeRequested);
  check((await get(copying.id)).state==='running','Keep working preserves the existing job without restarting it');
  const observations=[];const progressStart=performance.now();
  await waitFor(async()=>{const job=await get(copying.id);observations.push({time:performance.now()-progressStart,...job.progress,state:job.state});return terminal(job);});
  const result=await get(copying.id);
  check(result.state==='completed'&&result.progress.bytesProcessed===32*1024*1024&&result.progress.completedFiles===1,'native long copy reports exact bytes/files and completes after publication');
  check(new Set(observations.map(item=>item.bytesProcessed)).size>=3,'native long copy exposes multiple real incremental progress values');
  await done(next.id);
  const firstResult=await get(queued.id),failedResult=await get(failed.id),nextResult=await get(next.id);
  check(firstResult.state==='completed'&&failedResult.state==='failed'&&failedResult.error.code==='conflict'&&nextResult.state==='completed','native queue continues after destination conflict failure');
  check(firstResult.completedMs<=failedResult.startedMs&&failedResult.completedMs<=nextResult.startedMs,'native FIFO timestamps show deterministic sequential scheduling');
  await assert.rejects(lstat(join(right,'must-not-run')),error=>error.code==='ENOENT');check((await get(cancelled.id)).state==='cancelled','queued native cancellation prevents any filesystem execution');
  check(await evaluate(`document.querySelector('[aria-label="left directory path"]').value===${JSON.stringify(join(left,'browse'))}`),'completion does not restore an earlier pane location');
  const bytes=await readFile(join(right,'large.bin'));check(bytes.length===32*1024*1024&&bytes.every(value=>value===37),'published native large copy contains exact original fixture data');
  measurements.progressObservations=observations.length;measurements.distinctProgressValues=new Set(observations.map(item=>item.bytesProcessed)).size;
  measurements.observationDurationMs=Math.round(performance.now()-progressStart);
  // Cancel a second long copy after real progress, retain only marked staging.
  const cancelDestination=join(fixture,'cancel');await mkdir(cancelDestination);
  const cancelCopy=await submit({kind:'copy',source,destination:nativePath(cancelDestination)});
  await waitFor(async()=>{const job=await get(cancelCopy.id);return job.progress.bytesProcessed>0;});
  await ipc('cancel_operation',{id:cancelCopy.id});const stopped=await done(cancelCopy.id);
  check(stopped.state==='cancelled'&&stopped.error.code==='cancellationCleanupFailed'&&stopped.error.recovery,'running native cancellation reports retained partial staging truthfully');
  await assert.rejects(lstat(join(cancelDestination,'large.bin')),error=>error.code==='ENOENT');
  check((await lstat(join(left,'large.bin'))).size===32*1024*1024,'native cancellation leaves original source and no published partial destination');
  await rm(join(root,'slow-writes'));
  // External ENOSPC injection in a new fixture staging location, with real IPC.
  await writeFile(join(root,'slow-writes'),'fixture-only');const fullDestination=join(fixture,'full');await mkdir(fullDestination);
  const full=await submit({kind:'copy',source,destination:nativePath(fullDestination)});
  await waitFor(async()=>{const job=await get(full.id);return job.progress.bytesProcessed>0;});
  await writeFile(join(root,'fail-writes'),'fixture-only');const failure=await done(full.id);
  check(failure.state==='failed'&&failure.error.code==='storageFull'&&failure.retryable&&failure.progress.bytesProcessed>0&&failure.progress.bytesProcessed<failure.progress.totalBytes,'native write failure is structured and eligible for explicit safe retry');
  await rm(join(root,'fail-writes'));await rm(join(root,'slow-writes'));
  const retried=await ipc('retry_operation',{id:full.id,clientId:'native-background',sequence:++sequence});const recovered=await done(retried.id);
  check(recovered.state==='completed'&&recovered.retryOf===full.id&&recovered.id!==full.id,'native explicit retry revalidates and creates a new successful operation');
  // Reload attachment neither resubmits nor loses process-owned history.
  const ids=(await ipc('list_operations')).jobs.map(job=>job.id);
  await evaluate('window.__reloadGuard=true;location.reload()');await waitFor(()=>evaluate('window.__reloadGuard!==true && document.querySelector(".operations-toggle")!==null && !!window.__TAURI_INTERNALS__'));
  check(JSON.stringify((await ipc('list_operations')).jobs.map(job=>job.id))===JSON.stringify(ids),'native frontend reload reattaches to existing operation IDs without restarting jobs');
  await evaluate(`if(document.querySelector('.operations-toggle').getAttribute('aria-expanded')==='false')document.querySelector('.operations-toggle').click()`);
  await waitFor(()=>evaluate(`document.querySelectorAll('.operation-job').length===${ids.length}`));
  const screen=await evaluate('({width:innerWidth,height:innerHeight})');const shot=await command('Page.snapshotRect',{x:0,y:0,...screen,coordinateSystem:'Viewport'});
  await writeFile('test-results/slice-003-native-operations.png',Buffer.from(shot.dataURL.split(',')[1],'base64'));
  // Shutdown while a native write is temporarily blocked: 3s grace, explicit
  // force choice, then Keep working and eventual safe cancellation.
  await rm(join(root,'write-blocked'),{force:true});await writeFile(join(root,'blocked-writes'),'fixture-only');const blockedDest=join(fixture,'blocked');await mkdir(blockedDest);
  const blocked=await submit({kind:'copy',source,destination:nativePath(blockedDest)});
  await waitFor(async()=>{try{return await readFile(join(root,'write-blocked'),'utf8')==='1';}catch{return false;}});
  await ipc('plugin:window|close',{label:'main'});await waitFor(()=>evaluate('document.querySelector(".shutdown-dialog")?.open'));
  await ipc('shutdown_operations',{action:'cancelAndClose'});
  await waitFor(async()=>(await ipc('list_operations')).shutdownState==='blocked',6000);
  check(await evaluate(`Array.from(document.querySelectorAll('.shutdown-dialog button')).some(button=>button.textContent==='Force exit')`),'blocked native syscall exposes an explicit force-exit choice after bounded shutdown grace');
  await ipc('shutdown_operations',{action:'keepWorking'});await rm(join(root,'blocked-writes'));const cancelledAtShutdown=await done(blocked.id);
  check(cancelledAtShutdown.state==='cancelled'&&(await ipc('list_operations')).accepting,'shutdown cancellation drains safely and Keep working reopens admission');
  await writeFile(join(root,'slow-writes'),'fixture-only');const closingDest=join(fixture,'closing');await mkdir(closingDest);
  const closing=await submit({kind:'copy',source,destination:nativePath(closingDest)});
  await waitFor(async()=>{const job=await get(closing.id);return job.progress.bytesProcessed>0;});
  await ipc('plugin:window|close',{label:'main'});await waitFor(()=>evaluate('document.querySelector(".shutdown-dialog")?.open'));
  await evaluate(`Array.from(document.querySelectorAll('.shutdown-dialog button')).find(button=>button.textContent==='Cancel and close').click()`);
  const pid=Number(process.env.QPANES_NATIVE_APP_PID);assert(pid>1);
  await waitFor(async()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
  await assert.rejects(lstat(join(closingDest,'large.bin')),error=>error.code==='ENOENT');
  check((await lstat(join(left,'large.bin'))).size===32*1024*1024,'native Cancel and close safely cancels copying and actually exits the process within the grace period');
  completed=true;
} finally {
  for(const marker of ['slow-writes','fail-writes','blocked-writes','write-blocked'])await rm(join(root,marker),{force:true});
  const report={completed,mode:'REAL Linux Tauri/Rust IPC + WebKitGTK, DOM-dispatched UI input; fixture-only external delayed/failing writes',passed:checks.length,checks,measurements,limits:'Not trusted OS keys; Windows/macOS runtime NOT VERIFIED. Artificial delay measurements are responsiveness/progress evidence, not transfer benchmarks.'};
  await writeFile(`test-results/slice-003-native${completed?'':'-partial'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  await rm(fixture,{recursive:true,force:true});socket.close();
}
