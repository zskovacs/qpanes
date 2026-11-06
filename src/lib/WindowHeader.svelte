<script lang="ts">
  import { onMount } from 'svelte';
  import { isTauri } from '@tauri-apps/api/core';
  import { getCurrentWindow, type Window } from '@tauri-apps/api/window';
  import Icon from './Icon.svelte';
  import { observeWindow } from './window-state';

  let { onreturnfocus }: { onreturnfocus: () => void } = $props();
  let native = $state(false);
  let macos = $state(false);
  let maximized = $state(false);
  let error = $state('');
  let appWindow: Window;
  let observer: ReturnType<typeof observeWindow>;

  function failed(reason: unknown) {
    console.error('Window control failed', reason);
    error = 'Window action unavailable. Try again.';
  }
  onMount(() => {
    if (!isTauri()) return;
    native = true;
    macos = /Macintosh|Mac OS X/.test(navigator.userAgent);
    appWindow = getCurrentWindow();
    observer = observeWindow(appWindow, (state) => { maximized = state.maximized; }, failed);
    return () => observer.dispose();
  });
  async function action(name: 'minimize' | 'toggleMaximize' | 'close') {
    error = '';
    try {
      await appWindow[name]();
      if (name === 'toggleMaximize') await observer.refresh();
    } catch (reason) { failed(reason); }
  }
  function keepFocus(event: MouseEvent) {
    if (event.button === 0) event.preventDefault();
  }
  function returnFocus(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); onreturnfocus(); }
  }
</script>

<header class={['app-header', { macos }]} data-tauri-drag-region={native ? '' : undefined}>
  <div class="brand"><span class="brand-mark"><Icon name="panels" size={20} /></span><h1>Qpanes</h1><span class="brand-divider"></span><span class="workspace-title">Local files</span></div>
  <span class="read-only"><Icon name="lock" size={12} />Local workspace</span>
  {#if native && !macos}
    <div class="window-controls" role="group" aria-label="Window controls">
      <button type="button" aria-label="Minimize window" title="Minimize" onmousedown={keepFocus} onkeydown={returnFocus} onclick={() => action('minimize')}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg></button>
      <button type="button" aria-label={maximized ? 'Restore window' : 'Maximize window'} title={maximized ? 'Restore' : 'Maximize'} onmousedown={keepFocus} onkeydown={returnFocus} onclick={() => action('toggleMaximize')}><svg viewBox="0 0 12 12" aria-hidden="true">{#if maximized}<path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7z" />{:else}<path d="M1.5 1.5h9v9h-9z" />{/if}</svg></button>
      <button type="button" class="close" aria-label="Close window" title="Close" onmousedown={keepFocus} onkeydown={returnFocus} onclick={() => action('close')}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg></button>
    </div>
  {/if}
</header>
{#if error}<p class="window-error" role="alert">{error}</p>{/if}

<style>
  .app-header { height: 61px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 23px; border-bottom: 1px solid var(--border); background: var(--surface); user-select: none; }
  .brand { display: flex; align-items: center; gap: 11px; pointer-events: none; }
  .macos .brand { margin-left: 72px; }
  .brand-mark { color: var(--accent); display: grid; place-items: center; width: 29px; height: 29px; background: var(--selection); border: 1px solid var(--active-border); border-radius: 7px; }
  h1 { font-size: 17px; font-weight: 650; letter-spacing: -.5px; margin: 0; }
  .brand-divider { height: 17px; width: 1px; background: var(--border); margin: 0 5px 0 8px; }
  .workspace-title { font-size: 12px; color: var(--secondary); }
  .read-only { display: flex; gap: 7px; align-items: center; color: var(--secondary); background: var(--surface-raised); border: 1px solid var(--border); border-radius: 20px; padding: 5px 9px; font-size: 10px; margin-left: auto; pointer-events: none; white-space: nowrap; }
  .window-controls { display: flex; align-self: stretch; margin-right: -23px; }
  .window-controls button { width: 44px; padding: 0; display: grid; place-items: center; }
  .window-controls button:focus-visible { outline-offset: -5px; }
  .window-controls svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1; }
  .window-controls .close:hover { background: #b83240; color: white; }
  .window-error { position: absolute; z-index: 10; top: 61px; right: 8px; margin: 0; padding: 8px; background: var(--surface-raised); color: var(--warning); border: 1px solid var(--border); font-size: 12px; }
  @media (max-width: 850px) { .app-header { padding: 0 16px; } .window-controls { margin-right: -16px; } }
</style>
