// #4628 step 3 — the `Temporal` runtime global, end to end.
//
// The spike harness next door (`temporal-polyfill-harness.mjs`) answers
// "does the polyfill compile / validate / initialise?". This one answers the
// question that follows: "with the compiled polyfill published as a linked
// provider, what does a USER program that says `Temporal` actually observe?"
//
// Runs as a child process (same rationale as the spike harness and the
// clsx/acorn adapters): the provider compile is tens of seconds of synchronous
// work and must never block a vitest worker's RPC heartbeat.
//
// Loop:
//   1. ACQUIRE + LINK — the pinned tarball contract, unchanged
//      (setup-temporal-polyfill.mjs).
//   2. PROVIDER — `buildTemporalProvider` compiles the bundle ONCE into a
//      content-addressed provider binary (`src/temporal-provider.ts`).
//   3. CONSUME — each probe is compiled with `compileWithTemporalGlobal`,
//      which binds bare `Temporal` to the provider's export, then instantiated
//      through the ordinary linked-project path.
//
// Every probe records what it OBSERVED, never a pass/fail verdict. Two probe
// sets, and the split is the point:
//
//   * `supported` — shapes that work today. The vitest wrapper asserts these.
//     (#5222 moved the `Temporal.Now.*` probes from `knownGaps` to `supported`.)
//   * `knownGaps`  — shapes that do NOT work today, WITH the measurement that
//     says why they are not this change's fault. `Temporal.PlainDate.from(...)`
//     fails identically when the polyfill is compiled as ONE module with no
//     provider and no linking at all (measured 2026-08-30), so it is a
//     pre-existing compiler gap on the polyfill's own internals, not a
//     regression introduced by the provider seam. Recording them here — rather
//     than omitting them — is what keeps the next reader from re-deriving that.
//
// Invoke:  node --import tsx tests/dogfood/temporal-global-harness.mjs [--json]

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { instantiateLinkedProject } from "../../src/index.ts";
import { buildTemporalProvider, compileWithTemporalGlobal } from "../../src/temporal-provider.ts";
import { setupTemporalPolyfill, linkPolyfillSource } from "./setup-temporal-polyfill.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "temporal-global.json");

/** Shapes that work today — the vitest wrapper asserts every one of these. */
const SUPPORTED = {
  // The headline: `Temporal` is an OBJECT at run time, not a ReferenceError.
  // On `main` this same program answers "undefined" / throws
  // "Temporal is not defined" — the 1,589-row test262 bucket.
  typeofTemporal: `export function run() { return typeof Temporal; }`,
  // Issue acceptance criterion 1: the class names are enumerable own keys.
  ownPropertyNames: `export function run() { return Object.getOwnPropertyNames(Temporal).sort().join(","); }`,
  // Issue acceptance criterion 1: a Temporal class survives being passed as a
  // VALUE through a function boundary — the thing the #661 syntactic lowering
  // structurally cannot do.
  classAsValue: `
    function nameOf(K) { return typeof K; }
    export function run() { return nameOf(Temporal.PlainDate); }
  `,
  classHasStatics: `export function run() { return Object.getOwnPropertyNames(Temporal.PlainDate).sort().join(","); }`,
  // A constructed instance carries real field values from the polyfill.
  constructAndReadFields: `
    export function run() {
      const d = new Temporal.PlainDate(2020, 3, 4);
      return d.year + "/" + d.month + "/" + d.day;
    }
  `,
  // `Temporal` is a plain value: aliasing it must not disturb anything.
  aliasable: `
    export function run() { const T = Temporal; return typeof T.ZonedDateTime; }
  `,
  // (#5222) `Now` is a plain NAMESPACE OBJECT of functions nested one level
  // inside `Temporal`, so reaching its methods crosses the provider seam TWICE.
  // On base the second crossing erased them: "undefined", and
  // `Object.getOwnPropertyNames(Temporal.Now)` was empty.
  nowKeys: `export function run() { return Object.getOwnPropertyNames(Temporal.Now).sort().join(","); }`,
  nowInstantIsFunction: `export function run() { return typeof Temporal.Now.instant; }`,
  nowInstantCallable: `export function run() { return typeof Temporal.Now.instant(); }`,
  nowPlainDateISOIsFunction: `export function run() { return typeof Temporal.Now.plainDateISO; }`,
  // (#5223) Was a knownGap reading "[object Object]". It answers the real ISO
  // date on this base — the #5221 lowering fixes wired the prototype-method
  // dispatch for a `new`-constructed provider instance. Promoted here so the
  // vitest wrapper asserts it and a regression is loud.
  instanceToString: `export function run() { return new Temporal.PlainDate(2020, 3, 4).toString(); }`,
  // (#5237) Two rows the cross-module member fixes moved. Both were reported
  // as part of the `staticFrom` symptom and are genuinely seam defects, unlike
  // `staticFrom` itself (see its note). On base the first THREW and the second
  // answered 0.
  protoMethodCall: `export function run() { return Temporal.PlainDate.prototype.toString.call(new Temporal.PlainDate(2020, 3, 4)); }`,
  protoMemberCount: `export function run() { return Object.getOwnPropertyNames(Temporal.PlainDate.prototype).length; }`,
  // (#5239) The last of the `staticFrom` family, and the one every earlier
  // pass mis-attributed. `CreateTemporalDate` builds its instance as
  // `Object.create(<class value>.prototype)`; the syntactic fast path only
  // recognises the spelling `Object.create(Foo.prototype)`, so the minified
  // bundle got a plain host object whose [[Prototype]] was an opaque WasmGC
  // struct — a dead end for member dispatch. On base this answered
  // "[object Object]", and `.year` answered undefined, IDENTICALLY in a
  // single-module control with no linker at all.
  staticFrom: `export function run() { return Temporal.PlainDate.from("2026-08-30").toString(); }`,
  staticFromField: `export function run() { return String(Temporal.PlainDate.from("2026-08-30").year); }`,
  staticCompare: `export function run() { return Temporal.PlainDate.compare(Temporal.PlainDate.from("2020-03-04"), Temporal.PlainDate.from("2021-03-04")); }`,
};

/**
 * Shapes that do NOT work today. Recorded, not hidden. `note` states what was
 * measured about each, so the next reader does not have to re-derive whether
 * the provider seam caused it.
 */
const KNOWN_GAPS = {
  // (#5222) `Temporal.Now.instant` moved to SUPPORTED above. These two are
  // what is LEFT once the member loss is fixed, and they are different animals.
  nowPlainDateISOCall: {
    source: `export function run() { return typeof Temporal.Now.plainDateISO(); }`,
    note:
      "reachable and callable since #5222, but the CALL still throws (RuntimeError: dereferencing a null " +
      "pointer) — identically in the single-module shape with no provider and no linking (measured " +
      "2026-08-30, .tmp/probe-now-single.mts). RE-MEASURED 2026-08-31 after #5239 landed the Object.create " +
      "instance fix, in both the provider and single-module lanes: it still throws the same null deref, so " +
      "the earlier attribution to the `staticFrom` / Object.create family was WRONG — that family is now " +
      "fixed and this row did not move. Owned by #5221, not a provider-seam defect",
  },
  nowTimeZoneIdCall: {
    source: `export function run() { return typeof Temporal.Now.timeZoneId(); }`,
    note:
      'NEW, still linking-specific (measured 2026-08-30): answers "string" in the single-module shape but ' +
      "throws (RuntimeError: dereferencing a null pointer) through the provider. Unlike the member loss " +
      "#5222 fixed, this survives it — the residual is in what `timeZoneId` REACHES (the host " +
      "`Intl.DateTimeFormat().resolvedOptions()` path, cf. #5206), not in the value crossing",
  },
  instanceToStringTag: {
    source: `export function run() { const d = new Temporal.PlainDate(2020, 3, 4); return String(d[Symbol.toStringTag]); }`,
    note:
      'answers "undefined" — `Symbol.toStringTag` on a compiled class instance is not wired, so ' +
      "`Object.prototype.toString.call(inst)` still reports [object Object]. Measured 2026-08-30 (#5223) and " +
      "reproduced on a PLAIN user class in one module, so it is general, not Temporal- or provider-specific. " +
      "The prototype `toString()` METHOD does dispatch correctly (see `instanceToString` in SUPPORTED)",
  },
};

async function observe(source, provider, fileName) {
  const started = Date.now();
  try {
    const result = await compileWithTemporalGlobal(source, provider, { fileName });
    const errors = (result.errors ?? []).filter((e) => e.severity !== "warning");
    if (!result.success) {
      return { status: "compile-failed", errors: errors.slice(0, 3).map((e) => e.message), ms: Date.now() - started };
    }
    const { instance } = await instantiateLinkedProject(result);
    const value = instance.exports.run?.();
    return { status: "ok", value: value === undefined ? null : value, ms: Date.now() - started };
  } catch (error) {
    return {
      status: "threw",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ms: Date.now() - started,
    };
  }
}

export async function runTemporalGlobalHarness({ quiet = false, cacheDir } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const setup = setupTemporalPolyfill();
  const linked = linkPolyfillSource(setup);
  log(`[temporal-global] @js-temporal/polyfill@${setup.version} linked to ${linked.source.length} B`);

  const providerCacheDir = cacheDir ?? process.env.JS2WASM_TEMPORAL_CACHE ?? join(tmpdir(), "js2wasm-temporal-cache");
  const provider = await buildTemporalProvider({ polyfillSource: linked.source, cacheDir: providerCacheDir });
  log(
    `[temporal-global] provider ${provider.namespace} (${provider.artifact.binary.length} B) ` +
      `built in ${provider.buildMs}ms cacheHit=${provider.cacheHit}`,
  );

  const report = {
    issue: 4628,
    generatedAt: new Date().toISOString(),
    polyfillVersion: setup.version,
    provider: {
      namespace: provider.namespace,
      getterField: provider.getterField,
      binaryBytes: provider.artifact.binary.length,
      buildMs: provider.buildMs,
      cacheHit: provider.cacheHit,
    },
    supported: {},
    knownGaps: {},
  };

  for (const [label, source] of Object.entries(SUPPORTED)) {
    report.supported[label] = await observe(source, provider, `/${label}.js`);
    log(`[temporal-global] ${label}: ${JSON.stringify(report.supported[label])}`);
  }
  for (const [label, { source, note }] of Object.entries(KNOWN_GAPS)) {
    report.knownGaps[label] = { ...(await observe(source, provider, `/${label}.js`)), note };
    log(`[temporal-global] (gap) ${label}: ${report.knownGaps[label].status}`);
  }

  // The compile-once claim, measured rather than asserted: a SECOND consumer
  // must not pay the provider's build cost again.
  const secondConsumerStarted = Date.now();
  await observe(`export function run() { return typeof Temporal; }`, provider, "/second-consumer.js");
  report.secondConsumerMs = Date.now() - secondConsumerStarted;
  log(`[temporal-global] second consumer compile+run: ${report.secondConsumerMs}ms`);

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const report = await runTemporalGlobalHarness({ quiet: json });
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
}
