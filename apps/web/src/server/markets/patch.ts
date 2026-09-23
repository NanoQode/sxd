/**
 * Zod 4 fills default values for keys that are absent from a `.partial()`
 * object, so a validated PATCH body would otherwise reset every defaulted
 * field the client did not send. This keeps only the keys the client sent.
 */
export function pickPresentKeys<T extends object>(raw: unknown, parsed: T): Partial<T> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const present = new Set(Object.keys(raw as Record<string, unknown>));
  const out: Partial<T> = {};
  for (const key of Object.keys(parsed) as Array<keyof T & string>) {
    if (present.has(key)) out[key] = parsed[key];
  }
  return out;
}
