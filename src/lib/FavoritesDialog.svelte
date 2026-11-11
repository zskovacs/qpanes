<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import type { Favorite, FavoriteCandidate } from './favorites';
  import { probeDirectories, type DirectoryStatus } from './settings';

  let { side, favorites, current, persistent, problem = '', keys, onadd, onopen, onrename, onremove, onclose }: {
    side: 'left' | 'right'; favorites: Favorite[]; current: FavoriteCandidate | null; persistent: boolean; problem?: string;
    keys: { addFavorite: string };
    onadd: () => { favorite: Favorite; added: boolean } | { error: string } | null;
    onopen: (favorite: Favorite, newTab: boolean) => void;
    onrename: (id: string, label: string) => string | null;
    onremove: (id: string) => void;
    onclose: () => void;
  } = $props();
  const statusLabel: Record<Exclude<DirectoryStatus, 'available'>, string> = {
    missing: 'Missing', notDirectory: 'Not a folder', permissionDenied: 'No access', invalid: 'Not valid here', unreadable: 'Unavailable',
  };
  let dialog: HTMLDialogElement;
  let list = $state<HTMLUListElement>();
  let addButton: HTMLButtonElement;
  let closeButton: HTMLButtonElement;
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let renameError = $state('');
  let message = $state('');
  let statuses = $state<Record<string, DirectoryStatus>>({});
  const probing = new Set<string>();

  onMount(() => {
    dialog.showModal();
    void probe();
    const first = list?.querySelector<HTMLElement>('.favorite-open');
    (first ?? (current ? addButton : closeButton)).focus();
  });

  /** Availability is advisory; opening still lets the panel report its own error. */
  async function probe() {
    const pending = untrack(() => favorites).filter((favorite) => !(favorite.path in statuses) && !probing.has(favorite.path));
    if (!pending.length) return;
    for (const favorite of pending) probing.add(favorite.path);
    try {
      const result = await probeDirectories(pending.map((favorite) => favorite.path));
      pending.forEach((favorite, index) => { statuses[favorite.path] = result[index]; });
    } catch {
      // Unknown availability shows no badge; navigation reports real failures.
    } finally {
      for (const favorite of pending) probing.delete(favorite.path);
    }
  }

  function close() {
    if (dialog.open) dialog.close();
    onclose();
  }

  function rowButtons(): HTMLElement[] {
    return [...(list?.querySelectorAll<HTMLElement>('.favorite-open') ?? [])];
  }

  async function focusRow(index: number) {
    await tick();
    const buttons = rowButtons();
    (buttons[Math.min(index, buttons.length - 1)] ?? (current ? addButton : closeButton)).focus();
  }

  async function add() {
    const result = onadd();
    if (!result) return;
    if ('error' in result) { message = result.error; return; }
    message = result.added ? `Added “${result.favorite.label}”.` : `This folder is already in Favorites as “${result.favorite.label}”.`;
    void probe();
    await focusRow(favorites.findIndex((favorite) => favorite.id === result.favorite.id));
  }

  async function startRename(favorite: Favorite) {
    renaming = favorite.id;
    renameValue = favorite.label;
    renameError = '';
    await tick();
    const input = dialog.querySelector<HTMLInputElement>('.rename-input');
    input?.focus();
    input?.select();
  }

  async function finishRename(save: boolean) {
    const id = renaming;
    if (!id) return;
    if (save) {
      const error = onrename(id, renameValue);
      if (error) { renameError = error; return; }
      message = 'Favorite renamed. Its folder is unchanged.';
    }
    renaming = null;
    await focusRow(favorites.findIndex((favorite) => favorite.id === id));
  }

  async function remove(favorite: Favorite) {
    const index = favorites.findIndex((item) => item.id === favorite.id);
    onremove(favorite.id);
    message = `Removed “${favorite.label}” from Favorites. The folder itself is unchanged.`;
    await focusRow(index);
  }

  function rowKeydown(event: KeyboardEvent, favorite: Favorite, index: number) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const buttons = rowButtons();
    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: buttons.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      buttons[Math.max(0, Math.min(moves[event.key], buttons.length - 1))]?.focus();
    } else if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      onopen(favorite, true);
    } else if (event.key === 'F2') {
      event.preventDefault();
      void startRename(favorite);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      void remove(favorite);
    }
  }

  function renameKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void finishRename(false); }
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void finishRename(true); }
  }

  function dialogKeydown(event: KeyboardEvent) {
    // Closing is handled here, so a rename's own Escape never closes the dialog.
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }
</script>

<dialog bind:this={dialog} class="favorites-dialog" aria-labelledby="favorites-title" aria-describedby="favorites-help"
  oncancel={(event) => event.preventDefault()} onkeydown={dialogKeydown}>
  <div class="dialog-heading"><span>{side === 'left' ? 'LEFT' : 'RIGHT'} PANEL</span><h2 id="favorites-title">Favorites</h2></div>
  <div class="add-row">
    <button bind:this={addButton} class="add" disabled={!current} onclick={add} title={`Add current folder (${keys.addFavorite})`}><Icon name="star" size={14} />Add current folder</button>
    <span class="current-location" title={current?.location}>{current ? current.location : 'The panel has no folder to add yet.'}</span>
  </div>
  {#if message}<p class="message" role="status">{message}</p>{/if}
  {#if !persistent}<p class="message warning" role="alert">{problem || 'Settings are unavailable.'} Favorites changes last only for this session.</p>{/if}
  {#if favorites.length === 0}
    <p class="empty">No favorites yet. Add the current folder here or press {keys.addFavorite} in a panel.</p>
  {:else}
    <ul class="favorite-list" bind:this={list} aria-label="Favorite folders">
      {#each favorites as favorite, index (favorite.id)}
        {@const status = statuses[favorite.path]}
        <li class={['favorite', { unavailable: status && status !== 'available' }]}>
          {#if renaming === favorite.id}
            <div class="rename">
              <input class="rename-input" bind:value={renameValue} aria-label={`New name for ${favorite.label}`} aria-invalid={!!renameError} aria-describedby={renameError ? 'favorite-rename-error' : undefined}
                maxlength={400} spellcheck="false" autocomplete="off" onkeydown={renameKeydown} oninput={() => { renameError = ''; }} />
              <button onclick={() => finishRename(true)}>Save</button>
              <button onclick={() => finishRename(false)}>Cancel</button>
              {#if renameError}<span class="rename-error" id="favorite-rename-error" role="alert">{renameError}</span>{/if}
            </div>
          {:else}
            <button class="favorite-open" aria-label={`Open ${favorite.label}${status && status !== 'available' ? `, ${statusLabel[status]}` : ''}`} title={favorite.location}
              onclick={() => onopen(favorite, false)} onkeydown={(event) => rowKeydown(event, favorite, index)}>
              <Icon name="star" size={14} />
              <span class="favorite-text"><span class="favorite-label">{favorite.label}</span><span class="favorite-location">{favorite.location}</span></span>
              {#if status && status !== 'available'}<span class="favorite-status">{statusLabel[status]}</span>{/if}
            </button>
            <button class="row-action" aria-label={`Open ${favorite.label} in a new tab`} title="Open in new tab (Shift+Enter)" onclick={() => onopen(favorite, true)}><Icon name="tab" size={14} /></button>
            <button class="row-action" aria-label={`Rename ${favorite.label}`} title="Rename (F2)" onclick={() => startRename(favorite)}><Icon name="pencil" size={14} /></button>
            <button class="row-action" aria-label={`Remove ${favorite.label}`} title="Remove from Favorites (Delete)" onclick={() => remove(favorite)}>×</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <p class="keys" id="favorites-help">Enter opens here · Shift+Enter opens a new tab · F2 renames · Delete removes the favorite only · Esc closes</p>
  <div class="dialog-actions"><button bind:this={closeButton} onclick={close}>Close</button></div>
</dialog>

<style>
  .favorites-dialog { width: min(560px, calc(100vw - 40px)); max-height: calc(100dvh - 40px); padding: 21px 23px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 18px 70px #0008; overflow: auto; }
  .favorites-dialog::backdrop { background: #0008; }
  .dialog-heading > span { color: var(--muted); font-size: 9px; font-weight: 600; letter-spacing: .12em; }
  h2 { margin: 8px 0 14px; font-size: 18px; font-weight: 550; }
  button { border: 1px solid var(--border); border-radius: 4px; background: var(--surface-raised); color: var(--secondary); font-size: 11px; padding: 6px 10px; }
  .add-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .add { display: flex; align-items: center; gap: 6px; flex-shrink: 0; color: var(--accent); border-color: var(--active-border); }
  .current-location { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font: 10px var(--mono); }
  .message { margin: 10px 0 0; font-size: 11px; color: var(--secondary); overflow-wrap: anywhere; }
  .warning { color: var(--warning); }
  .empty { margin: 16px 0; color: var(--muted); font-size: 12px; }
  .favorite-list { list-style: none; margin: 14px 0 0; padding: 0; max-height: min(330px, 50dvh); overflow: auto; border: 1px solid var(--border); border-radius: 5px; }
  .favorite { display: flex; align-items: center; gap: 4px; padding: 4px; border-bottom: 1px solid var(--border); }
  .favorite:last-child { border-bottom: 0; }
  .favorite-open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 9px; border: 0; background: transparent; text-align: left; padding: 6px 7px; color: var(--folder); }
  .favorite-open:focus-visible { outline-offset: -2px; }
  .favorite-text { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
  .favorite-label { color: var(--text); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .favorite-location { color: var(--muted); font: 10px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .favorite-status { margin-left: auto; flex-shrink: 0; color: var(--warning); font-size: 10px; }
  .unavailable .favorite-label { color: var(--secondary); }
  .row-action { width: 28px; height: 28px; padding: 0; display: grid; place-items: center; flex-shrink: 0; border-color: transparent; background: transparent; font-size: 15px; }
  .rename { flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 3px; }
  .rename-input { flex: 1; min-width: 160px; padding: 7px 9px; border: 1px solid var(--accent); border-radius: 4px; background: var(--surface-raised); color: var(--text); font: 12px inherit; }
  .rename-input[aria-invalid='true'] { border-color: var(--danger, #e89191); }
  .rename-error { flex-basis: 100%; color: var(--danger, #e89191); font-size: 11px; }
  .keys { margin: 12px 0 0; color: var(--muted); font-size: 10px; line-height: 1.5; }
  .dialog-actions { display: flex; justify-content: flex-end; margin-top: 14px; }
</style>
