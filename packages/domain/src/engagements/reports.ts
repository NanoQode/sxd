/**
 * Report rules for engagement deliverables written under a service request
 * (the due-diligence decision memorandum and the virtual inspection report):
 * template sections, the scope-and-limitations requirement, and the
 * prohibition on guarantee wording. Pure functions.
 *
 * The named-reviewer and release rules are the shared ones in
 * `../projects/reports.ts`; these add content checks on top.
 */

/** Report kinds that may be drafted directly under a service request (no project needed). */
export const SERVICE_REQUEST_REPORT_KINDS = ['diligence_memo', 'virtual_inspection'] as const;
export type ServiceRequestReportKind = (typeof SERVICE_REQUEST_REPORT_KINDS)[number];

export function isServiceRequestReportKind(kind: string): kind is ServiceRequestReportKind {
  return (SERVICE_REQUEST_REPORT_KINDS as readonly string[]).includes(kind);
}

/** Kinds whose review and release need an explicit scope and limitations statement. */
export const REPORT_KINDS_REQUIRING_LIMITATIONS: readonly string[] = [
  'diligence_memo',
  'virtual_inspection',
];

/** Kinds that must never read as a legal guarantee (brief §8: no automatic legal guarantee). */
export const REPORT_KINDS_WITHOUT_GUARANTEES: readonly string[] = ['diligence_memo'];

export interface TemplateSection {
  key: string;
  heading: string;
  guidance?: string;
  required: boolean;
}

/** Fallback outline when no active template of the kind exists (headings only, no wording). */
export const FALLBACK_SECTIONS: Record<ServiceRequestReportKind, TemplateSection[]> = {
  diligence_memo: [
    { key: 'summary', heading: 'Summary of findings', required: true },
    { key: 'documents', heading: 'Documents reviewed', required: true },
    { key: 'survey', heading: 'Survey and site', required: false },
    { key: 'red_flags', heading: 'Red flags and open queries', required: true },
    { key: 'recommendation', heading: 'Recommendation', required: true },
  ],
  virtual_inspection: [
    { key: 'summary', heading: 'Summary', required: true },
    { key: 'checklist', heading: 'Checklist results', required: true },
    { key: 'findings', heading: 'Findings and severity', required: true },
    { key: 'next_steps', heading: 'Recommended next steps', required: false },
  ],
};

/**
 * Markdown skeleton from template sections: one level-2 heading per section
 * and nothing else. Guidance is for authors and never enters the report body.
 */
export function bodyFromSections(sections: readonly TemplateSection[]): string {
  return sections.map((s) => `## ${s.heading.trim()}\n\n`).join('');
}

function normalizeHeading(h: string): string {
  return h
    .replace(/[#*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Splits markdown into level-1/2 sections: heading → content (HTML comments removed). */
export function markdownSections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null) {
      const text = buffer
        .join('\n')
        .replace(/<!--[\s\S]*?-->/g, '')
        .trim();
      const prev = out.get(current);
      out.set(current, prev ? `${prev}\n${text}`.trim() : text);
    }
  };
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      current = normalizeHeading(m[2]!);
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

/** Required template sections that are missing or empty in the body. */
export function missingRequiredSections(
  bodyMarkdown: string,
  sections: readonly TemplateSection[],
): TemplateSection[] {
  const present = markdownSections(bodyMarkdown);
  return sections.filter((s) => {
    if (!s.required) return false;
    const content = present.get(normalizeHeading(s.heading));
    return content === undefined || content.length === 0;
  });
}

/**
 * Affirmative guarantee wording ("we guarantee…", "title is guaranteed",
 * "certify that the title is good"). Disclaimers such as "this memorandum is
 * not a guarantee" are not matched.
 */
const GUARANTEE_PATTERNS: readonly RegExp[] = [
  /\b(?:we|simplexd|the (?:firm|company|reviewer|team))\s+(?:hereby\s+)?(?:guarantee|warrant|certify|assure)s?\b/i,
  /\b(?:title|ownership|property|documents?)\s+(?:is|are)\s+(?:hereby\s+)?(?:guaranteed|certified|warranted)\b/i,
  /\bguaranteed\s+(?:good|clean|valid|perfect|genuine|free)\b/i,
  /\b(?:100%|fully|completely)\s+(?:safe|risk[- ]free|secure)\s+(?:to\s+buy|purchase|investment|title)\b/i,
];

export function findGuaranteeWording(text: string): string[] {
  const hits: string[] = [];
  for (const re of GUARANTEE_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}

export interface ReportContentProblem {
  code: 'scope_limitations_required' | 'section_missing' | 'guarantee_wording';
  message: string;
  section?: string;
}

/**
 * Content checks applied when a report is submitted for review and again at
 * release, so an approved revision that no longer meets them cannot go out.
 */
export function checkReportContent(input: {
  kind: string;
  bodyMarkdown: string;
  summary?: string | null;
  scopeLimitations: string | null;
  sections: readonly TemplateSection[];
}): ReportContentProblem[] {
  const problems: ReportContentProblem[] = [];
  if (
    REPORT_KINDS_REQUIRING_LIMITATIONS.includes(input.kind) &&
    !(input.scopeLimitations && input.scopeLimitations.trim().length > 0)
  ) {
    problems.push({
      code: 'scope_limitations_required',
      message: 'state the scope and limitations of this report before it is reviewed or released',
    });
  }
  for (const s of missingRequiredSections(input.bodyMarkdown, input.sections)) {
    problems.push({
      code: 'section_missing',
      section: s.key,
      message: `the required section "${s.heading}" is missing or empty`,
    });
  }
  if (REPORT_KINDS_WITHOUT_GUARANTEES.includes(input.kind)) {
    const text = [input.summary ?? '', input.bodyMarkdown, input.scopeLimitations ?? ''].join('\n');
    for (const hit of findGuaranteeWording(text)) {
      problems.push({
        code: 'guarantee_wording',
        message: `remove guarantee wording ("${hit}"): the memorandum records findings within its stated scope and is not a legal guarantee`,
      });
    }
  }
  return problems;
}

/** Reads template sections stored on a revision's structured findings; tolerant of any shape. */
export function sectionsFromFindings(findings: unknown): TemplateSection[] {
  if (!findings || typeof findings !== 'object') return [];
  const template = (findings as { template?: unknown }).template;
  if (!template || typeof template !== 'object') return [];
  const sections = (template as { sections?: unknown }).sections;
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((s) => {
    if (!s || typeof s !== 'object') return [];
    const o = s as Record<string, unknown>;
    if (typeof o['key'] !== 'string' || typeof o['heading'] !== 'string') return [];
    return [{ key: o['key'], heading: o['heading'], required: o['required'] === true }];
  });
}
