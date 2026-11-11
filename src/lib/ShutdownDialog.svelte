<script lang="ts">
  import { onMount } from 'svelte';
  import type { ShutdownAction } from './operations';

  let { shutdownState, activeCount, onaction, onreturnfocus, error = '' }: {
    shutdownState: 'idle' | 'draining' | 'blocked' | 'ready'; activeCount: number; onaction: (action: ShutdownAction) => Promise<void>; onreturnfocus?: () => void; error?: string;
  } = $props();
  let dialog: HTMLDialogElement;
  let keep: HTMLButtonElement;
  let busy = $state(false);
  let returnFocus: HTMLElement | null = null;
  let returnDialog: HTMLDialogElement | null = null;
  $effect.pre(() => {
    const state = shutdownState;
    const pending = busy;
    const focused = document.activeElement;
    if (!dialog?.open || !(focused instanceof HTMLButtonElement) || !dialog.contains(focused)) return;
    const action = focused.dataset.shutdownAction;
    if (!action) return;
    const available = action === 'keepWorking' || (action === 'forceExit' && state === 'blocked')
      || (action === 'cancelAndClose' && state === 'idle');
    // The dialog itself remains a focus owner while its controls change.
    // Moving before disable/removal avoids a BODY fallback during the drain.
    if (pending || !available) dialog.focus();
  });
  function focusTarget(target: HTMLElement | null): boolean {
    if (!target?.isConnected || target === document.body || target === document.documentElement || target.matches(':disabled')) return false;
    target.focus();
    return document.activeElement === target;
  }
  onMount(() => {
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A busy nameless dialog can already have lost its child focus to BODY.
    // Capture its native modal owner before opening our own top-layer dialog.
    returnDialog = returnFocus?.closest<HTMLDialogElement>('dialog[open]')
      ?? document.querySelector<HTMLDialogElement>('dialog:modal');
    dialog.showModal();
    keep.focus();
    return () => {
      const focused = document.activeElement;
      // Teardown/disabled controls can already have left focus on BODY.
      const restoreFocus = dialog.contains(focused) || focused === document.body || focused === document.documentElement;
      // Release modal inertness before restoring an underlying dialog or pane.
      dialog.close();
      if (!restoreFocus) return;
      if (focusTarget(returnFocus)) return;
      if (returnDialog?.isConnected && returnDialog.open) {
        for (const target of returnDialog.querySelectorAll<HTMLElement>('input, button, select, textarea, a[href], [tabindex]')) {
          if (focusTarget(target)) return;
        }
        if (focusTarget(returnDialog)) return;
      }
      onreturnfocus?.();
    };
  });
  async function action(value: ShutdownAction) {
    if (busy) return;
    busy = true;
    try { await onaction(value); } finally { busy = false; }
  }
</script>

<dialog bind:this={dialog} class="shutdown-dialog" aria-labelledby="shutdown-title" aria-describedby="shutdown-description"
  oncancel={(event) => { event.preventDefault(); void action('keepWorking'); }}>
  <h2 id="shutdown-title">Close QPanes?</h2>
  <div id="shutdown-description">
    {#if activeCount === 0}<p>All operations have finished.</p>
    {:else}<p>File operations are still queued or running. They cannot continue after QPanes exits.</p>{/if}
    {#if shutdownState === 'ready'}<p role="status">Closing QPanes… Any reported staging recovery locations still require manual review.</p>
    {:else if shutdownState === 'draining'}<p role="status">Cancelling queued operations and stopping the current copy safely…</p>
    {:else if shutdownState === 'blocked'}<p role="status">The current filesystem call has not finished. You can keep QPanes open or force exit. Force exit may leave staging data and an unknown operation outcome; inspect the source and destination before trying again.</p>
    {:else if activeCount === 0}<p>Close QPanes when you are ready. Any reported staging recovery locations still require manual review.</p>
    {:else}<p>Cancel and close requests safe cancellation, then waits briefly for operations to finish. Partial copy staging may remain for manual review.</p>{/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button bind:this={keep} data-shutdown-action="keepWorking" disabled={busy} onclick={() => action('keepWorking')}>Keep working</button>
    {#if shutdownState === 'blocked'}<button class="force" data-shutdown-action="forceExit" disabled={busy} onclick={() => action('forceExit')}>Force exit</button>
    {:else if shutdownState !== 'ready'}<button data-shutdown-action="cancelAndClose" disabled={busy || shutdownState === 'draining'} onclick={() => action('cancelAndClose')}>{activeCount === 0 && shutdownState === 'idle' ? 'Close QPanes' : 'Cancel and close'}</button>{/if}
  </div>
</dialog>

<style>
  .shutdown-dialog { width: min(440px, calc(100vw - 40px)); max-height: calc(100dvh - 40px); overflow: auto; padding: 23px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 18px 70px #0008; }
  .shutdown-dialog::backdrop { background: #0008; }
  h2 { margin: 0 0 17px; font-size: 18px; font-weight: 550; }
  p { font-size: 12px; line-height: 1.6; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
  button { padding: 8px 13px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-raised); color: var(--secondary); font-size: 11px; }
  button:disabled { opacity: .5; }
  .force, .error { color: var(--danger, #e89191); }
</style>
