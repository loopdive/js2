#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3451 slice 3 — build every distinct Test262 harness provider ONCE, in the
 * shard PARENT, before any fork pool starts.
 *
 * The corpus has exactly 64 distinct harness sources behind ~82,600 body
 * variants (#3451 slice 1 inventory), so a whole lane's provider set is a
 * bounded, enumerable thing: this walks the maintained checkout, collects the
 * distinct prefixes the runner's OWN `assembleLinkedHarness` produces, and
 * compiles each.
 *
 * WHY A SEPARATE STEP. It is the same fork-budget argument as the Temporal
 * pre-warm (#5353), one order of magnitude smaller and therefore a SOFTER
 * policy. A cold harness provider is 0.7-2.9 s against a 30 s per-row budget,
 * so a fork that builds one is slow, not doomed — which is why the worker does
 * NOT refuse to build without a stamp, and why this script's absence degrades
 * performance rather than verdicts. What it buys is that the first row of each
 * include-set in each fork is a cache read instead of a build: with four forks
 * and 64 sets that is up to 256 avoided builds per shard.
 *
 * It is therefore a SOFT failure by default (exit 0 with a warning): the lane
 * still runs correctly unprewarmed. `--strict` makes a failed build fatal, for
 * a CI step that would rather stop than silently pay the cost.
 *
 * Usage:
 *   JS2WASM_TEST262_HARNESS_CACHE=<dir> node scripts/prewarm-test262-harness-providers.mjs
 *   node scripts/prewarm-test262-harness-providers.mjs --cache-dir <dir> --target standalone
 *   node scripts/prewarm-test262-harness-providers.mjs --limit 8   # smoke
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { test262HarnessProviderCacheDir, writeHarnessPrewarmStamp } from "./test262-harness-cache.mjs";

function parseArgs(argv) {
  const args = { cacheDir: undefined, target: undefined, limit: Infinity, strict: false, root: "test262/test" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--cache-dir") args.cacheDir = argv[++i];
    else if (flag === "--target") args.target = argv[++i] === "host" ? undefined : argv[i];
    else if (flag === "--limit") args.limit = Number(argv[++i]);
    else if (flag === "--root") args.root = argv[++i];
    else if (flag === "--strict") args.strict = true;
    else if (flag === "--help" || flag === "-h") {
      console.log("usage: prewarm-test262-harness-providers.mjs [--cache-dir D] [--target host|standalone]");
      console.log("                                            [--root DIR] [--limit N] [--strict]");
      process.exit(0);
    } else {
      console.error(`unknown flag: ${flag}`);
      process.exit(2);
    }
  }
  return args;
}

function* walkJs(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walkJs(path);
    } else if (entry.endsWith(".js") && !entry.endsWith("_FIXTURE.js")) {
      yield path;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cacheDir = args.cacheDir ?? test262HarnessProviderCacheDir();

  // The runner's own split and metadata parse — imported, never reimplemented.
  // A pre-warm keyed by a DIFFERENT prefix than the worker asks for is not a
  // pre-warm at all; it is a cache full of artifacts nothing will ever read.
  const { assembleLinkedHarness } = await import(
    pathToFileURL(join(process.cwd(), "tests/test262-original-harness.ts"))
  );
  const { parseMeta } = await import(pathToFileURL(join(process.cwd(), "tests/test262-runner.ts")));
  const compilerBundle = await import(pathToFileURL(join(process.cwd(), "scripts/compiler-bundle.mjs")));

  if (typeof compilerBundle.buildHarnessProvider !== "function") {
    console.error("[prewarm-harness] compiler bundle does not export buildHarnessProvider — rebuild it from");
    console.error("[prewarm-harness] scripts/compiler-bundle-entry.ts (pnpm run build:compiler-bundle)");
    process.exit(args.strict ? 1 : 0);
  }

  // Distinct prefixes, keyed by the prefix TEXT (what the provider is keyed by)
  // and labelled by the part names for a readable stamp.
  const prefixes = new Map();
  let scanned = 0;
  for (const path of walkJs(args.root)) {
    let assembly;
    try {
      const source = readFileSync(path, "utf8");
      assembly = assembleLinkedHarness(source, parseMeta(source));
    } catch {
      continue; // an unparseable row is the runner's problem, not the cache's
    }
    scanned++;
    if (assembly.raw) continue; // raw tests carry no harness and bypass linking
    if (!prefixes.has(assembly.harnessPrefix)) {
      prefixes.set(assembly.harnessPrefix, assembly.harnessParts.map((part) => part.name).join("+"));
    }
    if (prefixes.size >= args.limit) break;
  }
  console.log(`[prewarm-harness] ${scanned} files scanned, ${prefixes.size} distinct harness prefixes`);

  const compileOptions = {
    allowJs: true,
    emitWat: false,
    skipSemanticDiagnostics: true,
    ...(args.target ? { target: args.target } : {}),
  };
  const providers = [];
  let failed = 0;
  const started = Date.now();
  for (const [harnessPrefix, parts] of prefixes) {
    try {
      const provider = await compilerBundle.buildHarnessProvider({ harnessPrefix, cacheDir, compileOptions });
      providers.push({
        key: compilerBundle.harnessProviderCacheKey({ harnessPrefix, compileOptions }),
        namespace: provider.namespace,
        bytes: provider.artifact.binary.length,
        buildMs: provider.buildMs,
        cacheHit: provider.cacheHit === true,
        parts,
      });
      console.log(
        `[prewarm-harness] ${parts} → ${provider.artifact.binary.length} B in ${provider.buildMs}ms ` +
          `cacheHit=${provider.cacheHit}`,
      );
    } catch (error) {
      failed++;
      // Named, never swallowed: a prefix that cannot build is a prefix every
      // row using it will fall back on, and the fallback count in the run is
      // the only other place that would show it.
      console.error(`[prewarm-harness] FAILED ${parts}: ${error?.message ?? String(error)}`);
    }
  }

  writeHarnessPrewarmStamp(cacheDir, { providers }, args.target);
  console.log(
    `[prewarm-harness] ${providers.length} provider(s) warm, ${failed} failed, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s, cache ${cacheDir}`,
  );
  if (failed > 0 && args.strict) process.exit(1);
}

await main();
