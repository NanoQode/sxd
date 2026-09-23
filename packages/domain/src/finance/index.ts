/**
 * Financial calculators for feasibility scenarios (build brief §6.4).
 *
 * "All calculators are scenarios, not guaranteed valuations or investment
 * advice." Money here is whole-naira scenario arithmetic held in JavaScript
 * numbers: estimates for comparison, not ledger money (the ledger package
 * keeps integer kobo). Percentages are fractions on input (0.1 = 10%) and
 * yields are reported as percentages (`*Percent`). Nothing is defaulted:
 * every calculator returns a `Result` and names what is missing.
 *
 * Pure functions only: no I/O, no framework code, no market averages.
 */
export * from './result';
export * from './area';
export * from './denominator';
export * from './development-cost';
export * from './long-let';
export * from './short-stay';
export * from './phasing';
export * from './npv-irr';
export * from './loan';
export * from './sensitivity';
