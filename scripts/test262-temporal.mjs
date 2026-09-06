// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5353 — the ONE gate and the ONE pre-warm contract for the compiled
 * `Temporal` global (#4628) across every test262 lane.
 *
 * #5248 wired the in-process lane (`tests/test262-runner.ts`) and left the
 * SHARDED lane (`scripts/test262-worker.mjs`) unwired, so the published
 * conformance number contained no Temporal gain at all. Wiring the second lane
 * means two lanes now have to agree about WHICH rows get a `Temporal` binding.
 * A gate that disagrees between lanes is the #4162/#3441/#3613 drift class all
 * over again: the same row is scored against a different realm depending on who
 * ran it, and the baseline validator then reports a drift that does not exist.
 * So the rule lives here, in plain `.mjs` with no compiler import, and both
 * lanes call it.
 *
 * It also owns the PRE-WARM STAMP, which exists because the two lanes have
 * genuinely different budgets. The in-process lane may build the provider
 * cold (~40-65 s) — nothing kills it. A shard fork is killed at 30 s, so it
 * must never attempt a cold build; the shard PARENT (the workflow step, or
 * `scripts/run-test262-vitest.sh`) runs `scripts/prewarm-temporal-provider.mjs`
 * first, which writes the stamp. A fork that cannot find a stamp matching the
 * provider it would ask for runs its rows UNLINKED rather than risking a
 * per-row timeout storm across the shard.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** File the pre-warm step writes into the provider cache dir. */
export const TEMPORAL_PREWARM_STAMP = "prewarm.json";

/**
 * `JS2WASM_TEST262_TEMPORAL=0` opts a consumer out of the provider.
 *
 * Read LAZILY on every call, never captured into a module-scope const: a
 * consumer that sets the variable in its own module body
 * (`scripts/validate-test262-baseline.ts` did exactly that, for the lane-parity
 * reason documented there) runs AFTER this module is evaluated, because ESM
 * imports are hoisted. A hoisted const captures the unset value and drops the
 * opt-out without a word.
 */
export function temporalProviderDisabled() {
  return process.env.JS2WASM_TEST262_TEMPORAL === "0";
}

/**
 * Does this test need the real `Temporal` global?
 *
 * PATH or `features:`, because neither alone is complete: `built-ins/Temporal/**`
 * and `intl402/Temporal/**` are the bulk, while the 8
 * `built-ins/Date/prototype/toTemporalInstant/**` rows have no path separator
 * before `Temporal` and are reached only through `features:`.
 *
 * Deliberately NOT `referencesTemporal(source)` (`src/temporal-provider.ts`),
 * whose loose "any occurrence, even inside a string" rule is right for a
 * user-facing API and wrong here: `assembleOriginalHarness` concatenates the
 * upstream harness into every test, and a stray mention in a comment would put
 * a non-Temporal row on the linked path and make it pay a ~2 MB provider
 * instantiation for a binding it never reads.
 *
 * @param {string} filePath test262 file path (absolute or repo-relative)
 * @param {readonly string[] | undefined} features the test's `features:` list
 */
export function test262NeedsTemporalGlobal(filePath, features) {
  if (temporalProviderDisabled()) return false;
  if (/[\\/]Temporal[\\/]/.test(filePath)) return true;
  return Array.isArray(features) && features.includes("Temporal");
}

/**
 * Where the content-addressed provider binary lives.
 *
 * `JS2WASM_TEMPORAL_CACHE` is the shared handle: the pre-warm step writes it,
 * the shards read it, and CI points it at a directory restored from an
 * artifact. The tmpdir default keeps a bare in-process run working.
 */
export function temporalCacheDir() {
  return process.env.JS2WASM_TEMPORAL_CACHE ?? join(tmpdir(), "js2wasm-temporal-cache");
}

/**
 * Record that a provider with `key` is present in `cacheDir`.
 *
 * @param {string} cacheDir
 * @param {{ key: string, namespace: string, bytes: number, buildMs: number, cacheHit: boolean }} info
 */
export function writeTemporalPrewarmStamp(cacheDir, info) {
  mkdirSync(cacheDir, { recursive: true });
  const stamp = { ...info, generatedAt: new Date().toISOString() };
  writeFileSync(join(cacheDir, TEMPORAL_PREWARM_STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/**
 * Read the pre-warm stamp, or `null` when there is none / it is unreadable.
 *
 * A missing stamp is a normal state (nobody pre-warmed), not an error — the
 * caller decides whether it can afford a cold build.
 */
export function readTemporalPrewarmStamp(cacheDir) {
  const path = join(cacheDir, TEMPORAL_PREWARM_STAMP);
  if (!existsSync(path)) return null;
  try {
    const stamp = JSON.parse(readFileSync(path, "utf-8"));
    return typeof stamp?.key === "string" ? stamp : null;
  } catch {
    return null;
  }
}

/**
 * Load the pinned polyfill bundle as one linked ES module source.
 *
 * Dynamic, because acquiring it reads two committed tarballs and is pure cost
 * for a lane that never runs a Temporal row.
 */
export async function loadTemporalPolyfillSource() {
  const { setupTemporalPolyfill, linkPolyfillSource } = await import("../tests/dogfood/setup-temporal-polyfill.mjs");
  return linkPolyfillSource(setupTemporalPolyfill()).source;
}
