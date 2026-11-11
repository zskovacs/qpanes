// Real Tauri/Rust IPC and disposable filesystem fixtures; UI input is DOM-dispatched.
// Run through run-operations.sh with QPANES_NATIVE_PHASE=hardening and BACKGROUND=1.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
const root=process.env.QPANES_TEST_IO_ROOT,inspector=process.env.QPANES_INSPECTOR;
assert(root?.startsWith('/tmp/qpanes-slice-002-native.'));
assert.equal(await readFile(join(root,'qpanes-native-isolation'),'utf8'),'QPanes disposable native Trash fixtures\n');
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
const submit=intent=>ipc('submit_operation',{request:{clientId:'native-hardening',sequence:++sequence,intent}});
const done=id=>waitFor(async()=>{const job=await ipc('get_operation',{id});return ['completed','failed','cancelled'].includes(job.state)&&job;});
async function listing(path){return ipc('list_directory',{request:{target:{kind:'typed',value:path},sort:'name',direction:'ascending'}});}
async function entry(parent,name){const found=(await listing(parent)).entries.find(item=>item.name===name);assert(found?.identity);return found;}
async function go(side,path){
 await evaluate(`(()=>{const el=document.querySelector('[aria-label="${side} directory path"]');el.value=${JSON.stringify(path)};el.dispatchEvent(new Event('input',{bubbles:true}));el.form.requestSubmit();})()`);
 await waitFor(()=>evaluate(`document.querySelector('[aria-label="${side} directory path"]').value===${JSON.stringify(path)} && document.querySelector('[aria-label="${side} files"]').getAttribute('aria-busy')==='false'`));
}
async function unavailable(side,path){
 await waitFor(()=>evaluate(`document.querySelector('[aria-label="${side} panel"] [role="alert"]')!==null`));
 assert.equal(await evaluate(`document.querySelector('[aria-label="${side} directory path"]').value`),path);
}
const checks=[];const check=(value,message)=>{assert(value,message);checks.push(message);};
const fixture=await mkdtemp(join(root,'hardening-'));const left=join(fixture,'left'),right=join(fixture,'right');let complete=false;
try{
 await ready;await waitFor(()=>evaluate('!!window.__TAURI_INTERNALS__ && !!document.querySelector(".operations-toggle")'));
 await mkdir(left);await mkdir(right);await mkdir(join(left,'selected','child'),{recursive:true});await mkdir(join(left,'selected-other'));
 await writeFile(join(left,'selected','child','inside.txt'),'exact nested fixture bytes');
 await go('left',left);await go('right',join(left,'selected','child'));
 let job=await submit({kind:'rename',source:await entry(left,'selected'),name:'renamed'});assert.equal((await done(job.id)).state,'completed');
 await unavailable('right',join(left,'selected','child'));
 check(await readFile(join(left,'renamed','child','inside.txt'),'utf8')==='exact nested fixture bytes','native rename invalidates an open descendant and preserves exact bytes without redirecting its pane');
 await go('right',join(left,'selected-other'));job=await submit({kind:'rename',source:await entry(left,'renamed'),name:'selected'});await done(job.id);
 await waitFor(()=>evaluate(`document.querySelector('[aria-label="left files"]').getAttribute('aria-busy') === 'false'`));
 check(await evaluate(`!document.querySelector('[aria-label="right panel"] [role="alert"]')`),'similarly prefixed sibling stays available after native rename');
 await go('left',join(left,'selected','child'));await go('right',right);
 job=await submit({kind:'move',source:await entry(left,'selected'),destination:nativePath(right)});assert.equal((await done(job.id)).state,'completed');
 await unavailable('left',join(left,'selected','child'));
 check(await readFile(join(right,'selected','child','inside.txt'),'utf8')==='exact nested fixture bytes','native directory move invalidates old open subtree in the other direction without losing data');
 await go('left',left);await go('right',join(right,'selected'));
 job=await submit({kind:'rename',source:await entry(right,'selected'),name:'right-renamed'});await done(job.id);await unavailable('right',join(right,'selected'));
 check(true,'native rename invalidates a pane displaying the source directory itself');
 // A confirmed drain is superseded by Keep working; late copy cancellation
 // must leave the process alive, retain staging and reopen admission.
 const source=join(fixture,'copy-source');await mkdir(source);await writeFile(join(source,'large.bin'),Buffer.alloc(1024*1024,43));const original=await entry(source,'large.bin');
 const firstDest=join(fixture,'cancelled');await mkdir(firstDest);await rm(join(root,'write-blocked'),{force:true});await writeFile(join(root,'blocked-writes'),'fixture only');
 const copy=await submit({kind:'copy',source:original,destination:nativePath(firstDest)});
 await waitFor(async()=>{try{return await readFile(join(root,'write-blocked'),'utf8')==='1';}catch{return false;}});
 await ipc('plugin:window|close',{label:'main'});await waitFor(()=>evaluate('document.querySelector(".shutdown-dialog")?.open'));
 const first=(await ipc('list_operations')).shutdownAttempt;assert(first);
 await ipc('shutdown_operations',{action:'cancelAndClose',attempt:first});
 await waitFor(async()=>(await ipc('list_operations')).shutdownState==='blocked',6000);
 await ipc('shutdown_operations',{action:'keepWorking',attempt:first});await rm(join(root,'blocked-writes'));
 const cancelled=await done(copy.id);check(cancelled.state==='cancelled'&&cancelled.error.code==='cancellationCleanupFailed'&&cancelled.progress.bytesProcessed===65536,'native cancellation after blocked write retains accurate partial progress and visible recovery');
 const again=await submit({kind:'create',parent:nativePath(left),name:'kept-working'});await done(again.id);
 check((await ipc('list_operations')).accepting && (await lstat(join(left,'kept-working'))).isDirectory(),'Keep working invalidates the drain and prevents automatic exit when cancelled work later finishes');
 // Repeated closes share one prompt; old attempts cannot affect a new one.
 const finalDest=join(fixture,'final');await mkdir(finalDest);await rm(join(root,'write-blocked'),{force:true});await writeFile(join(root,'blocked-writes'),'fixture only');
 const final=await submit({kind:'copy',source:original,destination:nativePath(finalDest)});
 await waitFor(async()=>{try{return await readFile(join(root,'write-blocked'),'utf8')==='1';}catch{return false;}});
 await ipc('plugin:window|close',{label:'main'});await waitFor(()=>evaluate('document.querySelector(".shutdown-dialog")?.open'));
 const second=(await ipc('list_operations')).shutdownAttempt;assert(second&&second!==first);
 await ipc('plugin:window|close',{label:'main'});check((await ipc('list_operations')).shutdownAttempt===second,'repeated native Close retains the current attempt identity');
 await ipc('shutdown_operations',{action:'cancelAndClose',attempt:second});
 await evaluate(`window.__staleCloseReply=null;window.__TAURI_INTERNALS__.invoke('shutdown_operations',{action:'forceExit',attempt:${JSON.stringify(first)}}).then(()=>window.__staleCloseReply={accepted:true},error=>window.__staleCloseReply={error})`);
 await waitFor(()=>evaluate('window.__staleCloseReply!==null'));
 check(await evaluate('window.__staleCloseReply.error?.code==="invalidOperation"') && (await ipc('list_operations')).shutdownState==='draining','stale native Force exit is rejected and a new attempt retains its own grace');
 await waitFor(async()=>(await ipc('list_operations')).shutdownState==='blocked',6000);
 check((await ipc('get_operation',{id:final.id})).state==='cancelling','shutdown timeout never marks unresolved copying as completed');
 await rm(join(root,'blocked-writes'));
 const pid=Number(process.env.QPANES_NATIVE_APP_PID);assert(pid>1);
 await waitFor(async()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});
 await assert.rejects(lstat(join(finalDest,'large.bin')),error=>error.code==='ENOENT');
 const stages=(await readdir(finalDest)).filter(name=>name.startsWith('.qpanes-copy-'));assert.equal(stages.length,1);
 check((await readFile(join(finalDest,stages[0],'payload'))).equals(Buffer.alloc(65536,43)) && (await readFile(join(source,'large.bin'))).equals(Buffer.alloc(1024*1024,43)),'late native cancellation automatically completes normal close after cleanup returns, retaining exact stage/source bytes without publication');
 complete=true;
}finally{
 await rm(join(root,'blocked-writes'),{force:true});await rm(join(root,'write-blocked'),{force:true});
 const report={complete,mode:'real Linux Tauri/Rust IPC + filesystem; DOM-dispatched input; fixture-only delayed writes',passed:checks.length,checks,limits:'Windows/macOS runtime and trusted native OS keyboard input NOT VERIFIED'};
 await writeFile(`test-results/slice-003-hardening-native${complete?'':'-partial'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await rm(fixture,{recursive:true,force:true});socket.close();
}
