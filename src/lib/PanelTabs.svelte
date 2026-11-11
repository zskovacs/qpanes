<script lang="ts">
  import { tick, untrack } from 'svelte';
  import FilePane, { type DragRequest, type DropState, type PaneSnapshot } from './FilePane.svelte';
  import Icon from './Icon.svelte';
  import type { NativePath } from './filesystem';
  import { cycleIndex, indexAfterClose, MAX_TABS, tabLabel, type PanelSession, type TabSeed } from './tabs';

  let { side, active, session, hints, dropState = null, draggingPath = null, onactivate, onswitch, onchange, onnotice, onfavorites, ondragrequest }: {
    side: 'left' | 'right'; active: boolean; session: PanelSession;
    hints: { newTab: string; closeTab: string; quickFilter: string; openFavorites: string };
    dropState?: DropState; draggingPath?: NativePath | null;
    onactivate: () => void; onswitch: () => void; onchange: () => void; onnotice: (message: string) => void;
    onfavorites: () => void; ondragrequest: (request: DragRequest) => void;
  } = $props();

  type Tab = { id: number; seed: TabSeed };
  let nextId = 1;
  // Each tab keeps its own mounted FilePane: listing, selection, sort, filter,
  // path draft and request sequencing survive switching without re-reading.
  const restored = untrack(() => session);
  let tabs = $state<Tab[]>(restored.tabs.map((seed) => ({ id: nextId++, seed: { ...seed } })));
  let activeId = $state(tabs[restored.activeTab]?.id ?? tabs[0].id);
  const panes: Record<number, FilePane | undefined> = {};
  let strip: HTMLDivElement;
  let activeIndex = $derived(tabs.findIndex((tab) => tab.id === activeId));
  const current = () => panes[activeId];

  export function focusList() { current()?.focusList(); }
  export function editPath() { current()?.editPath(); }
  export function openFilter() { void current()?.openFilter(); }
  export function openLocation(path: NativePath) { current()?.openLocation(path); }
  export function operationSnapshot(): PaneSnapshot | null { return current()?.operationSnapshot() ?? null; }
  /** Operation completions reach every mounted tab, including inactive ones. */
  export function refreshAffectedDirectories(paths: NativePath[], subtrees: NativePath[] = [], unknownChanges = false) {
    for (const tab of tabs) panes[tab.id]?.refreshAffectedDirectories(paths, subtrees, unknownChanges);
  }
  export function sessionState(): PanelSession {
    return { activeTab: Math.max(0, activeIndex), tabs: tabs.map((tab) => ({ ...tab.seed })) };
  }
  /** The current tab's committed (or restored) location; never a display label. */
  export function currentSeed(): TabSeed { return { ...tabs[Math.max(0, activeIndex)].seed }; }

  async function show(id: number, focus: boolean) {
    activeId = id;
    onchange();
    await tick();
    if (focus) focusList();
    strip?.querySelector<HTMLElement>(`[aria-selected="true"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** New tabs open the current directory (with its sort) after the current tab. */
  export function newTab(seed: TabSeed = currentSeed()): boolean {
    if (tabs.length >= MAX_TABS) { onnotice(`A panel can hold at most ${MAX_TABS} tabs.`); return false; }
    const tab = { id: nextId++, seed: { ...seed } };
    tabs.splice(activeIndex + 1, 0, tab);
    void show(tab.id, true);
    return true;
  }

  /** A panel always keeps one usable tab. */
  export function closeTab(id = activeId) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (tabs.length === 1) { onnotice('A panel always keeps at least one tab.'); return; }
    const wasActive = id === activeId;
    const count = tabs.length;
    // A clicked × focuses its tab button; hand focus over before it is removed.
    if (!wasActive && document.getElementById(`${side}-${id}-tab`)?.contains(document.activeElement)) focusList();
    tabs.splice(index, 1);
    // Right neighbour, else left; jobs and other tabs are untouched.
    if (wasActive) void show(tabs[indexAfterClose(count, index)].id, true);
    else onchange();
  }

  export function cycle(delta: number) {
    if (tabs.length < 2) return;
    void show(tabs[cycleIndex(tabs.length, activeIndex, delta)].id, true);
  }

  function updateSeed(tab: Tab, seed: TabSeed) {
    tab.seed = seed;
    onchange();
  }

  /** Roving focus within the tab strip (ARIA tabs pattern, automatic activation). */
  function tabKeydown(event: KeyboardEvent, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const moves: Record<string, number> = { ArrowLeft: cycleIndex(tabs.length, index, -1), ArrowRight: cycleIndex(tabs.length, index, 1), Home: 0, End: tabs.length - 1 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    event.stopPropagation();
    const id = tabs[moves[event.key]].id;
    void show(id, false).then(() => document.getElementById(`${side}-${id}-tab`)?.focus());
  }

  function tabClick(event: MouseEvent, id: number) {
    // The close glyph is part of the tab so the tablist owns only tabs.
    if ((event.target as Element).closest('[data-close-tab]')) closeTab(id);
    else void show(id, true);
  }
</script>

<section class={['pane', { active }]} aria-label={`${side} panel`} onfocusin={onactivate}>
  <header class="pane-heading">
    <div class="pane-label"><span class="pane-indicator"></span><h2>{side === 'left' ? 'Left panel' : 'Right panel'}</h2><span class="active-label">{active ? 'ACTIVE' : 'LOCAL'}</span></div>
    <div class="tab-strip" bind:this={strip} role="tablist" aria-label={`${side} tabs`}>
      {#each tabs as tab, index (tab.id)}
        <button role="tab" class={['tab', { current: tab.id === activeId }]} id={`${side}-${tab.id}-tab`} aria-selected={tab.id === activeId} aria-controls={`${side}-${tab.id}-panel`} aria-label={tabLabel(tab.seed)}
          tabindex={tab.id === activeId ? 0 : -1} title={`${tab.seed.location || tabLabel(tab.seed)}\nClose: ${hints.closeTab} or middle-click`}
          onclick={(event) => tabClick(event, tab.id)} onkeydown={(event) => tabKeydown(event, index)} onauxclick={(event) => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } }}>
          <Icon name="folder" size={12} /><span class="tab-name">{tabLabel(tab.seed)}</span>
          {#if tabs.length > 1}<span class="tab-close" data-close-tab aria-hidden="true">×</span>{/if}
        </button>
      {/each}
    </div>
    <button class="new-tab" aria-label={`${side}: new tab`} title={`New tab (${hints.newTab})`} onclick={() => newTab()}><Icon name="plus" size={14} /></button>
  </header>
  {#each tabs as tab (tab.id)}
    <FilePane bind:this={panes[tab.id]} {side} tabId={tab.id} {active} visible={tab.id === activeId} initial={tab.seed} {hints}
      dropState={tab.id === activeId ? dropState : null} draggingPath={tab.id === activeId ? draggingPath : null}
      {onswitch} {onfavorites} {ondragrequest} onlocation={(seed) => updateSeed(tab, seed)} />
  {/each}
</section>

<style>
  .pane { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; overflow: hidden; position: relative; container-type: inline-size; }
  .pane.active { border-color: var(--active-border); }
  .pane-heading { height: 45px; flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--border); background: var(--surface-raised); }
  .pane-label { display: flex; align-items: center; gap: 9px; white-space: nowrap; flex-shrink: 0; }
  h2 { margin: 0; font-size: 12px; font-weight: 600; }
  .pane-indicator { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .active .pane-indicator { background: var(--accent); }
  .active-label { color: var(--muted); font-size: 9px; font-weight: 600; letter-spacing: .08em; }
  .active .active-label { color: var(--accent); }
  .tab-strip { flex: 1; min-width: 0; display: flex; align-items: center; gap: 3px; overflow-x: auto; scrollbar-width: none; padding: 3px 1px; }
  .tab-strip::-webkit-scrollbar { display: none; }
  .tab { flex: 0 1 auto; min-width: 54px; max-width: 160px; height: 27px; display: flex; align-items: center; gap: 6px; padding: 0 6px 0 8px; border: 1px solid transparent; border-radius: 4px; color: var(--muted); font-size: 11px; white-space: nowrap; }
  .tab :global(svg) { flex-shrink: 0; color: var(--folder); opacity: .7; }
  .tab.current { color: var(--secondary); background: var(--background); border-color: var(--border); }
  .active .tab.current { color: var(--text); border-color: var(--active-border); box-shadow: inset 0 -2px 0 var(--accent); }
  .tab:focus-visible { outline-offset: -2px; }
  .tab-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tab-close { flex-shrink: 0; width: 16px; height: 16px; display: grid; place-items: center; border-radius: 3px; color: var(--muted); font-size: 13px; line-height: 1; visibility: hidden; }
  .tab.current .tab-close, .tab:hover .tab-close { visibility: visible; }
  .tab-close:hover { background: var(--hover); color: var(--text); }
  .new-tab { width: 27px; height: 27px; flex-shrink: 0; display: grid; place-items: center; color: var(--secondary); border-radius: 4px; }
  @container (max-width: 500px) { h2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); } }
  @container (max-width: 360px) {
    .active-label { font-size: 8px; }
    .pane-heading { height: 36px; padding-left: 10px; gap: 6px; }
    .tab { height: 24px; min-width: 44px; padding: 0 4px 0 6px; gap: 4px; }
    .tab :global(svg) { display: none; }
  }
</style>
