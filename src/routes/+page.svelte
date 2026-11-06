<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import FilePane, { type PaneSnapshot } from '$lib/FilePane.svelte';
  import OperationDialog, { type OperationKind } from '$lib/OperationDialog.svelte';
  import { copyEntry, createDirectory, moveEntry, renameEntry, trashEntry, type FileEntry, type OperationResult } from '$lib/filesystem';
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
    if (operation) return;
    const origin = (active === 'left' ? left : right).operationSnapshot();
    const opposite = (active === 'left' ? right : left).operationSnapshot();
    if (!origin) { operationNotice = 'Wait for the panel to finish, or finish editing its path.'; return; }
    if (kind !== 'create' && !origin.entry) { operationNotice = 'Select a real file or directory first.'; return; }
    if ((kind === 'copy' || kind === 'move') && !opposite) { operationNotice = 'The destination panel must show an available directory.'; return; }
    operationNotice = '';
    const context = { owner: active, origin, opposite };
    operation = kind === 'create' ? { ...context, kind } : { ...context, kind, entry: origin.entry! };
  }

  function executeOperation(context: OperationContext, name: string): Promise<OperationResult> {
    switch (context.kind) {
      case 'create': return createDirectory({ parent: context.origin.path, name });
      case 'rename': return renameEntry({ source: context.entry, name });
      case 'trash': return trashEntry({ source: context.entry });
      case 'copy': return copyEntry({ source: context.entry, destination: context.opposite!.path });
      case 'move': return moveEntry({ source: context.entry, destination: context.opposite!.path });
    }
  }

  function closeOperation(context: OperationContext, result?: OperationResult) {
    operation = null;
    const originPane = context.owner === 'left' ? left : right;
    const oppositePane = context.owner === 'left' ? right : left;
    originPane.focusList();
    if (!result) return;
    const labels: Record<OperationKind, string> = {
      create: 'Directory created.', rename: 'Entry renamed.', copy: 'Copy completed.', move: 'Move completed.', trash: 'Entry moved to Trash.',
    };
    operationNotice = [labels[context.kind], ...result.warnings].join(' ');
    const transfer = context.kind === 'copy' || context.kind === 'move';
    if (context.kind !== 'copy') originPane.refreshAfterOperation(context.origin, transfer ? undefined : result.path);
    if (context.opposite && (transfer || context.opposite.path === context.origin.path)) {
      oppositePane.refreshAfterOperation(context.opposite, context.kind === 'trash' ? undefined : result.path);
    }
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
    {#each operationActions as action (action.kind)}<button title={`${action.label} (${action.key})`} aria-label={action.label} onclick={() => startOperation(action.kind)}><kbd>{action.key === 'Delete' ? 'Del' : action.key}</kbd><span>{action.label}</span></button>{/each}
  </div></div>
  <div class="workspace" bind:this={workspace} style:--split={`${split}%`}>
    <FilePane side="left" active={active === 'left'} bind:this={left} onactivate={() => { active = 'left'; }} onswitch={switchPane} />
    <div class="splitter" role="slider" aria-label="Resize panels" aria-orientation="horizontal" aria-valuemin="30" aria-valuemax="70" aria-valuenow={Math.round(split)} aria-valuetext={`Left panel ${Math.round(split)} percent`} tabindex="0" onkeydown={resizeKey}
      onpointerdown={(event) => { resizing = true; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); }} ondblclick={() => { split = 50; }}><span></span></div>
    <FilePane side="right" active={active === 'right'} bind:this={right} onactivate={() => { active = 'right'; }} onswitch={switchPane} />
  </div>
  <footer class="app-footer"><div class="shortcuts"><span><kbd>Tab</kbd>Switch panel</span><span><kbd>↑</kbd><kbd>↓</kbd>Select</span><span><kbd>Enter</kbd>Open folder</span><span><kbd>⌫</kbd>Parent</span><span class="path-shortcut"><kbd>Ctrl / ⌘ L</kbd>Edit path</span></div><span class="local-status"><span></span>Local filesystem</span></footer>
</main>
{#if operation}
  {@const context = operation}
  <OperationDialog kind={context.kind} sourceName={context.kind === 'create' ? undefined : context.entry.name} sourceLocation={context.origin.label}
    destinationLocation={context.kind === 'copy' || context.kind === 'move' ? context.opposite?.label : undefined}
    execute={(name) => executeOperation(context, name)} oncancel={() => closeOperation(context)} oncomplete={(result) => closeOperation(context, result)} />
{/if}
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
  @media (max-width: 850px) { .path-shortcut, .local-status, .operation-actions button > span { display: none; } .workspace { margin: 0 10px; } .workspace-intro { padding: 0 16px; } .shortcuts { gap: 12px; } }
</style>
