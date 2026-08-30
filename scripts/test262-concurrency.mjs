import { availableParallelism } from "node:os";

export const TEST262_DEFAULT_MAX_CONCURRENCY = 32;

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Resolve the worker count used by the unified Test262 compiler pool. */
export function resolveTest262PoolSize(env = process.env) {
  return parsePositiveInteger(env.COMPILER_POOL_SIZE) ?? Math.max(1, availableParallelism() - 1);
}

/**
 * Test262's concurrent callbacks must not exceed the active compiler pool.
 * Unit tests retain the existing 32-callback Vitest default.
 */
export function resolveVitestMaxConcurrency(env = process.env) {
  const isTest262Run = Boolean(env.TEST262_TARGET || env.TEST262_RESULT_PREFIX);
  if (!isTest262Run) return TEST262_DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.min(TEST262_DEFAULT_MAX_CONCURRENCY, resolveTest262PoolSize(env)));
}
