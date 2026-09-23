'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  Textarea,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';

/** One 0–100 score per criterion; re-scoring replaces your previous row for this bid. */
export function ScoreBid({
  bidId,
  label,
  criteria,
  weights,
  existing,
}: {
  bidId: string;
  label: string;
  criteria: string[];
  weights: Record<string, number>;
  existing: Record<string, number> | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [scores, setScores] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      criteria.map((c) => [c, existing?.[c] !== undefined ? String(existing[c]) : '']),
    ),
  );
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = Object.fromEntries(criteria.map((c) => [c, Number(scores[c])]));
  const valid = criteria.every(
    (c) => scores[c] !== '' && Number.isFinite(parsed[c]) && parsed[c]! >= 0 && parsed[c]! <= 100,
  );
  const total = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  const weighted = valid
    ? criteria.reduce((s, c) => s + parsed[c]! * ((weights[c] ?? 0) / total), 0)
    : null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(`/api/v1/bids/${bidId}/evaluations`, {
        body: { scores: parsed, notes: notes.trim() || null },
      });
      toast({ title: 'Scores saved', tone: 'success' });
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        {existing ? 'Re-score' : 'Score'}
      </Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          title={`Score ${label}`}
          description="Each criterion 0–100. The weighted score uses the tender's published weights."
        >
          <div className="space-y-3">
            {error ? (
              <Alert tone="danger" title="Not saved">
                {error}
              </Alert>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              {criteria.map((c) => (
                <Field key={c} label={`${c} (weight ${weights[c]})`} required>
                  {({ id }) => (
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      max={100}
                      value={scores[c] ?? ''}
                      onChange={(e) => setScores((prev) => ({ ...prev, [c]: e.target.value }))}
                    />
                  )}
                </Field>
              ))}
            </div>
            <Field label="Notes">
              {({ id }) => (
                <Textarea
                  id={id}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={4000}
                  className="min-h-16"
                />
              )}
            </Field>
            <p className="text-sm" aria-live="polite">
              Weighted score preview:{' '}
              <strong>{weighted === null ? '—' : weighted.toFixed(2)}</strong>
            </p>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button loading={busy} disabled={!valid} onClick={() => void save()}>
                Save scores
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
