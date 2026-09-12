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
 * (#5383 S3) That hard failure is a statement about THIS script, not about the
 * standalone lane's policy. No standalone baseline is measured with a provider
 * yet, so a failed standalone build must not fail CI — the workflow runs that
 * step `continue-on-error`, no stamp is written, and `test262TemporalLaneEnabled`
 * then keeps every standalone Temporal row unlinked. Keeping the exit code
 * honest here is what lets the workflow make that choice explicitly instead of
 * this script guessing.
 *
 * (#5383 S3) It now builds a provider PER TARGET. `--target host` (the default,
 * i.e. `--target gc` with the JS host adapter) is byte-identical to the
 * pre-#5383 behaviour, down to the stamp file name. `--target standalone`
 * builds the host-free provider and stamps it under its own name, so the two
 * lanes never read each other's certificate. Repeat the flag (or pass `both`)
 * to build more than one; each target is stamped as soon as it succeeds, so a
 * later target failing never invalidates an earlier one's artifact.
 *
 * Usage:
 *   JS2WASM_TEMPORAL_CACHE=<dir> node scripts/prewarm-temporal-provider.mjs
 *   node scripts/prewarm-temporal-provider.mjs --cache-dir <dir>
 *   node scripts/prewarm-temporal-provider.mjs --target standalone
 *   node scripts/prewarm-temporal-provider.mjs --target both
 *
 * Requires `scripts/compiler-bundle.mjs` built from `scripts/compiler-bundle-entry.ts`
 * (`pnpm run build:compiler-bundle`) — the entry that publishes the provider.
 */

import {
  loadTemporalPolyfillSource,
  temporalCacheDir,
  temporalProviderCompileOptions,
  writeTemporalPrewarmStamp,
} from "./test262-temporal.mjs";

/**
 * Which providers to build. `host` is spelled out rather than left implicit so
 * a `--target both` run reports two named lines instead of one anonymous pair.
 */
function parseTargets(argv) {
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--target") continue;
    const value = argv[i + 1];
    if (value === "both") targets.push(undefined, "standalone");
    else if (value === "host" || value === "gc") targets.push(undefined);
    else if (value === "standalone") targets.push("standalone");
    else {
      console.error(`prewarm-temporal-provider: --target must be host|standalone|both (got ${value ?? "nothing"})`);
      process.exit(2);
    }
  }
  return targets.length > 0 ? [...new Set(targets)] : [undefined];
}

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
  const argv = process.argv.slice(2);
  const cacheDir = parseCacheDir(argv);
  const targets = parseTargets(argv);
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
  for (const target of targets) {
    const label = target ?? "host";
    const compileOptions = temporalProviderCompileOptions(target);
    // The key MUST be computed with the same options the build uses, or the
    // stamp certifies an artifact nobody will ask for and the consuming lane
    // refuses with a key mismatch it cannot act on.
    const key = bundle.temporalProviderCacheKey({ polyfillSource, compileOptions });
    const started = Date.now();
    const provider = await bundle.buildTemporalProvider({ polyfillSource, cacheDir, compileOptions });
    const stamp = writeTemporalPrewarmStamp(
      cacheDir,
      {
        key,
        namespace: provider.namespace,
        bytes: provider.artifact.binary.length,
        buildMs: provider.buildMs,
        cacheHit: provider.cacheHit,
      },
      target,
    );
    console.log(
      `prewarm-temporal-provider: OK — ${label} ${provider.namespace} (${stamp.bytes} B) ` +
        `in ${Date.now() - started}ms cacheHit=${provider.cacheHit} key=${key.slice(0, 16)} dir=${cacheDir}`,
    );
  }
}

main().catch((error) => {
  console.error(`prewarm-temporal-provider: FAILED — ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
