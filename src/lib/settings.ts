import { invoke, isTauri } from '@tauri-apps/api/core';
import type { NativePath } from './filesystem';
import type { Favorite } from './favorites';
import type { PanelSession } from './tabs';

/** Mirrors `qpanes_core::settings`. Rust validates every load and save. */
export interface SessionState { activeSide: 'left' | 'right'; left: PanelSession | null; right: PanelSession | null }
export interface SettingsDocument { version: 1; favorites: Favorite[]; shortcuts: Record<string, string>; session: SessionState | null }
export type SettingsStatus = 'loaded' | 'missing' | 'recovered' | 'unavailable';
export interface SettingsLoad { document: SettingsDocument; status: SettingsStatus; warnings: string[] }
export type DirectoryStatus = 'available' | 'missing' | 'notDirectory' | 'permissionDenied' | 'invalid' | 'unreadable';

export const defaultSettings = (): SettingsDocument => ({ version: 1, favorites: [], shortcuts: {}, session: null });

/**
 * Never rejects. Any failure, including a load that does not answer in time,
 * yields defaults with `unavailable`, which disables saving for the session so
 * an unread file can never be overwritten. `quiet` marks a rejected IPC call
 * (no settings boundary answered); Rust warnings and timeouts are not quiet.
 */
export async function loadSettings(timeoutMs = 2500): Promise<SettingsLoad & { quiet: boolean }> {
  const fallback = (quiet: boolean, warning?: string) => ({ document: defaultSettings(), status: 'unavailable' as const, warnings: warning ? [warning] : [], quiet });
  if (!isTauri()) return fallback(true);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('timeout');
  try {
    const timeout = new Promise<typeof timedOut>((resolve) => { timer = setTimeout(() => resolve(timedOut), timeoutMs); });
    const loaded = await Promise.race([invoke<SettingsLoad>('load_settings'), timeout]);
    // A slow settings read is a real condition worth a visible warning.
    if (loaded === timedOut) return fallback(false, 'Settings took too long to load. Changes will not be saved during this session.');
    return { ...loaded, quiet: false };
  } catch {
    return fallback(true, 'Settings could not be loaded. Changes will not be saved during this session.');
  } finally {
    clearTimeout(timer);
  }
}

export function saveSettings(document: SettingsDocument): Promise<void> {
  return invoke('save_settings', { document });
}

export function probeDirectories(paths: NativePath[]): Promise<DirectoryStatus[]> {
  return invoke('probe_directories', { paths });
}

/**
 * One save in flight; changes made meanwhile coalesce into one later write of
 * the latest state. Saves therefore cannot complete out of order.
 */
export function createSettingsWriter(save: (document: SettingsDocument) => Promise<void>, onresult: (error: unknown | null) => void) {
  let pending: (() => SettingsDocument) | null = null;
  let running: Promise<void> | null = null;
  async function drain() {
    try {
      while (pending) {
        const build = pending;
        pending = null;
        try { await save(build()); onresult(null); }
        catch (error) { onresult(error); }
      }
    } finally { running = null; }
  }
  return {
    schedule(build: () => SettingsDocument): Promise<void> {
      pending = build;
      running ??= drain();
      return running;
    },
    idle: (): Promise<void> => running ?? Promise.resolve(),
  };
}
