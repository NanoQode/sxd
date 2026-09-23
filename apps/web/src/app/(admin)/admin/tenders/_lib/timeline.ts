import { DateTime } from 'luxon';
import { validateTenderTimeline, type TenderStageTimestamps } from '@simplexd/domain/timelines';

/** Tender timeline fields in canonical order (shared by the server page and the client form). */
export const TIMELINE_FIELDS: Array<{
  key: keyof TenderStageTimestamps;
  label: string;
  required?: boolean;
}> = [
  { key: 'releaseAt', label: 'Release', required: true },
  { key: 'siteVisitAt', label: 'Site visit' },
  { key: 'questionCutoffAt', label: 'Question cut-off' },
  { key: 'answersPublishedAt', label: 'Answers published' },
  { key: 'submissionDeadlineAt', label: 'Submission deadline', required: true },
  { key: 'evaluationCompleteAt', label: 'Evaluation complete' },
  { key: 'awardTargetAt', label: 'Award target' },
];

const STAGE_LABEL: Record<string, string> = {
  tender_release: 'Release',
  site_visit: 'Site visit',
  question_cutoff: 'Question cut-off',
  answer_publication: 'Answers published',
  submission_deadline: 'Submission deadline',
  evaluation: 'Evaluation complete',
  award: 'Award target',
};

/** Wall-clock input (in the tender's display zone) to an ISO instant with offset; null when blank or invalid. */
export function wallClockToIso(value: string, zone: string): string | null {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone });
  return dt.isValid ? dt.toISO({ suppressMilliseconds: true }) : null;
}

export function isoToWallClock(iso: string | null | undefined, zone: string): string {
  if (!iso) return '';
  const dt = DateTime.fromISO(iso).setZone(zone);
  return dt.isValid ? dt.toFormat("yyyy-LL-dd'T'HH:mm") : '';
}

/** Human messages for timeline problems, e.g. "Question cut-off must be after Site visit." */
export function timelineMessages(
  values: Partial<Record<keyof TenderStageTimestamps, string | null>>,
): string[] {
  const result = validateTenderTimeline({
    releaseAt: values.releaseAt ?? '',
    siteVisitAt: values.siteVisitAt ?? null,
    questionCutoffAt: values.questionCutoffAt ?? null,
    answersPublishedAt: values.answersPublishedAt ?? null,
    submissionDeadlineAt: values.submissionDeadlineAt ?? '',
    evaluationCompleteAt: values.evaluationCompleteAt ?? null,
    awardTargetAt: values.awardTargetAt ?? null,
  });
  return result.violations.map((v) => {
    const stage = STAGE_LABEL[v.stage] ?? v.stage;
    if (v.code === 'missing_required') return `${stage} is required.`;
    if (v.code === 'invalid_timestamp') return `${stage} is not a valid date and time.`;
    return `${stage} must be after ${STAGE_LABEL[v.previousStage ?? ''] ?? v.previousStage}.`;
  });
}
