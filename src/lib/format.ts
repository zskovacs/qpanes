import type { EntryKind } from './filesystem';
const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const date = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  const unit = bytes === 0 ? 0 : Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1);
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${sizes[unit]}`;
}
export function formatDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(new Date(ms).getTime())) return '—';
  return date.format(ms);
}
export const kindLabel: Record<EntryKind, string> = {
  directory: 'Folder', file: 'File', symlink: 'Link', other: 'Special', unknown: 'Unknown',
};
