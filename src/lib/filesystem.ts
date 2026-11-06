import { invoke, isTauri } from '@tauri-apps/api/core';

/** Opaque native identifier. Never derive a native path from a display label. */
export type NativePath = string;
export type SortKey = 'name' | 'size' | 'modified';
export type SortDirection = 'ascending' | 'descending';
export type DirectoryTarget = { kind: 'home' } | { kind: 'path'; value: NativePath } | { kind: 'typed'; value: string };
export type EntryKind = 'directory' | 'file' | 'symlink' | 'other' | 'unknown';
export interface FileEntry {
  path: NativePath; name: string; kind: EntryKind;
  size: number | null; modifiedMs: number | null; metadataError: string | null;
  identity?: string | null;
}
export interface ListRequest { target: DirectoryTarget; sort: SortKey; direction: SortDirection }
export interface DirectoryListing {
  path: NativePath; label: string; parent: NativePath | null;
  entries: FileEntry[]; warnings: string[]; sort: SortKey; direction: SortDirection;
}
export interface FilesystemError { code: string; message: string }
export interface CreateDirectoryRequest { parent: NativePath; name: string }
export interface RenameRequest { source: FileEntry; name: string }
export interface TransferRequest { source: FileEntry; destination: NativePath }
export interface TrashRequest { source: FileEntry }
export interface OperationResult { path: NativePath | null; warnings: string[] }

export function listDirectory(request: ListRequest): Promise<DirectoryListing> {
  if (!isTauri()) {
    return Promise.reject({ code: 'unavailable', message: 'Open QPanes in its desktop window to browse your files.' });
  }
  return invoke<DirectoryListing>('list_directory', { request });
}

/** Pure Rust sorting of real entries only; virtual navigation rows stay in the UI. */
export function sortDirectoryEntries(entries: FileEntry[], sort: SortKey, direction: SortDirection): Promise<FileEntry[]> {
  return invoke<FileEntry[]>('sort_directory_entries', { entries, sort, direction });
}

export function createDirectory(request: CreateDirectoryRequest): Promise<OperationResult> {
  return invoke<OperationResult>('create_directory', { request });
}

export function renameEntry(request: RenameRequest): Promise<OperationResult> {
  return invoke<OperationResult>('rename_entry', { request });
}

export function copyEntry(request: TransferRequest): Promise<OperationResult> {
  return invoke<OperationResult>('copy_entry', { request });
}

export function moveEntry(request: TransferRequest): Promise<OperationResult> {
  return invoke<OperationResult>('move_entry', { request });
}

export function trashEntry(request: TrashRequest): Promise<OperationResult> {
  return invoke<OperationResult>('trash_entry', { request });
}

export function filesystemError(value: unknown): FilesystemError {
  if (typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string') {
    return { code: 'code' in value ? String(value.code) : 'io', message: value.message };
  }
  return { code: 'io', message: typeof value === 'string' ? value : 'The directory could not be read. Try again.' };
}
