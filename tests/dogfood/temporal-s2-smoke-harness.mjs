// #5383 S2 — the three-assertion standalone smoke test, measured.
//
// The sibling `temporal-global-harness.mjs` answers the same family of
// questions on the JS-HOST lane. This one is `--target standalone` /
// `hostBridge: "off"` — no JS runtime at all on either side of the link, which
// is the whole point of #5383: the consumer and the compiled polyfill provider
// have to agree on a wasm↔wasm value ABI with no host to marshal through.
//
// Child process, same rationale as every other dogfood adapter: the provider
// compile is ~3.3 MB of synchronous work and OOMs / heartbeat-stalls a vitest
// worker if run in-process (measured 2026-09-12 — the in-worker version died
// with a V8 OOM before reaching an assertion).
//
// Every probe records what it OBSERVED. The wrapper asserts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { instantiateLinkedProject } from "../../src/index.ts";
import { buildTemporalProvider, compileWithTemporalGlobal } from "../../src/temporal-provider.ts";
import { setupTemporalPolyfill, linkPolyfillSource } from "./setup-temporal-polyfill.mjs";

/** The S2 acceptance assertions, plus the intermediate reads that localise a failure. */
const PROBES = {
  // S2 assertion 1.
  keys: `export function run() { return Object.keys(Temporal).length; }`,
  // S2 assertion 2, with its two precursors.
  hasPlainDate: `export function run() { return ("PlainDate" in Temporal) ? 1 : 0; }`,
  day: `export function run() {
    const d = new Temporal.PlainDate(2024, 1, 1);
    const v = d.day;
    return typeof v === "number" ? v : -1;
  }`,
  // S2 assertion 3, with the precursors that prove the Duration itself crosses
  // — so a failure here is not a boundary failure. See the `it.todo` in
  // `tests/issue-5383-standalone-temporal-provider.test.ts` for the reduction.
  durationHours: `export function run() {
    const d = Temporal.Duration.from({ hours: 1 });
    const v = d.hours;
    return typeof v === "number" ? v : -1;
  }`,
  durationHasTotal: `export function run() {
    return typeof Temporal.Duration.from({ hours: 1 }).total === "function" ? 1 : 0;
  }`,
  total: `export function run() {
    const v = Temporal.Duration.from({ hours: 1 }).total("minutes");
    return typeof v === "number" ? v : -1;
  }`,
};

const STANDALONE = { target: "standalone", hostBridge: "off" };

async function observe(source, provider, fileName) {
  try {
    const result = await compileWithTemporalGlobal(source, provider, {
      ...STANDALONE,
      fileName,
      allowJs: true,
      skipSemanticDiagnostics: true,
    });
    if (!result.success) {
      return { status: "compile-error", error: (result.errors ?? [])[0]?.message?.slice(0, 200) ?? "?" };
    }
    const { instance } = await instantiateLinkedProject(result, {});
    return { status: "ok", value: instance.exports.run() };
  } catch (error) {
    return { status: "throw", error: String(error?.message ?? error).slice(0, 200) };
  }
}

export async function runTemporalS2SmokeHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const linked = linkPolyfillSource(setupTemporalPolyfill());
  const cacheDir = process.env.JS2WASM_TEMPORAL_S2_CACHE ?? mkdtempSync(join(tmpdir(), "js2wasm-temporal-s2-"));
  const provider = await buildTemporalProvider({
    polyfillSource: linked.source,
    cacheDir,
    compileOptions: STANDALONE,
  });
  const report = {
    issue: 5383,
    slice: "S2k",
    provider: {
      namespace: provider.namespace,
      binaryBytes: provider.artifact.binary.length,
      cacheHit: provider.cacheHit,
      buildMs: provider.buildMs,
    },
    probes: {},
  };
  for (const [label, source] of Object.entries(PROBES)) {
    report.probes[label] = await observe(source, provider, `/${label}.js`);
    log(`[temporal-s2] ${label}: ${JSON.stringify(report.probes[label])}`);
  }
  return report;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const report = await runTemporalS2SmokeHarness({ quiet: json });
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
}
