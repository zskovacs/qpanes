import type { NativePath, SortDirection, SortKey } from './filesystem';

/** Bounded per panel: each tab holds one in-memory listing. */
export const MAX_TABS = 32;

/** Where a tab starts. `path: null` opens the native home directory. Labels are display-only. */
export interface TabSeed { path: NativePath | null; location: string; name: string; sort: SortKey; direction: SortDirection }
export interface PanelSession { activeTab: number; tabs: TabSeed[] }

export const homeSeed = (): TabSeed => ({ path: null, location: '', name: '', sort: 'name', direction: 'ascending' });

/** Wrap-around tab cycling. */
export function cycleIndex(count: number, index: number, delta: number): number {
  if (count <= 0) return -1;
  return ((index + delta) % count + count) % count;
}

/** Index of the tab to activate after removing `index`: right neighbour, else left. */
export function indexAfterClose(count: number, index: number): number {
  if (count <= 1) return -1;
  return index < count - 1 ? index : index - 1;
}

const sorts = new Set(['name', 'size', 'modified']);
const directions = new Set(['ascending', 'descending']);

/** Defensive restore of an already Rust-validated session; never yields an empty panel. */
export function restorePanel(session: PanelSession | null | undefined): PanelSession {
  const tabs = (Array.isArray(session?.tabs) ? session.tabs : [])
    .filter((tab) => tab && (tab.path === null || typeof tab.path === 'string') && sorts.has(tab.sort) && directions.has(tab.direction))
    .slice(0, MAX_TABS)
    .map((tab) => ({ path: tab.path, location: String(tab.location ?? ''), name: String(tab.name ?? ''), sort: tab.sort, direction: tab.direction }));
  if (!tabs.length) return { activeTab: 0, tabs: [homeSeed()] };
  const active = Number.isInteger(session?.activeTab) && session!.activeTab >= 0 && session!.activeTab < tabs.length ? session!.activeTab : 0;
  return { activeTab: active, tabs };
}

export function tabLabel(seed: TabSeed): string {
  return seed.name || seed.location || 'Home';
}
