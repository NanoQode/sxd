import 'server-only';
import { ApiError } from '@simplexd/contracts';
import type { RequestIdentity } from './auth/session';

/**
 * Feature flags gate both interface and endpoints. `identity.featureFlags` is
 * already evaluated for the caller (global switch plus rollout rules), so a
 * disabled expansion answers 404 `feature_disabled` rather than revealing that
 * the module exists. Records created while a flag was on are retained.
 */

export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  rollout: { organizationIds?: string[]; staffOnly?: boolean } | null;
}

/**
 * Evaluates feature flags for one caller. A disabled flag is off for everyone.
 * An enabled flag is on for staff; for customers and visitors it also has to
 * pass the rollout rules (staff-only, or an organisation allow-list).
 */
export function evaluateFeatureFlags(
  rows: FeatureFlagRow[],
  caller: { staff: boolean; organizationId: string | null },
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const row of rows) {
    if (!row.enabled) {
      out[row.key] = false;
      continue;
    }
    if (caller.staff || !row.rollout) {
      out[row.key] = true;
      continue;
    }
    if (row.rollout.staffOnly) {
      out[row.key] = false;
      continue;
    }
    const orgs = row.rollout.organizationIds;
    out[row.key] =
      !orgs || orgs.length === 0
        ? true
        : caller.organizationId !== null && orgs.includes(caller.organizationId);
  }
  return out;
}

export function isFeatureEnabled(identity: RequestIdentity, key: string): boolean {
  return identity.featureFlags[key] === true;
}

export function requireFeature(identity: RequestIdentity, key: string): void {
  if (!isFeatureEnabled(identity, key)) {
    throw new ApiError('feature_disabled', 'this feature is not enabled', {
      details: { feature: key },
    });
  }
}

/** Expansion services are flagged `expansion.<workflowTemplateKey>`. */
export function expansionFlagKey(workflowTemplateKey: string): string {
  return `expansion.${workflowTemplateKey}`;
}
