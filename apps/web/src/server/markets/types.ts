import type { schema } from '@simplexd/db';

/** Row shapes the read model works with. Loaded by `load.ts`, mapped by `mappers.ts`. */

export type MarketRow = typeof schema.markets.$inferSelect;
export type StateRow = typeof schema.states.$inferSelect;
export type SourceRow = typeof schema.sources.$inferSelect;
export type ObservationRow = typeof schema.observations.$inferSelect;
export type InterpretationRow = typeof schema.observationInterpretations.$inferSelect;
export type FacilityRow = typeof schema.supplyFacilities.$inferSelect;
export type CoverageRow = typeof schema.supplierCoverage.$inferSelect;
export type QuoteRow = typeof schema.supplierQuotes.$inferSelect;
export type ResearchTaskRow = typeof schema.researchTasks.$inferSelect;
export type MarketFlagRow = typeof schema.marketFlags.$inferSelect;
export type NeighborhoodRow = typeof schema.neighborhoods.$inferSelect;
export type ServiceCoverageRow = typeof schema.serviceCoverage.$inferSelect;
export type ServiceRow = typeof schema.services.$inferSelect;
export type TimelineTemplateRow = typeof schema.timelineTemplates.$inferSelect;

/** An immutable observation with its current editorial interpretation and its source. */
export interface ObservationRecord {
  observation: ObservationRow;
  interpretation: InterpretationRow;
  source: SourceRow;
}

export interface SupplierLeadRecord {
  coverage: CoverageRow;
  facility: FacilityRow;
  state: StateRow | null;
  source: SourceRow | null;
}

/** A market with everything the summary, detail and ranking adapter need. */
export interface MarketBundle {
  market: MarketRow;
  state: StateRow;
  /** City, neighbourhood and site observations that apply to this market. */
  local: ObservationRecord[];
  /** Statewide (and national) context for the market's state. Never a city value. */
  regional: ObservationRecord[];
  leads: SupplierLeadRecord[];
  quotes: QuoteRow[];
  tasks: ResearchTaskRow[];
  flags: MarketFlagRow[];
}
