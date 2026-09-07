#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5353 — build the compile-once `Temporal` provider (#4628) ONCE, in the shard
 * PARENT, before any fork pool starts.
 *
 * Why a separate step instead of letting the first Temporal row build it: the
 * vitest fork pool kills a job at 30 s (`pool.runTest(..., 30_000)`) and a cold
 * provider build is ~40-65 s. A fork that tried would not merely be slow — it
 * would time out, be retried, and burn the same 50 s in the next fork, turning
 * every Temporal row in the shard into a timeout. So this runs where nothing
 * kills it, and `scripts/test262-worker.mjs` refuses to build at all unless the
 * stamp this script writes says the artifact is already there (~1 s cache read).
 *
 * Deliberately a HARD failure (exit 1) rather than a soft degrade. A shard that
 * silently ran unlinked would report ~6,600 Temporal rows as regressions against
 * a baseline measured WITH the provider — a loud but thoroughly misleading
 * signal that costs a merge-queue cycle to diagnose. One failed step naming its
 * own cause is cheaper.
 *
 * Usage:
 *   JS2WASM_TEMPORAL_CACHE=<dir> node scripts/prewarm-temporal-provider.mjs
 *   node scripts/prewarm-temporal-provider.mjs --cache-dir <dir>
 *
 * Requires `scripts/compiler-bundle.mjs` built from `scripts/compiler-bundle-entry.ts`
 * (`pnpm run build:compiler-bundle`) — the entry that publishes the provider.
 */

import { loadTemporalPolyfillSource, temporalCacheDir, writeTemporalPrewarmStamp } from "./test262-temporal.mjs";

function parseCacheDir(argv) {
  const index = argv.indexOf("--cache-dir");
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value) {
      console.error("prewarm-temporal-provider: --cache-dir needs a directory");
      process.exit(2);
    }
    return value;
  }
  return temporalCacheDir();
}

async function main() {
  const cacheDir = parseCacheDir(process.argv.slice(2));
  const bundle = await import("./compiler-bundle.mjs");
  if (typeof bundle.buildTemporalProvider !== "function" || typeof bundle.temporalProviderCacheKey !== "function") {
    // The bundle predates #5353 or was built straight from `src/index.ts` by a
    // helper script. Say which, because the symptom downstream (shards running
    // unlinked) points nowhere near this.
    console.error(
      "prewarm-temporal-provider: scripts/compiler-bundle.mjs does not export buildTemporalProvider.\n" +
        "  Rebuild it from the bundle ENTRY: pnpm run build:compiler-bundle",
    );
    process.exit(1);
  }

  const polyfillSource = await loadTemporalPolyfillSource();
  const key = bundle.temporalProviderCacheKey({ polyfillSource });
  const started = Date.now();
  const provider = await bundle.buildTemporalProvider({ polyfillSource, cacheDir });
  const stamp = writeTemporalPrewarmStamp(cacheDir, {
    key,
    namespace: provider.namespace,
    bytes: provider.artifact.binary.length,
    buildMs: provider.buildMs,
    cacheHit: provider.cacheHit,
  });
  console.log(
    `prewarm-temporal-provider: OK — ${provider.namespace} (${stamp.bytes} B) ` +
      `in ${Date.now() - started}ms cacheHit=${provider.cacheHit} key=${key.slice(0, 16)} dir=${cacheDir}`,
  );
}

main().catch((error) => {
  console.error(`prewarm-temporal-provider: FAILED — ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
