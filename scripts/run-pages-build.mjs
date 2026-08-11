#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function run(command, args) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
  });
}

const hasPlanningArtifacts =
  existsSync(resolve(ROOT, "plan")) &&
  existsSync(resolve(ROOT, "website", "dashboard")) &&
  existsSync(resolve(ROOT, "scripts", "sprint-stats.ts")) &&
  existsSync(resolve(ROOT, "scripts", "build-planning-artifacts.mjs"));

// Refresh conformance numbers (#1522) before any step that reads ROADMAP.md,
// plan/goals/goal-graph.md, README.md, or CLAUDE.md. Idempotent — only writes
// when test262-current.json moved.
if (existsSync(resolve(ROOT, "benchmarks", "results", "test262-current.json"))) {
  run("node", ["scripts/sync-conformance-numbers.mjs"]);
}

if (hasPlanningArtifacts) {
  run(process.execPath, ["--experimental-strip-types", "scripts/sprint-stats.ts"]);
  run("node", ["scripts/build-planning-artifacts.mjs"]);
}

// Keep the visible ES2016+ feature catalog aligned with TC39's canonical
// finished-proposals table. The sync script retains the committed last-known-
// good artifact when the network is unavailable, so local/offline builds stay
// deterministic while every Pages deployment gets a chance to refresh.
run(process.execPath, ["--experimental-strip-types", "scripts/sync-es-edition-features.ts"]);

// Recompile the landing-page feature-catalog examples (website/public/
// feature-examples.json) against the CURRENT compiler, before the edition
// reconciliation pass below overlays fresh test262 pass counts on top.
//
// This was previously a manual-only step (`pnpm run generate:feature-examples`,
// #1157) and went unrun for two months while the compiler kept landing PRs —
// 24 rows stayed flagged `noCompile: true` with "not supported" prose, nine of
// which had started compiling and running correctly (some over the "full"
// 90%+ test262 threshold) without anyone noticing, because nothing regenerated
// the artifact to find out. Running it on every push to main, alongside the
// edition data it already sits next to, closes that gap.
//
// Safe to run unconditionally: this script now MERGES into the existing
// committed file rather than overwriting it (see the PRESERVED_KEYS comment
// in generate-feature-examples.ts) — it owns the compiled-example fields
// (js/wat/compileSuccess/badge/noCompile/…) and carries `testCategories` /
// `passCount` / `totalCount` / `tests` / `testsTruncated` forward from
// whatever is already on disk, since those belong to the SEPARATE test262
// reconciliation pipeline below and this script has no test262 data of its
// own to score them with. Costs ~30s (CPU-bound compilation of ~90 small
// snippets; the generator never instantiates or executes the compiled Wasm,
// so it carries none of the async-runtime hang risk that live execution
// would).
// Runs under `tsx`, NOT `node --experimental-strip-types`. This generator is
// the only script in this file that imports the compiler itself
// (`../src/index.js`, needed to compile the snippets). Type-stripping does not
// perform TypeScript's `.js` -> `.ts` specifier rewriting, so plain node fails
// with ERR_MODULE_NOT_FOUND on `src/index.js` (which does not exist on disk —
// only `src/index.ts` does) and takes the whole Pages deploy down with it.
// `pnpm run generate:feature-examples` is the canonical invocation; reuse it
// rather than duplicating the runner here.
run("pnpm", ["run", "generate:feature-examples"]);

run(process.execPath, ["--experimental-strip-types", "scripts/generate-editions.ts"]);

// (#2636) Per-edition STANDALONE buckets. The host pass above wrote
// test262-editions.json from the JS-host baseline JSONL; run the same edition
// classifier over the standalone-lane baseline JSONL so the landing-page
// host/standalone toggle has per-edition *standalone* pass rates, not just the
// latest edition. Best-effort: fetching the standalone baseline and the
// classifier itself are both wrapped so an offline local build (or a transient
// baseline outage) skips the standalone editions file instead of failing the
// whole Pages build — the reader then falls back to the committed file, or to
// the pre-#2636 "Unavailable" state for standalone editions.
try {
  try {
    run("node", ["scripts/fetch-baseline-jsonl.mjs", "--standalone"]);
  } catch {
    // network / baseline unavailable — the existsSync guard below skips cleanly
  }
  const standaloneJsonl = resolve(ROOT, ".test262-cache", "test262-standalone-current.jsonl");
  if (existsSync(standaloneJsonl)) {
    run(process.execPath, [
      "--experimental-strip-types",
      "scripts/generate-editions.ts",
      "--results",
      standaloneJsonl,
      "--output",
      resolve(ROOT, "website", "public", "benchmarks", "results", "test262-standalone-editions.json"),
      // (#2914) The standalone lane must count a `pass` only when it is
      // host-free (no `env::__*` runtime import) — mirroring the standalone
      // donut headline (#2879) and the absolute floor (#2097). Without this,
      // the per-edition slider counted leaky (host-import) passes and diverged
      // from the honest headline/floor.
      "--host-free",
      // (#4362) Also emit the standalone twin of the landing-page feature-row
      // counts. Reads the host catalog (for row names / testCategories /
      // curated examples) and writes ONLY the recomputed host-free
      // passCount/totalCount to a separate file, leaving the host one intact.
      "--feature-examples-out",
      resolve(ROOT, "website", "public", "feature-examples-standalone.json"),
    ]);
  } else {
    console.warn(
      "[run-pages-build] standalone baseline JSONL unavailable — keeping committed test262-standalone-editions.json",
    );
  }
} catch (error) {
  console.warn(`[run-pages-build] standalone edition generation skipped: ${error?.message ?? error}`);
}

run("pnpm", ["run", "build:playground"]);
run("pnpm", ["run", "build:compiler-bundle"]);
// Experimental Wasm flags required by generate-size-benchmarks (Node 25):
//   --experimental-wasm-stringref         — stringview_wtf16 (wasm:js-string ops)
//   --experimental-wasm-custom-descriptors — exact heap type (custom-descriptors)
// Without these, Node rejects modules at compile-time with "invalid heap type X".
run(process.execPath, [
  "--experimental-strip-types",
  "--experimental-wasm-stringref",
  "--experimental-wasm-custom-descriptors",
  "scripts/generate-size-benchmarks.ts",
]);

// Derive the landing-page feature-support badges from the real test262 pass
// rates (and refresh the served report/categories the live counts read), so
// the "Status is derived from Test262 pass rates" claim is actually true.
// Idempotent — only writes when a badge or the served data moved.
run("node", ["scripts/derive-feature-badges.mjs"]);

run("node", ["scripts/build-pages.js"]);
