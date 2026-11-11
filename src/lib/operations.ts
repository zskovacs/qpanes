import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { FileEntry, FilesystemError, NativePath, OperationResult } from './filesystem';

export type OperationIntent =
  | { kind: 'copy' | 'move'; source: FileEntry; destination: NativePath }
  | { kind: 'create'; parent: NativePath; name: string }
  | { kind: 'rename'; source: FileEntry; name: string }
  | { kind: 'trash'; source: FileEntry };
export type OperationState = 'queued' | 'preparing' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export interface OperationProgress {
  currentItem: NativePath | null; currentLabel: string | null;
  bytesProcessed: number; totalBytes: number | null; completedFiles: number; totalFiles: number | null;
  elapsedMs: number; bytesPerSecond: number | null; remainingMs: number | null;
}
export interface OperationJob {
  id: string; intent: OperationIntent; sourceLabel: string | null; destinationLabel: string | null; affectedDirectories: NativePath[]; invalidatedSubtrees: NativePath[]; invalidationRevision: number | null;
  submittedMs: number; startedMs: number | null; completedMs: number | null;
  state: OperationState; progress: OperationProgress; cancellationRequested: boolean; cancellable: boolean;
  result: OperationResult | null; error: FilesystemError | null; retryable: boolean; retryOf: string | null;
}
export interface OperationsSnapshot {
  revision: number; invalidationRevision: number; jobs: OperationJob[]; accepting: boolean; closeRequested: boolean;
  shutdownState: 'idle' | 'draining' | 'blocked' | 'ready'; shutdownAttempt: string | null;
}
export interface SubmitRequest { clientId: string; sequence: number; intent: OperationIntent }
export type ShutdownAction = 'keepWorking' | 'cancelAndClose' | 'forceExit';
export const emptyOperations: OperationsSnapshot = {
  revision: 0, invalidationRevision: 0, jobs: [], accepting: true, closeRequested: false, shutdownState: 'idle', shutdownAttempt: null,
};
export const isTerminal = (job: Pick<OperationJob, 'state'>) => ['completed', 'failed', 'cancelled'].includes(job.state);
export const stateLabel: Record<OperationState, string> = {
  queued: 'Queued', preparing: 'Preparing', running: 'Running', cancelling: 'Cancelling',
  completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};
export const operationLabel: Record<OperationIntent['kind'], string> = {
  copy: 'Copy', move: 'Move', create: 'Create directory', rename: 'Rename', trash: 'Move to Trash',
};

/** A missing completed attempt cannot be reconstructed from bounded history.
 * Detect that gap without retaining tombstones or depending on event delivery. */
export function operationInvalidationGap(snapshot: OperationsSnapshot, previous: number): boolean {
  if (snapshot.invalidationRevision <= previous) return false;
  const observed = new Set(snapshot.jobs.flatMap((job) => job.invalidationRevision !== null
    && job.invalidationRevision > previous && job.invalidationRevision <= snapshot.invalidationRevision
    ? [job.invalidationRevision] : []));
  return observed.size !== snapshot.invalidationRevision - previous;
}

/** Percentage is data work only. Publication is still required for completion. */
export function progressPercent(job: OperationJob): number | null {
  if (job.state === 'completed') return 100;
  const total = job.progress.totalBytes;
  if (total === null || total === 0 || job.progress.bytesProcessed >= total) return null;
  return job.progress.bytesProcessed / total * 100;
}

export function listOperations(): Promise<OperationsSnapshot> { return invoke('list_operations'); }
export function getOperation(id: string): Promise<OperationJob> { return invoke('get_operation', { id }); }
export function cancelOperation(id: string): Promise<OperationJob> { return invoke('cancel_operation', { id }); }
export function dismissOperation(id: string): Promise<void> { return invoke('dismiss_operation', { id }); }
export function shutdownOperations(action: ShutdownAction, attempt: string | null): Promise<void> { return invoke('shutdown_operations', { action, attempt }); }

/** Native component/ancestry semantics stay in Rust; opaque IDs are never split in JS. */
export function classifyOperationInvalidation(paths: NativePath[], directories: NativePath[], subtrees: NativePath[]): Promise<boolean[]> {
  return invoke('classify_operation_invalidation', { paths, directories, subtrees });
}

/** One client per renderer attachment; retries of an uncertain submission reuse its token. */
export function operationClient(clientId = crypto.randomUUID()) {
  let sequence = 0;
  function token() {
    if (sequence >= 0xffff_ffff) throw new Error('Submission limit reached. Reload QPanes.');
    return { clientId, sequence: ++sequence };
  }
  return {
    submission(intent: OperationIntent) {
      const request: SubmitRequest = { ...token(), intent: structuredClone(intent) };
      return () => invoke<OperationJob>('submit_operation', { request });
    },
    retry(id: string) {
      const request = { id, ...token() };
      return () => invoke<OperationJob>('retry_operation', request);
    },
  };
}

type RevisionSource = {
  listen: (changed: (revision: number) => void) => Promise<() => void>;
  snapshot: () => Promise<OperationsSnapshot>;
};
const nativeSource: RevisionSource = {
  listen: (changed) => listen<number>('operations-changed', (event) => changed(event.payload)),
  snapshot: listOperations,
};

/** Events are hints only: listen first, coalesce reads, and accept newer complete snapshots. */
export function observeOperations(
  update: (snapshot: OperationsSnapshot) => void,
  onerror: (error: unknown) => void,
  source: RevisionSource = nativeSource,
  onconnected: () => void = () => {},
) {
  let disposed = false;
  let attached = false;
  let busy = false;
  let dirty = false;
  let wanted = 0;
  let applied = -1;
  let unlisten: (() => void) | undefined;
  let registration: Promise<void> | null = null;
  const fail = (error: unknown) => { if (!disposed) onerror(error); };
  const release = (listener: () => void) => {
    try { void Promise.resolve(listener()).catch(fail); } catch (error) { fail(error); }
  };
  async function refresh() {
    if (disposed) return;
    dirty = true;
    if (!attached) await connect();
    if (disposed || !attached || busy) return;
    busy = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        const snapshot = await source.snapshot();
        if (disposed) return;
        // Connectivity is independent of registry changes. Equal revisions still
        // acknowledge recovery without replaying data or invalidation callbacks.
        onconnected();
        if (snapshot.revision > applied) {
          applied = snapshot.revision;
          update(snapshot);
        }
        if (wanted > Math.max(snapshot.revision, applied)) dirty = true;
      }
    } catch (error) { fail(error); }
    finally { busy = false; }
  }
  function connect(): Promise<void> {
    if (attached || disposed) return Promise.resolve();
    if (registration) return registration;
    registration = Promise.resolve().then(() => source.listen((revision) => {
      if (disposed || revision <= applied) return;
      wanted = Math.max(wanted, revision);
      void refresh();
    })).then((listener) => {
      if (disposed) { release(listener); return; }
      unlisten = listener;
      attached = true;
    }).catch(fail).finally(() => { registration = null; });
    return registration;
  }
  const ready = refresh();
  return {
    ready,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (unlisten) release(unlisten);
      unlisten = undefined;
    },
  };
}
