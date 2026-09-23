'use client';

import { DIALOG_MAX_H } from '@/lib/admin/dialog';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { leaseKindSchema, rentPeriodSchema, type LeaseDto } from '@simplexd/contracts';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  Input,
  NativeSelect,
  humanize,
  useToast,
} from '@simplexd/ui';
import { adminFetch, errorMessage } from '@/lib/admin/client';
import { parseNairaToKobo } from '@/lib/admin/money';

/**
 * Draft lease on a property (and optionally a unit). Rent collected under the
 * lease belongs to the owner; SimplexD's management fee is configured here and
 * posted separately.
 */
export function LeaseCreateDialog({
  properties,
}: {
  properties: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [propertyId, setPropertyId] = useState('');
  const [units, setUnits] = useState<Array<{ id: string; label: string }>>([]);
  const [unitId, setUnitId] = useState('');
  const [kind, setKind] = useState('residential_annual');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [rent, setRent] = useState('');
  const [period, setPeriod] = useState('annual');
  const [deposit, setDeposit] = useState('0');
  const [feeBasis, setFeeBasis] = useState('none');
  const [feePercent, setFeePercent] = useState('');
  const [feeFixed, setFeeFixed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!propertyId) return;
    let cancelled = false;
    adminFetch<{ items: Array<{ id: string; label: string }> }>(
      `/api/v1/properties/${propertyId}/units`,
    )
      .then((res) => {
        if (!cancelled) setUnits(res.items ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  const rentKobo = parseNairaToKobo(rent);
  const depositKobo = parseNairaToKobo(deposit || '0');
  const feeBps = feePercent ? Math.round(Number(feePercent) * 100) : null;
  const feeFixedKobo = feeFixed ? parseNairaToKobo(feeFixed) : null;
  const ready =
    Boolean(propertyId && startDate) &&
    rentKobo !== null &&
    BigInt(rentKobo) > 0n &&
    depositKobo !== null &&
    (feeBasis !== 'percentage_of_collected' ||
      (feeBps !== null && feeBps > 0 && feeBps <= 10_000)) &&
    (feeBasis !== 'fixed_monthly' || (feeFixedKobo !== null && BigInt(feeFixedKobo) > 0n)) &&
    (!endDate || endDate > startDate);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const lease = await adminFetch<LeaseDto>('/api/v1/leases', {
        body: {
          propertyId,
          unitId: unitId || null,
          kind,
          startDate,
          endDate: endDate || null,
          rentAmountKobo: rentKobo,
          rentPeriod: period,
          depositKobo,
          managementFeeBasis: feeBasis,
          managementFeeBps: feeBasis === 'percentage_of_collected' ? feeBps : null,
          managementFeeFixedKobo: feeBasis === 'fixed_monthly' ? feeFixedKobo : null,
        },
      });
      toast({ title: 'Draft lease created', tone: 'success' });
      setOpen(false);
      router.push(`/admin/rentals/leases/${lease.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New lease</Button>
      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent
          className={DIALOG_MAX_H}
          title="New lease (draft)"
          description="Terms are editable until the lease becomes active; the rent schedule is generated on activation."
          size="lg"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {error ? (
              <div className="sm:col-span-2">
                <Alert tone="danger" title="Not created">
                  {error}
                </Alert>
              </div>
            ) : null}
            <Field label="Property" required>
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={propertyId}
                  onChange={(e) => {
                    setPropertyId(e.target.value);
                    setUnitId('');
                    setUnits([]);
                  }}
                >
                  <option value="">Choose</option>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field
              label="Unit"
              hint={
                propertyId && units.length === 0
                  ? 'No units recorded; the lease covers the whole property.'
                  : undefined
              }
            >
              {({ id, describedBy }) => (
                <NativeSelect
                  id={id}
                  aria-describedby={describedBy}
                  value={unitId}
                  onChange={(e) => setUnitId(e.target.value)}
                  disabled={units.length === 0}
                >
                  <option value="">Whole property</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Kind" required>
              {({ id }) => (
                <NativeSelect id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
                  {leaseKindSchema.options.map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Rent period" required>
              {({ id }) => (
                <NativeSelect id={id} value={period} onChange={(e) => setPeriod(e.target.value)}>
                  {rentPeriodSchema.options.map((k) => (
                    <option key={k} value={k}>
                      {humanize(k)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
            <Field label="Start date" required>
              {({ id }) => (
                <Input
                  id={id}
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="End date"
              error={
                endDate && startDate && endDate <= startDate ? 'End must be after start' : undefined
              }
            >
              {({ id }) => (
                <Input
                  id={id}
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Rent per period (₦)"
              required
              error={rent && rentKobo === null ? 'Enter a naira amount' : undefined}
            >
              {({ id }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={rent}
                  onChange={(e) => setRent(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Deposit (₦)"
              error={depositKobo === null ? 'Enter a naira amount' : undefined}
            >
              {({ id }) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                />
              )}
            </Field>
            <Field label="Management fee basis">
              {({ id }) => (
                <NativeSelect
                  id={id}
                  value={feeBasis}
                  onChange={(e) => setFeeBasis(e.target.value)}
                >
                  <option value="none">None</option>
                  <option value="percentage_of_collected">Percentage of rent collected</option>
                  <option value="fixed_monthly">Fixed monthly</option>
                </NativeSelect>
              )}
            </Field>
            {feeBasis === 'percentage_of_collected' ? (
              <Field label="Fee %" required>
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={feePercent}
                    onChange={(e) => setFeePercent(e.target.value)}
                    placeholder="e.g. 10"
                  />
                )}
              </Field>
            ) : feeBasis === 'fixed_monthly' ? (
              <Field label="Fixed fee per month (₦)" required>
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={feeFixed}
                    onChange={(e) => setFeeFixed(e.target.value)}
                  />
                )}
              </Field>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!ready} onClick={() => void create()}>
              Create draft lease
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
