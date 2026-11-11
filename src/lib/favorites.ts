import type { NativePath } from './filesystem';

/** A remembered directory. `path` is the opaque native identity; label/location are display-only. */
export interface Favorite { id: string; label: string; path: NativePath; location: string }
export interface FavoriteCandidate { path: NativePath; location: string; name: string }

export const MAX_FAVORITES = 256;
export const MAX_LABEL = 200;

/** Display labels: no control characters or surrounding spaces, bounded length. */
export function cleanLabel(text: string): string {
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()].slice(0, MAX_LABEL).join('').trim();
}

export function validateLabel(text: string): { label: string } | { error: string } {
  const label = cleanLabel(text);
  if (!label) return { error: 'Enter a name.' };
  if ([...text.trim()].length > MAX_LABEL) return { error: `Use at most ${MAX_LABEL} characters.` };
  return { label };
}

/**
 * Duplicates are exact native identities (listings are canonical). An existing
 * favorite is returned instead of adding a second entry for the same directory.
 */
export function addFavorite(list: readonly Favorite[], candidate: FavoriteCandidate, id: string):
  { list: Favorite[]; favorite: Favorite; added: true } | { list: Favorite[]; favorite: Favorite; added: false } | { error: string } {
  const existing = list.find((favorite) => favorite.path === candidate.path);
  if (existing) return { list: [...list], favorite: existing, added: false };
  if (list.length >= MAX_FAVORITES) return { error: `Favorites can hold at most ${MAX_FAVORITES} folders.` };
  const favorite = { id, label: cleanLabel(candidate.name) || cleanLabel(candidate.location) || 'Folder', path: candidate.path, location: candidate.location };
  return { list: [...list, favorite], favorite, added: true };
}

/** Renaming only changes the label; the native target is never rewritten. */
export function renameFavorite(list: readonly Favorite[], id: string, text: string): { list: Favorite[] } | { error: string } {
  const result = validateLabel(text);
  if ('error' in result) return result;
  if (!list.some((favorite) => favorite.id === id)) return { error: 'This favorite no longer exists.' };
  return { list: list.map((favorite) => favorite.id === id ? { ...favorite, label: result.label } : favorite) };
}

export function removeFavorite(list: readonly Favorite[], id: string): Favorite[] {
  return list.filter((favorite) => favorite.id !== id);
}
