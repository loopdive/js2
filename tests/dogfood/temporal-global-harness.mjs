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

import { mkdirSync, statSync, writeFileSync } from "node:fs";
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
  // (#5243) THE FIRST ARITHMETIC ROW THAT WORKS. `add("P1D")` reaches the ISO
  // calendar's `dateAdd(e, {years = 0, …}, i)` exactly like `add({days: 1})`
  // does; on base BOTH threw `Cannot destructure 'null' or 'undefined'` because
  // the record `Wr(e) → { ...t.date, days: n }` built on the host path was
  // null-cast back into its inferred struct type. This row's argument is a
  // STRING, so the only object crossing the provider seam is that internal
  // record — which is why it flips here while `add({days: 1})` (a user object
  // literal crossing the seam, #5225's lane) stays in knownGaps.
  arithmeticAddString: `export function run() { return Temporal.PlainDate.from("2020-03-04").add("P1D").toString(); }`,
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
  // (#5241) The arithmetic family — every test262 Temporal arithmetic row takes
  // an argument, so this is what bounds that bucket next. #5241 fixed the
  // extern-class HIJACK that made a builtin-colliding method name answer
  // `undefined` without calling; these rows prove the call now HAPPENS and
  // fails deeper, on defects that are not #5241's.
  //
  // Measured 2026-08-31 with a fresh JS2WASM_TEMPORAL_CACHE per lane
  // (.tmp/probe-temporal-5241.mjs and .tmp/probe-temporal-single-5241.mjs):
  //
  //   PROVIDER lane        base           after #5241
  //     add({days:1})      THREW          THREW      (unchanged)
  //     add("P1D")         THREW          THREW      (unchanged)
  //     subtract/with/until THREW         THREW      (unchanged)
  //     equals("…")        true           true       (no regression)
  //   SINGLE-MODULE lane (polyfill + consumer in ONE module, no linker)
  //     add({days:1})      undefined  →   TypeError: Cannot destructure 'null' or 'undefined'
  //     add("P1D")         undefined  →   TypeError: compiled class constructor Duration bridge unavailable
  //     subtract({days:1}) same Duration-bridge TypeError both sides
  //     with({year:2021})  "2021-03-04"   "2021-03-04"  (worked already)
  //
  // So the `undefined` #5241 names IS gone where the class is visible, and what
  // is left is two different defects: a missing compiled-class constructor
  // bridge for `Duration`, and a null destructure inside the polyfill's options
  // handling. Through the PROVIDER the throw predates and survives #5241, which
  // is why these stay here rather than being promoted.
  //
  // (#5242) The FIRST of those two is now fixed — a compiled class reached as a
  // VALUE has a real constructor bridge (`__class_construct_<Class>_<arity>`),
  // so `compiled class constructor Duration bridge unavailable` no longer
  // appears anywhere. Re-measured 2026-08-31 with a fresh JS2WASM_TEMPORAL_CACHE
  // per lane, on both sides of the change:
  //
  //   SINGLE-MODULE lane        base (#5242)                    after #5242
  //     add({days:1})           destructure null                destructure null   (unchanged)
  //     add("P1D")              Duration bridge unavailable  →  destructure null
  //     subtract({days:1})      Duration bridge unavailable  →  destructure null
  //     subtract("P1D")         Duration bridge unavailable  →  destructure null
  //     with({year:2021})       "2021-03-04"                    "2021-03-04"       (unchanged)
  //     new Duration(0,0,0,1)   "P1D"                           "P1D"              (unchanged)
  //   PROVIDER lane             every arithmetic row throws identically on both
  //                             sides (WebAssembly.Exception) — measured, not
  //                             inherited; the whole `knownGaps` block below is
  //                             byte-identical between the two runs.
  //
  // HOW TO ASSEMBLE THE SINGLE-MODULE CONTROL — one line decides what you
  // measure, and getting it wrong looks like a PASS (#5243, 2026-08-31). The
  // polyfill bundle ends with `export{qi as Temporal}`: an export ALIAS, not a
  // top-level binding. So concatenating the bundle with a consumer that says
  // bare `Temporal` leaves that identifier UNBOUND, and the #661 syntactic
  // native lowering answers the spelling instead — the compiled polyfill is
  // never entered. Measured with both bindings in ONE module:
  //
  //                          bare `Temporal`            `const T = qi`
  //     typeof               "undefined"                "object"
  //     .PlainDate.name      THREW "Temporal is not     "PlainDate"
  //                           defined"
  //     add({days:1})        "2020-03-05"               THREW destructure null
  //     with({year:2021})    THREW "with is not a       "2021-03-04"
  //                           function"
  //
  // `typeof Temporal === "undefined"` while `Temporal.PlainDate.from(…).add(…)`
  // returns a correct date is the tell. Bind the namespace —
  // `const Temporal = qi;` — or you are measuring the native lowering, whose
  // gaps (no `with`) are the exact INVERSE of the polyfill's.
  //
  // What is LEFT in the single-module lane is ONE defect, and it is not this
  // change's: the ISO calendar's `dateAdd(e, {years=0, months=0, weeks=0,
  // days=0}, i)` has a DESTRUCTURING PARAMETER, and its second argument arrives
  // null through the dynamic method bridge (`__extern_method_call` →
  // `__call_fn_method_3` → `__anon_0_dateAdd`). Control: `add({days:1})` — which
  // never constructs a Duration at all — fails with the SAME message and the
  // SAME stack on base, where no constructor bridge was involved. So it is a
  // parameter-destructuring / argument-marshalling gap on the dynamic method
  // bridge, adjacent to #5221's destructuring work, not a residue of the
  // constructor path.
  //
  // (#5243) That null is FIXED, and the bridge was the messenger, not the
  // cause. The polyfill's `Wr(e)` returns `{ ...t.date, days: n }`; an object
  // literal with a spread has no statically closed shape, so it is built on
  // the HOST and comes back as an `externref`, while `Wr`'s inferred return
  // type is the concrete `__anon_37` record. `coerceType`'s `externref →
  // ref/ref_null` arm `ref.test`ed that host object against the struct, failed,
  // and pushed `ref.null`. Measured 2026-08-31, fresh JS2WASM_TEMPORAL_CACHE
  // per lane, both sides of the change:
  //
  //   SINGLE-MODULE lane        base (#5243)                  after #5243
  //     add({days:1})           destructure null           →  "2020-03-04" (wrong, see below)
  //     subtract({days:1})      destructure null           →  "2020-03-04" (wrong)
  //     add("P1D")              destructure null           →  "2020-03-04" (wrong)
  //     with({year:2021})       "2021-03-04"                  "2021-03-04"  (unchanged)
  //     new Duration(0,0,0,1)   "P1D"                         "P1D"         (unchanged)
  //   PROVIDER lane
  //     add("P1D")              destructure null           →  "2020-03-05" CORRECT
  //                              (now asserted as `arithmeticAddString` above)
  //     add({days:1})           WebAssembly.Exception         unchanged (#5225)
  //     subtract / with         WebAssembly.Exception         unchanged (#5225)
  //
  // The single-module rows stop THROWING but answer the unchanged date,
  // because a SECOND defect owns them and it is not this one: the polyfill's
  // `sn(e)` (ToTemporalDuration) constructs through the intrinsics registry,
  // `new (ce("%Temporal.Duration%"))(…)`, i.e. #5242's class-VALUE ctor mirror.
  // Measured on the same build: the mirror's `[[Construct]]` trap receives the
  // right ten arguments and resolves `__class_construct_Duration_10`, and
  // calling that export DIRECTLY from JS yields a Duration reading
  // "11,12,13,14,15" — but the instance the trap hands back to Wasm reads
  // "11,0,0,0,0,0,0,0,0,0", every field after the first defaulted. Control:
  // `new Temporal.Duration(11,…,20)` (statically resolved, no mirror) reads all
  // ten correctly. That is #5244's lane, filed separately.
  arithmeticAddDuration: {
    source: `export function run() { return Temporal.PlainDate.from("2020-03-04").add({days: 1}).toString(); }`,
    note:
      "throws through the provider, identically on the #5241 base (measured 2026-08-31, fresh provider cache). " +
      "In the SINGLE-MODULE control the same call moved from `undefined` (the #5241 hijack: `add` first-matched " +
      "`Set.prototype.add`) to a real TypeError from inside the polyfill, so the call now happens. Residual is " +
      "not the extern-binding defect; the object-literal ARGUMENT crossing the provider seam is #5225's lane. " +
      "(#5242) This row is the CONTROL that attributes the remaining single-module failure: it never constructs a " +
      "Duration, yet it throws `Cannot destructure 'null' or 'undefined'` with an identical stack on both sides of " +
      "#5242 — the ISO calendar's `dateAdd(e, {years=0, …}, i)` destructuring parameter receives null through the " +
      "dynamic method bridge. So that null is NOT a constructor-path residue. " +
      "(#5243) That null is FIXED (it was the host-path object SPREAD in `Wr`, null-cast back into its inferred " +
      "record type — see the block above). This row's provider-lane throw is UNCHANGED and is #5225's; its " +
      'single-module control now answers "2020-03-04" — no throw, wrong date — which is #5244',
  },
  arithmeticSubtract: {
    source: `export function run() { return Temporal.PlainDate.from("2020-03-04").subtract({days: 1}).toString(); }`,
    note:
      "same provider-lane throw, unchanged by #5241 AND unchanged by #5242 (both sides measured 2026-08-31 with a " +
      "fresh provider cache). The single-module control moved: it failed with `compiled class constructor Duration " +
      "bridge unavailable` on both sides of #5241, and #5242 fixed that — it now fails one layer deeper, on the " +
      "`dateAdd` destructuring-parameter null shared with `arithmeticAddDuration`. Provider-lane residue is the " +
      "object-literal ARGUMENT crossing the seam, #5225's lane. (#5243) Same as `arithmeticAddDuration`: the " +
      'destructuring null is gone, the provider throw is unchanged, and the single-module control answers "2020-03-04" ' +
      "(#5244)",
  },
  arithmeticWith: {
    source: `export function run() { return Temporal.PlainDate.from("2020-03-04").with({year: 2021}).toString(); }`,
    note:
      'throws through the provider on both sides of #5241, but ANSWERS "2021-03-04" in the single-module control ' +
      "on both sides too — so this row isolates the provider SEAM specifically, unlike the two above",
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
  // (#5227 / #5243) A CACHE HIT IS NOT FREE INFORMATION — SAY SO.
  //
  // The provider cache is content-addressed on the POLYFILL source, which a
  // compiler change does not touch. So a hit serves a provider binary built by
  // whatever compiler ran last in this container, against a consumer compiled
  // by yours, and the mismatch surfaces as `RuntimeError: dereferencing a null
  // pointer` in rows that have nothing to do with your change.
  //
  // Cost of not saying it, measured 2026-08-31: a 17-hour-old
  // `$TMPDIR/js2wasm-temporal-cache` made FIVE asserted `supported` rows fail
  // at once — `protoMethodCall`, `staticFrom`, `staticFromField`,
  // `staticCompare`, `arithmeticAddString` — in a pre-commit hook run, on a
  // branch where every one of them passes with a fresh cache. The vitest
  // wrapper reports only the first, so it reads as one specific regression in
  // somebody's recent work rather than as a stale artifact.
  //
  // Rule: after ANY `src/` edit, point `JS2WASM_TEMPORAL_CACHE` at a fresh
  // directory. The age below is printed so a surprising row can be checked
  // against it before it is attributed to a code change.
  let providerCacheAgeHours = null;
  if (provider.cacheHit) {
    try {
      providerCacheAgeHours =
        Math.round(((Date.now() - statSync(join(providerCacheDir, "providers")).mtimeMs) / 3_600_000) * 10) / 10;
    } catch {
      /* cache layout differs — the warning below still stands */
    }
    log(
      `[temporal-global] WARNING: served a CACHED provider${providerCacheAgeHours === null ? "" : `, ${providerCacheAgeHours}h old`}` +
        ` from ${providerCacheDir}. It was NOT built by the compiler in this working tree. A failing row may be ` +
        `this, not your change — re-run with JS2WASM_TEMPORAL_CACHE pointing at a fresh directory before ` +
        `attributing it.`,
    );
  }

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
      // (#5227 / #5243) Non-null ONLY on a cache hit. A reader diagnosing a
      // failed row should check this before attributing it to a code change.
      cacheAgeHours: providerCacheAgeHours,
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
