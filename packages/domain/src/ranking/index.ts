/**
 * Deterministic, versioned market ranking engine.
 *
 * Brief §6.3 (quoted): "Build a deterministic, versioned service, not an LLM choosing cities."
 * Pure functions and types only: no I/O, no clock, no database.
 */

export * from './types';
export * from './dates';
export * from './hash';
export * from './normalise';
export * from './eligibility';
export * from './policy';
export * from './scoring';
export * from './rank';
export * from './compare';
export * from './snapshot';
