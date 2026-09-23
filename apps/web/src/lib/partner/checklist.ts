import type { ChecklistItem } from './offline/types';

/**
 * Staff attach a checklist to a scheduled visit as free JSON. Accepts the
 * shapes we have seen (array of strings, array of {key,label,...}, or our own
 * {items:[...]} envelope) and falls back to a single item carrying the raw
 * text so nothing is silently dropped.
 */
export function normalizeChecklist(raw: unknown): ChecklistItem[] {
  if (raw === null || raw === undefined) return [];
  const source =
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : raw;
  if (Array.isArray(source)) {
    const out: ChecklistItem[] = [];
    source.forEach((entry, index) => {
      if (typeof entry === 'string') {
        out.push({ key: `item_${index + 1}`, label: entry, checked: false });
      } else if (typeof entry === 'object' && entry !== null) {
        const e = entry as Record<string, unknown>;
        const label = String(e.label ?? e.title ?? e.text ?? e.name ?? `Item ${index + 1}`);
        out.push({
          key: String(e.key ?? e.id ?? `item_${index + 1}`),
          label,
          checked: Boolean(e.checked ?? e.done ?? false),
          note: typeof e.note === 'string' ? e.note : undefined,
        });
      }
    });
    return out;
  }
  if (typeof source === 'string' && source.trim()) {
    return source
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
      .filter(Boolean)
      .map((label, index) => ({ key: `item_${index + 1}`, label, checked: false }));
  }
  return [{ key: 'raw', label: JSON.stringify(source), checked: false }];
}
