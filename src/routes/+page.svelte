<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import FilePane from '$lib/FilePane.svelte';
  import WindowHeader from '$lib/WindowHeader.svelte';
  import '$lib/app.css';
  let active = $state<'left' | 'right'>('left');
  let split = $state(50);
  let resizing = $state(false);
  let workspace: HTMLDivElement;
  let left: FilePane;
  let right: FilePane;
  afterNavigate(() => { left.focusList(); });
  function switchPane() {
    active = active === 'left' ? 'right' : 'left';
    (active === 'left' ? left : right).focusList();
  }
  function keyboard(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      (active === 'left' ? left : right).editPath();
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
  <div class="workspace-intro"><div><span class="eyebrow">WORKSPACE</span><span class="intro-description">Two panels. One flow.</span></div><span class="navigation-hint">Browse with your keyboard<span>↑ ↓</span></span></div>
  <div class="workspace" bind:this={workspace} style:--split={`${split}%`}>
    <FilePane side="left" active={active === 'left'} bind:this={left} onactivate={() => { active = 'left'; }} onswitch={switchPane} />
    <div class="splitter" role="slider" aria-label="Resize panels" aria-orientation="horizontal" aria-valuemin="30" aria-valuemax="70" aria-valuenow={Math.round(split)} aria-valuetext={`Left panel ${Math.round(split)} percent`} tabindex="0" onkeydown={resizeKey}
      onpointerdown={(event) => { resizing = true; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); }} ondblclick={() => { split = 50; }}><span></span></div>
    <FilePane side="right" active={active === 'right'} bind:this={right} onactivate={() => { active = 'right'; }} onswitch={switchPane} />
  </div>
  <footer class="app-footer"><div class="shortcuts"><span><kbd>Tab</kbd>Switch panel</span><span><kbd>↑</kbd><kbd>↓</kbd>Select</span><span><kbd>Enter</kbd>Open folder</span><span><kbd>⌫</kbd>Parent</span><span class="path-shortcut"><kbd>Ctrl / ⌘ L</kbd>Edit path</span></div><span class="local-status"><span></span>Local filesystem</span></footer>
</main>
<style>
  main { height: 100dvh; min-height: 320px; display: flex; flex-direction: column; }
  .workspace-intro { height: 59px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; flex-shrink: 0; }
  .workspace-intro > div { display: flex; align-items: center; gap: 15px; }
  .eyebrow { font-size: 9px; color: var(--secondary); letter-spacing: .12em; font-weight: 600; }
  .intro-description { font-size: 11px; color: var(--muted); }
  .navigation-hint { font-size: 10px; color: var(--muted); display: flex; align-items: center; gap: 9px; }
  .navigation-hint > span { letter-spacing: 3px; }
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
  @media (max-width: 850px) { .path-shortcut, .local-status, .navigation-hint { display: none; } .workspace { margin: 0 10px; } .workspace-intro { padding: 0 16px; } .shortcuts { gap: 12px; } }
</style>
