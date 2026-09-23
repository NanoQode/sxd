/**
 * Pure helpers that turn admin form values into request bodies. Server
 * components cannot pass functions to client components, so dialogs rendered
 * from server pages describe their body declaratively (field keys, dotted
 * paths, empty handling, static extras) or name a transform registered here.
 */

export type FormValues = Record<string, string | number | boolean | null | undefined>;

export interface BodyFieldSpec {
  name: string;
  /** Dotted path in the request body; defaults to `name`. */
  bodyKey?: string;
  /** How an empty value is sent: omitted (default) or explicit null. */
  emptyAs?: 'omit' | 'null';
  /** Comma-separated input sent as a string array. */
  list?: boolean;
  /** UI-only field (used by a transform), never copied into the body. */
  omitFromBody?: boolean;
}

/** Sets a dotted path on an object, creating intermediate objects. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cursor[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

export function splitList(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Maps normalised values to a body using the field specs and static extras (dotted keys allowed). */
export function buildBody(
  fields: BodyFieldSpec[],
  values: FormValues,
  extraBody?: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.omitFromBody) continue;
    const raw = values[f.name];
    const empty = raw === undefined || raw === null || raw === '';
    let value: unknown = raw;
    if (f.list) value = empty ? [] : splitList(raw);
    else if (empty) {
      if (f.emptyAs === 'null') value = null;
      else continue;
    }
    setPath(body, f.bodyKey ?? f.name, value);
  }
  if (extraBody) for (const [k, v] of Object.entries(extraBody)) setPath(body, k, v);
  return body;
}

/** Special-case transforms referenced by name from server pages. */
export const FORM_TRANSFORMS = {
  /** Permit application: the statutory target is sent only with both days and a source. */
  permitApplication: (values: FormValues, extra: Record<string, unknown>) => ({
    jurisdiction: values.jurisdiction,
    authority: values.authority,
    permitType: values.permitType,
    documentType: values.documentType || null,
    applicationReference: values.applicationReference || null,
    feesKobo: values.feesKobo || null,
    propertyId: extra.propertyId ?? null,
    statutoryTarget:
      values.statutoryDays && values.statutorySource
        ? {
            days: Number(values.statutoryDays),
            basis: values.statutoryBasis || 'business',
            sourceNote: values.statutorySource,
          }
        : null,
    notes: values.notes || null,
  }),
} satisfies Record<string, (values: FormValues, extra: Record<string, unknown>) => unknown>;

export type FormTransformName = keyof typeof FORM_TRANSFORMS;

/** Replaces `{id}` (or any `{key}`) in a redirect template with fields of the API result. */
export function fillTemplate(template: string, result: unknown): string {
  const rec = (typeof result === 'object' && result !== null ? result : {}) as Record<
    string,
    unknown
  >;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    encodeURIComponent(String(rec[key] ?? '')),
  );
}
