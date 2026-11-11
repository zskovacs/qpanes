<script module lang="ts">
  import { classifyOperationInvalidation } from './operations';
  import type { FileEntry, NativePath } from './filesystem';
  import type { TabSeed } from './tabs';
  export interface PaneSnapshot {
    path: NativePath;
    label: string;
    name: string;
    revision: number;
    entry: FileEntry | null;
  }
  /** A real file or directory row offered for dragging. `select` makes it the
   * pane selection and returns a fresh snapshot, or null if no longer valid. */
  export interface DragRequest { event: PointerEvent; entry: FileEntry; select: () => PaneSnapshot | null }
  export type DropState = 'valid' | 'invalid' | null;
</script>
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { listDirectory, sortDirectoryEntries, filesystemError, type DirectoryListing, type DirectoryTarget, type FilesystemError, type SortKey, type SortDirection } from './filesystem';
  import { filterKey, matchingIndices } from './filter';
  import { formatDate, formatSize, kindLabel } from './format';

  let { side, tabId, active, visible, initial, hints, dropState = null, draggingPath = null, onswitch, onlocation, onfavorites, ondragrequest }: {
    side: 'left' | 'right'; tabId: number; active: boolean; visible: boolean; initial: TabSeed;
    hints: { quickFilter: string; openFavorites: string };
    dropState?: DropState; draggingPath?: NativePath | null;
    onswitch: () => void; onlocation: (seed: TabSeed) => void; onfavorites: () => void; ondragrequest: (request: DragRequest) => void;
  } = $props();
  let listing = $state.raw<DirectoryListing | null>(null);
  let loading = $state(true);
  let sorting = $state(false);
  let error = $state<FilesystemError | null>(null);
  // A restored location stays visible while it loads or if it is unavailable.
  let draft = $state(untrack(() => initial.location));
  let sort = $state<SortKey>(untrack(() => initial.sort));
  let direction = $state<SortDirection>(untrack(() => initial.direction));
  let selectedIndex = $state(-1);
  let scrollTop = $state(0);
  // Hidden tabs report zero height; keep the last visible measurement.
  let height = $state(400);
  let note = $state('');
  let detailsOpen = $state(false);
  let filter = $state('');
  let filterOpen = $state(false);
  let listElement: HTMLDivElement;
  let pathInput: HTMLInputElement;
  let filterInput = $state<HTMLInputElement>();
  let detailsSummary: HTMLElement;
  let errorSummary = $state<HTMLElement>();
  let sequence = 0;
  let disposed = false;
  let started = false;
  let navigationRevision = 0;
  let draftRevision = 0;
  let editingPath = false;
  type NavigationIntent = { target: DirectoryTarget; selection?: string };
  let retryIntent: NavigationIntent = { target: { kind: 'home' } };
  const rowHeight = 32;
  const overscan = 8;
  const number = new Intl.NumberFormat();
  const viewId = $derived(`${side}-${tabId}`);
  // A parent action cannot be mistaken for a real FileEntry or sent to file IPC.
  type PaneRow = { kind: 'parent'; key: 'parent' } | { kind: 'entry'; key: string; entry: FileEntry };
  const entryKey = (path: NativePath) => `entry:${path}`;
  let entries = $derived(listing?.entries ?? []);
  // Normalized once per listing; filtering never re-reads the directory.
  let filterKeys = $derived(entries.map((entry) => filterKey(entry.name)));
  let matched = $derived(filter ? matchingIndices(filterKeys, filter).map((index) => entries[index]) : entries);
  let rows = $derived.by((): PaneRow[] => [
    ...(listing?.parent ? [{ kind: 'parent' as const, key: 'parent' as const }] : []),
    ...matched.map((entry): PaneRow => ({ kind: 'entry', key: entryKey(entry.path), entry })),
  ]);
  let selected = $derived(rows[selectedIndex]);
  let selectedEntry = $derived(selected?.kind === 'entry' ? selected.entry : undefined);
  let selectedName = $derived(selected?.kind === 'parent' ? '[..]' : selectedEntry?.name);
  let start = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  let end = $derived(Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + overscan));
  let visibleRows = $derived(rows.slice(start, end));
  let activeDescendant = $derived(selectedIndex >= start && selectedIndex < end ? `${viewId}-entry-${selectedIndex}` : undefined);
  let folders = $derived(entries.filter((entry) => entry.kind === 'directory').length);

  $effect(() => () => { disposed = true; sequence++; });

  // Restored inactive tabs load on first display; a shown tab re-applies its
  // logical scroll because a hidden element has no scroll box.
  $effect(() => {
    if (!visible) return;
    untrack(() => {
      if (!started) {
        started = true;
        void navigate(initial.path ? { kind: 'path', value: initial.path } : { kind: 'home' });
      }
      if (listElement) listElement.scrollTop = scrollTop;
    });
  });

  export function focusList() { listElement?.focus(); }
  export function editPath() { pathInput?.focus(); pathInput?.select(); }
  export function openLocation(path: NativePath) { void navigate({ kind: 'path', value: path }); }

  /** A parent action has no FileEntry and cannot enter an operation request. */
  export function operationSnapshot(): PaneSnapshot | null {
    if (!listing || loading || error || editingPath) return null;
    return { path: listing.path, label: listing.label, name: listing.name || listing.label, revision: navigationRevision, entry: selectedEntry ?? null };
  }

  export async function openFilter() {
    filterOpen = true;
    await tick();
    filterInput?.focus();
    filterInput?.select();
  }

  // Retain at most the displayed path and one in-flight navigation revision.
  let pendingOperationPath: NativePath | null = null;
  let pendingNavigationRefresh: number | null = null;
  export function refreshAffectedDirectories(paths: NativePath[], subtrees: NativePath[] = [], unknownChanges = false) {
    // A tab that has never been displayed reads fresh data when first shown.
    if (!started) return;
    // A history gap has no recoverable path set. Re-read only this pane's
    // current/arriving location through the existing deferred refresh guards.
    if (listing && (unknownChanges || paths.includes(listing.path))) pendingOperationPath = listing.path;
    if (loading && (unknownChanges || retryIntent.target.kind !== 'path' || paths.includes(retryIntent.target.value))) {
      // Typed/home targets are resolved by Rust. Conservatively re-read the
      // arriving canonical location if work finished during that request.
      pendingNavigationRefresh = sequence;
    }
    if (subtrees.length && !unknownChanges) void checkSubtreeInvalidation(subtrees);
    refreshPendingOperation();
  }

  async function checkSubtreeInvalidation(subtrees: NativePath[]) {
    const revision = navigationRevision;
    const request = sequence;
    const displayed = listing?.path;
    const target = loading && retryIntent.target.kind === 'path' ? retryIntent.target.value : undefined;
    const paths = [...new Set([displayed, target].filter((path): path is NativePath => path !== undefined))];
    if (!paths.length) return;
    try {
      const affected = await classifyOperationInvalidation(paths, [], subtrees);
      // A newer navigation already reads after the mutation. Never let an older
      // ancestry response refresh its former location or restore its selection.
      if (disposed || revision !== navigationRevision) return;
      for (let index = 0; index < paths.length; index++) {
        if (!affected[index]) continue;
        if (paths[index] === listing?.path) pendingOperationPath = paths[index];
        if (loading && request === sequence && paths[index] === target) pendingNavigationRefresh = sequence;
      }
      refreshPendingOperation();
    } catch (cause) {
      if (!disposed && revision === navigationRevision) error = filesystemError(cause);
    }
  }

  function refreshPendingOperation() {
    if (loading || editingPath || error || !listing) return;
    const affected = pendingOperationPath === listing.path || pendingNavigationRefresh === sequence;
    pendingOperationPath = null;
    pendingNavigationRefresh = null;
    if (affected) void navigate({ kind: 'path', value: listing.path }, selected?.key);
  }

  /** Select by key within the (possibly filtered) rows, else the first real entry, else `[..]`. */
  function selectKey(key: string | undefined) {
    const offset = listing?.parent ? 1 : 0;
    const match = key ? rows.findIndex((row) => row.key === key) : -1;
    selectedIndex = match >= 0 ? match : rows.length > offset ? offset : offset ? 0 : -1;
  }

  async function commitListing(result: DirectoryListing, request: number, selection?: string, pathRevision?: number) {
    // Sort preferences may change repeatedly while either IPC operation is pending.
    // Keep the destination and sort the returned data, never re-read the old path.
    while (request === sequence && (result.sort !== sort || result.direction !== direction)) {
      const requestedSort = sort;
      const requestedDirection = direction;
      const ordered = await sortDirectoryEntries(result.entries, requestedSort, requestedDirection);
      result = { ...result, entries: ordered, sort: requestedSort, direction: requestedDirection };
    }
    if (request !== sequence) return;
    listing = result;
    // A completed request must not erase a path the user started editing meanwhile.
    // Pure sorting leaves the path editor unchanged entirely.
    if (pathRevision !== undefined && (!editingPath || pathRevision === draftRevision)) {
      draft = result.label;
      editingPath = false;
    }
    selectKey(selection);
    scrollTop = 0;
    if (visible) listElement.scrollTop = 0;
    onlocation({ path: result.path, location: result.label, name: result.name || result.label, sort: result.sort, direction: result.direction });
    await tick();
    if (request === sequence) revealSelection();
  }

  async function navigate(target: DirectoryTarget, selection?: string) {
    // A filter belongs to the directory it was typed for; refreshes keep it.
    if (!(target.kind === 'path' && target.value === listing?.path)) clearFilter();
    started = true;
    navigationRevision++;
    const request = ++sequence;
    const pathRevision = draftRevision;
    // The displayed selection may belong to a different directory after failure.
    // Keep the complete intent for every retry, including repeated failures.
    retryIntent = { target, selection };
    loading = true;
    sorting = false;
    error = null;
    note = '';
    try {
      const result = await listDirectory({ target, sort, direction });
      await commitListing(result, request, selection, pathRevision);
    } catch (cause) {
      if (request !== sequence) return;
      error = filesystemError(cause);
      if (listing) { sort = listing.sort; direction = listing.direction; }
    } finally {
      if (request === sequence) {
        loading = false;
        refreshPendingOperation();
      }
    }
  }

  function retry() {
    // Transfer focus before the focused Retry button is removed. No delayed focus
    // restoration can steal focus after the user moves to another pane/control.
    focusList();
    void navigate(retryIntent.target, retryIntent.selection);
  }

  function cancelPathEdit() {
    editingPath = false;
    draft = listing?.label ?? untrack(() => initial.location);
    refreshPendingOperation();
    focusList();
  }

  function closeErrorDetails() {
    // Native details owns its open state. Closing directly also works before its
    // asynchronous toggle event has fired (e.g. fast Enter followed by Escape).
    const details = errorSummary?.parentElement as HTMLDetailsElement | undefined;
    if (details) details.open = false;
    errorSummary?.focus();
  }

  function errorDetailsKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); closeErrorDetails(); }
  }

  function sortFocusOut(event: FocusEvent) {
    const control = event.currentTarget as HTMLElement;
    // CSS hiding a focused control emits blur with no related target. Ordinary
    // focus moves (including pointer/splitter interaction) keep their owner.
    if (event.relatedTarget || control.getClientRects().length) return;
    const controls = control.closest('.columns');
    const equivalent = controls?.querySelector<HTMLElement>(
      control.classList.contains('column') ? 'select' : `[data-sort="${sort}"]`
    );
    if (equivalent?.getClientRects().length) equivalent.focus();
    else focusList();
  }

  function revealSelection() {
    if (selectedIndex < 0 || !listElement) return;
    const top = selectedIndex * rowHeight;
    let next = scrollTop;
    if (top < next) next = top;
    else if (top + rowHeight > next + height) next = top + rowHeight - height;
    if (!visible) { scrollTop = next; return; }
    listElement.scrollTop = next;
    scrollTop = listElement.scrollTop;
  }

  function select(index: number) {
    if (loading) return;
    selectedIndex = Math.max(0, Math.min(index, rows.length - 1));
    if (rows.length === 0) selectedIndex = -1;
    note = '';
    revealSelection();
  }

  function openSelected() {
    if (loading || !selected) return;
    if (selected.kind === 'parent') parent();
    else if (selected.entry.kind === 'directory') void navigate({ kind: 'path', value: selected.entry.path });
    else note = selected.entry.kind === 'symlink' ? 'Links are shown without following their targets.' : 'Select a folder to open it.';
  }

  function parent() {
    if (listing?.parent) void navigate({ kind: 'path', value: listing.parent }, entryKey(listing.path));
  }

  function refresh() {
    void navigate(listing ? { kind: 'path', value: listing.path } : retryIntent.target, selected?.key);
  }

  function changeSort(key: SortKey) {
    direction = sort === key && direction === 'ascending' ? 'descending' : 'ascending';
    sort = key;
    void reorder();
  }

  function reverseSort() {
    direction = direction === 'ascending' ? 'descending' : 'ascending';
    void reorder();
  }

  async function reorder() {
    // The active navigation/sort operation will apply these latest preferences.
    if (loading || !listing) return;
    const request = ++sequence;
    const selection = selected?.key;
    loading = true;
    sorting = true;
    try {
      await commitListing(listing, request, selection);
    } catch (cause) {
      if (request !== sequence) return;
      error = filesystemError(cause);
      if (listing) { sort = listing.sort; direction = listing.direction; }
    } finally {
      if (request === sequence) {
        loading = false;
        sorting = false;
        refreshPendingOperation();
      }
    }
  }

  function submitPath(event: SubmitEvent) {
    event.preventDefault();
    editingPath = false;
    // An unchanged lossy label is never reinterpreted as a native identifier,
    // including the remembered location of an unavailable restored tab.
    const restored = untrack(() => initial);
    const native = listing ? (draft === listing.label ? listing.path : null) : restored.path && draft === restored.location ? restored.path : null;
    void navigate(native ? { kind: 'path', value: native } : { kind: 'typed', value: draft });
    focusList();
  }

  function changeFilter(event: Event & { currentTarget: HTMLInputElement }) {
    // Keep a real entry that still matches; otherwise select the first match.
    const key = selected?.kind === 'entry' ? selected.key : undefined;
    filter = event.currentTarget.value;
    selectKey(key);
    note = '';
    revealSelection();
  }

  /** Clearing never strands focus: an owned filter input hands it to the list. */
  function clearFilter() {
    if (!filter && !filterOpen) return;
    if (filterInput && document.activeElement === filterInput) focusList();
    const key = selected?.key;
    filter = '';
    filterOpen = false;
    if (listing) { selectKey(key); revealSelection(); }
  }

  function closeFilter() {
    focusList();
    clearFilter();
  }

  function filterKeydown(event: KeyboardEvent) {
    const page = Math.max(1, Math.floor(height / rowHeight));
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFilter(); }
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); focusList(); openSelected(); }
    else if (moves[event.key]) { event.preventDefault(); event.stopPropagation(); select(selectedIndex + moves[event.key]); }
  }

  function rowPointerDown(event: PointerEvent, row: PaneRow) {
    // Only a real file or directory can be dragged; never the [..] action.
    if (row.kind !== 'entry' || (row.entry.kind !== 'file' && row.entry.kind !== 'directory')) return;
    if (event.button !== 0 || !event.isPrimary || (event.pointerType !== 'mouse' && event.pointerType !== 'pen')) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || loading || editingPath) return;
    const key = row.key;
    ondragrequest({ event, entry: row.entry, select: () => {
      const index = rows.findIndex((candidate) => candidate.key === key);
      if (index < 0 || loading) return null;
      select(index);
      return operationSnapshot();
    } });
  }

  function keydown(event: KeyboardEvent) {
    if (event.altKey && event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation(); detailsOpen = true; detailsSummary.focus(); return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); onswitch(); return; }
    const actions: Record<string, () => void> = {
      ArrowDown: () => select(selectedIndex + 1), ArrowUp: () => select(selectedIndex - 1),
      Home: () => select(0), End: () => select(rows.length - 1),
      PageDown: () => select(selectedIndex + Math.max(1, Math.floor(height / rowHeight))),
      PageUp: () => select(selectedIndex - Math.max(1, Math.floor(height / rowHeight))),
      Enter: openSelected, Backspace: parent,
    };
    if (filterOpen || filter) actions.Escape = closeFilter;
    if (actions[event.key]) { event.preventDefault(); event.stopPropagation(); actions[event.key](); }
  }
</script>

<div class={['pane-view', { active, 'drop-valid': dropState === 'valid', 'drop-invalid': dropState === 'invalid' }]} id={`${viewId}-panel`} role="tabpanel" aria-labelledby={`${viewId}-tab`} hidden={!visible} data-drop-side={visible ? side : undefined}>
  <div class="navigation">
    <button class="icon-button" aria-label={`${side}: parent directory`} title="Parent directory (Backspace)" disabled={!listing?.parent} onclick={() => { parent(); focusList(); }}><Icon name="up" /></button>
    <button class="icon-button" aria-label={`${side}: home directory`} title="Home directory" onclick={() => { void navigate({ kind: 'home' }); focusList(); }}><Icon name="home" /></button>
    <button class="icon-button" aria-label={`${side}: favorites`} title={`Favorites (${hints.openFavorites})`} onclick={onfavorites}><Icon name="star" /></button>
    <form class="path-form" onsubmit={submitPath}>
      <Icon name="folder" size={15} />
      <input bind:this={pathInput} bind:value={draft} oninput={() => { draftRevision++; editingPath = true; }} aria-label={`${side} directory path`} placeholder="Absolute directory path" spellcheck="false" autocomplete="off" title={draft}
        onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); cancelPathEdit(); } }} />
      <button class="path-go" type="submit" aria-label={`${side}: go to path`} title="Go to directory"><Icon name="chevron" size={14} /></button>
    </form>
    <button class="icon-button" aria-label={`${side}: refresh directory`} title="Refresh directory" onclick={refresh}><Icon name="refresh" /></button>
  </div>
  <div class="columns" aria-label={`${side} sorting`}>
    <div class="compact-sorting">
      <label>Sort <select aria-label={`${side} sort by`} value={sort} onchange={(event) => changeSort(event.currentTarget.value as SortKey)} onblur={sortFocusOut}>
        <option value="name">Name</option><option value="size">Size</option><option value="modified">Modified</option>
      </select></label>
      <button class="sort-direction" aria-label={`${side}: reverse sort direction`} title={`Sort ${direction}`} onclick={reverseSort} onblur={sortFocusOut}>{direction === 'ascending' ? '↑' : '↓'}</button>
    </div>
    {#each [{ key: 'name', label: 'Name' }, { key: 'size', label: 'Size' }, { key: 'modified', label: 'Modified' }] as column (column.key)}
      <button class={['column', column.key, { sorted: sort === column.key }]} data-sort={column.key} aria-label={`Sort ${side} by ${column.key}, ${sort === column.key ? direction : 'unsorted'}`} aria-pressed={sort === column.key} onclick={() => changeSort(column.key as SortKey)} onblur={sortFocusOut}>
        {column.label}<span class="sort-arrow">{sort === column.key ? direction === 'ascending' ? '↑' : '↓' : ''}</span>
      </button>
    {/each}
    <span class="type-heading">Type</span>
  </div>
  {#if filterOpen || filter}
    <div class="filter-bar" role="search" aria-label={`${side} quick filter`}>
      <Icon name="filter" size={14} />
      <input bind:this={filterInput} value={filter} oninput={changeFilter} onkeydown={filterKeydown} aria-label={`${side} filter names`} placeholder="Filter names in this folder" spellcheck="false" autocomplete="off" title={`Quick Filter (${hints.quickFilter}) · Escape clears`} />
      <span class="filter-count">{filter ? `${number.format(matched.length)} of ${number.format(entries.length)}` : ''}</span>
      <!-- Pointer affordance only: Escape clears from the keyboard, so Tab goes from the filter straight to its list. -->
      <button class="filter-clear" tabindex="-1" aria-label={`${side}: clear filter`} title="Clear filter (Escape)" onclick={closeFilter}>×</button>
    </div>
  {/if}
  {#if error}
    <div class="error-banner" role="alert">
      <Icon name="alert" />
      <div class="error-preview"><strong>Couldn’t read directory</strong><span title={error.message}>{error.message}</span></div>
      <details class="error-details">
        <summary bind:this={errorSummary} aria-label={`${side}: error details`} title="Full error details" onkeydown={errorDetailsKeydown}><Icon name="info" size={16} /></summary>
        <div class="error-card" role="dialog" aria-label={`${side} error details`} tabindex="-1" onkeydown={errorDetailsKeydown}>
          <div class="metadata-heading"><span>DIRECTORY ERROR</span><button aria-label={`${side}: close error details`} onclick={closeErrorDetails}>×</button></div>
          <p>{error.message}</p>
          {#if listing}<p class="error-location">Showing {listing.label}</p>{:else if draft}<p class="error-location">Location {draft}</p>{/if}
        </div>
      </details>
      <button class="retry" onclick={retry}>Retry</button>
    </div>
  {/if}
  {#if listing?.warnings.length}
    <div class="warning-banner" role="status">{listing.warnings.join(' · ')}</div>
  {/if}
  <div class="file-list" bind:this={listElement} bind:clientHeight={null, (value) => { if (value) height = value; }} role="listbox" aria-label={`${side} files`} aria-busy={loading} aria-activedescendant={activeDescendant} tabindex="0" onkeydown={keydown}
    onscroll={() => { if (visible) scrollTop = listElement.scrollTop; }}>
    <div class="virtual-space" role="presentation" style:height={`${rows.length * rowHeight}px`}>
      {#each visibleRows as row, offset (row.key)}
        {@const index = start + offset}
        <div id={`${viewId}-entry-${index}`} class={['file-row', { selected: index === selectedIndex, unavailable: row.kind === 'entry' && row.entry.kind === 'unknown', dragging: row.kind === 'entry' && row.entry.path === draggingPath }]} role="option" aria-label={row.kind === 'parent' ? '[..] Parent directory' : undefined} aria-selected={index === selectedIndex} aria-posinset={index + 1} aria-setsize={rows.length} tabindex="-1" style:top={`${index * rowHeight}px`}
          onclick={() => { select(index); focusList(); }} ondblclick={() => { select(index); openSelected(); }} onpointerdown={(event) => rowPointerDown(event, row)}
          onkeydown={keydown} title={row.kind === 'parent' ? 'Parent directory (Backspace)' : `${row.entry.name}${row.entry.metadataError ? `\n${row.entry.metadataError}` : ''}`}>
          {#if row.kind === 'parent'}
            <span class="entry-name"><span class="entry-icon directory"><Icon name="up" size={17} /></span><span class="filename">[..]</span></span>
            <span class="parent-hint">Parent directory</span>
          {:else}
          {@const entry = row.entry}
          <span class="entry-name"><span class={['entry-icon', entry.kind]}><Icon name={entry.kind === 'directory' ? 'folder' : entry.kind === 'symlink' ? 'link' : 'file'} size={17} /></span><span class="filename">{entry.name}</span>{#if entry.metadataError}<span class="metadata-warning" aria-label={entry.metadataError}>!</span>{/if}</span>
          <span class="entry-size" title={entry.size === null ? 'Size unavailable or not applicable' : `${entry.size.toLocaleString()} bytes`}>{formatSize(entry.size)}</span>
          <span class="entry-date" title={entry.modifiedMs === null ? 'Modification time unavailable' : new Date(entry.modifiedMs).toLocaleString()}>{formatDate(entry.modifiedMs)}</span>
          <span class="entry-type">{kindLabel[entry.kind]}</span>
          {/if}
        </div>
      {/each}
    </div>
    {#if !loading && !error && entries.length === 0}
      <div class={['list-state', { 'with-parent': !!listing?.parent }]}><Icon name="folder" size={30} /><strong>This folder is empty</strong><span>Go up a level or browse another path.</span></div>
    {:else if !loading && filter && matched.length === 0}
      <div class={['list-state', { 'with-parent': !!listing?.parent }]} role="status"><Icon name="filter" size={30} /><strong>No names match “{filter}”</strong><span>Press Escape to clear the filter.</span></div>
    {:else if !loading && error && !listing}
      <div class="list-state"><Icon name="alert" size={30} /><strong>Directory unavailable</strong><span>Enter an absolute path above or try Home.</span></div>
    {/if}
  </div>
  {#if loading}<div class="loading-strip" role="status">{sorting ? 'Sorting…' : 'Reading directory…'}</div>{/if}
  <footer class="pane-status">
    <span>{filter ? `${number.format(matched.length)} of ` : ''}{number.format(entries.length)} {entries.length === 1 ? 'item' : 'items'}<span class="status-divider">·</span>{number.format(folders)} {folders === 1 ? 'folder' : 'folders'}</span>
    <span class="selection-detail" title={selectedName}>{note || (selected?.kind === 'parent' ? 'Parent directory' : selectedEntry ? `${selectedEntry.name} · ${kindLabel[selectedEntry.kind]}` : 'No selection')}</span>
    <details class="selection-info" bind:open={detailsOpen}>
      <summary bind:this={detailsSummary} aria-label={`${side}: selection details`} title="Selection details (Alt+Enter)" onkeydown={(event) => { if (event.key === 'Escape') { event.preventDefault(); detailsOpen = false; focusList(); } }}><Icon name="info" size={16} /></summary>
      <div class="metadata-card" role="region" aria-label={`${side} selection details`}>
        <div class="metadata-heading"><span>SELECTION DETAILS</span><button aria-label={`${side}: close selection details`} onclick={() => { detailsOpen = false; focusList(); }}>×</button></div>
        <strong class="metadata-name">{selectedName ?? 'No selection'}</strong>
        {#if selected?.kind === 'parent'}<p>Parent directory · navigation only</p>
        {:else if selectedEntry}
          <dl><dt>Type</dt><dd>{kindLabel[selectedEntry.kind]}</dd>
            <dt>Size</dt><dd>{selectedEntry.size === null ? 'Not available / not applicable' : `${selectedEntry.size.toLocaleString()} bytes (${formatSize(selectedEntry.size)})`}</dd>
            <dt>Modified</dt><dd>{selectedEntry.modifiedMs === null ? 'Not available' : new Date(selectedEntry.modifiedMs).toLocaleString()}</dd></dl>
          {#if selectedEntry.metadataError}<p class="metadata-error">{selectedEntry.metadataError}</p>{/if}
        {:else}<p>This directory has no selected item.</p>{/if}
      </div>
    </details>
  </footer>
</div>

<style>
  .pane-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pane-view[hidden] { display: none; }
  .navigation { display: flex; align-items: center; gap: 3px; height: 51px; padding: 0 8px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
  .icon-button { width: 29px; height: 29px; flex-shrink: 0; display: grid; place-items: center; color: var(--secondary); border-radius: 4px; }
  .path-form { min-width: 0; height: 30px; margin: 0 3px; display: flex; gap: 7px; align-items: center; flex: 1; background: var(--background); border: 1px solid var(--border); border-radius: 4px; padding-left: 9px; color: var(--muted); }
  .path-form:focus-within { border-color: var(--accent); }
  input { flex: 1; width: 0; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-family: var(--mono); font-size: 11px; height: 100%; }
  .path-go { display: grid; place-items: center; width: 25px; height: 26px; flex-shrink: 0; }
  .columns, .file-row { display: grid; grid-template-columns: minmax(100px, 1fr) 76px 112px 60px; gap: 8px; align-items: center; padding: 0 14px; }
  .columns { height: 33px; flex-shrink: 0; background: var(--surface-raised); border-bottom: 1px solid var(--border); color: var(--muted); font-size: 10px; }
  .column { font-size: 10px; padding: 5px 0; text-align: left; display: flex; gap: 7px; align-items: center; }
  .column.size { justify-content: flex-end; }
  .column.sorted { color: var(--secondary); }
  .sort-arrow { color: var(--accent); }
  .compact-sorting { display: none; }
  .compact-sorting label { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
  .compact-sorting select { min-width: 0; flex: 1; border: 1px solid var(--border); border-radius: 3px; background: var(--background); color: var(--text); font: inherit; height: 25px; padding: 0 4px; }
  .sort-direction { flex-shrink: 0; width: 27px; height: 25px; color: var(--accent); border: 1px solid var(--border); border-radius: 3px; }
  .filter-bar { height: 31px; flex-shrink: 0; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 14px; border-bottom: 1px solid var(--border); background: var(--background); color: var(--accent); }
  .filter-bar:focus-within { box-shadow: inset 0 -1px 0 var(--accent); }
  .filter-count { color: var(--muted); font-size: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .filter-clear { width: 24px; height: 24px; flex-shrink: 0; color: var(--secondary); border-radius: 3px; font-size: 15px; }
  .file-list { flex: 1; min-height: 0; overflow: auto; position: relative; scrollbar-gutter: stable; outline: none; }
  .file-list:focus-visible { box-shadow: inset 0 0 0 1px var(--accent); }
  .drop-valid .file-list { box-shadow: inset 0 0 0 2px var(--accent); background: var(--selection); }
  .drop-invalid .file-list { box-shadow: inset 0 0 0 2px var(--warning); cursor: not-allowed; }
  .virtual-space { position: relative; }
  .file-row { position: absolute; width: 100%; height: 32px; font-size: 12px; user-select: none; border-left: 2px solid transparent; padding-left: 12px; cursor: default; }
  .file-row:hover { background: var(--hover); }
  .file-row.selected { background: var(--selection-inactive); border-left-color: var(--muted); }
  .active .file-row.selected { background: var(--selection); border-left-color: var(--accent); }
  .file-row.dragging { opacity: .55; outline: 1px dashed var(--accent); outline-offset: -2px; }
  .entry-name { display: flex; align-items: center; gap: 9px; min-width: 0; }
  .filename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entry-icon { color: #8594a9; flex-shrink: 0; display: flex; }
  .entry-icon.directory { color: var(--folder); }
  .entry-icon.symlink { color: var(--accent); }
  .entry-size, .entry-date, .entry-type { color: var(--secondary); font-size: 10px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .entry-size { text-align: right; font-family: var(--mono); }
  .entry-type { color: var(--muted); }
  .parent-hint { grid-column: 2 / -1; color: var(--muted); font-size: 10px; text-align: right; }
  .unavailable .filename, .metadata-warning { color: var(--warning); }
  .metadata-warning { margin-left: auto; }
  .pane-status { height: 33px; flex-shrink: 0; padding: 0 12px; display: flex; align-items: center; justify-content: space-between; gap: 9px; color: var(--muted); background: var(--surface-raised); border-top: 1px solid var(--border); font-size: 10px; white-space: nowrap; }
  .status-divider { padding: 0 6px; }
  .selection-detail { overflow: hidden; text-overflow: ellipsis; }
  .selection-info { margin-left: auto; flex-shrink: 0; }
  .selection-info summary { list-style: none; display: grid; place-items: center; height: 25px; width: 25px; cursor: pointer; border-radius: 3px; color: var(--secondary); }
  .selection-info summary::-webkit-details-marker { display: none; }
  .selection-info summary:hover, .selection-info[open] summary { color: var(--accent); background: var(--hover); }
  .metadata-card, .error-card { position: absolute; bottom: 39px; left: 8px; right: 8px; z-index: 2; max-height: calc(100% - 64px); overflow: auto; padding: 12px; background: var(--surface-raised); border: 1px solid var(--active-border); border-radius: 5px; box-shadow: 0 4px 20px #0005; white-space: normal; color: var(--text); font-size: 11px; }
  .metadata-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--secondary); font-size: 9px; letter-spacing: .08em; margin-bottom: 7px; }
  .metadata-heading button { font-size: 18px; padding: 0 5px; }
  .metadata-name { display: block; overflow-wrap: anywhere; font-size: 12px; }
  .metadata-card dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 12px; margin-bottom: 0; }
  .metadata-card dt { color: var(--secondary); }
  .metadata-card dd { margin: 0; overflow-wrap: anywhere; }
  .metadata-card p { margin-bottom: 0; }
  .metadata-error { color: var(--warning); overflow-wrap: anywhere; }
  .loading-strip { padding: 7px 14px; background: var(--selection); color: var(--accent); font-size: 11px; border-top: 1px solid var(--active-border); }
  .list-state { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 10px; color: var(--muted); text-align: center; padding: 20px; font-size: 11px; }
  .list-state strong { color: var(--secondary); font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
  .list-state.with-parent { top: 32px; }
  .error-banner { display: flex; flex-shrink: 0; height: 40px; max-height: 40px; align-items: center; gap: 7px; margin: 4px 6px; padding: 4px 7px; border: 1px solid #6d443b; border-radius: 4px; color: var(--warning); background: #2c201e; font-size: 11px; }
  .error-preview { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
  .error-preview strong, .error-preview span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error-preview strong { font-size: 10px; font-weight: 600; }
  .error-preview span { font-size: 10px; }
  .error-banner :global(svg), .error-details, .retry { flex-shrink: 0; }
  .retry { padding: 3px 6px; border: 1px solid #6d443b; border-radius: 3px; }
  .error-details summary { list-style: none; display: grid; place-items: center; width: 25px; height: 25px; cursor: pointer; border-radius: 3px; }
  .error-details summary::-webkit-details-marker { display: none; }
  .error-details summary:hover { background: var(--hover); }
  .error-card { z-index: 3; border-color: #6d443b; overflow-wrap: anywhere; }
  .error-card p { margin: 0 0 8px; }
  .error-location { color: var(--secondary); }
  .warning-banner { padding: 7px 14px; color: var(--warning); font-size: 11px; }
  @container (max-width: 500px) { .columns, .file-row { grid-template-columns: minmax(90px, 1fr) 65px 100px; gap: 6px; padding-right: 9px; } .entry-type, .type-heading { display: none; } }
  @container (max-width: 360px) {
    .file-row { grid-template-columns: minmax(75px, 1fr) 58px; }
    .columns { display: flex; padding: 0 9px; }
    .compact-sorting { display: flex; width: 100%; align-items: center; gap: 7px; }
    .column, .type-heading, .entry-date, .selection-detail { display: none; }
    .navigation { height: 44px; padding: 0 5px; gap: 1px; }
    /* Four navigation buttons must still leave a usable path field. */
    .icon-button { width: 25px; }
    .path-form { padding-left: 6px; margin: 0 2px; }
    .path-form > :global(svg) { display: none; }
    .list-state { padding: 8px; gap: 5px; }
    .list-state :global(svg) { display: none; }
    .filter-count { display: none; }
  }
</style>
