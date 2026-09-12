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

/** File the pre-warm step writes into the provider cache dir (HOST lane). */
export const TEMPORAL_PREWARM_STAMP = "prewarm.json";

/**
 * (#5383 S3) ONE stamp PER TARGET, in the one cache dir.
 *
 * The host and standalone providers are two different binaries built from the
 * same polyfill — `temporalProviderCacheKey` already fingerprints the compile
 * options, so their keys differ. A single `prewarm.json` could therefore only
 * ever certify one of them, and the other lane would read a stamp whose key
 * does not match the provider it is about to ask for. That is not merely a
 * miss: the worker's key check would refuse, and the refusal reason would name
 * the WRONG artifact. Separate names keep each lane's answer independent, and
 * keep the CI artifact a single directory.
 *
 * Host keeps the historical file name so an artifact restored from a cache
 * built before this slice still certifies the host lane.
 *
 * @param {string | undefined} target compile target (`undefined` = JS host)
 */
export function temporalPrewarmStampName(target) {
  return target === undefined ? TEMPORAL_PREWARM_STAMP : `prewarm-${target}.json`;
}

/**
 * The provider compile options a given test262 lane needs.
 *
 * The host lane asks for the default (`--target gc` + JS host adapter) by
 * passing nothing, so its cache key — and therefore its cached artifact and its
 * stamp — is byte-identical to the pre-#5383 one. Standalone asks for the
 * host-free provider (#5383): `hostBridge: "off"` is not decoration, it is what
 * makes the provider instantiate with an empty import list.
 *
 * @param {string | undefined} target
 * @returns {{ target: string, hostBridge: string } | undefined}
 */
export function temporalProviderCompileOptions(target) {
  return target === "standalone" ? { target: "standalone", hostBridge: "off" } : undefined;
}

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
 * (#5364) Substring that identifies a realm-global the compiled Temporal
 * polyfill installs on `globalThis` for its own use.
 *
 * `@js-temporal/polyfill` keeps every Temporal object's internal slots in ONE
 * store reached through `globalThis[Symbol('@@Temporal__GetSlots')]` /
 * `@@Temporal__CreateSlots`, and it installs them FIRST-WRITER-WINS. That is
 * correct for its own assumption — one polyfill instance per realm — and it is
 * exactly the assumption a test262 fork breaks: since #5353 every Temporal row
 * instantiates the provider AGAIN in the same realm, and every row after the
 * first silently reuses row 1's slot store, i.e. row 1's provider instance.
 */
const TEMPORAL_REALM_GLOBAL_MARKER = "Temporal__";

/**
 * Drop the previous row's Temporal realm globals so the next instance installs
 * its OWN, and report what was dropped.
 *
 * Measured on the 123-row #5249 calendar list (`.tmp/probe-slotreset.mts`, an
 * `era-japanese` + `month-boundary-gregory` pair): without this,
 * `month-boundary-gregory.js` fails `endYesterdayNextDay: instanceof` in a
 * batch and `Unsupported era name: gregory` alone — a per-row verdict that
 * depends on which rows ran before it in the same fork. With it, the batch
 * answers what the solo process answers.
 *
 * This is a HARNESS-level repair, not a compiler fix: the polyfill is entitled
 * to assume one instance per realm, and it is the multi-row fork that violates
 * that. Retiring the marker between rows is what restores the assumption.
 */
export function resetTemporalRealmGlobals() {
  const dropped = [];
  for (const symbol of Object.getOwnPropertySymbols(globalThis)) {
    if (!String(symbol).includes(TEMPORAL_REALM_GLOBAL_MARKER)) continue;
    delete globalThis[symbol];
    dropped.push(String(symbol));
  }
  return dropped;
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
 * @param {string | undefined} [target] compile target the artifact was built for
 */
export function writeTemporalPrewarmStamp(cacheDir, info, target) {
  mkdirSync(cacheDir, { recursive: true });
  const stamp = { ...info, target: target ?? null, generatedAt: new Date().toISOString() };
  writeFileSync(join(cacheDir, temporalPrewarmStampName(target)), `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/**
 * Read the pre-warm stamp, or `null` when there is none / it is unreadable.
 *
 * A missing stamp is a normal state (nobody pre-warmed), not an error — the
 * caller decides whether it can afford a cold build.
 */
export function readTemporalPrewarmStamp(cacheDir, target) {
  const path = join(cacheDir, temporalPrewarmStampName(target));
  if (!existsSync(path)) return null;
  try {
    const stamp = JSON.parse(readFileSync(path, "utf-8"));
    return typeof stamp?.key === "string" ? stamp : null;
  } catch {
    return null;
  }
}

/**
 * (#5383 S3) May THIS lane link a compiled `Temporal` provider at all?
 *
 * Answered per TARGET, and separately from the per-row `test262NeedsTemporalGlobal`
 * question, because the two failure modes are different: a wrong per-row answer
 * scores one row against the wrong realm, a wrong per-lane answer does it to
 * every Temporal row in the shard.
 *
 *  - **host** (`undefined`) — always eligible. Unchanged from #5353, including
 *    the right to build cold in the in-process lane.
 *  - **standalone** — eligible ONLY when a standalone-keyed pre-warm stamp is
 *    present. This is the FAIL-SOFT hinge of the slice: with no artifact (or an
 *    unreadable/corrupt one — `readTemporalPrewarmStamp` answers `null` for
 *    both) the rows run UNLINKED, exactly as they did before this slice. A
 *    missing standalone provider must never turn honest `Temporal is not
 *    defined` failures into timeouts or compile_errors against the #1897 floor.
 *  - **linear / wasi** — never. No provider is built for them and the linker's
 *    deferred-init export does not exist for WASI's `_start` contract.
 *
 * Cheap by construction (one `existsSync` + a small JSON parse) but still worth
 * hoisting out of a per-row loop — both callers evaluate it once per process.
 *
 * @param {string | undefined} target
 * @param {string} [cacheDir]
 */
export function test262TemporalLaneEnabled(target, cacheDir = temporalCacheDir()) {
  if (temporalProviderDisabled()) return false;
  if (target === undefined) return true;
  if (target !== "standalone") return false;
  return readTemporalPrewarmStamp(cacheDir, target) !== null;
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
