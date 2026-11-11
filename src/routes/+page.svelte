<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import FilePane, { type PaneSnapshot } from '$lib/FilePane.svelte';
  import OperationDialog, { type OperationKind } from '$lib/OperationDialog.svelte';
  import { onMount } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { filesystemError, type FileEntry } from '$lib/filesystem';
  import OperationsPanel from '$lib/OperationsPanel.svelte';
  import ShutdownDialog from '$lib/ShutdownDialog.svelte';
  import { cancelOperation, dismissOperation, emptyOperations, isTerminal, observeOperations, operationClient, operationInvalidationGap, shutdownOperations, type OperationIntent, type OperationJob, type OperationsSnapshot, type ShutdownAction } from '$lib/operations';
  import WindowHeader from '$lib/WindowHeader.svelte';
  import '$lib/app.css';
  let active = $state<'left' | 'right'>('left');
  let split = $state(50);
  let resizing = $state(false);
  let workspace: HTMLDivElement;
  let left: FilePane;
  let right: FilePane;
  type OperationContext = {
    owner: 'left' | 'right'; origin: PaneSnapshot; opposite: PaneSnapshot | null;
  } & ({ kind: 'create' } | { kind: Exclude<OperationKind, 'create'>; entry: FileEntry });
  let operation = $state.raw<OperationContext | null>(null);
  let operationNotice = $state('');
  let operations = $state.raw<OperationsSnapshot>(emptyOperations);
  let operationsError = $state('');
  let operationActionError = $state('');
  let shutdownError = $state('');
  let freshProgress = $state<string[]>([]);
  let freshnessTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: ReturnType<typeof observeOperations> | undefined;
  let client: ReturnType<typeof operationClient>;
  let submission: { key: string; send: () => Promise<OperationJob> } | null = null;
  let previousJobs = new Map<string, string>();
  let invalidationRevision = 0;
  const retries = new Map<string, () => Promise<OperationJob>>();
  onMount(() => {
    if (!isTauri()) return;
    client = operationClient();
    observer = observeOperations((snapshot) => {
      const missingInvalidations = operationInvalidationGap(snapshot, invalidationRevision);
      invalidationRevision = snapshot.invalidationRevision;
      const affected = new Set<string>();
      const subtrees = new Set<string>();
      for (const job of snapshot.jobs) {
        if (isTerminal(job) && previousJobs.get(job.id) !== job.state) {
          for (const path of job.affectedDirectories) affected.add(path);
          for (const path of job.invalidatedSubtrees ?? []) subtrees.add(path);
        }
      }
      operations = snapshot;
      clearTimeout(freshnessTimer);
      const transferring = snapshot.jobs.find((job) => job.state === 'running' && job.progress.bytesPerSecond !== null);
      const freshnessRemaining = transferring?.startedMs !== null && transferring ? transferring.startedMs! + transferring.progress.elapsedMs + 1500 - Date.now() : 0;
      freshProgress = transferring && freshnessRemaining > 0 ? [transferring.id] : [];
      if (freshProgress.length) freshnessTimer = setTimeout(() => { freshProgress = []; }, freshnessRemaining);
      previousJobs = new Map(snapshot.jobs.map((job) => [job.id, job.state]));
      for (const id of retries.keys()) if (!previousJobs.has(id)) retries.delete(id);
      if (affected.size || subtrees.size || missingInvalidations) {
        left?.refreshAffectedDirectories([...affected], [...subtrees], missingInvalidations);
        right?.refreshAffectedDirectories([...affected], [...subtrees], missingInvalidations);
      }
    }, (cause) => { operationsError = filesystemError(cause).message; }, undefined, () => { operationsError = ''; });
    return () => { observer?.dispose(); clearTimeout(freshnessTimer); };
  });
  async function jobAction(kind: 'cancel' | 'retry' | 'dismiss', id: string) {
    operationActionError = '';
    try {
      if (kind === 'cancel') await cancelOperation(id);
      else if (kind === 'dismiss') await dismissOperation(id);
      else {
        let send = retries.get(id);
        if (!send) { send = client.retry(id); retries.set(id, send); }
        await send();
      }
      await observer?.refresh();
    } catch (cause) { operationActionError = filesystemError(cause).message; }
  }
  async function shutdown(action: ShutdownAction) {
    shutdownError = '';
    try { await shutdownOperations(action, operations.shutdownAttempt); await observer?.refresh(); }
    catch (cause) { shutdownError = filesystemError(cause).message; }
  }
  const operationActions: { kind: OperationKind; key: string; label: string }[] = [
    { kind: 'rename', key: 'F2', label: 'Rename' }, { kind: 'copy', key: 'F5', label: 'Copy' },
    { kind: 'move', key: 'F6', label: 'Move' }, { kind: 'create', key: 'F7', label: 'New folder' },
    { kind: 'trash', key: 'Delete', label: 'Trash' },
  ];
  afterNavigate(() => { left.focusList(); });
  function switchPane() {
    active = active === 'left' ? 'right' : 'left';
    (active === 'left' ? left : right).focusList();
  }
  function keyboard(event: KeyboardEvent) {
    if (operation || (event.target instanceof Element && event.target.closest('dialog'))) {
      if (event.key === 'F5') event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      (active === 'left' ? left : right).editPath();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.defaultPrevented) return;
    const action = operationActions.find((candidate) => candidate.key === event.key);
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
      if (action?.key === 'F5') event.preventDefault();
      return;
    }
    if (action) { event.preventDefault(); startOperation(action.kind); }
  }

  function startOperation(kind: OperationKind) {
    if (operation || operations.closeRequested || !operations.accepting) return;
    const origin = (active === 'left' ? left : right).operationSnapshot();
    const opposite = (active === 'left' ? right : left).operationSnapshot();
    if (!origin) { operationNotice = 'Wait for the panel to finish, or finish editing its path.'; return; }
    if (kind !== 'create' && !origin.entry) { operationNotice = 'Select a real file or directory first.'; return; }
    if ((kind === 'copy' || kind === 'move') && !opposite) { operationNotice = 'The destination panel must show an available directory.'; return; }
    operationNotice = '';
    submission = null;
    const context = { owner: active, origin, opposite };
    operation = kind === 'create' ? { ...context, kind } : { ...context, kind, entry: origin.entry! };
  }

  function executeOperation(context: OperationContext, name: string): Promise<OperationJob> {
    let intent: OperationIntent;
    switch (context.kind) {
      case 'create': intent = { kind: 'create', parent: context.origin.path, name }; break;
      case 'rename': intent = { kind: 'rename', source: context.entry, name }; break;
      case 'trash': intent = { kind: 'trash', source: context.entry }; break;
      case 'copy': case 'move': intent = { kind: context.kind, source: context.entry, destination: context.opposite!.path }; break;
    }
    if (!client) return Promise.reject({ code: 'unavailable', message: 'Open QPanes in its desktop window to perform file operations.' });
    const key = JSON.stringify(intent);
    if (!submission || submission.key !== key) submission = { key, send: client.submission(intent) };
    return submission.send();
  }

  function closeOperation(context: OperationContext, job?: OperationJob) {
    operation = null;
    submission = null;
    (context.owner === 'left' ? left : right).focusList();
    if (job) void observer?.refresh();
  }
  function resize(event: PointerEvent) {
    if (!resizing) return;
    const bounds = workspace.getBoundingClientRect();
    split = Math.max(30, Math.min(70, (event.clientX - bounds.left) / bounds.width * 100));
  }
  function resizeKey(event: KeyboardEvent) {
    const delta = event.key === 'ArrowLeft' ? -2 : event.key === 'ArrowRight' ? 2 : 0;
    if (delta) { event.preventDefault(); split = Math.max(30, Math.min(70, split + delta)); }
    if (event.key === 'Home') { event.preventDefault(); split = 50; }
  }
</script>
<svelte:head><title>Qpanes · Local files</title><meta name="description" content="A fast, keyboard-first dual-pane file manager." /></svelte:head>
<svelte:window onkeydown={keyboard} onpointermove={resize} onpointerup={() => { resizing = false; }} onpointercancel={() => { resizing = false; }} />
<main class={{ resizing }}>
  <WindowHeader onreturnfocus={() => (active === 'left' ? left : right).focusList()} />
  <div class="workspace-intro"><div><span class="eyebrow">WORKSPACE</span><span class="intro-description">Two panels. One flow.</span></div><div class="operation-actions" aria-label="File operations">
    {#each operationActions as action (action.kind)}<button title={`${action.label} (${action.key})`} aria-label={action.label} disabled={!operations.accepting || operations.closeRequested} onclick={() => startOperation(action.kind)}><kbd>{action.key === 'Delete' ? 'Del' : action.key}</kbd><span>{action.label}</span></button>{/each}
  </div></div>
  <div class="workspace" bind:this={workspace} style:--split={`${split}%`}>
    <FilePane side="left" active={active === 'left'} bind:this={left} onactivate={() => { active = 'left'; }} onswitch={switchPane} />
    <div class="splitter" role="slider" aria-label="Resize panels" aria-orientation="horizontal" aria-valuemin="30" aria-valuemax="70" aria-valuenow={Math.round(split)} aria-valuetext={`Left panel ${Math.round(split)} percent`} tabindex="0" onkeydown={resizeKey}
      onpointerdown={(event) => { resizing = true; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); }} ondblclick={() => { split = 50; }}><span></span></div>
    <FilePane side="right" active={active === 'right'} bind:this={right} onactivate={() => { active = 'right'; }} onswitch={switchPane} />
  </div>
  <OperationsPanel jobs={operations.jobs} {freshProgress} error={operationsError} actionError={operationActionError} onclearerror={() => { operationActionError = '';}} oncancel={(id) => jobAction('cancel', id)} onretry={(id) => jobAction('retry', id)} ondismiss={(id) => jobAction('dismiss', id)} onrefresh={() => { void observer?.refresh(); }} />
  <footer class="app-footer"><div class="shortcuts"><span><kbd>Tab</kbd>Switch panel</span><span><kbd>↑</kbd><kbd>↓</kbd>Select</span><span><kbd>Enter</kbd>Open folder</span><span><kbd>⌫</kbd>Parent</span><span class="path-shortcut"><kbd>Ctrl / ⌘ L</kbd>Edit path</span></div><span class="local-status"><span></span>Local filesystem</span></footer>
</main>
{#if operation}
  {@const context = operation}
  <OperationDialog kind={context.kind} sourceName={context.kind === 'create' ? undefined : context.entry.name} sourceLocation={context.origin.label}
    destinationLocation={context.kind === 'copy' || context.kind === 'move' ? context.opposite?.label : undefined}
    execute={(name) => executeOperation(context, name)} oncancel={() => closeOperation(context)} oncomplete={(result) => closeOperation(context, result)} />
{/if}
{#if operations.closeRequested}<ShutdownDialog activeCount={operations.jobs.filter((job) => !isTerminal(job)).length} shutdownState={operations.shutdownState} onaction={shutdown} onreturnfocus={() => (active === 'left' ? left : right).focusList()} error={shutdownError} />{/if}
{#if operationNotice}<div class="operation-notice" role="status"><span>{operationNotice}</span><button aria-label="Dismiss operation message" onclick={() => { operationNotice = ''; }}>×</button></div>{/if}
<style>
  main { height: 100dvh; min-height: 320px; display: flex; flex-direction: column; }
  .workspace-intro { height: 59px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; flex-shrink: 0; }
  .workspace-intro > div { display: flex; align-items: center; gap: 15px; }
  .eyebrow { font-size: 9px; color: var(--secondary); letter-spacing: .12em; font-weight: 600; }
  .intro-description { font-size: 11px; color: var(--muted); }
  .operation-actions { display: flex; align-items: center; gap: 6px; }
  .operation-actions > button { display: flex; align-items: center; gap: 5px; padding: 5px; border-radius: 3px; color: var(--muted); font-size: 10px; }
  .operation-notice { position: fixed; z-index: 10; right: 22px; bottom: 45px; display: flex; align-items: flex-start; gap: 14px; max-width: min(560px, calc(100vw - 44px)); max-height: 150px; overflow: auto; padding: 12px 14px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-raised); box-shadow: 0 6px 24px #0006; font-size: 11px; line-height: 1.5; }
  .operation-notice > span { overflow-wrap: anywhere; }
  .operation-notice > button { color: var(--muted); }
  .workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, var(--split)) 9px minmax(0, 1fr); margin: 0 17px; }
  .splitter { display: grid; place-items: center; cursor: col-resize; outline-offset: -1px; touch-action: none; }
  .splitter > span { width: 2px; height: 30px; border-radius: 2px; background: var(--border); }
  .splitter:hover > span, .splitter:focus-visible > span, .resizing .splitter > span { background: var(--accent); }
  .resizing { cursor: col-resize; user-select: none; }
  .app-footer { height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 0 22px; font-size: 10px; color: var(--muted); }
  .shortcuts { display: flex; align-items: center; gap: 17px; }
  .shortcuts > span { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
  kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 19px; padding: 0 4px; border: 1px solid var(--border); border-radius: 3px; color: var(--secondary); background: var(--surface-raised); font: 9px var(--mono); }
  .local-status { white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .local-status > span { width: 5px; height: 5px; background: var(--accent); border-radius: 50%; }
  @media (max-height: 600px) { .workspace-intro { height: 43px; } .app-footer { height: 30px; } }
  @media (max-width: 850px) { .path-shortcut, .local-status, .operation-actions button > span { display: none; } .workspace { margin: 0 10px; } .workspace-intro { padding: 0 16px; } .shortcuts { gap: 12px; } }
</style>
