import 'server-only';
import { SEVERITY_RANK } from '@simplexd/domain/engagements';
import { renderMarkdown } from '@/lib/markdown';
import type { ItemSnapshot } from './snapshot';

/**
 * Print-ready HTML for a released report version (brief §10 "export
 * reports"). There is no PDF library in the stack, so the document is built
 * for the browser's print pipeline: an A4 `@page`, print-safe colours,
 * repeated table headers, no interactive elements, and a note telling the
 * reader to use Print → Save as PDF. Everything user-supplied is escaped; the
 * report body goes through the same sanitising markdown renderer as the
 * portal.
 */

export interface ExportEvidenceRef {
  source: string;
  name: string;
  checksumSha256: string | null;
  sizeBytes: number | null;
  capturedAt?: string | null;
}

export interface ReportExportModel {
  title: string;
  kind: string;
  version: number;
  releasedAt: string | null;
  organizationName: string | null;
  context: string | null;
  authorName: string | null;
  reviewerName: string | null;
  reviewedAt: string | null;
  releasedByName: string | null;
  summary: string | null;
  bodyMarkdown: string;
  scopeLimitations: string | null;
  items: ItemSnapshot[];
  itemsCapturedAt: string | null;
  evidence: ExportEvidenceRef[];
  generatedAt: string;
  reportId: string;
  timeZone?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const KIND_LABELS: Record<string, string> = {
  diligence_memo: 'Due diligence decision memorandum',
  virtual_inspection: 'Virtual inspection report',
  inspection: 'Inspection report',
  progress: 'Progress report',
};

function label(value: string): string {
  const s = value.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDate(isoValue: string | null, zone: string): string {
  if (!isoValue) return 'not recorded';
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return 'not recorded';
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  return `${text} (${zone})`;
}

function formatBytes(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function itemsTable(caption: string, items: ItemSnapshot[], withSeverity: boolean): string {
  if (items.length === 0) return '';
  const rows = items
    .map(
      (i) => `<tr>
  <td>${escapeHtml(i.title)}${i.detail ? `<div class="muted">${escapeHtml(i.detail)}</div>` : ''}${
    i.resolutionNote ? `<div class="muted">Resolution: ${escapeHtml(i.resolutionNote)}</div>` : ''
  }</td>
  ${withSeverity ? `<td>${i.severity ? `<span class="sev sev-${escapeHtml(i.severity)}">${escapeHtml(label(i.severity))}</span>` : '—'}</td>` : `<td>${escapeHtml(i.kindLabel)}</td>`}
  <td>${escapeHtml(label(i.status))}</td>
  <td>${i.reference ? escapeHtml(i.reference) : '—'}</td>
  <td>${i.evidence.length === 0 ? '—' : i.evidence.map((e) => escapeHtml(e.name)).join('<br>')}</td>
</tr>`,
    )
    .join('\n');
  return `<table>
<caption>${escapeHtml(caption)}</caption>
<thead><tr><th scope="col">Item</th><th scope="col">${withSeverity ? 'Severity' : 'Type'}</th><th scope="col">Status</th><th scope="col">Reference</th><th scope="col">Evidence</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

export function renderReportExport(model: ReportExportModel): string {
  const zone = model.timeZone ?? 'Africa/Lagos';
  const kindLabel = KIND_LABELS[model.kind] ?? label(model.kind);
  const redFlags = model.items
    .filter((i) => i.kind === 'red_flag')
    .sort(
      (a, b) =>
        (b.severity ? SEVERITY_RANK[b.severity] : -1) - (a.severity ? SEVERITY_RANK[a.severity] : -1),
    );
  const findings = model.items.filter((i) => i.kind === 'site_finding');
  const checklist = model.items.filter((i) => i.kind !== 'red_flag' && i.kind !== 'site_finding');
  const itemEvidence: ExportEvidenceRef[] = model.items.flatMap((i) =>
    i.evidence.map((e) => ({
      source: `${i.kindLabel}: ${i.title}`,
      name: e.name,
      checksumSha256: e.checksumSha256,
      sizeBytes: e.sizeBytes,
    })),
  );
  const evidence = [...model.evidence, ...itemEvidence];
  const footer = `Released report version ${model.version} — generated ${formatDate(model.generatedAt, zone)}`;
  const snapshotNote = model.itemsCapturedAt
    ? `<p class="muted">Engagement records as captured with this version on ${escapeHtml(formatDate(model.itemsCapturedAt, zone))}. Later changes are not reflected until a new version is released.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(model.title)} — version ${model.version}</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1d21; --muted: #5b6470; --border: #d5d9de; --bg: #ffffff; --soft: #f3f5f7; --accent: #0b5d4b; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e7eaee; --muted: #a7b0ba; --border: #3a4048; --bg: #121518; --soft: #1c2126; --accent: #6fd1b6; } }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px 96px; }
  header.doc { border-bottom: 2px solid var(--accent); padding-bottom: 12px; margin-bottom: 20px; }
  .eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: 12px; color: var(--muted); margin: 0 0 4px; }
  h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; overflow-wrap: anywhere; }
  h2 { font-size: 19px; margin: 28px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
  h3 { font-size: 16px; margin: 20px 0 6px; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 12px 0 0; font-size: 14px; }
  dl.meta dt { color: var(--muted); }
  dl.meta dd { margin: 0; overflow-wrap: anywhere; }
  .muted { color: var(--muted); font-size: 13px; }
  .notice { background: var(--soft); border-left: 4px solid var(--accent); padding: 10px 14px; margin: 16px 0; }
  .limitations { border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; background: var(--soft); white-space: pre-wrap; }
  .body { overflow-wrap: anywhere; }
  .body img { max-width: 100%; height: auto; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  caption { text-align: left; font-weight: 600; padding: 4px 0; }
  th, td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  code.hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; word-break: break-all; }
  .sev { font-weight: 600; }
  .sev-critical, .sev-high { color: #b3261e; }
  .sev-medium { color: #8a5a00; }
  @media (prefers-color-scheme: dark) { .sev-critical, .sev-high { color: #ff8a80; } .sev-medium { color: #ffd166; } }
  .table-scroll { overflow-x: auto; }
  footer.doc { margin-top: 32px; border-top: 1px solid var(--border); padding-top: 8px; font-size: 12px; color: var(--muted); }
  @page { size: A4; margin: 18mm 16mm 20mm; }
  @media print {
    :root { color-scheme: light; --fg: #000; --muted: #444; --border: #999; --bg: #fff; --soft: #f2f2f2; --accent: #0b5d4b; }
    body { font-size: 11pt; }
    main { max-width: none; padding: 0 0 12mm; }
    .no-print { display: none !important; }
    h2 { break-after: avoid; }
    .table-scroll { overflow: visible; }
    .sev-critical, .sev-high { color: #000; text-decoration: underline; }
    .sev-medium { color: #000; }
    footer.doc { position: fixed; bottom: 0; left: 0; right: 0; margin: 0; padding: 4px 0 0; background: #fff; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
<main>
<p class="notice no-print">This is the released version prepared for printing. To keep a PDF copy, use your browser's <strong>Print</strong> command and choose <strong>Save as PDF</strong>.</p>
<header class="doc">
  <p class="eyebrow">${escapeHtml(kindLabel)}</p>
  <h1>${escapeHtml(model.title)}</h1>
  <dl class="meta">
    <dt>Version</dt><dd>Released version ${model.version}</dd>
    <dt>Released</dt><dd>${escapeHtml(formatDate(model.releasedAt, zone))}</dd>
    ${model.organizationName ? `<dt>Prepared for</dt><dd>${escapeHtml(model.organizationName)}</dd>` : ''}
    ${model.context ? `<dt>Engagement</dt><dd>${escapeHtml(model.context)}</dd>` : ''}
    <dt>Author</dt><dd>${escapeHtml(model.authorName ?? 'not recorded')}</dd>
    <dt>Named reviewer</dt><dd>${escapeHtml(model.reviewerName ?? 'not recorded')}${model.reviewedAt ? ` · reviewed ${escapeHtml(formatDate(model.reviewedAt, zone))}` : ''}</dd>
    ${model.releasedByName ? `<dt>Released by</dt><dd>${escapeHtml(model.releasedByName)}</dd>` : ''}
    <dt>Report reference</dt><dd><code class="hash">${escapeHtml(model.reportId)}</code></dd>
  </dl>
</header>
${model.summary ? `<section aria-labelledby="summary-h"><h2 id="summary-h">Summary</h2><p>${escapeHtml(model.summary)}</p></section>` : ''}
<section aria-labelledby="scope-h">
  <h2 id="scope-h">Scope and limitations</h2>
  ${
    model.scopeLimitations && model.scopeLimitations.trim()
      ? `<div class="limitations">${escapeHtml(model.scopeLimitations)}</div>`
      : '<p class="muted">No scope and limitations statement was recorded with this version.</p>'
  }
</section>
<section class="body" aria-label="Report">
${renderMarkdown(model.bodyMarkdown)}
</section>
${
  redFlags.length + findings.length + checklist.length > 0
    ? `<section aria-labelledby="records-h">
  <h2 id="records-h">Engagement records referenced</h2>
  ${snapshotNote}
  <div class="table-scroll">${itemsTable('Red flags', redFlags, true)}</div>
  <div class="table-scroll">${itemsTable('Site findings', findings, true)}</div>
  <div class="table-scroll">${itemsTable('Checklist, references and queries', checklist, false)}</div>
</section>`
    : ''
}
<section aria-labelledby="evidence-h">
  <h2 id="evidence-h">Evidence references</h2>
  ${
    evidence.length === 0
      ? '<p class="muted">This version references no evidence files.</p>'
      : `<p class="muted">Files are identified by name and SHA-256 checksum so a copy can be verified; capture times and locations are user-provided and are not proof of authenticity.</p>
  <div class="table-scroll"><table>
  <thead><tr><th scope="col">Source</th><th scope="col">File</th><th scope="col">SHA-256</th><th scope="col">Size</th></tr></thead>
  <tbody>
  ${evidence
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.source)}${e.capturedAt ? `<div class="muted">Captured (user-provided) ${escapeHtml(formatDate(e.capturedAt, zone))}</div>` : ''}</td><td>${escapeHtml(e.name)}</td><td><code class="hash">${e.checksumSha256 ? escapeHtml(e.checksumSha256) : 'not recorded'}</code></td><td>${formatBytes(e.sizeBytes)}</td></tr>`,
    )
    .join('\n  ')}
  </tbody></table></div>`
  }
</section>
<footer class="doc">${escapeHtml(footer)}</footer>
</main>
</body>
</html>
`;
}
