/**
 * Site inventory reconciliation (read-only).
 *
 * Reads docs/operations/site-inventory.csv (or the path given as the first
 * argument) and reports, for every crawled URL of the live simplexd.co site,
 * whether the platform is ready for it:
 *
 *   migrate   the target path must resolve to a live page (static route,
 *             published market/service/resource/policy/listing); when the
 *             target differs from the source path, an active redirect from the
 *             source must exist as well.
 *   redirect  an active redirect from the source path must exist, point at
 *             target_url with the recorded status, and the target must be live.
 *   drop      no redirect may exist; the URL will answer 404 after cutover.
 *
 * Nothing is written. Exit code 1 when any row is a gap, so the cutover
 * checklist can run it as a gate. `--json` prints machine-readable output;
 * `--check-live <baseUrl>` additionally sends a HEAD request per source path
 * to a deployment (for example the temporary hostname before DNS switch) and
 * reports the HTTP status it answers with.
 *
 * Usage: pnpm --filter @simplexd/web reconcile:inventory [path/to/inventory.csv] [--json] [--check-live https://host]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, schema, withActor } from '@simplexd/db';
import { toSitePath } from '../src/lib/site-routes';
import { livePageKind } from '../src/server/content/site-routes';

interface InventoryRow {
  source_url: string;
  status_code?: string;
  title?: string;
  content_type?: string;
  decision: string;
  target_url?: string;
  image_rights?: string;
  owner?: string;
  notes?: string;
}

type RowStatus = 'ok' | 'gap' | 'warn' | 'skip';

interface RowReport {
  line: number;
  sourceUrl: string;
  sourcePath: string | null;
  decision: string;
  targetPath: string | null;
  targetExists: string | null;
  redirect: { toPath: string; statusCode: number; active: boolean } | null;
  liveStatus: number | null;
  status: RowStatus;
  reasons: string[];
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const liveIndex = args.indexOf('--check-live');
const liveBase = liveIndex >= 0 ? (args[liveIndex + 1] ?? '').replace(/\/$/, '') : null;
const csvPath = path.resolve(
  args.find((a, i) => !a.startsWith('--') && (i === 0 || args[i - 1] !== '--check-live')) ??
    path.resolve(import.meta.dirname, '../../../docs/operations/site-inventory.csv'),
);

if (!fs.existsSync(csvPath)) {
  console.error(`Inventory not found: ${csvPath}`);
  process.exit(2);
}

const rows = parse(fs.readFileSync(csvPath, 'utf8'), {
  bom: true,
  columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
  skip_empty_lines: true,
  trim: true,
  relax_column_count: true,
}) as InventoryRow[];

const anonymous = { userId: null, organizationId: null, staff: false } as const;

async function liveStatusOf(sourcePath: string): Promise<number | null> {
  if (!liveBase) return null;
  try {
    const res = await fetch(`${liveBase}${sourcePath}`, { method: 'HEAD', redirect: 'manual' });
    return res.status;
  } catch {
    return -1;
  }
}

const reports: RowReport[] = [];
try {
  const db = getDb();
  await withActor(db, anonymous, async (tx) => {
    for (const [i, row] of rows.entries()) {
      const line = i + 2;
      const decision = (row.decision ?? '').trim().toLowerCase();
      const sourcePath = toSitePath(row.source_url ?? '');
      const report: RowReport = {
        line,
        sourceUrl: row.source_url ?? '',
        sourcePath,
        decision,
        targetPath: null,
        targetExists: null,
        redirect: null,
        liveStatus: null,
        status: 'ok',
        reasons: [],
      };
      reports.push(report);
      const gap = (why: string) => {
        report.status = 'gap';
        report.reasons.push(why);
      };
      const warn = (why: string) => {
        if (report.status === 'ok') report.status = 'warn';
        report.reasons.push(why);
      };
      if ((row.owner ?? '').trim().toLowerCase() === 'example') {
        report.status = 'skip';
        report.reasons.push('example row from the template; delete it');
        continue;
      }
      if (!sourcePath) {
        gap('source_url is not a URL or path');
        continue;
      }
      const [existing] = await tx
        .select({
          toPath: schema.redirects.toPath,
          statusCode: schema.redirects.statusCode,
          active: schema.redirects.active,
        })
        .from(schema.redirects)
        .where(eq(schema.redirects.fromPath, sourcePath));
      report.redirect = existing ?? null;
      report.liveStatus = await liveStatusOf(sourcePath);

      switch (decision) {
        case 'migrate': {
          const targetPath = row.target_url?.trim() ? toSitePath(row.target_url) : sourcePath;
          report.targetPath = targetPath;
          if (!targetPath) {
            gap('target_url is not a path');
            break;
          }
          const kind = await livePageKind(tx, targetPath);
          report.targetExists = kind;
          if (!kind) gap(`target ${targetPath} is not a live page (not published or no such route)`);
          if (targetPath !== sourcePath) {
            if (!existing || !existing.active) gap(`no active redirect from ${sourcePath} to ${targetPath}`);
            else if (existing.toPath !== targetPath)
              gap(`redirect from ${sourcePath} points at ${existing.toPath}, not ${targetPath}`);
          } else if (existing?.active) {
            gap(`an active redirect exists from ${sourcePath} although the page is migrated at the same path`);
          }
          if ((row.image_rights ?? '').trim().toLowerCase() !== 'yes')
            warn(`image_rights is "${row.image_rights || 'blank'}": migrate text only until rights are confirmed`);
          if (liveBase && report.liveStatus !== null && report.liveStatus !== 200)
            gap(`${liveBase}${sourcePath} answers ${report.liveStatus}, expected 200`);
          break;
        }
        case 'redirect': {
          const raw = row.target_url?.trim() ?? '';
          const targetPath = raw.startsWith('/') || /^https?:\/\//i.test(raw) ? (raw.startsWith('/') ? toSitePath(raw) : raw) : null;
          report.targetPath = targetPath;
          if (!targetPath) {
            gap('target_url is required for a redirect');
            break;
          }
          if (!existing) gap(`no redirect configured from ${sourcePath} (import the inventory in Admin → Content → Redirects)`);
          else {
            if (!existing.active) gap(`redirect from ${sourcePath} is inactive`);
            if (existing.toPath !== targetPath)
              gap(`redirect from ${sourcePath} points at ${existing.toPath}, inventory says ${targetPath}`);
            const wanted = Number(row.status_code);
            if ([301, 302, 308].includes(wanted) && existing.statusCode !== wanted)
              warn(`redirect status is ${existing.statusCode}, inventory recorded ${wanted}`);
          }
          if (targetPath.startsWith('/')) {
            const kind = await livePageKind(tx, targetPath);
            report.targetExists = kind;
            if (!kind) gap(`redirect target ${targetPath} is not a live page`);
          } else {
            report.targetExists = 'external';
          }
          if (liveBase && report.liveStatus !== null && ![301, 302, 307, 308].includes(report.liveStatus))
            gap(`${liveBase}${sourcePath} answers ${report.liveStatus}, expected a redirect`);
          break;
        }
        case 'drop': {
          if (existing?.active) warn(`an active redirect exists from ${sourcePath}; the inventory says drop`);
          const kind = await livePageKind(tx, sourcePath);
          if (kind) warn(`${sourcePath} still resolves to a live ${kind}; it will not 404`);
          if (liveBase && report.liveStatus !== null && report.liveStatus !== 404)
            warn(`${liveBase}${sourcePath} answers ${report.liveStatus}, expected 404`);
          break;
        }
        default:
          gap(`decision must be migrate, redirect or drop (got "${row.decision ?? ''}")`);
      }
    }
  });
} finally {
  await closeDb();
}

const counts = { ok: 0, gap: 0, warn: 0, skip: 0 } as Record<RowStatus, number>;
for (const r of reports) counts[r.status] += 1;

if (json) {
  console.log(JSON.stringify({ file: csvPath, counts, rows: reports }, null, 2));
} else {
  console.log(`Inventory: ${csvPath} (${reports.length} rows)`);
  for (const r of reports) {
    const marker = r.status === 'ok' ? 'OK  ' : r.status === 'gap' ? 'GAP ' : r.status === 'warn' ? 'WARN' : 'SKIP';
    const redirect = r.redirect
      ? `redirect → ${r.redirect.toPath} (${r.redirect.statusCode}${r.redirect.active ? '' : ', inactive'})`
      : 'no redirect';
    const live = r.liveStatus === null ? '' : ` · live ${r.liveStatus === -1 ? 'unreachable' : r.liveStatus}`;
    console.log(
      `${marker} line ${r.line} ${r.decision.padEnd(8)} ${r.sourcePath ?? r.sourceUrl} → ${r.targetPath ?? '—'} [${r.targetExists ?? '—'}] · ${redirect}${live}`,
    );
    for (const reason of r.reasons) console.log(`       - ${reason}`);
  }
  console.log(
    `\n${counts.ok} ok, ${counts.gap} gap${counts.gap === 1 ? '' : 's'}, ${counts.warn} warning${counts.warn === 1 ? '' : 's'}, ${counts.skip} skipped.`,
  );
  console.log('Read-only: nothing was changed. The live site is never switched by this script.');
}
process.exit(counts.gap > 0 ? 1 : 0);
