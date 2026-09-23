'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type {
  FileDto,
  OwnerAuthorityDto,
  ParcelDto,
  PropertyDto,
  UnitDto,
  UnitStatus,
} from '@simplexd/contracts';
import {
  Alert,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  EmptyState,
  Field,
  Input,
  NativeSelect,
  StatusBadge,
  Textarea,
  formatDateTimeLabel,
  humanize,
  useToast,
} from '@simplexd/ui';
import { describeError, portalFetch } from '@/lib/portal/client';
import { ErrorState } from './error-state';
import { FileUploader } from './file-uploader';
import { PropertyForm } from './property-form';
import { SignedDownloadButton } from './signed-download';

type Err = { message: string; correlationId: string | null } | null;

/** Edit button + dialog around the property form. */
export function EditPropertyButton({
  property,
  canManage,
}: {
  property: PropertyDto;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!canManage) return null;
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Edit property
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title={`Edit ${property.name}`}
          description={`Version ${property.version}; concurrent edits are detected and refused.`}
          size="lg"
        >
          <PropertyForm property={property} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

const UNIT_STATUSES: UnitStatus[] = ['vacant', 'occupied', 'unavailable'];

export function UnitsPanel({
  propertyId,
  units,
  canManage,
  zone,
}: {
  propertyId: string;
  units: UnitDto[];
  canManage: boolean;
  zone: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [editing, setEditing] = useState<UnitDto | null | 'new'>(null);
  const [form, setForm] = useState({
    label: '',
    unitType: '',
    bedrooms: '',
    bathrooms: '',
    floorAreaM2: '',
    status: 'vacant' as UnitStatus,
    notes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);

  function open(unit: UnitDto | 'new') {
    setError(null);
    setForm(
      unit === 'new'
        ? {
            label: '',
            unitType: '',
            bedrooms: '',
            bathrooms: '',
            floorAreaM2: '',
            status: 'vacant',
            notes: '',
          }
        : {
            label: unit.label,
            unitType: unit.unitType,
            bedrooms: unit.bedrooms?.toString() ?? '',
            bathrooms: unit.bathrooms?.toString() ?? '',
            floorAreaM2: unit.floorAreaM2 ?? '',
            status: unit.status,
            notes: unit.notes ?? '',
          },
    );
    setEditing(unit);
  }

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      label: form.label.trim(),
      unitType: form.unitType.trim(),
      bedrooms: form.bedrooms ? Number(form.bedrooms) : null,
      bathrooms: form.bathrooms ? Number(form.bathrooms) : null,
      floorAreaM2: form.floorAreaM2.trim() || null,
      status: form.status,
      notes: form.notes.trim() || null,
    };
    try {
      if (editing === 'new') await portalFetch(`/api/v1/properties/${propertyId}/units`, { body });
      else if (editing)
        await portalFetch(`/api/v1/properties/${propertyId}/units/${editing.id}`, {
          method: 'PATCH',
          body,
        });
      toast({ title: editing === 'new' ? 'Unit added' : 'Unit updated', tone: 'success' });
      setEditing(null);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  async function remove(unit: UnitDto) {
    if (!window.confirm(`Delete unit ${unit.label}? This is refused when leases reference it.`))
      return;
    try {
      await portalFetch(`/api/v1/properties/${propertyId}/units/${unit.id}`, { method: 'DELETE' });
      toast({ title: 'Unit deleted', tone: 'success' });
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      toast({
        title: 'Could not delete',
        description: e.correlationId
          ? `${e.message} (ref ${e.correlationId.slice(0, 8)})`
          : e.message,
        tone: 'danger',
      });
    }
  }

  return (
    <div className="space-y-4">
      {canManage ? (
        <Button type="button" variant="secondary" onClick={() => open('new')}>
          Add unit
        </Button>
      ) : null}
      {units.length === 0 ? (
        <EmptyState
          title="No units"
          description="Units (flats, shops, rooms) let the team track occupancy and leases per space."
        />
      ) : (
        <DataTable
          caption="Units"
          rows={units}
          rowKey={(u) => u.id}
          rowLabel={(u) => `Unit ${u.label}`}
          columns={[
            {
              key: 'label',
              header: 'Label',
              cell: (u) => <span className="font-medium">{u.label}</span>,
            },
            { key: 'type', header: 'Type', cell: (u) => u.unitType },
            {
              key: 'beds',
              header: 'Bed / bath',
              cell: (u) => `${u.bedrooms ?? '—'} / ${u.bathrooms ?? '—'}`,
            },
            {
              key: 'area',
              header: 'Floor m²',
              cell: (u) => u.floorAreaM2 ?? '—',
              hideOnMobile: true,
            },
            { key: 'status', header: 'Status', cell: (u) => <StatusBadge status={u.status} /> },
            {
              key: 'updated',
              header: 'Updated',
              cell: (u) => formatDateTimeLabel(u.updatedAt, zone),
              hideOnMobile: true,
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              mobileLabel: 'Actions',
              cell: (u) =>
                canManage ? (
                  <span className="flex gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => open(u)}>
                      Edit
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void remove(u)}>
                      Delete
                    </Button>
                  </span>
                ) : (
                  <span className="text-fg-muted">View only</span>
                ),
            },
          ]}
        />
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent
          title={editing === 'new' ? 'Add a unit' : `Edit unit ${editing?.label ?? ''}`}
          description="Labels must be unique within the property."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="space-y-4"
          >
            {error ? (
              <ErrorState
                title="Could not save"
                message={error.message}
                correlationId={error.correlationId}
              />
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Label" required>
                {({ id }) => (
                  <Input
                    id={id}
                    value={form.label}
                    onChange={(e) => setForm({ ...form, label: e.target.value })}
                    maxLength={60}
                    required
                  />
                )}
              </Field>
              <Field label="Unit type" required hint="e.g. 2-bed flat, shop, office">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    value={form.unitType}
                    onChange={(e) => setForm({ ...form, unitType: e.target.value })}
                    maxLength={60}
                    required
                  />
                )}
              </Field>
              <Field label="Bedrooms">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={50}
                    value={form.bedrooms}
                    onChange={(e) => setForm({ ...form, bedrooms: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Bathrooms">
                {({ id }) => (
                  <Input
                    id={id}
                    type="number"
                    min={0}
                    max={50}
                    value={form.bathrooms}
                    onChange={(e) => setForm({ ...form, bathrooms: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Floor area (m²)">
                {({ id }) => (
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={form.floorAreaM2}
                    onChange={(e) => setForm({ ...form, floorAreaM2: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Status">
                {({ id }) => (
                  <NativeSelect
                    id={id}
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as UnitStatus })}
                  >
                    {UNIT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {humanize(s)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <Field label="Notes" className="sm:col-span-2">
                {({ id }) => (
                  <Textarea
                    id={id}
                    rows={2}
                    maxLength={2000}
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                )}
              </Field>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditing(null)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Save unit
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function ParcelsPanel({
  propertyId,
  parcels,
  canManage,
}: {
  propertyId: string;
  parcels: ParcelDto[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    reference: '',
    surveyPlanRef: '',
    areaValue: '',
    areaUnit: 'm2',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await portalFetch(`/api/v1/properties/${propertyId}/parcels`, {
        body: {
          reference: form.reference.trim() || null,
          surveyPlanRef: form.surveyPlanRef.trim() || null,
          area: form.areaValue.trim()
            ? { value: form.areaValue.trim(), unit: form.areaUnit }
            : null,
        },
      });
      toast({ title: 'Parcel added', tone: 'success' });
      setOpen(false);
      setForm({ reference: '', surveyPlanRef: '', areaValue: '', areaUnit: 'm2' });
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({ message: e.message, correlationId: e.correlationId });
    } finally {
      setBusy(false);
    }
  }

  async function remove(parcel: ParcelDto) {
    if (!window.confirm(`Delete parcel ${parcel.reference ?? parcel.id.slice(0, 8)}?`)) return;
    try {
      await portalFetch(`/api/v1/properties/${propertyId}/parcels/${parcel.id}`, {
        method: 'DELETE',
      });
      toast({ title: 'Parcel deleted', tone: 'success' });
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      toast({ title: 'Could not delete', description: e.message, tone: 'danger' });
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Parcels</h3>
        {canManage ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Add parcel
          </Button>
        ) : null}
      </div>
      {parcels.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No parcels recorded. Add survey plan references so due diligence can be tied to the exact
          land.
        </p>
      ) : (
        <ul className="space-y-2 text-sm">
          {parcels.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
            >
              <span>
                <span className="font-medium">{p.reference ?? 'Unreferenced parcel'}</span>
                {p.surveyPlanRef ? ` · survey plan ${p.surveyPlanRef}` : ''}
                {p.area
                  ? ` · ${p.area.declaredValue} ${p.area.declaredUnit}${p.area.m2 ? ` (${p.area.m2} m²)` : ' (not converted)'}`
                  : ''}
                {p.boundary ? ' · boundary recorded' : ''}
              </span>
              {canManage ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => void remove(p)}>
                  Delete
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Add a parcel"
          description="Boundaries (GeoJSON) can be added by the survey team later."
          size="sm"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="space-y-4"
          >
            {error ? (
              <ErrorState
                title="Could not add"
                message={error.message}
                correlationId={error.correlationId}
              />
            ) : null}
            <Field label="Reference">
              {({ id }) => (
                <Input
                  id={id}
                  value={form.reference}
                  onChange={(e) => setForm({ ...form, reference: e.target.value })}
                  maxLength={120}
                />
              )}
            </Field>
            <Field label="Survey plan reference">
              {({ id }) => (
                <Input
                  id={id}
                  value={form.surveyPlanRef}
                  onChange={(e) => setForm({ ...form, surveyPlanRef: e.target.value })}
                  maxLength={120}
                />
              )}
            </Field>
            <Field label="Area (as declared)">
              {({ id }) => (
                <div className="flex gap-2">
                  <Input
                    id={id}
                    inputMode="decimal"
                    value={form.areaValue}
                    onChange={(e) => setForm({ ...form, areaValue: e.target.value })}
                  />
                  <NativeSelect
                    aria-label="Area unit"
                    className="w-28"
                    value={form.areaUnit}
                    onChange={(e) => setForm({ ...form, areaUnit: e.target.value })}
                  >
                    {['m2', 'sqft', 'ha', 'acre', 'plot'].map((u) => (
                      <option key={u} value={u}>
                        {u === 'm2' ? 'm²' : u}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy}>
                Add parcel
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function OwnerAuthorityPanel({
  propertyId,
  authorities,
  canManage,
  zone,
}: {
  propertyId: string;
  authorities: OwnerAuthorityDto[];
  canManage: boolean;
  zone: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [ownerName, setOwnerName] = useState('');
  const [note, setNote] = useState('');
  const [document, setDocument] = useState<FileDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err>(null);

  async function submit() {
    if (!document) {
      setError({ message: 'Upload the signed authority document first.', correlationId: null });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await portalFetch(`/api/v1/properties/${propertyId}/owner-authorities`, {
        body: {
          ownerName: ownerName.trim(),
          authorityDocumentFileId: document.id,
          note: note.trim() || null,
        },
      });
      toast({
        title: 'Owner authority submitted',
        description: 'The team verifies it before listing or management work starts.',
        tone: 'success',
      });
      setOpen(false);
      setOwnerName('');
      setNote('');
      setDocument(null);
      router.refresh();
    } catch (err) {
      const e = describeError(err);
      setError({
        message:
          e.code === 'file_quarantined'
            ? 'The document is still being scanned; try again in a moment.'
            : e.message,
        correlationId: e.correlationId,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Owner authority</h3>
        {canManage ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Submit authority
          </Button>
        ) : null}
      </div>
      {authorities.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No owner authority on file. Listing, letting or managing this property needs a verified
          authority from the owner.
        </p>
      ) : (
        <ul className="space-y-2 text-sm">
          {authorities.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{a.ownerName}</span>
                <StatusBadge status={a.effectiveStatus} />
                <span className="text-fg-muted">
                  submitted {formatDateTimeLabel(a.createdAt, zone)}
                </span>
                {a.expiresAt ? (
                  <span className="text-fg-muted">
                    · expires {formatDateTimeLabel(a.expiresAt, zone)}
                  </span>
                ) : null}
                {a.note ? <span className="text-fg-muted">· {a.note}</span> : null}
              </span>
              {a.authorityDocumentFileId ? (
                <SignedDownloadButton
                  fileId={a.authorityDocumentFileId}
                  fileName="authority document"
                  status="clean"
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Submit an owner authority"
          description="Upload the signed authority (letter, power of attorney or mandate) and name the owner."
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-4"
          >
            {error ? (
              <ErrorState
                title="Could not submit"
                message={error.message}
                correlationId={error.correlationId}
              />
            ) : null}
            <Field label="Owner's full name" required>
              {({ id }) => (
                <Input
                  id={id}
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  minLength={2}
                  maxLength={160}
                  required
                />
              )}
            </Field>
            <div>
              <p className="mb-2 text-sm font-medium">Authority document</p>
              {document ? (
                <Alert
                  tone={document.status === 'clean' ? 'success' : 'info'}
                  title={document.originalName}
                >
                  {document.status === 'clean'
                    ? 'Scanned clean and ready to submit.'
                    : `Status: ${humanize(document.status)}.`}
                </Alert>
              ) : (
                <FileUploader
                  purpose="org_document"
                  entityType="property"
                  entityId={propertyId}
                  multiple={false}
                  compact
                  label="Upload document"
                  hint="PDF or image."
                  refreshOnSettle={false}
                  onUploaded={setDocument}
                />
              )}
            </div>
            <Field label="Note">
              {({ id }) => (
                <Textarea
                  id={id}
                  rows={2}
                  maxLength={2000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!document}>
                Submit for verification
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
