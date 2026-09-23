import { and, eq, isNull, ne } from 'drizzle-orm';
import { schema, systemContext, withActor, type Database } from '@simplexd/db';
import { rewrapSecret, type Keyring } from '@simplexd/integrations/secrets';

/**
 * Re-wraps every non-retired secret whose data key is wrapped by a master
 * key other than the current one. The plaintext never leaves the process:
 * `rewrapSecret` decrypts with the previous key and re-encrypts with the
 * current key in memory. Secrets the keyring cannot open are reported, not
 * skipped silently, so an expired rotation window is visible.
 *
 * The worker handler (apps/worker/src/handlers/integrations.ts) runs the
 * same procedure; this copy backs the integration tests.
 */
export interface RewrapReport {
  masterKeyId: string;
  scanned: number;
  rewrapped: number;
  failed: Array<{ id: string; provider: string; fieldName: string; error: string }>;
}

export async function rewrapPendingSecrets(db: Database, keyring: Keyring): Promise<RewrapReport> {
  return withActor(db, systemContext('integrations-rewrap'), async (tx) => {
    const rows = await tx
      .select()
      .from(schema.secretReferences)
      .where(
        and(
          isNull(schema.secretReferences.retiredAt),
          ne(schema.secretReferences.masterKeyId, keyring.current.id),
        ),
      );
    const report: RewrapReport = {
      masterKeyId: keyring.current.id,
      scanned: rows.length,
      rewrapped: 0,
      failed: [],
    };
    for (const row of rows) {
      try {
        const next = rewrapSecret(row, keyring);
        await tx
          .update(schema.secretReferences)
          .set({
            masterKeyId: next.masterKeyId,
            wrappedDek: next.wrappedDek,
            dekIv: next.dekIv,
            dekTag: next.dekTag,
            ciphertext: next.ciphertext,
            iv: next.iv,
            tag: next.tag,
          })
          .where(eq(schema.secretReferences.id, row.id));
        report.rewrapped += 1;
      } catch (err) {
        report.failed.push({
          id: row.id,
          provider: row.provider,
          fieldName: row.fieldName,
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
    await tx.insert(schema.integrationLogs).values({
      provider: 'secrets',
      environment: 'all',
      level: report.failed.length > 0 ? 'warn' : 'info',
      event: 'secrets.rewrapped',
      messageSanitized: `Re-wrapped ${report.rewrapped}/${report.scanned} secrets under master key ${keyring.current.id}${
        report.failed.length > 0 ? `; ${report.failed.length} could not be opened` : ''
      }`,
      metadataSanitized: {
        masterKeyId: keyring.current.id,
        rewrapped: report.rewrapped,
        failed: report.failed.map((f) => ({ id: f.id, provider: f.provider, fieldName: f.fieldName })),
      },
    });
    return report;
  });
}
