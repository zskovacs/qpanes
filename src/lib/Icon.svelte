<script lang="ts">
  let { name, size = 16 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
    file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M8 13h8M8 17h5',
    up: 'm6 10 6-6 6 6M12 4v16',
    home: 'm3 10 9-7 9 7M5 9v12h5v-7h4v7h5V9',
    refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6',
    chevron: 'm9 5 7 7-7 7',
    link: 'm10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
    alert: 'M12 8v5m0 4h.01M10 3 1 19a1 1 0 0 0 1 2h20a1 1 0 0 0 1-2L14 3a2 2 0 0 0-4 0Z',
    lock: 'M6 10V7a6 6 0 0 1 12 0v3M4 10h16v12H4zM12 14v4',
    panels: 'M3 4h18v16H3zM12 4v16M7 8h1m8 0h1M7 12h1m8 0h1',
    info: 'M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
    star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9L12 3Z',
    plus: 'M12 5v14M5 12h14',
    filter: 'M3 5h18l-7 8.5V19l-4 2v-7.5L3 5Z',
    keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M17 14H7',
    tab: 'M4 9V5h7v4M3 9h18v10H3zM15 12v4M13 14h4',
    pencil: 'm4 20 1-4L16 5l3 3L8 19l-4 1ZM14 7l3 3',
  };
</script>
<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={paths[name] ?? paths.file} />
</svg>
