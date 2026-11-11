import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeOperations, progressPercent, operationClient, operationInvalidationGap } from '../src/lib/operations.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
const snapshot = (revision, state = 'running') => ({ revision, invalidationRevision: 0, jobs: [{ id: '1', state, invalidationRevision: null }], accepting: true, closeRequested: false, shutdownState: 'idle' });
function fixture() {
  const updates = [], errors = [];
  let changed, reads = 0, released = 0;
  let read = async () => snapshot(1);
  const source = {
    listen: async callback => { changed = callback; return () => { released++; }; },
    snapshot: () => { reads++; return read(); },
  };
  const observer = observeOperations(value => updates.push(value), error => errors.push(error), source);
  return { observer, updates, errors, source, change: revision => changed(revision), read: callback => { read = callback; }, counts: () => ({ reads, released }) };
}

test('listener attaches before initial snapshot and coalesces updates arriving during reads', async () => {
  const first = deferred(), second = deferred();
  const f = fixture();
  let count = 0;
  f.read(() => ++count === 1 ? first.promise : second.promise);
  await tick();
  f.change(3); f.change(4); f.change(5);
  assert.equal(f.counts().reads, 1, 'only one snapshot can be in flight');
  first.resolve(snapshot(2)); await tick();
  assert.equal(f.counts().reads, 2);
  second.resolve(snapshot(5, 'completed')); await f.observer.ready;
  assert.deepEqual(f.updates.map(value => value.revision), [2, 5]);
  assert.equal(f.updates.at(-1).jobs[0].state, 'completed');
  f.observer.dispose();
});

test('older events and snapshots cannot overwrite a terminal state or restore dismissed history', async () => {
  const f = fixture(); await f.observer.ready;
  f.read(async () => snapshot(4, 'completed')); f.change(4); await tick();
  f.read(async () => snapshot(2)); await f.observer.refresh();
  f.change(2); await tick();
  assert.equal(f.updates.at(-1).jobs[0].state, 'completed');
  f.read(async () => ({ ...snapshot(5), jobs: [] })); f.change(5); await tick();
  f.change(4); await tick();
  assert.deepEqual(f.updates.at(-1).jobs, []);
  f.observer.dispose();
});

test('dispose releases one listener, ignores pending reads and prevents duplicate reattachment subscriptions', async () => {
  const f = fixture(); await f.observer.ready;
  const read = deferred(); f.read(() => read.promise);
  const refreshing = f.observer.refresh();
  const count = f.updates.length;
  f.observer.dispose(); f.observer.dispose();
  read.resolve(snapshot(8)); await refreshing; f.change(10); await f.observer.refresh();
  assert.equal(f.counts().released, 1); assert.equal(f.updates.length, count);
  const next = fixture(); await next.observer.ready;
  assert.equal(next.updates.length, 1, 'new attachment recovers the current snapshot without submitting');
  next.observer.dispose();
});

test('listener resolving after unmount is immediately released without a snapshot read', async () => {
  const registration = deferred(); let reads = 0, released = 0;
  const observer = observeOperations(() => assert.fail('disposed observer updated'), () => assert.fail('disposed observer errored'), {
    listen: () => registration.promise, snapshot: async () => { reads++; return snapshot(1); },
  });
  observer.dispose(); registration.resolve(() => { released++; }); await observer.ready;
  assert.equal(reads, 0); assert.equal(released, 1);
});

test('snapshot failures remain recoverable by explicit refresh without a timer polling loop', async () => {
  const f = fixture(); f.read(async () => { throw new Error('IPC unavailable'); });
  await f.observer.ready;
  assert.equal(f.errors.length, 1); assert.equal(f.counts().reads, 1);
  f.read(async () => snapshot(4)); await f.observer.refresh();
  assert.equal(f.updates.at(-1).revision, 4); assert.equal(f.counts().reads, 2);
  f.observer.dispose();
});

test('failed listener registration can reconnect explicitly without accumulating subscriptions', async () => {
  let attempts = 0, released = 0, reads = 0;
  const errors = [], updates = [];
  const observer = observeOperations(value => updates.push(value), error => errors.push(error), {
    listen: async () => { if (++attempts === 1) throw new Error('Cannot listen'); return () => { released++; }; },
    snapshot: async () => { reads++; return snapshot(3); },
  });
  await observer.ready;
  assert.equal(errors.length, 1); assert.equal(reads, 0);
  await observer.refresh();
  assert.equal(attempts, 2); assert.equal(updates.at(-1).revision, 3);
  observer.dispose(); assert.equal(released, 1);
});

test('unknown and empty byte totals are indeterminate; failed data-copy 100% is never successful completion', () => {
  const job = (state, bytesProcessed, totalBytes) => ({ state, progress: { bytesProcessed, totalBytes } });
  assert.equal(progressPercent(job('running', 0, null)), null);
  assert.equal(progressPercent(job('running', 0, 0)), null);
  assert.equal(progressPercent(job('running', 50, 100)), 50);
  assert.equal(progressPercent(job('running', 99.5, 100)), 99.5);
  assert.equal(progressPercent(job('failed', 99.5, 100)), 99.5);
  assert.equal(progressPercent(job('running', 100, 100)), null);
  assert.equal(progressPercent(job('failed', 100, 100)), null);
  assert.equal(progressPercent(job('cancelled', 100, 100)), null);
  assert.equal(progressPercent(job('completed', 0, 0)), 100);
});

test('uncertain admission retries reuse a token and immutable intent; independent actions get new sequences', async () => {
  const calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, payload) => { calls.push({ command, payload: structuredClone(payload) }); return { id: 'accepted' }; } } };
  try {
    const client = operationClient('renderer-client');
    const intent = { kind: 'create', parent: 'opaque', name: 'confirmed' };
    const send = client.submission(intent); intent.name = 'changed-after-confirmation';
    await send(); await send();
    assert.deepEqual(calls[0].payload, calls[1].payload);
    assert.equal(calls[0].payload.request.intent.name, 'confirmed');
    const retry = client.retry('failed-job'); await retry(); await retry();
    assert.deepEqual(calls[2].payload, calls[3].payload);
    assert.equal(calls[2].payload.sequence, 2);
    await client.submission({ kind: 'create', parent: 'other', name: 'new' })();
    assert.equal(calls[4].payload.request.sequence, 3);
  } finally { delete globalThis.window; }
});

test('equal-revision reconnect acknowledges healthy communication without replaying operation data', async () => {
  let read = async () => snapshot(7);
  let health = 'unknown';
  let updates = 0;
  const observer = observeOperations(() => { updates++; }, () => { health = 'unavailable'; }, {
    listen: async () => () => {},
    snapshot: () => read(),
  }, () => { health = 'available'; });
  await observer.ready;
  read = async () => { throw new Error('Temporary read failure'); };
  await observer.refresh();
  assert.equal(health, 'unavailable');
  read = async () => snapshot(7);
  await observer.refresh();
  assert.equal(health, 'available', 'a successful read must acknowledge connectivity even when no registry data changed');
  assert.equal(updates, 1, 'equal revisions must not replay operation updates or pane invalidations');
  observer.dispose();
});


test('invalidation gaps detect pruned or dismissed completions independently of job state delivery', () => {
  const state = (invalidationRevision, stamps) => ({ ...snapshot(99), invalidationRevision, jobs: stamps.map((stamp, index) => ({ id: String(index), state: stamp === null ? 'running' : 'completed', invalidationRevision: stamp })) });
  assert.equal(operationInvalidationGap(state(0, [null]), 0), false);
  assert.equal(operationInvalidationGap(state(2, [1, 2, null]), 0), false);
  assert.equal(operationInvalidationGap(state(2, [2]), 1), false, 'already observed dismissal causes no gap');
  assert.equal(operationInvalidationGap(state(2, [2]), 0), true, 'unobserved removed completion is detected');
  assert.equal(operationInvalidationGap(state(66, Array.from({length:64}, (_, i) => i + 3)), 0), true, 'bounded history cannot hide missing completion');
  assert.equal(operationInvalidationGap(state(66, Array.from({length:64}, (_, i) => i + 3)), 2), false, 'retained suffix covers all work since the last acknowledged epoch');
  assert.equal(operationInvalidationGap(state(66, []), 66), false, 'dismissal/progress alone does not repeat invalidation');
});

test('invalidation reconciliation catches work never seen queued or running', () => {
  const next = { ...snapshot(50), invalidationRevision: 4, jobs: [] };
  assert.equal(operationInvalidationGap(next, 0), true);
  assert.equal(operationInvalidationGap({ ...next, jobs: [{ invalidationRevision: 4 }, { invalidationRevision: 4 }, { invalidationRevision: null }] }, 2), true, 'duplicate history entries cannot conceal a missing sequence');
});
