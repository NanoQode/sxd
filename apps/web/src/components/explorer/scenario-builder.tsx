'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  FormProvider,
  useFieldArray,
  useFormContext,
  useForm,
  useWatch,
  type FieldErrors,
  type FieldPath,
} from 'react-hook-form';
import { Button, Field, Input, NativeSelect, Textarea } from '@simplexd/ui';
import {
  COPY,
  assumptionsFromForm,
  formFromAssumptions,
  missingAssumptionInputs,
  scenarioFormSchema,
  stableKey,
  type ScenarioFormInput,
  type ScenarioFormOutput,
} from '@/lib/explorer';
import { CalculatorResults } from './calculator-results';
import { useExplorer } from './explorer-context';
import { useDebouncedValue } from './use-debounced-value';

/**
 * Assumption-mode scenario builder: base/low/high input sets with explicit
 * units (whole naira, m², months, percentages) feeding the calculator
 * service. Blank optional inputs stay missing; the calculators say what is
 * still needed instead of inventing a value.
 */

function errorAt(errors: FieldErrors<ScenarioFormInput>, path: string): string | undefined {
  let node: unknown = errors;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  const message = (node as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}

function NumberField({
  name,
  label,
  unit,
  hint,
}: {
  name: FieldPath<ScenarioFormInput>;
  label: string;
  unit?: string;
  hint?: ReactNode;
}) {
  const {
    register,
    formState: { errors },
  } = useFormContext<ScenarioFormInput>();
  const error = errorAt(errors, name);
  return (
    <Field label={unit ? `${label} (${unit})` : label} hint={hint} error={error}>
      {({ id, describedBy, invalid }) => (
        <Input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} inputMode="decimal" autoComplete="off" {...register(name)} />
      )}
    </Field>
  );
}

function SectionCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {description ? <p className="mb-2 text-xs text-fg-muted">{description}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function UnitGroups() {
  const { control, register, formState: { errors } } = useFormContext<ScenarioFormInput>();
  const { fields, append, remove } = useFieldArray({ control, name: 'units' });
  return (
    <div className="sm:col-span-2 space-y-2">
      {fields.length === 0 ? <p className="text-xs text-fg-muted">Add at least one unit group (e.g. 4 × 3-bed flats at ₦3,000,000 per year).</p> : null}
      {fields.map((field, index) => (
        <div key={field.id} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_auto_1fr_auto]">
          <Field label="Unit label" error={errorAt(errors, `units.${index}.label`)}>
            {({ id }) => <Input id={id} placeholder="3-bed flats" {...register(`units.${index}.label`)} />}
          </Field>
          <Field label="Count" error={errorAt(errors, `units.${index}.count`)}>
            {({ id, invalid }) => <Input id={id} inputMode="numeric" aria-invalid={invalid || undefined} className="sm:w-24" {...register(`units.${index}.count`)} />}
          </Field>
          <Field label="Annual rent per unit (₦)" error={errorAt(errors, `units.${index}.annualRentPerUnitNaira`)}>
            {({ id, invalid }) => <Input id={id} inputMode="decimal" aria-invalid={invalid || undefined} {...register(`units.${index}.annualRentPerUnitNaira`)} />}
          </Field>
          <div className="flex items-end">
            <Button size="icon" variant="ghost" aria-label={`Remove unit group ${index + 1}`} onClick={() => remove(index)}>
              <Trash2 aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button variant="secondary" onClick={() => append({ label: '', count: '1', annualRentPerUnitNaira: '' })}>
        <Plus aria-hidden="true" className="h-4 w-4" /> Add unit group
      </Button>
    </div>
  );
}

function SetFields({ set }: { set: 'low' | 'high' }) {
  const { register, control } = useFormContext<ScenarioFormInput>();
  const enabled = useWatch({ control, name: `${set}.enabled` });
  const units = useWatch({ control, name: 'units' }) ?? [];
  const label = set === 'low' ? 'Low case' : 'High case';
  return (
    <fieldset className="rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-semibold">{label}</legend>
      <label className="sx-touch flex items-center gap-2 text-sm">
        <input type="checkbox" className="h-5 w-5 accent-[var(--sx-primary)]" {...register(`${set}.enabled`)} />
        Run a {set} input set (blank fields inherit the base)
      </label>
      {enabled ? (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <NumberField name={`${set}.vacancyPercent`} label="Vacancy rate" unit="%" />
          <NumberField name={`${set}.landCostNaira`} label="Land cost" unit="₦" />
          <NumberField name={`${set}.buildRateNairaPerM2`} label="Build rate" unit="₦ per m²" />
          <NumberField name={`${set}.completionDelayMonths`} label="Completion delay" unit="months" />
          <NumberField name={`${set}.annualDebtServiceNaira`} label="Annual debt service" unit="₦" />
          {units.map((group, index) => (
            <NumberField key={index} name={`${set}.unitRents.${index}`} label={`Annual rent per unit: ${group?.label || `group ${index + 1}`}`} unit="₦" />
          ))}
        </div>
      ) : null}
    </fieldset>
  );
}

export function ScenarioBuilder() {
  const { assumptions, setAssumptions, calculators, calculatorsUsable } = useExplorer();
  const form = useForm<ScenarioFormInput, unknown, ScenarioFormOutput>({
    resolver: zodResolver(scenarioFormSchema),
    defaultValues: formFromAssumptions(assumptions),
    mode: 'onBlur',
  });
  const appliedKeyRef = useRef(stableKey(assumptions));

  // Scenario loaded from the server or a draft: refresh the form.
  useEffect(() => {
    const key = stableKey(assumptions);
    if (key === appliedKeyRef.current) return;
    appliedKeyRef.current = key;
    form.reset(formFromAssumptions(assumptions));
  }, [assumptions, form]);

  // Form → assumptions, debounced, only when valid.
  const values = useWatch({ control: form.control });
  const debounced = useDebouncedValue(values, 450);
  useEffect(() => {
    const parsed = scenarioFormSchema.safeParse(debounced);
    if (!parsed.success) return;
    const next = assumptionsFromForm(parsed.data);
    const key = stableKey(next);
    if (key === appliedKeyRef.current) return;
    appliedKeyRef.current = key;
    setAssumptions(next);
  }, [debounced, setAssumptions]);

  const taxKind = useWatch({ control: form.control, name: 'taxKind' });
  const shortStayEnabled = useWatch({ control: form.control, name: 'shortStayEnabled' });
  const showNpv = assumptions.base.discountRate !== null && assumptions.base.exitValueNaira !== null;

  return (
    <section aria-labelledby="scenario-builder-heading" className="rounded-lg border border-gold/60 bg-bg-elevated p-4" data-testid="scenario-builder">
      <div className="mb-3">
        <h2 id="scenario-builder-heading" className="text-lg font-semibold">
          Scenario builder (assumption mode)
        </h2>
        <p className="text-sm text-fg-muted">{COPY.scenarioDisclaimer} Whole naira, square metres, months and percentages.</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FormProvider {...form}>
          <form className="space-y-3" onSubmit={(event) => event.preventDefault()} aria-label="Scenario assumptions" noValidate>
            <SectionCard title="Development cost" description="total = land + acquisition + build + fees + approvals + utilities/external works + contingency + financing during build">
              <NumberField name="landCostNaira" label="Land cost" unit="₦" />
              <NumberField name="acquisitionCostsNaira" label="Acquisition costs" unit="₦" />
              <NumberField name="grossFloorAreaM2" label="Gross floor area" unit="m²" hint="Actual surveyed area; a plot is not a fixed size." />
              <NumberField name="buildRateNairaPerM2" label="Approved build rate" unit="₦ per m²" />
              <NumberField name="boqTotalNaira" label="Priced BOQ total" unit="₦" hint="When supplied the BOQ is the basis; it is never added to the area-rate estimate." />
              <NumberField name="professionalFeesNaira" label="Professional fees" unit="₦" />
              <NumberField name="approvalsNaira" label="Approvals" unit="₦" />
              <NumberField name="utilitiesAndExternalWorksNaira" label="Utilities and external works" unit="₦" />
              <NumberField name="contingencyPercent" label="Contingency" unit="% of build + fees" />
              <NumberField name="financingDuringBuildNaira" label="Financing during build" unit="₦" />
            </SectionCard>

            <SectionCard title="Rental income" description="scheduled rent = Σ units × annual rent; effective income = scheduled × (1 − vacancy) × (1 − collection loss) + other income">
              <UnitGroups />
              <NumberField name="vacancyPercent" label="Vacancy rate" unit="%" />
              <NumberField name="collectionLossPercent" label="Collection loss" unit="%" />
              <NumberField name="otherAnnualIncomeNaira" label="Other annual income" unit="₦" />
            </SectionCard>

            <SectionCard title="Operating expenses and tax" description="Management fee is either a percentage of effective income or a fixed amount, never both.">
              <NumberField name="managementFeePercent" label="Management fee" unit="% of effective income" />
              <NumberField name="managementFeeFixedNaira" label="Fixed management fee" unit="₦ per year" />
              <NumberField name="maintenanceNaira" label="Maintenance" unit="₦ per year" />
              <NumberField name="insuranceNaira" label="Insurance" unit="₦ per year" />
              <NumberField name="serviceCostsNaira" label="Service costs" unit="₦ per year" />
              <NumberField name="unrecoverableChargesNaira" label="Unrecoverable charges" unit="₦ per year" />
              <Field label="Tax assumption" hint="Supplied and reviewed by the business; the calculator never chooses a rate.">
                {({ id, describedBy }) => (
                  <NativeSelect id={id} aria-describedby={describedBy} {...form.register('taxKind')}>
                    <option value="none">None</option>
                    <option value="fraction_of_noi">Percentage of NOI</option>
                    <option value="fixed">Fixed annual amount</option>
                  </NativeSelect>
                )}
              </Field>
              {taxKind === 'fraction_of_noi' ? <NumberField name="taxPercent" label="Tax on NOI" unit="%" /> : null}
              {taxKind === 'fixed' ? <NumberField name="taxFixedNaira" label="Fixed annual tax" unit="₦" /> : null}
              <NumberField name="capexReserveNaira" label="Capex reserve" unit="₦ per year" hint="Reported separately from NOI." />
            </SectionCard>

            <SectionCard title="Debt, equity and schedule">
              <NumberField name="annualDebtServiceNaira" label="Annual debt service" unit="₦" hint="Principal and interest; not an NOI expense." />
              <NumberField name="equityNaira" label="Equity invested" unit="₦" hint="Needed for cash-on-cash." />
              <NumberField name="constructionMonths" label="Construction duration" unit="months" />
              <NumberField name="completionDelayMonths" label="Completion delay" unit="months" hint="Delays postpone the rental start." />
            </SectionCard>

            <fieldset className="rounded-lg border border-border p-3">
              <legend className="px-1 text-sm font-semibold">Short stay (optional, separate cohort)</legend>
              <label className="sx-touch flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-5 w-5 accent-[var(--sx-primary)]" {...form.register('shortStayEnabled')} />
                Model a short-stay unit (available nights, occupancy, nightly rate)
              </label>
              {shortStayEnabled ? (
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <NumberField name="shortStay.availableNightsPerYear" label="Available nights per year" hint="Explicit; never assumed to be 365." />
                  <NumberField name="shortStay.occupiedPercent" label="Occupied nights" unit="%" />
                  <NumberField name="shortStay.nightlyRateNaira" label="Nightly rate" unit="₦" />
                  <NumberField name="shortStay.platformChargePercent" label="Platform charge" unit="%" />
                  <NumberField name="shortStay.cleaningCostPerStayNaira" label="Cleaning per stay" unit="₦" />
                  <NumberField name="shortStay.averageLengthOfStayNights" label="Average length of stay" unit="nights" />
                  <NumberField name="shortStay.operatingCostsNaira" label="Other operating costs" unit="₦ per year" />
                </div>
              ) : null}
            </fieldset>

            <SectionCard title="Exit and discounting (optional)" description="NPV and IRR need an explicit discount rate, exit value and selling costs; nothing is defaulted.">
              <NumberField name="discountPercent" label="Discount rate" unit="% per year" />
              <NumberField name="exitValueNaira" label="Exit value" unit="₦" />
              <NumberField name="sellingCostsPercent" label="Selling costs" unit="%" />
              <NumberField name="holdYears" label="Hold period" unit="years" />
            </SectionCard>

            <SetFields set="low" />
            <SetFields set="high" />

            <Field label="Notes" hint="Assumption sources, e.g. a quantity surveyor's estimate reference.">
              {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} {...form.register('notes')} />}
            </Field>
          </form>
        </FormProvider>
        <div className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">Results (your assumptions)</h3>
          <CalculatorResults
            result={calculators.data ?? null}
            loading={calculators.isLoading || calculators.isFetching}
            error={calculators.error}
            onRetry={() => void calculators.refetch()}
            usable={calculatorsUsable}
            missing={missingAssumptionInputs(assumptions)}
            showNpv={showNpv}
          />
        </div>
      </div>
    </section>
  );
}
