<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import PanelTabs from '$lib/PanelTabs.svelte';
  import type { DragRequest, PaneSnapshot } from '$lib/FilePane.svelte';
  import OperationDialog, { type DialogKind, type OperationKind, type TransferChoice } from '$lib/OperationDialog.svelte';
  import FavoritesDialog from '$lib/FavoritesDialog.svelte';
  import ShortcutsDialog from '$lib/ShortcutsDialog.svelte';
  import Icon from '$lib/Icon.svelte';
  import { onMount, tick } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { filesystemError, type FileEntry } from '$lib/filesystem';
  import OperationsPanel from '$lib/OperationsPanel.svelte';
  import ShutdownDialog from '$lib/ShutdownDialog.svelte';
  import { cancelOperation, classifyOperationInvalidation, dismissOperation, emptyOperations, isTerminal, observeOperations, operationClient, operationInvalidationGap, shutdownOperations, type OperationIntent, type OperationJob, type OperationsSnapshot, type ShutdownAction } from '$lib/operations';
  import { createSettingsWriter, loadSettings, saveSettings, type SettingsDocument } from '$lib/settings';
  import { restorePanel, type PanelSession } from '$lib/tabs';
  import { addFavorite, removeFavorite, renameFavorite, type Favorite, type FavoriteCandidate } from '$lib/favorites';
  import { actionFor, checkAssignment, comboFromEvent, defaultBindings, detectPlatform, formatCombo, isRepeatable, MAX_SHORTCUT_ENTRIES, persistedShortcuts, resolveBindings, suppressesWebviewDefault, type Bindings, type ShortcutAction } from '$lib/shortcuts';
  import WindowHeader from '$lib/WindowHeader.svelte';
  import '$lib/app.css';
  type Side = 'left' | 'right';
  const platform = detectPlatform();
  let active = $state<Side>('left');
  let split = $state(50);
  let resizing = $state(false);
  let workspace: HTMLDivElement;
  let left = $state<PanelTabs>();
  let right = $state<PanelTabs>();
  const panel = (side: Side) => side === 'left' ? left : right;
  type OperationContext = {
    owner: Side; origin: PaneSnapshot; opposite: PaneSnapshot | null;
  } & ({ kind: 'create' } | { kind: Exclude<DialogKind, 'create'>; entry: FileEntry });
  let operation = $state.raw<OperationContext | null>(null);
  let notice = $state('');
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

  // Settings: Rust validates and owns the file; this page owns the live state.
  let sessions = $state.raw<{ left: PanelSession; right: PanelSession } | null>(null);
  let favorites = $state.raw<Favorite[]>([]);
  let bindings = $state.raw<Bindings>(defaultBindings(platform));
  let persistent = $state(false);
  let settingsProblem = $state('');
  let favoritesSide = $state<Side | null>(null);
  let preservedShortcuts: Record<string, string> = {};
  let shortcutsOpen = $state(false);
  let lastSaveError = '';
  const writer = createSettingsWriter(saveSettings, (cause) => {
    const message = cause === null ? '' : filesystemError(cause).message;
    if (message && message !== lastSaveError) notice = `Settings could not be saved: ${message}`;
    lastSaveError = message;
  });
  const key = (action: ShortcutAction) => formatCombo(bindings[action], platform);
  let hints = $derived({ newTab: key('newTab'), closeTab: key('closeTab'), quickFilter: key('quickFilter'), openFavorites: key('openFavorites') });

  onMount(() => {
    void restoreSettings();
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
        // Every mounted tab, including inactive ones, checks its own location.
        left?.refreshAffectedDirectories([...affected], [...subtrees], missingInvalidations);
        right?.refreshAffectedDirectories([...affected], [...subtrees], missingInvalidations);
      }
    }, (cause) => { operationsError = filesystemError(cause).message; }, undefined, () => { operationsError = ''; });
    return () => { observer?.dispose(); clearTimeout(freshnessTimer); endDrag(); };
  });

  async function restoreSettings() {
    const loaded = await loadSettings();
    const resolved = resolveBindings(loaded.document.shortcuts, platform);
    const session = loaded.document.session;
    bindings = resolved.bindings;
    preservedShortcuts = resolved.preserved;
    favorites = loaded.document.favorites;
    active = session?.activeSide === 'right' ? 'right' : 'left';
    sessions = { left: restorePanel(session?.left), right: restorePanel(session?.right) };
    // Never save over a file that could not be read or preserved.
    persistent = loaded.status !== 'unavailable';
    settingsProblem = persistent ? '' : loaded.warnings[0] ?? 'Settings are unavailable.';
    const warnings = [...(loaded.quiet ? [] : loaded.warnings), ...resolved.warnings];
    if (warnings.length) notice = warnings.slice(0, 4).join(' ') + (warnings.length > 4 ? ` (${warnings.length - 4} more)` : '');
    await tick();
    // Initial focus after restore, unless the user already chose a control.
    if (!document.activeElement || document.activeElement === document.body) panel(active)?.focusList();
  }

  function buildSettings(): SettingsDocument {
    return {
      version: 1,
      favorites: favorites.map((favorite) => ({ ...favorite })),
      shortcuts: persistedShortcuts(preservedShortcuts, bindings, platform),
      session: { activeSide: active, left: left?.sessionState() ?? sessions!.left, right: right?.sessionState() ?? sessions!.right },
    };
  }
  function persist() {
    if (persistent && sessions) void writer.schedule(buildSettings);
  }
  function activate(side: Side) {
    if (active === side) return;
    active = side;
    persist();
  }

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
  const operationActions: { kind: OperationKind; action: ShortcutAction; label: string }[] = [
    { kind: 'rename', action: 'rename', label: 'Rename' }, { kind: 'copy', action: 'copy', label: 'Copy' },
    { kind: 'move', action: 'move', label: 'Move' }, { kind: 'create', action: 'createDirectory', label: 'New folder' },
    { kind: 'trash', action: 'trash', label: 'Trash' },
  ];
  afterNavigate(() => { panel(active)?.focusList(); });
  function switchPane() {
    activate(active === 'left' ? 'right' : 'left');
    panel(active)?.focusList();
  }

  /** The single shortcut dispatcher. Actions only open confirmations or change views. */
  function keyboard(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    const combo = comboFromEvent(event);
    const target = event.target instanceof Element ? event.target : null;
    if (operation || favoritesSide || shortcutsOpen || operations.closeRequested || target?.closest('dialog')) {
      if (suppressesWebviewDefault(combo, platform)) event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      panel(active)?.editPath();
      return;
    }
    const action = actionFor(bindings, combo);
    if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) {
      // Typing never triggers actions; only Quick Filter re-focuses its field.
      if (action === 'quickFilter') { event.preventDefault(); if (!event.repeat) runAction(action); }
      else if (suppressesWebviewDefault(combo, platform)) event.preventDefault();
      return;
    }
    if (!action) {
      if (suppressesWebviewDefault(combo, platform)) event.preventDefault();
      return;
    }
    event.preventDefault();
    if (event.repeat && !isRepeatable(action)) return;
    runAction(action);
  }

  function runAction(action: ShortcutAction) {
    // Nothing settings-backed can be edited before settings finish loading.
    if (!sessions) return;
    const current = panel(active);
    switch (action) {
      case 'copy': case 'move': case 'rename': case 'trash': startOperation(action); break;
      case 'createDirectory': startOperation('create'); break;
      case 'newTab': current?.newTab(); break;
      case 'closeTab': current?.closeTab(); break;
      case 'nextTab': current?.cycle(1); break;
      case 'previousTab': current?.cycle(-1); break;
      case 'quickFilter': current?.openFilter(); break;
      case 'addFavorite': addCurrentFavorite(active, false); break;
      case 'openFavorites': favoritesSide = active; break;
      case 'openShortcuts': shortcutsOpen = true; break;
    }
  }

  function startOperation(kind: OperationKind) {
    if (operation || operations.closeRequested || !operations.accepting) return;
    const origin = panel(active)?.operationSnapshot() ?? null;
    const opposite = panel(active === 'left' ? 'right' : 'left')?.operationSnapshot() ?? null;
    if (!origin) { notice = 'Wait for the panel to finish, or finish editing its path.'; return; }
    if (kind !== 'create' && !origin.entry) { notice = 'Select a real file or directory first.'; return; }
    if ((kind === 'copy' || kind === 'move') && !opposite) { notice = 'The destination panel must show an available directory.'; return; }
    notice = '';
    submission = null;
    const context = { owner: active, origin, opposite };
    operation = kind === 'create' ? { ...context, kind } : { ...context, kind, entry: origin.entry! };
  }

  function executeOperation(context: OperationContext, name: string, choice: TransferChoice | null): Promise<OperationJob> {
    let intent: OperationIntent;
    switch (context.kind) {
      case 'create': intent = { kind: 'create', parent: context.origin.path, name }; break;
      case 'rename': intent = { kind: 'rename', source: context.entry, name }; break;
      case 'trash': intent = { kind: 'trash', source: context.entry }; break;
      case 'copy': case 'move': intent = { kind: context.kind, source: context.entry, destination: context.opposite!.path }; break;
      case 'transfer':
        // Identities were captured at drop time; tab switches cannot redirect them.
        if (!choice) return Promise.reject({ code: 'invalidOperation', message: 'Choose Copy or Move.' });
        intent = { kind: choice, source: context.entry, destination: context.opposite!.path };
        break;
    }
    if (!client) return Promise.reject({ code: 'unavailable', message: 'Open QPanes in its desktop window to perform file operations.' });
    const submissionKey = JSON.stringify(intent);
    if (!submission || submission.key !== submissionKey) submission = { key: submissionKey, send: client.submission(intent) };
    return submission.send();
  }

  function closeOperation(context: OperationContext, job?: OperationJob) {
    operation = null;
    submission = null;
    panel(context.owner)?.focusList();
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

  // Favorites never touch filesystem contents; only the settings file changes.
  function candidate(side: Side): FavoriteCandidate | null {
    const snapshot = panel(side)?.operationSnapshot();
    return snapshot ? { path: snapshot.path, location: snapshot.label, name: snapshot.name } : null;
  }
  function addCurrentFavorite(side: Side, quiet: boolean) {
    const current = candidate(side);
    if (!current) { if (!quiet) notice = 'Wait for the panel to show a folder before adding it to Favorites.'; return null; }
    const result = addFavorite(favorites, current, crypto.randomUUID());
    if ('error' in result) { if (!quiet) notice = result.error; return result; }
    if (result.added) { favorites = result.list; persist(); }
    if (!quiet) notice = result.added ? `Added “${result.favorite.label}” to Favorites${persistent ? '' : ' for this session'}.` : `“${result.favorite.label}” is already in Favorites.`;
    return result;
  }
  async function closeFavorites(side: Side) {
    favoritesSide = null;
    await tick();
    panel(side)?.focusList();
  }
  async function openFavorite(side: Side, favorite: Favorite, newTab: boolean) {
    favoritesSide = null;
    activate(side);
    const target = panel(side);
    if (!target) return;
    if (newTab) {
      const { sort, direction } = target.currentSeed();
      // At the tab limit the panel reports a notice; keep focus usable once
      // the modal favorites dialog (which makes the page inert) is gone.
      if (!target.newTab({ path: favorite.path, location: favorite.location, name: favorite.label, sort, direction })) { await tick(); target.focusList(); }
    } else {
      target.openLocation(favorite.path);
      await tick();
      target.focusList();
    }
  }
  function assignShortcut(action: ShortcutAction, combo: string) {
    const problem = checkAssignment(bindings, action, combo, platform);
    if (problem) return problem;
    const next = { ...bindings, [action]: combo };
    // Never trim stored entries (e.g. from another QPanes version) to make room.
    if (Object.keys(persistedShortcuts(preservedShortcuts, next, platform)).length > MAX_SHORTCUT_ENTRIES) {
      const kept = Object.keys(preservedShortcuts).length;
      return { kind: 'invalid' as const, message: `Settings already hold the maximum of ${MAX_SHORTCUT_ENTRIES} shortcut entries${kept ? `, including ${kept} from another QPanes version` : ''}. Reset a custom shortcut first.` };
    }
    bindings = next;
    persist();
    return null;
  }
  /** Restoring a default can never create a second binding for one combination. */
  function resetShortcut(action: ShortcutAction) {
    const problem = checkAssignment(bindings, action, defaultBindings(platform)[action], platform);
    if (problem) return problem;
    bindings = { ...bindings, [action]: defaultBindings(platform)[action] };
    persist();
    return null;
  }
  async function closeShortcuts() {
    shortcutsOpen = false;
    await tick();
    panel(active)?.focusList();
  }

  // Internal drag and drop. A drop only opens the Copy/Move/Cancel dialog.
  type DragSession = {
    pointerId: number; side: Side; entry: FileEntry; select: () => PaneSnapshot | null; source: Element;
    startX: number; startY: number; started: boolean; origin: PaneSnapshot | null; ownsFocus: boolean;
    x: number; y: number; over: Side | null; verdict: 'valid' | 'invalid' | null; reason: string; destinationName: string;
  };
  let drag = $state.raw<DragSession | null>(null);
  const blocked = () => !!(operation || favoritesSide || shortcutsOpen || operations.closeRequested || !operations.accepting);

  function dragRequest(side: Side, request: DragRequest) {
    const source = (request.event.target as Element | null)?.closest('.file-list');
    if (drag || blocked() || !source) return;
    drag = { pointerId: request.event.pointerId, side, entry: request.entry, select: request.select, source,
      startX: request.event.clientX, startY: request.event.clientY, started: false, origin: null, ownsFocus: false,
      x: request.event.clientX, y: request.event.clientY, over: null, verdict: null, reason: '', destinationName: '' };
    // Capture phase: runs before list handlers that stop propagation.
    window.addEventListener('keydown', dragKey, true);
  }
  function dropTarget(session: DragSession, x: number, y: number): Pick<DragSession, 'over' | 'verdict' | 'reason' | 'destinationName'> {
    const none = { over: null, verdict: null, reason: '', destinationName: '' };
    // Only the opposite panel's displayed directory is a target: not its tab
    // strip, not the header drag region, not the source panel.
    const side = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-side]')?.dataset.dropSide;
    if ((side !== 'left' && side !== 'right') || side === session.side || !session.origin) return none;
    const destination = panel(side)?.operationSnapshot();
    if (!destination) return { over: side, verdict: 'invalid', reason: 'The destination panel is busy or unavailable.', destinationName: '' };
    if (destination.path === session.origin.path) return { over: side, verdict: 'invalid', reason: 'The item is already in this folder.', destinationName: destination.name };
    if (destination.path === session.entry.path) return { over: side, verdict: 'invalid', reason: 'A folder cannot be copied or moved into itself.', destinationName: destination.name };
    return { over: side, verdict: 'valid', reason: '', destinationName: destination.name };
  }
  function dragMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if ((event.buttons & 1) === 0) { endDrag(); return; }
    let session = drag;
    if (!session.started) {
      if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < 6) return;
      const origin = blocked() ? null : session.select();
      if (!origin || origin.entry?.path !== session.entry.path) { endDrag(); return; }
      try { session.source.setPointerCapture(event.pointerId); } catch { /* A pointer that is not active cannot be captured; window listeners still observe it. */ }
      session.source.addEventListener('lostpointercapture', endDrag);
      // Pointerdown focused the pressed row, so the drag owns its list's focus.
      session = { ...session, started: true, origin, ownsFocus: session.source.contains(document.activeElement) };
    }
    drag = { ...session, x: event.clientX, y: event.clientY, ...dropTarget(session, event.clientX, event.clientY) };
  }
  function dragUp(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const session = drag;
    const target = session.started ? dropTarget(session, event.clientX, event.clientY) : null;
    endDrag();
    if (!session.started || !target?.over) return;
    if (target.verdict !== 'valid') { notice = target.reason; return; }
    void confirmDrop(session, target.over);
  }
  function endDrag() {
    const session = drag;
    drag = null;
    window.removeEventListener('keydown', dragKey, true);
    if (!session) return;
    session.source.removeEventListener('lostpointercapture', endDrag);
    // A drag never produces the click that normally hands a pressed row's focus
    // to its list. Recover it when the row still holds focus or was removed by a
    // refresh (focus fell to BODY); never override a newer focus owner.
    const list = session.source as HTMLElement;
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || (focused !== list && list.contains(focused));
    if (session.started && session.ownsFocus && lost && list.isConnected) list.focus();
    try { if (session.source.hasPointerCapture(session.pointerId)) session.source.releasePointerCapture(session.pointerId); } catch { /* already released */ }
  }
  function dragKey(event: KeyboardEvent) {
    if (!drag || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) return;
    const started = drag.started;
    endDrag();
    // Escape only cancels; other keys keep their usual meaning afterwards.
    if (event.key === 'Escape' && started) { event.preventDefault(); event.stopPropagation(); }
  }
  async function confirmDrop(session: DragSession, side: Side) {
    // Capture both identities at drop time, before any asynchronous check.
    const destination = panel(side)?.operationSnapshot() ?? null;
    const origin = session.origin;
    const entry = session.entry;
    if (blocked() || !origin) { notice = 'Finish the open dialog or shutdown before dropping.'; return; }
    if (!destination) { notice = 'The destination panel must show an available directory.'; return; }
    if (entry.kind === 'directory') {
      try {
        const [inside] = await classifyOperationInvalidation([destination.path], [], [entry.path]);
        if (inside) { notice = 'A folder cannot be copied or moved into itself or one of its subfolders.'; return; }
      } catch (cause) {
        notice = `The drop target could not be checked, so nothing was changed. ${filesystemError(cause).message}`;
        return;
      }
    }
    if (blocked()) return;
    notice = '';
    submission = null;
    operation = { kind: 'transfer', owner: session.side, origin: { ...origin, entry }, opposite: destination, entry };
  }
</script>
<svelte:head><title>Qpanes · Local files</title><meta name="description" content="A fast, keyboard-first dual-pane file manager." /></svelte:head>
<svelte:window onkeydown={keyboard} onpointermove={(event) => { resize(event); dragMove(event); }} onpointerup={(event) => { resizing = false; dragUp(event); }} onpointercancel={() => { resizing = false; endDrag(); }} onblur={endDrag} />
<main class={{ resizing, dragging: drag?.started, 'drag-invalid': drag?.started && drag.verdict === 'invalid' }}>
  <WindowHeader onreturnfocus={() => panel(active)?.focusList()} />
  <div class="workspace-intro"><div><span class="eyebrow">WORKSPACE</span><span class="intro-description">Two panels. One flow.</span></div><div class="operation-actions" aria-label="File operations">
    {#each operationActions as action (action.kind)}<button title={`${action.label} (${key(action.action)})`} aria-label={action.label} disabled={!operations.accepting || operations.closeRequested} onclick={() => startOperation(action.kind)}><kbd>{key(action.action)}</kbd><span>{action.label}</span></button>{/each}
  </div></div>
  <div class="workspace" bind:this={workspace} style:--split={`${split}%`}>
    {#if sessions}
      <PanelTabs side="left" active={active === 'left'} bind:this={left} session={sessions.left} {hints} dropState={drag?.started && drag.over === 'left' ? drag.verdict : null} draggingPath={drag?.started && drag.side === 'left' ? drag.entry.path : null}
        onactivate={() => activate('left')} onswitch={switchPane} onchange={persist} onnotice={(message) => { notice = message; }} onfavorites={() => { favoritesSide = 'left'; }} ondragrequest={(request) => dragRequest('left', request)} />
    {:else}<div class="pane-placeholder" aria-hidden="true"></div>{/if}
    <div class="splitter" role="slider" aria-label="Resize panels" aria-orientation="horizontal" aria-valuemin="30" aria-valuemax="70" aria-valuenow={Math.round(split)} aria-valuetext={`Left panel ${Math.round(split)} percent`} tabindex="0" onkeydown={resizeKey}
      onpointerdown={(event) => { resizing = true; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); }} ondblclick={() => { split = 50; }}><span></span></div>
    {#if sessions}
      <PanelTabs side="right" active={active === 'right'} bind:this={right} session={sessions.right} {hints} dropState={drag?.started && drag.over === 'right' ? drag.verdict : null} draggingPath={drag?.started && drag.side === 'right' ? drag.entry.path : null}
        onactivate={() => activate('right')} onswitch={switchPane} onchange={persist} onnotice={(message) => { notice = message; }} onfavorites={() => { favoritesSide = 'right'; }} ondragrequest={(request) => dragRequest('right', request)} />
    {:else}<div class="pane-placeholder" aria-hidden="true"></div>{/if}
  </div>
  <OperationsPanel jobs={operations.jobs} {freshProgress} error={operationsError} actionError={operationActionError} onclearerror={() => { operationActionError = '';}} oncancel={(id) => jobAction('cancel', id)} onretry={(id) => jobAction('retry', id)} ondismiss={(id) => jobAction('dismiss', id)} onrefresh={() => { void observer?.refresh(); }} />
  <footer class="app-footer"><div class="shortcuts"><span><kbd>Tab</kbd>Switch panel</span><span><kbd>↑</kbd><kbd>↓</kbd>Select</span><span><kbd>Enter</kbd>Open folder</span><span><kbd>⌫</kbd>Parent</span><span class="path-shortcut"><kbd>Ctrl / ⌘ L</kbd>Edit path</span><span class="path-shortcut"><kbd>{hints.quickFilter}</kbd>Filter</span></div>
    <div class="footer-end"><span class="local-status"><span></span>Local filesystem</span><button class="shortcuts-button" disabled={!sessions} title={`Keyboard shortcuts (${key('openShortcuts')})`} onclick={() => { shortcutsOpen = true; }}><Icon name="keyboard" size={14} />Shortcuts</button></div></footer>
</main>
{#if drag?.started}
  <div class={['drag-ghost', drag.verdict]} style:left={`${drag.x + 14}px`} style:top={`${drag.y + 14}px`} aria-hidden="true">
    <Icon name={drag.entry.kind === 'directory' ? 'folder' : 'file'} size={14} /><strong>{drag.entry.name}</strong>
    <span>{drag.verdict === 'valid' ? `Drop into ${drag.destinationName} to choose Copy or Move` : drag.verdict === 'invalid' ? drag.reason : 'Drag onto the other panel · Esc cancels'}</span>
  </div>
{/if}
{#if operation}
  {@const context = operation}
  <OperationDialog kind={context.kind} sourceName={context.kind === 'create' ? undefined : context.entry.name} sourceLocation={context.origin.label}
    destinationLocation={context.kind === 'copy' || context.kind === 'move' || context.kind === 'transfer' ? context.opposite?.label : undefined}
    execute={(name, choice) => executeOperation(context, name, choice)} oncancel={() => closeOperation(context)} oncomplete={(result) => closeOperation(context, result)} />
{/if}
{#if favoritesSide}
  {@const side = favoritesSide}
  <FavoritesDialog {side} {favorites} current={candidate(side)} {persistent} problem={settingsProblem} keys={{ addFavorite: key('addFavorite') }}
    onadd={() => addCurrentFavorite(side, true)} onopen={(favorite, newTab) => openFavorite(side, favorite, newTab)}
    onrename={(id, label) => { const result = renameFavorite(favorites, id, label); if ('error' in result) return result.error; favorites = result.list; persist(); return null; }}
    onremove={(id) => { favorites = removeFavorite(favorites, id); persist(); }} onclose={() => closeFavorites(side)} />
{/if}
{#if shortcutsOpen}
  <ShortcutsDialog {platform} {bindings} {persistent} problem={settingsProblem} onassign={assignShortcut}
    onreset={resetShortcut}
    onresetall={() => { bindings = defaultBindings(platform); persist(); }} onclose={closeShortcuts} />
{/if}
{#if operations.closeRequested}<ShutdownDialog activeCount={operations.jobs.filter((job) => !isTerminal(job)).length} shutdownState={operations.shutdownState} onaction={shutdown} onreturnfocus={() => panel(active)?.focusList()} error={shutdownError} />{/if}
{#if notice}<div class="operation-notice" role="status"><span>{notice}</span><button aria-label="Dismiss operation message" onclick={() => { notice = ''; }}>×</button></div>{/if}
<style>
  main { height: 100dvh; min-height: 320px; display: flex; flex-direction: column; }
  main.dragging { cursor: grabbing; user-select: none; }
  main.drag-invalid { cursor: not-allowed; }
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
  .pane-placeholder { border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
  .splitter { display: grid; place-items: center; cursor: col-resize; outline-offset: -1px; touch-action: none; }
  .splitter > span { width: 2px; height: 30px; border-radius: 2px; background: var(--border); }
  .splitter:hover > span, .splitter:focus-visible > span, .resizing .splitter > span { background: var(--accent); }
  .resizing { cursor: col-resize; user-select: none; }
  .app-footer { height: 44px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 0 22px; font-size: 10px; color: var(--muted); }
  .shortcuts { display: flex; align-items: center; gap: 17px; min-width: 0; overflow: hidden; }
  .shortcuts > span { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
  kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 19px; padding: 0 4px; border: 1px solid var(--border); border-radius: 3px; color: var(--secondary); background: var(--surface-raised); font: 9px var(--mono); }
  .footer-end { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
  .local-status { white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  .local-status > span { width: 5px; height: 5px; background: var(--accent); border-radius: 50%; }
  .shortcuts-button { display: flex; align-items: center; gap: 5px; padding: 4px 6px; border-radius: 3px; color: var(--muted); font-size: 10px; white-space: nowrap; }
  .drag-ghost { position: fixed; z-index: 20; pointer-events: none; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 2px 7px; max-width: 320px; padding: 7px 10px; border: 1px solid var(--active-border); border-radius: 5px; background: var(--surface-raised); box-shadow: 0 6px 22px #0007; color: var(--folder); font-size: 11px; }
  .drag-ghost strong { color: var(--text); font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .drag-ghost span { grid-column: 1 / -1; color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
  .drag-ghost.valid { border-color: var(--accent); }
  .drag-ghost.valid span { color: var(--accent); }
  .drag-ghost.invalid { border-color: var(--warning); }
  .drag-ghost.invalid span { color: var(--warning); }
  @media (max-height: 600px) { .workspace-intro { height: 43px; } .app-footer { height: 30px; } }
  @media (max-width: 850px) { .path-shortcut, .local-status, .operation-actions button > span { display: none; } .workspace { margin: 0 10px; } .workspace-intro { padding: 0 16px; } .shortcuts { gap: 12px; } }
</style>
