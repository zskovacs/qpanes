<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { comboFromEvent, defaultBindings, formatCombo, labelOf, shortcutDefinitions, type Bindings, type Platform, type ShortcutAction, type ShortcutProblem } from './shortcuts';

  let { platform, bindings, persistent, problem = '', onassign, onreset, onresetall, onclose }: {
    platform: Platform; bindings: Bindings; persistent: boolean; problem?: string;
    onassign: (action: ShortcutAction, combo: string) => ShortcutProblem | null;
    onreset: (action: ShortcutAction) => ShortcutProblem | null;
    onresetall: () => void;
    onclose: () => void;
  } = $props();
  const defaults = $derived(defaultBindings(platform));
  const groups = ['Files', 'Tabs', 'Navigation'] as const;
  const fixed = $derived([
    ['Tab / Shift+Tab', 'Switch panel / move focus'], ['↑ ↓ PgUp PgDn Home End', 'Move selection'], ['Enter / double-click', 'Open folder'],
    [platform === 'mac' ? '⌫' : 'Backspace', 'Parent folder'], [formatCombo(platform === 'mac' ? 'Meta+L' : 'Ctrl+L', platform), 'Edit path'],
    [formatCombo('Alt+Enter', platform), 'Selection details'], ['Esc', 'Close filter, dialog or path editing'],
  ]);
  let dialog: HTMLDialogElement;
  let capturing = $state<ShortcutAction | null>(null);
  let error = $state('');
  let message = $state('');

  onMount(() => {
    dialog.showModal();
    dialog.querySelector<HTMLElement>('.change')?.focus();
  });

  function close() {
    if (dialog.open) dialog.close();
    onclose();
  }

  function begin(event: MouseEvent, action: ShortcutAction) {
    (event.currentTarget as HTMLElement).focus();
    capturing = capturing === action ? null : action;
    error = '';
    message = capturing ? `Press the new shortcut for ${labelOf(action)}. Esc cancels.` : '';
  }

  /** While capturing, every key is consumed here and never reaches app shortcuts. */
  function captureKeydown(event: KeyboardEvent, action: ShortcutAction) {
    if (capturing !== action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      capturing = null; error = ''; message = `${labelOf(action)} is unchanged.`;
      return;
    }
    const combo = comboFromEvent(event);
    if (!combo) return; // A modifier alone: wait for the key.
    const result = onassign(action, combo);
    if (result) { error = result.message; return; }
    capturing = null;
    error = '';
    message = `${labelOf(action)} is now ${formatCombo(combo, platform)}.`;
  }

  async function reset(action: ShortcutAction) {
    capturing = null;
    const problem = onreset(action);
    if (problem) { error = `Cannot restore ${labelOf(action)}: ${problem.message} Change that action first.`; message = ''; return; }
    error = '';
    message = `${labelOf(action)} restored to ${formatCombo(defaults[action], platform)}.`;
    await tick();
    dialog.querySelector<HTMLElement>(`[data-change="${action}"]`)?.focus();
  }

  function resetAll() {
    onresetall();
    capturing = null;
    error = '';
    message = 'All shortcuts restored to their defaults.';
  }

  function dialogKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }
</script>

<dialog bind:this={dialog} class="shortcuts-dialog" aria-labelledby="shortcuts-title" oncancel={(event) => event.preventDefault()} onkeydown={dialogKeydown}>
  <div class="dialog-heading"><span>SETTINGS</span><h2 id="shortcuts-title">Keyboard shortcuts</h2></div>
  <p class="intro">Shortcuts work while a panel or toolbar has focus. They never run while you type in a field or a dialog is open, and file operations always ask for confirmation.</p>
  {#if !persistent}<p class="note warning" role="alert">{problem || 'Settings are unavailable.'} Changes last only for this session.</p>{/if}
  <div class="status" role="status">{message}</div>
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#each groups as group (group)}
    <h3>{group}</h3>
    <ul class="bindings">
      {#each shortcutDefinitions.filter((definition) => definition.group === group) as definition (definition.action)}
        {@const custom = bindings[definition.action] !== defaults[definition.action]}
        <li class={{ capturing: capturing === definition.action }}>
          <span class="action">{definition.label}</span>
          <kbd aria-label={`${definition.label} shortcut`}>{formatCombo(bindings[definition.action], platform)}</kbd>
          <button class="change" data-change={definition.action} aria-label={capturing === definition.action ? `Press new shortcut for ${definition.label}` : `Change ${definition.label} shortcut`}
            onclick={(event) => begin(event, definition.action)} onkeydown={(event) => captureKeydown(event, definition.action)} onblur={() => { if (capturing === definition.action) capturing = null; }}>
            {capturing === definition.action ? 'Press keys…' : 'Change'}
          </button>
          <button class="reset" aria-label={`Reset ${definition.label} shortcut`} title={`Default: ${formatCombo(defaults[definition.action], platform)}`} disabled={!custom} onclick={() => reset(definition.action)}>Reset</button>
        </li>
      {/each}
    </ul>
  {/each}
  <h3>Fixed</h3>
  <dl class="fixed">
    {#each fixed as [keys, description] (keys)}<dt><kbd>{keys}</kbd></dt><dd>{description}</dd>{/each}
  </dl>
  {#if platform === 'mac'}<p class="note">⌘W, ⌘Q, ⌘H and ⌘M belong to the macOS application menu.</p>{/if}
  <div class="dialog-actions">
    <button onclick={resetAll}>Restore defaults</button>
    <button class="confirm" onclick={close}>Done</button>
  </div>
</dialog>

<style>
  .shortcuts-dialog { width: min(520px, calc(100vw - 40px)); max-height: calc(100dvh - 40px); padding: 21px 23px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); box-shadow: 0 18px 70px #0008; overflow: auto; }
  .shortcuts-dialog::backdrop { background: #0008; }
  .dialog-heading > span { color: var(--muted); font-size: 9px; font-weight: 600; letter-spacing: .12em; }
  h2 { margin: 8px 0 10px; font-size: 18px; font-weight: 550; }
  h3 { margin: 16px 0 6px; color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
  .intro, .note { margin: 0 0 8px; color: var(--muted); font-size: 11px; line-height: 1.5; }
  .warning { color: var(--warning); }
  .status { min-height: 16px; color: var(--secondary); font-size: 11px; }
  .error { margin-top: 4px; color: var(--danger, #e89191); font-size: 11px; }
  .bindings { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 5px; }
  .bindings li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: 8px; padding: 5px 6px 5px 10px; border-bottom: 1px solid var(--border); font-size: 12px; }
  .bindings li:last-child { border-bottom: 0; }
  .bindings li.capturing { background: var(--selection); }
  .action { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  kbd { min-width: 22px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface-raised); color: var(--secondary); font: 10px var(--mono); text-align: center; white-space: nowrap; }
  button { border: 1px solid var(--border); border-radius: 4px; background: var(--surface-raised); color: var(--secondary); font-size: 11px; padding: 5px 9px; }
  .capturing .change { color: var(--accent); border-color: var(--accent); }
  .fixed { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; font-size: 11px; color: var(--secondary); }
  .fixed dt { margin: 0; }
  .fixed dd { margin: 0; align-self: center; }
  .dialog-actions { display: flex; justify-content: space-between; margin-top: 18px; }
  .confirm { color: var(--accent); border-color: var(--accent); }
</style>
