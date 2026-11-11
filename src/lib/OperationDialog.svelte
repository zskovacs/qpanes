<script module lang="ts">
  export type OperationKind = 'create' | 'rename' | 'copy' | 'move' | 'trash';
</script>
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { filesystemError, type FilesystemError } from './filesystem';
  import type { OperationJob } from './operations';

  let { kind, sourceName, sourceLocation, destinationLocation, execute, oncomplete, oncancel }: {
    kind: OperationKind;
    sourceName?: string;
    sourceLocation: string;
    destinationLocation?: string;
    execute: (name: string) => Promise<OperationJob>;
    oncomplete: (result: OperationJob) => void;
    oncancel: () => void;
  } = $props();
  const titles: Record<OperationKind, string> = {
    create: 'Create directory', rename: 'Rename', copy: 'Copy', move: 'Move', trash: 'Move to Trash',
  };
  let title = $derived(titles[kind]);
  let hasName = $derived(kind === 'create' || kind === 'rename');
  let name = $state('');
  let busy = $state(false);
  let error = $state<FilesystemError | null>(null);
  let dialog: HTMLDialogElement;
  let nameInput = $state<HTMLInputElement>();
  let confirmButton: HTMLButtonElement;

  onMount(() => {
    name = kind === 'rename' ? sourceName ?? '' : '';
    dialog.showModal();
    if (hasName && nameInput) {
      // Apply the initial value before selecting; the state flush follows mount.
      nameInput.value = name;
      nameInput.focus();
      nameInput.select();
    }
    else confirmButton.focus();
  });

  function cancel() {
    if (busy) return;
    dialog.close();
    oncancel();
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (hasName && !name) {
      error = { code: 'invalidName', message: 'Enter a name.' };
      nameInput?.focus();
      return;
    }
    busy = true;
    error = null;
    try {
      const result = await execute(name);
      dialog.close();
      oncomplete(result);
    } catch (cause) {
      error = filesystemError(cause);
      busy = false;
      await tick();
      if (dialog.open) {
        if (hasName) nameInput?.focus();
        else confirmButton.focus();
      }
    } finally {
      busy = false;
    }
  }

  function keydown(event: KeyboardEvent) {
    // A held Enter must not repeat an operation after its first completion.
    if (event.key === 'Enter' && event.repeat) event.preventDefault();
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }
</script>

<dialog bind:this={dialog} class="operation-dialog" aria-labelledby="operation-title" aria-describedby="operation-description" aria-busy={busy}
  oncancel={(event) => { event.preventDefault(); cancel(); }} onkeydown={keydown}>
  <form onsubmit={submit}>
    <div class="dialog-heading"><span>FILE OPERATION</span><h2 id="operation-title">{title}</h2></div>
    <div id="operation-description">
      {#if kind === 'create'}
        <p>Create a new directory in this location.</p>
      {:else if kind === 'trash'}
        <p>Move <strong>{sourceName}</strong> to the operating system’s Trash?</p>
        <p class="dialog-note">You can restore it from Trash. QPanes will report an error if Trash is unavailable.</p>
      {:else}
        <p>{title} <strong>{sourceName}</strong>{kind === 'rename' ? '.' : ' to the opposite panel.'}</p>
      {/if}
      <dl>
        <dt>{kind === 'create' ? 'Location' : 'Source location'}</dt><dd>{sourceLocation}</dd>
        {#if destinationLocation}<dt>Destination location</dt><dd>{destinationLocation}</dd>{/if}
      </dl>
      {#if kind === 'copy' || kind === 'move'}<p class="dialog-note">Existing destinations will be rejected.</p>{/if}
    </div>
    {#if hasName}
      <label class="name-label" for="operation-name">{kind === 'create' ? 'Directory name' : 'New name'}</label>
      <input id="operation-name" bind:this={nameInput} bind:value={name} readonly={busy} autocomplete="off" spellcheck="false"
        aria-invalid={!!error} aria-describedby={error ? 'operation-error' : undefined} oninput={() => { error = null; }} />
    {/if}
    {#if error}<div class="operation-error" id="operation-error" role="alert"><strong>{error.code}</strong><span>{error.message}</span></div>{/if}
    {#if busy}<p class="busy-message" role="status">Submitting {title.toLowerCase()}…</p>{/if}
    <div class="dialog-actions">
      <button type="button" disabled={busy} onclick={cancel}>Cancel</button>
      <button bind:this={confirmButton} class="confirm" type="submit" disabled={busy}>{busy ? 'Submitting…' : title}</button>
    </div>
  </form>
</dialog>

<style>
  .operation-dialog { width: min(440px, calc(100vw - 40px)); max-height: calc(100dvh - 40px); padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 18px 70px #0008; overflow: auto; }
  .operation-dialog::backdrop { background: #0008; }
  form { padding: 23px; }
  .dialog-heading > span { color: var(--muted); font-size: 9px; font-weight: 600; letter-spacing: .12em; }
  h2 { margin: 8px 0 17px; font-size: 18px; font-weight: 550; }
  p { margin: 10px 0; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  strong { font-weight: 600; }
  .dialog-note { color: var(--muted); font-size: 11px; }
  dl { display: grid; gap: 5px; margin: 16px 0; }
  dt { margin-top: 4px; font-size: 10px; color: var(--muted); }
  dd { margin: 0; font: 11px/1.6 var(--mono); color: var(--secondary); overflow-wrap: anywhere; white-space: pre-wrap; }
  .name-label { display: block; margin: 18px 0 7px; font-size: 11px; color: var(--secondary); }
  input { box-sizing: border-box; width: 100%; padding: 9px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-raised); color: var(--text); font: 12px var(--mono); }
  input[aria-invalid='true'] { border-color: var(--danger, #e89191); }
  .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
  button { padding: 8px 13px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-raised); color: var(--secondary); font: inherit; font-size: 11px; cursor: pointer; }
  .confirm { color: var(--accent); border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: wait; }
  .operation-error { display: grid; gap: 5px; margin-top: 14px; padding: 10px; border: 1px solid var(--danger, #e89191); border-radius: 4px; color: var(--danger, #e89191); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
  .busy-message { color: var(--accent); font-size: 11px; }
</style>
