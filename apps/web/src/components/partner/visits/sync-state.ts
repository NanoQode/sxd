import type { Draft } from '@/lib/partner/offline/types';

/** Badge tone for a draft's sync state (always shown with a word, never colour alone). */
export function syncStateTone(
  state: Draft['syncState'],
): 'warning' | 'danger' | 'success' | 'info' {
  switch (state) {
    case 'synced':
      return 'success';
    case 'rejected':
      return 'danger';
    case 'syncing':
      return 'info';
    default:
      return 'warning';
  }
}

export function syncStateLabel(state: Draft['syncState']): string {
  switch (state) {
    case 'unsynced':
      return 'Unsynced';
    case 'syncing':
      return 'Syncing…';
    case 'partial':
      return 'Partly synced';
    case 'synced':
      return 'Synced';
    case 'rejected':
      return 'Rejected by server';
  }
}
