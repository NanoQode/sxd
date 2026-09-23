/** Honest state labels for integration configurations (brief §16). */
export const STATUS_LABELS: Record<string, string> = {
  disconnected: 'Not configured',
  configured_unverified: 'Saved, not tested',
  connected: 'Connected',
  degraded: 'Degraded',
  expired: 'Expired',
  disabled: 'Disabled',
};

export function statusLabel(
  status: string,
  dto: { lastCheckOk: boolean | null; isActive: boolean } | null,
): string {
  if (dto && status === 'configured_unverified' && dto.lastCheckOk === true && !dto.isActive)
    return 'Tested, not active';
  if (dto && status === 'configured_unverified' && dto.isActive) return 'Active, not verified';
  return STATUS_LABELS[status] ?? status;
}
