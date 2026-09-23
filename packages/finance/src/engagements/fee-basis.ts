import { and, eq, ne } from 'drizzle-orm';
import { ApiError } from '@simplexd/contracts';
import { schema, type Transaction } from '@simplexd/db';
import { bpsOf } from '@simplexd/domain/money';

/**
 * Purchase-support fee rule (build brief §2): "Never calculate a
 * purchase-support invoice without an agreed percentage basis and signed
 * scope." A quote is percentage-based when its fee basis carries a
 * percentage, or when the requested service is priced on a percentage basis
 * (its package `price_basis` is `percentage`). Such a quote may be issued or
 * accepted only when:
 *  - the percentage and an agreed basis amount (the purchase price the
 *    percentage applies to, or an explicit cap agreed with the customer) are
 *    recorded on the quote version;
 *  - the customer-signed scope is on file: a clean (scanned) file attached to
 *    this service request and referenced by `signedScopeFileId`, and the
 *    version states the scope it covers;
 *  - the version's lines are exactly the fee derived from that basis, so the
 *    invoice raised on acceptance computes from the agreed basis only.
 */

export interface StoredPercentageBasis {
  percentageBps?: number;
  basisDescription?: string;
  basisAmountKobo?: string;
  basisKind?: 'agreed_purchase_price' | 'agreed_cap';
  signedScopeFileId?: string;
}

export interface PercentageRuleProblem {
  path: string;
  message: string;
}

type ServiceRequestRow = typeof schema.serviceRequests.$inferSelect;
type QuoteVersionRow = typeof schema.quoteVersions.$inferSelect;

/** The live percentage-priced package of the request's service, if any. */
export async function percentagePackageFor(
  tx: Transaction,
  sr: Pick<ServiceRequestRow, 'serviceId' | 'packageId'>,
): Promise<{ percentageBps: number | null } | null> {
  const rows = await tx
    .select({
      id: schema.servicePackages.id,
      priceBasis: schema.servicePackages.priceBasis,
      percentageBps: schema.servicePackages.percentageBps,
    })
    .from(schema.servicePackages)
    .where(
      and(
        eq(schema.servicePackages.serviceId, sr.serviceId),
        ne(schema.servicePackages.publicationState, 'retired'),
      ),
    );
  const chosen = sr.packageId ? rows.filter((r) => r.id === sr.packageId) : rows;
  const pct = chosen.find((r) => r.priceBasis === 'percentage');
  return pct ? { percentageBps: pct.percentageBps } : null;
}

/** The single fee line a percentage basis yields (the only lines such a quote may carry). */
export function percentageFeeKobo(basis: StoredPercentageBasis): bigint | null {
  if (!basis.percentageBps || !basis.basisAmountKobo) return null;
  if (!/^\d+$/.test(basis.basisAmountKobo)) return null;
  const amount = BigInt(basis.basisAmountKobo);
  if (amount <= 0n) return null;
  return bpsOf(amount, basis.percentageBps);
}

/**
 * Checks a quote version against the percentage rule. Returns the problems
 * (empty when the version satisfies it or is not percentage-based).
 */
export async function percentageRuleProblems(
  tx: Transaction,
  sr: ServiceRequestRow,
  version: Pick<QuoteVersionRow, 'feeBasis' | 'lines' | 'subtotalKobo' | 'scopeMarkdown'>,
): Promise<{ applies: boolean; problems: PercentageRuleProblem[] }> {
  const basis = (version.feeBasis ?? {}) as StoredPercentageBasis;
  const pkg = await percentagePackageFor(tx, sr);
  const applies = Boolean(basis.percentageBps) || pkg !== null;
  if (!applies) return { applies, problems: [] };
  const problems: PercentageRuleProblem[] = [];
  if (!basis.percentageBps || basis.percentageBps <= 0) {
    problems.push({
      path: 'feeBasis.percentageBps',
      message: 'this service is charged on an agreed percentage basis; record the percentage',
    });
  }
  const fee = percentageFeeKobo(basis);
  if (!basis.basisAmountKobo || fee === null) {
    problems.push({
      path: 'feeBasis.basisAmountKobo',
      message:
        'record the agreed basis amount the percentage applies to (the agreed purchase price or an explicit cap)',
    });
  }
  if (!basis.signedScopeFileId) {
    problems.push({
      path: 'feeBasis.signedScopeFileId',
      message: 'attach the scope the customer signed to the request and reference it',
    });
  } else {
    const [file] = await tx
      .select({
        id: schema.fileObjects.id,
        organizationId: schema.fileObjects.organizationId,
        entityType: schema.fileObjects.entityType,
        entityId: schema.fileObjects.entityId,
        status: schema.fileObjects.status,
        deletedAt: schema.fileObjects.deletedAt,
      })
      .from(schema.fileObjects)
      .where(eq(schema.fileObjects.id, basis.signedScopeFileId));
    if (
      !file ||
      file.deletedAt ||
      file.entityType !== 'service_request' ||
      file.entityId !== sr.id ||
      (file.organizationId !== null && file.organizationId !== sr.organizationId)
    ) {
      problems.push({
        path: 'feeBasis.signedScopeFileId',
        message: 'the signed scope must be a file attached to this service request',
      });
    } else if (file.status !== 'clean') {
      problems.push({
        path: 'feeBasis.signedScopeFileId',
        message: `the signed scope file is ${file.status.replace(/_/g, ' ')}; it must pass the malware scan first`,
      });
    }
  }
  if (!version.scopeMarkdown || version.scopeMarkdown.trim().length === 0) {
    problems.push({ path: 'scopeMarkdown', message: 'state the scope the percentage fee covers' });
  }
  if (fee !== null) {
    const lines = version.lines ?? [];
    const derived =
      lines.length === 1 &&
      lines[0]!.quantity === '1' &&
      BigInt(lines[0]!.unitAmountKobo) === fee &&
      version.subtotalKobo === fee;
    if (!derived) {
      problems.push({
        path: 'lines',
        message:
          'a percentage fee is computed from the agreed basis only; create a new version from the fee basis instead of typed lines',
      });
    }
  }
  return { applies, problems };
}

/** Throws `insufficient_evidence` unless the version satisfies the percentage rule. */
export async function assertPercentageRule(
  tx: Transaction,
  sr: ServiceRequestRow,
  version: Pick<QuoteVersionRow, 'feeBasis' | 'lines' | 'subtotalKobo' | 'scopeMarkdown'>,
  stage: 'issue' | 'accept',
): Promise<void> {
  const { problems } = await percentageRuleProblems(tx, sr, version);
  if (problems.length === 0) return;
  throw new ApiError(
    'insufficient_evidence',
    stage === 'issue'
      ? 'a percentage-basis fee cannot be issued without an agreed basis amount and the customer-signed scope'
      : 'this percentage-basis quote cannot be accepted: its agreed basis amount or signed scope is missing',
    { details: problems },
  );
}
