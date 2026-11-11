<script lang="ts">
  import { formatSize } from './format';
  import { isTerminal, operationLabel, progressPercent, stateLabel, type OperationJob } from './operations';

  let { jobs, freshProgress = [], error = '', actionError = '', oncancel, onretry, ondismiss, onrefresh, onclearerror }: {
    jobs: OperationJob[]; freshProgress?: string[]; error?: string; actionError?: string;
    oncancel: (id: string) => Promise<void>; onretry: (id: string) => Promise<void>;
    ondismiss: (id: string) => Promise<void>; onrefresh: () => void; onclearerror: () => void;
  } = $props();
  let expanded = $state(false);
  let pending = $state<string[]>([]);
  let toggle: HTMLButtonElement;
  let active = $derived(jobs.filter((job) => !isTerminal(job)));
  let queued = $derived(active.filter((job) => job.state === 'queued').length);
  let current = $derived(active.find((job) => job.state !== 'queued'));
  let failures = $derived(jobs.filter((job) => job.state === 'failed').length);
  let summary = $derived(active.length ? `${active.length - queued} active · ${queued} queued` : failures ? `${failures} failed · ${jobs.length} in history` : jobs.length ? `${jobs.length} in history` : 'No operations');

  // Inspect ownership before Svelte removes/disables an action. This effect
  // does nothing for normal progress or focus anywhere outside this panel.
  $effect.pre(() => {
    const currentJobs = jobs;
    const connectionError = error;
    const currentActionError = actionError;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLButtonElement) || !toggle?.parentElement?.contains(focused)) return;
    const action = focused.dataset.operationAction;
    if (!action) return;
    const id = focused.closest<HTMLElement>('[data-operation-id]')?.dataset.operationId;
    const job = currentJobs.find((item) => item.id === id);
    const available = action === 'reconnect' ? !!connectionError : action === 'clear-error' ? !!currentActionError
      : job && (action === 'cancel' ? job.cancellable && job.state !== 'cancelling'
        : action === 'retry' ? job.state === 'failed' && job.retryable : isTerminal(job));
    if (!available) toggle.focus();
  });

  async function action(kind: 'cancel' | 'retry' | 'dismiss', id: string) {
    if (pending.includes(id)) return;
    pending = [...pending, id];
    // These controls may disappear immediately or when cancellation settles.
    // Move focus once for this explicit action; later progress never refocuses.
    toggle.focus();
    try { await (kind === 'cancel' ? oncancel : kind === 'retry' ? onretry : ondismiss)(id); }
    finally { pending = pending.filter((item) => item !== id); }
  }
  function duration(ms: number): string {
    const seconds = Math.ceil(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
</script>

<section class="operations-panel" aria-label="Operations">
  <button bind:this={toggle} class="operations-toggle" aria-expanded={expanded} aria-controls="operations-history" onclick={() => { expanded = !expanded; }}>
    <span class="panel-name"><span aria-hidden="true">{expanded ? '▾' : '▸'}</span> Operations</span>
    <span class="summary">{summary}</span>
    {#if current}
      <span class="current-summary">{operationLabel[current.intent.kind]} · {stateLabel[current.state]}</span>
      {@const percentage = progressPercent(current)}
      {#if percentage === null}<progress class="summary-progress" aria-label="Current operation progress" max="100"></progress>
      {:else}<progress class="summary-progress" aria-label="Current operation progress" max="100" value={percentage}></progress>{/if}
    {/if}
    {#if error}<span class="connection-warning">Updates unavailable</span>{/if}
  </button>
  {#if expanded}
    <div id="operations-history" class="operations-history" role="region" aria-label="Operation history">
      {#if error}<div class="panel-error" role="alert"><span>{error}</span><button data-operation-action="reconnect" onclick={onrefresh}>Reconnect</button></div>{/if}
      {#if actionError}<div class="panel-error" role="alert"><span>{actionError}</span><button data-operation-action="clear-error" aria-label="Dismiss operation action error" onclick={onclearerror}>Dismiss</button></div>{/if}
      {#if jobs.length === 0}<p class="empty">Confirmed file operations appear here. You can keep browsing while they run.</p>{/if}
      {#each jobs as job (job.id)}
        {@const percentage = progressPercent(job)}
        {@const title = job.intent.kind === 'create' ? job.intent.name : job.intent.source.name}
        <article class={['operation-job', job.state]} aria-label={`${operationLabel[job.intent.kind]} ${title}`} data-operation-id={job.id}>
          <div class="job-heading"><strong title={title}>{operationLabel[job.intent.kind]} <span>{title}</span></strong><span class="job-state">{stateLabel[job.state]}</span></div>
          <div class="job-body">
            <div class="job-details">
              {#if job.sourceLabel}<p class="location" title={job.sourceLabel}>From {job.sourceLabel}</p>{/if}
              {#if job.destinationLabel}<p class="location" title={job.destinationLabel}>To {job.destinationLabel}</p>{/if}
              {#if job.intent.kind === 'rename'}<p class="location" title={job.intent.name}>New name: {job.intent.name}</p>{/if}
              {#if job.progress.currentLabel && !isTerminal(job)}<p class="location current-item" title={job.progress.currentLabel}>{job.progress.currentLabel}</p>{/if}
              {#if job.intent.kind === 'copy'}
                {#if percentage !== null}<progress aria-label={`${title} copy progress`} max="100" value={percentage}></progress>
                {:else if !isTerminal(job)}<progress aria-label={`${title} copy progress`} max="100"></progress>{/if}
                <p class="metrics"><span>{formatSize(job.progress.bytesProcessed)}{job.progress.totalBytes !== null ? ` / ${formatSize(job.progress.totalBytes)}` : ' copied'}</span><span>{job.progress.completedFiles}{job.progress.totalFiles !== null ? ` / ${job.progress.totalFiles}` : ''} files</span>
                  {#if freshProgress.includes(job.id) && !isTerminal(job) && job.progress.bytesPerSecond !== null}<span>{formatSize(job.progress.bytesPerSecond)}/s</span>{/if}
                  {#if freshProgress.includes(job.id) && !isTerminal(job) && job.progress.remainingMs !== null}<span>About {duration(job.progress.remainingMs)} left</span>{/if}
                  {#if job.startedMs !== null}<span>{duration(job.progress.elapsedMs)} elapsed</span>{/if}
                </p>
                {#if !isTerminal(job) && job.progress.totalBytes !== null && job.progress.bytesProcessed === job.progress.totalBytes}<p class="limit-note">{job.cancellable ? 'Finalizing copy…' : 'Publishing destination…'}</p>{/if}
              {/if}
              {#if job.state === 'running' && !job.cancellable && job.intent.kind !== 'copy'}<p class="limit-note">Native operation started; cancellation is no longer available.</p>{/if}
              {#if job.error}<p class="job-error"><strong>{job.error.code}</strong> {job.error.message}</p>{/if}
              {#if job.error?.recovery}<p class="limit-note">Staging was retained. Review the recovery location in the error before removing anything.</p>{/if}
              {#each job.result?.warnings ?? [] as warning (warning)}<p class="job-warning">{warning}</p>{/each}
              {#if job.state === 'failed' && !job.retryable}<p class="limit-note">Retry unavailable. Inspect the source, destination and Trash before submitting a new operation.</p>{/if}
            </div>
            <div class="job-actions">
              {#if job.cancellable || job.state === 'cancelling'}<button data-operation-action="cancel" disabled={pending.includes(job.id) || job.state === 'cancelling'} aria-label={`Cancel ${title}`} onclick={() => action('cancel', job.id)}>{job.state === 'cancelling' ? 'Cancelling…' : 'Cancel'}</button>{/if}
              {#if job.state === 'failed' && job.retryable}<button data-operation-action="retry" disabled={pending.includes(job.id)} aria-label={`Retry ${title}`} onclick={() => action('retry', job.id)}>Retry</button>{/if}
              {#if isTerminal(job)}<button data-operation-action="dismiss" disabled={pending.includes(job.id)} aria-label={`Dismiss ${title}`} onclick={() => action('dismiss', job.id)}>Dismiss</button>{/if}
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .operations-panel { flex-shrink: 0; margin: 8px 17px 0; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); font-size: 11px; }
  .operations-toggle { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 16px; padding: 7px 12px; text-align: left; color: var(--secondary); }
  .panel-name { color: var(--text); font-weight: 550; white-space: nowrap; }
  .panel-name > span { color: var(--muted); margin-right: 5px; }
  .summary { color: var(--muted); white-space: nowrap; }
  .current-summary { margin-left: auto; color: var(--secondary); white-space: nowrap; }
  progress { display: block; width: 100%; height: 5px; border: 0; border-radius: 3px; accent-color: var(--accent); background: var(--surface-raised); }
  progress::-webkit-progress-bar { background: var(--surface-raised); border-radius: 3px; }
  progress::-webkit-progress-value { background: var(--accent); border-radius: 3px; }
  progress::-moz-progress-bar { background: var(--accent); border-radius: 3px; }
  .failed progress { accent-color: var(--danger, #e89191); }
  .failed progress::-webkit-progress-value { background: var(--danger, #e89191); }
  .failed progress::-moz-progress-bar { background: var(--danger, #e89191); }
  .cancelled progress { accent-color: var(--muted); }
  .cancelled progress::-webkit-progress-value { background: var(--muted); }
  .cancelled progress::-moz-progress-bar { background: var(--muted); }
  .summary-progress { width: 100px; flex-shrink: 1; }
  .operations-history { max-height: min(250px, 32dvh); overflow: auto; border-top: 1px solid var(--border); }
  .empty { padding: 15px; margin: 0; color: var(--muted); line-height: 1.5; }
  .operation-job { padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .operation-job:last-child { border-bottom: 0; }
  .job-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .job-heading > strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
  .job-heading > strong > span { margin-left: 7px; color: var(--secondary); }
  .job-state { white-space: nowrap; color: var(--muted); font-size: 10px; }
  .running .job-state, .completed .job-state { color: var(--accent); }
  .failed .job-state, .job-error { color: var(--danger, #e89191); }
  .job-body { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-top: 5px; }
  .job-details { flex: 1; min-width: 0; }
  p { margin: 4px 0; line-height: 1.5; }
  .location { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 10px; }
  .current-item { color: var(--secondary); }
  .job-details > progress { margin-top: 8px; }
  .metrics { display: flex; flex-wrap: wrap; gap: 3px 14px; margin-top: 6px; color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .job-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .job-actions button, .panel-error button { padding: 5px 8px; border: 1px solid var(--border); border-radius: 3px; background: var(--surface-raised); color: var(--secondary); font-size: 10px; }
  button:disabled { opacity: .5; cursor: default; }
  .job-error, .job-warning, .limit-note { overflow-wrap: anywhere; font-size: 10px; }
  .job-warning, .connection-warning { color: var(--warning); }
  .limit-note { color: var(--muted); }
  .panel-error { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 10px 12px; color: var(--warning); overflow-wrap: anywhere; }
  @media (max-height: 600px) { .operations-panel { margin-top: 4px; } .operations-toggle { min-height: 28px; padding-top: 4px; padding-bottom: 4px; } .operations-history { max-height: max(54px, calc(100dvh - 500px)); } }
  @media (max-width: 850px) { .operations-panel { margin-right: 10px; margin-left: 10px; } .operations-toggle { gap: 9px; } .current-summary { font-size: 10px; } .summary-progress { width: 55px; } }
  @media (max-width: 740px) { .current-summary { display: none; } .summary-progress { margin-left: auto; } }
</style>
