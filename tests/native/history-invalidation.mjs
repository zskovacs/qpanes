// Native regression: actual Tauri/Rust bytes with delayed snapshot callback delivery.
// Run through run-operations.sh, PHASE=history and BACKGROUND=1.
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
  await evaluate(`window.__backgroundReply=null;window.__reviewBypass=true;window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)}).then(value=>window.__backgroundReply={value},error=>window.__backgroundReply={error});window.__reviewBypass=false;`);
  await waitFor(()=>evaluate('window.__backgroundReply!==null'));
  const reply=await evaluate('window.__backgroundReply'); assert(!reply.error,JSON.stringify(reply.error)); return reply.value;
}

const nativePath=path=>`u:${Buffer.from(path).toString('hex')}`;
let sequence=0;
const submit=intent=>ipc('submit_operation',{request:{clientId:'native-history-regression',sequence:++sequence,intent}});
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

const fixture=await mkdtemp(join(root,'history-eviction-'));let completed=false;
const report={mode:'REAL Tauri/Rust IPC and filesystem, delayed renderer snapshot promises only',fixture};
try {
 await ready;await waitFor(()=>evaluate('!!window.__TAURI_INTERNALS__ && !!document.querySelector(".operations-toggle")'));
 const left=join(fixture,'left'),right=join(fixture,'right'),aux=join(fixture,'aux');await mkdir(left);await mkdir(right);await mkdir(aux);
 const data=Buffer.alloc(256*1024,37);await writeFile(join(left,'copied.bin'),data);await writeFile(join(right,'original.txt'),'untouched');
 await go('left',left);await go('right',right);
 const old=await submit({kind:'create',parent:nativePath(aux),name:'dismiss-me'});assert.equal((await done(old.id)).state,'completed');
 await evaluate(`(()=>{const t=document.querySelector('.operations-toggle');if(t.getAttribute('aria-expanded')!=='true')t.click();})()`);
 await waitFor(()=>evaluate(`!!document.querySelector('[data-operation-id="${old.id}"] [data-operation-action="dismiss"]')`));
 await rm(join(root,'write-blocked'),{force:true});await writeFile(join(root,'blocked-writes'),'fixture-only');
 const copy=await submit({kind:'copy',source:await entry(left,'copied.bin'),destination:nativePath(right)});
 await waitFor(async()=>{try{return await readFile(join(root,'write-blocked'),'utf8')==='1';}catch{return false;}});
 await waitFor(()=>evaluate(`!!document.querySelector('[data-operation-id="${copy.id}"] [data-operation-action="cancel"]')`));
 // Hold only delivery of renderer snapshot responses. Backend calls and all real
 // mutation intents keep their original code. Capture an actual Running snapshot.
 await evaluate(`(()=>{
   window.__holdSnapshots=true;window.__heldSnapshots=[];
   const callbacks=window.__TAURI_INTERNALS__.callbacks;
   window.__reviewMapSet=callbacks.set.bind(callbacks);
   callbacks.set=function(id,callback){
     const bypass=window.__reviewBypass;
     return window.__reviewMapSet(id,data=>{
       if(!bypass&&window.__holdSnapshots&&Array.isArray(data?.jobs)&&Number.isInteger(data?.revision)){
         window.__heldSnapshots.push({snapshot:data,resolve:()=>callback(data)});return;
       }
       return callback(data);
     });
   };
   document.querySelector('[data-operation-id="${old.id}"] [data-operation-action="dismiss"]').click();
 })()`);
 await waitFor(()=>evaluate(`window.__heldSnapshots.some(x=>x.snapshot.jobs.some(job=>job.id==='${copy.id}'&&job.state==='running'))`));
 report.heldSnapshot=await evaluate(`window.__heldSnapshots[0].snapshot`);
 await rm(join(root,'blocked-writes'));assert.equal((await done(copy.id)).state,'completed');
 assert((await readFile(join(right,'copied.bin'))).equals(data));
 for(let n=0;n<65;n++){
   const next=await submit({kind:'create',parent:nativePath(aux),name:'other-'+n});
   assert.equal((await done(next.id)).state,'completed');
 }
 const authoritative=await ipc('list_operations');
 assert.equal(authoritative.jobs.length,64);assert(!authoritative.jobs.some(job=>job.id===copy.id));
 report.authoritativeRevision=authoritative.revision;report.retainedJobs=authoritative.jobs.length;report.copyEvicted=true;
 await evaluate(`(()=>{window.__holdSnapshots=false;for(const item of window.__heldSnapshots.splice(0))item.resolve(item.snapshot)})()`);
 await waitFor(()=>evaluate(`document.querySelectorAll('.operation-job').length===64 && !document.querySelector('[data-operation-id="${copy.id}"]')`));
 // Snapshot reconciliation has converged, so no delayed terminal event is pending.
 await waitFor(()=>evaluate(`Array.from(document.querySelectorAll('[aria-label=\"right files\"] .filename')).some(x=>x.textContent==='copied.bin')`));
 report.visible=await evaluate(`Array.from(document.querySelectorAll('[aria-label="right files"] .filename')).map(x=>x.textContent)`);
 report.onDisk=(await readdir(right)).sort();
 report.stale=!report.visible.includes('copied.bin')&&report.onDisk.includes('copied.bin');
 assert(!report.stale,'Completed/evicted copy must refresh the destination automatically');
 report.path=await evaluate(`document.querySelector('[aria-label=\"right directory path\"]').value`);
 assert.equal(report.path,right);
 report.passed=5;
 await evaluate(`document.querySelector('[aria-label="right: refresh directory"]').click()`);
 await waitFor(()=>evaluate(`Array.from(document.querySelectorAll('[aria-label="right files"] .filename')).some(x=>x.textContent==='copied.bin')`));
 report.manualRefreshRecovers=true;completed=true;
} finally {
 await rm(join(root,'blocked-writes'),{force:true});await rm(join(root,'write-blocked'),{force:true});
 report.completed=completed;
 await writeFile('test-results/slice-003-history-invalidation-native.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 try{await evaluate('window.__holdSnapshots=false;for(const item of window.__heldSnapshots??[])item.resolve(item.snapshot)')}catch{}
 await rm(fixture,{recursive:true,force:true});socket.close();
}
