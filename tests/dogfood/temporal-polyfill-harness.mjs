// @js-temporal/polyfill dogfood harness — COMPILE + VALIDATE lane only (#4628).
//
// This is the spike harness for #4628 ("Temporal as a real runtime object").
// Its deliverable is a NUMBER, not an implementation: how many compile errors
// does js2wasm report on the published @js-temporal/polyfill bundle, grouped
// by rejection reason, and does the emitted binary validate?
//
// Deliberately the CHEAP HALF of the dogfood pattern: no differential
// execution lane. clsx/acorn/marked diff compiled output against a native
// oracle; here the question is only whether the ~15k-line real-world library
// gets through the front end at all, so the harness stops at
// WebAssembly.compile(). Adding a run+diff lane is follow-up work that only
// makes sense once the compile lane is green.
//
// Loop:
//   1. ACQUIRE  — two pinned npm-pack tarballs, no run-time network
//                 (@js-temporal/polyfill + its single dep jsbi); see
//                 setup-temporal-polyfill.mjs.
//   2. LINK     — concatenate jsbi ahead of the polyfill's ESM bundle and
//                 rewrite its one `import` into a local binding. Collision-free
//                 by construction (see temporal-polyfill-pin.json `_note`).
//   3. COMPILE  — through compile() with the SAME options the test262 runner
//                 uses (tests/test262-runner.ts): allowJs + skipSemanticDiagnostics
//                 + sourceMap. `allowJs` is load-bearing: without it this
//                 measures TypeScript diagnostics on published JS, not compiler
//                 gaps.
//   4. VALIDATE — WebAssembly.compile(binary). Compiling and validating are
//                 DIFFERENT gates: #4627 is exactly a case where the first
//                 passed and the second did not.
//   4b. INSTANTIATE — WebAssembly.instantiate(binary). A THIRD gate, added in
//                 #4628 step 3, for the same reason 4 exists: on 2026-08-29
//                 the ESM lane passed 3 and 4 and still threw the instant its
//                 module init ran. Option A installs `Temporal` from this
//                 module's exports, so a module that never finishes init has
//                 no exports to install and no wiring can route around it.
//                 Disable with `--no-instantiate`.
//   5. BUCKET   — group diagnostics by normalized rejection reason, largest
//                 first. This list is the real artifact — a prioritized
//                 compiler-bug backlog against a real-world library, useful
//                 regardless of which #4628 option wins.
//
// A second, link-free lane compiles dist/index.umd.js (self-contained,
// Babel-transpiled to ES5) so the numbers are not an artifact of one bundle
// shape.
//
// Invoke:  node tests/dogfood/temporal-polyfill-harness.mjs
//          node tests/dogfood/temporal-polyfill-harness.mjs --json
//
// Pure tooling — this file fixes no compiler bug.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import ts from "typescript";

import { compile } from "../../src/index.ts";
import { setupTemporalPolyfill, linkPolyfillSource, readUmdSource } from "./setup-temporal-polyfill.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "temporal-polyfill-surface.json");

// The exact option set tests/test262-runner.ts passes for a test body. Kept
// here as one object so the spike can never drift from the lane whose 2,206
// `Temporal is not defined` rows motivate the issue.
const TEST262_COMPILE_OPTIONS = {
  allowJs: true,
  sourceMap: true,
  emitWat: false,
  skipSemanticDiagnostics: true,
};

// ---------------------------------------------------------------------------
// Bucketing — group by REJECTION REASON, not by message identity.
//
// Two levels: a coarse `category` (what kind of gap is this?) and a fine
// `bucket` (the message with literals normalized away, so 400 rejections of
// the same construct collapse to one row with a count).
// ---------------------------------------------------------------------------
function categorizeError(message) {
  const m = message ?? "";
  // Compiler capability gaps first — these are the ones that matter.
  if (/Unsupported|not supported|not yet supported|unsupported/i.test(m)) return "unsupported-construct";
  if (/Cannot (compile|emit|lower|resolve)/i.test(m)) return "cannot-lower";
  if (/BigInt|bigint/.test(m)) return "bigint";
  if (/getter|setter|accessor|defineProperty|property descriptor/i.test(m)) return "property-descriptors";
  if (/prototype|__proto__|setPrototypeOf|extends|super\b/i.test(m)) return "prototype-and-class";
  if (/dynamic|computed|index signature|element access/i.test(m)) return "dynamic-access";
  if (/[Rr]egular expression|RegExp/.test(m)) return "regexp";
  if (/[Ii]ntl\b/.test(m)) return "intl";
  if (/generator|yield|async|await|Promise/i.test(m)) return "async-and-generators";
  // TypeScript-diagnostic noise (should be near-zero with skipSemanticDiagnostics).
  if (/Property '.*' does not exist on type/.test(m)) return "ts-property-noise";
  if (/Cannot find name/.test(m)) return "ts-cannot-find-name";
  if (/is not assignable to/.test(m)) return "ts-not-assignable";
  if (/implicitly has an? '.*' type/.test(m)) return "ts-implicit-any";
  return "other";
}

function normalizeForBucket(message) {
  return (message ?? "")
    .replace(/\d+/g, "N")
    .replace(/'[^']*'/g, "'X'")
    .replace(/"[^"]*"/g, '"X"')
    .slice(0, 200);
}

function bucketDiagnostics(errors) {
  /** @type {Record<string, {count:number, sample:string, firstLine:number|null, buckets:Record<string,number>}>} */
  const categories = {};
  /** @type {Record<string, {count:number, category:string, sample:string, firstLine:number|null}>} */
  const buckets = {};

  for (const e of errors) {
    const message = e.message ?? String(e);
    const cat = categorizeError(message);
    const norm = normalizeForBucket(message);

    if (!categories[cat]) {
      categories[cat] = { count: 0, sample: message, firstLine: e.line ?? null, buckets: {} };
    }
    categories[cat].count++;
    categories[cat].buckets[norm] = (categories[cat].buckets[norm] ?? 0) + 1;

    if (!buckets[norm]) {
      buckets[norm] = { count: 0, category: cat, sample: message, firstLine: e.line ?? null };
    }
    buckets[norm].count++;
  }

  const ranked = Object.entries(buckets)
    .map(([reason, v]) => ({ reason, ...v }))
    .sort((a, b) => b.count - a.count);

  return { categories, ranked };
}

// ---------------------------------------------------------------------------
// One compile + validate + instantiate lane.
// ---------------------------------------------------------------------------
async function measure({ label, fileName, source, log, instantiate = true }) {
  const lane = { label, fileName, sourceBytes: source.length };

  const t0 = performance.now();
  let result;
  let threw = null;
  try {
    result = await compile(source, { fileName, ...TEST262_COMPILE_OPTIONS });
  } catch (e) {
    threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  lane.compileMs = Math.round(performance.now() - t0);

  if (threw) {
    lane.compile = { success: false, threw, errorCount: null };
    lane.validation = { validates: false, firstError: "compile() threw — no binary" };
    log(`[dogfood] ${label}: compile() THREW after ${lane.compileMs}ms — ${threw}`);
    return lane;
  }

  const all = result.errors ?? [];
  const errors = all.filter((e) => e.severity !== "warning");
  const warnings = all.filter((e) => e.severity === "warning");
  const { categories, ranked } = bucketDiagnostics(errors);

  lane.compile = {
    success: result.success,
    errorCount: errors.length,
    warningCount: warnings.length,
    distinctReasons: ranked.length,
    binaryBytes: result.binary?.length ?? 0,
    categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.count])),
    topReasons: ranked.slice(0, 25),
    warningCategories: Object.fromEntries(
      Object.entries(bucketDiagnostics(warnings).categories).map(([k, v]) => [k, v.count]),
    ),
  };
  log(
    `[dogfood] ${label}: compile() success=${result.success} in ${lane.compileMs}ms — ` +
      `${errors.length} errors / ${warnings.length} warnings across ${ranked.length} distinct reasons, ` +
      `binary ${result.binary?.length ?? 0} bytes`,
  );

  // VALIDATE — a separate gate from compiling (see #4627).
  let validates = false;
  let validationError = null;
  if (result.binary && result.binary.length) {
    try {
      await WebAssembly.compile(result.binary);
      validates = true;
    } catch (e) {
      validationError = e instanceof Error ? e.message : String(e);
    }
  } else {
    validationError = "no binary emitted";
  }
  lane.validation = { validates, firstError: validationError };
  log(
    validates
      ? `[dogfood] ${label}: WebAssembly.compile() OK — binary validates`
      : `[dogfood] ${label}: WebAssembly.compile() FAILED — ${validationError}`,
  );

  // INSTANTIATE — a THIRD gate, separate from both above (#4628 step 3).
  //
  // The spike stopped at validate, and that left the decisive question
  // unasked: a module can compile and validate and still throw the moment its
  // module-init runs. It does. Option A installs `Temporal` from this module's
  // exports, so an instantiate failure is a hard blocker — no wiring choice
  // can route around a module that never produces exports. Reported as its
  // own lane so a future run cannot mistake "validates" for "works".
  if (instantiate && validates) {
    const t1 = performance.now();
    let instantiated = false;
    let instantiateError = null;
    try {
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
      result.importObject?.__setInstance?.(instance);
      instantiated = true;
      lane.instantiation = {
        instantiated,
        ms: Math.round(performance.now() - t1),
        exportCount: Object.keys(instance.exports).length,
      };
    } catch (e) {
      // A module-init throw arrives as a WebAssembly.Exception whose payload
      // needs the module's own `__exn_tag` export to read — unavailable here,
      // because the throw happened BEFORE there is an instance. Record the
      // shape; `.tmp` bisection is how the offending statement gets named.
      //
      // (#5209) A HOST-side TypeError (the common module-init blocker: the
      // runtime refusing a compiled value at a host boundary) does carry a
      // stack, and it names the polyfill function chain down from
      // `__module_init` — which is the single most useful line for filing the
      // next blocker. `JS2WASM_DOGFOOD_STACK=1` prints it. Off by default so
      // the report output stays the stable artifact it is today.
      if (process.env.JS2WASM_DOGFOOD_STACK) console.error("[dogfood] init stack:\n" + (e?.stack ?? e));
      instantiateError =
        typeof WebAssembly !== "undefined" && e instanceof WebAssembly.Exception
          ? "WebAssembly.Exception thrown from module init (payload unreadable: no instance, so no __exn_tag)"
          : e instanceof Error
            ? `${e.name}: ${e.message}`
            : String(e);
      lane.instantiation = { instantiated, ms: Math.round(performance.now() - t1), error: instantiateError };
    }
    log(
      instantiated
        ? `[dogfood] ${label}: WebAssembly.instantiate() OK — module init ran`
        : `[dogfood] ${label}: WebAssembly.instantiate() FAILED — ${instantiateError}`,
    );
  } else {
    lane.instantiation = { instantiated: false, skipped: instantiate ? "binary does not validate" : "lane disabled" };
  }

  return lane;
}

// ---------------------------------------------------------------------------
// SLICE lane — the fallback when the whole-bundle compile does not terminate.
//
// A CE count you never obtain is worth less than a bucketed cause list from
// partial coverage, so this mode splits the linked bundle at TOP-LEVEL
// STATEMENT boundaries and compiles the chunks one at a time, printing each
// result as it lands. Two honesty constraints:
//
//   * COVERAGE IS REPORTED, never silently truncated. Every slice records
//     whether it compiled, and a slice that is skipped (`--skip-slices`, used
//     to step past one that hangs) stays in the report as `skipped`.
//   * A slice is NOT a module. Chunking breaks cross-references, so a slice's
//     diagnostics can include noise a whole-bundle compile would not produce.
//     The bucket list from this lane is a PRIORITIZED HINT, not a substitute
//     for the whole-bundle number.
// ---------------------------------------------------------------------------
function sliceTopLevel(source, fileName, perSlice) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const statements = sf.statements;
  const slices = [];
  for (let i = 0; i < statements.length; i += perSlice) {
    const group = [];
    for (let j = i; j < Math.min(i + perSlice, statements.length); j++) group.push(statements[j]);
    const start = group[0].getStart(sf);
    const end = group[group.length - 1].getEnd();
    slices.push({
      index: slices.length,
      firstStatement: i,
      statementCount: group.length,
      text: source.slice(start, end),
    });
  }
  return { totalStatements: statements.length, slices };
}

async function measureSlices({ source, fileName, perSlice, skip, log }) {
  const { totalStatements, slices } = sliceTopLevel(source, fileName, perSlice);
  log(`[dogfood] slice lane: ${totalStatements} top-level statements → ${slices.length} slices of ${perSlice}`);

  const results = [];
  const allErrors = [];
  const allValidationErrors = [];
  for (const slice of slices) {
    if (skip.has(slice.index)) {
      results.push({ ...slice, text: undefined, status: "skipped" });
      log(`[dogfood]   slice ${slice.index}: SKIPPED by --skip-slices`);
      continue;
    }
    const t0 = performance.now();
    let result;
    let threw = null;
    try {
      result = await compile(slice.text, {
        fileName: `${fileName}.slice${slice.index}.mjs`,
        ...TEST262_COMPILE_OPTIONS,
      });
    } catch (e) {
      threw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    const ms = Math.round(performance.now() - t0);

    if (threw) {
      results.push({ index: slice.index, statementCount: slice.statementCount, status: "threw", threw, ms });
      log(`[dogfood]   slice ${slice.index}: THREW in ${ms}ms — ${threw.slice(0, 120)}`);
      continue;
    }
    const errors = (result.errors ?? []).filter((e) => e.severity !== "warning");
    allErrors.push(...errors);
    let validates = false;
    let validationError = result.binary?.length ? null : "no binary emitted";
    if (result.binary?.length) {
      try {
        await WebAssembly.compile(result.binary);
        validates = true;
      } catch (e) {
        validationError = e instanceof Error ? e.message : String(e);
      }
    }
    if (validationError) allValidationErrors.push({ slice: slice.index, message: validationError });
    results.push({
      index: slice.index,
      statementCount: slice.statementCount,
      status: result.success ? "compiled" : "compile-failed",
      errorCount: errors.length,
      validates,
      validationError,
      binaryBytes: result.binary?.length ?? 0,
      ms,
    });
    log(
      `[dogfood]   slice ${slice.index}: ${result.success ? "ok" : "FAILED"} in ${ms}ms — ` +
        `${errors.length} errors, validates=${validates}` +
        (validationError ? ` — ${validationError.slice(0, 160)}` : ""),
    );
  }

  const ran = results.filter((r) => r.status !== "skipped");
  const { ranked, categories } = bucketDiagnostics(allErrors);
  return {
    perSlice,
    totalStatements,
    sliceCount: slices.length,
    coverage: {
      slicesRun: ran.length,
      slicesSkipped: results.length - ran.length,
      statementsCovered: ran.reduce((n, r) => n + r.statementCount, 0),
      statementsTotal: totalStatements,
    },
    slices: results,
    errorCount: allErrors.length,
    // The validate gate is SEPARATE from the compile gate (#4627). With zero
    // compile errors the whole spike answer lives here.
    validationFailures: allValidationErrors.length,
    validationReasons: Object.entries(
      allValidationErrors.reduce((acc, v) => {
        const key = normalizeForBucket(v.message);
        acc[key] = acc[key] ?? { count: 0, sample: v.message, slices: [] };
        acc[key].count++;
        acc[key].slices.push(v.slice);
        return acc;
      }, {}),
    )
      .map(([reason, v]) => ({ reason, ...v }))
      .sort((a, b) => b.count - a.count),
    distinctReasons: ranked.length,
    categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.count])),
    topReasons: ranked.slice(0, 40),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function runHarness({
  quiet = false,
  umd = true,
  slices = 0,
  skipSlices = [],
  whole = true,
  instantiate = true,
} = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const report = {
    issue: 4628,
    generatedAt: new Date().toISOString(),
    compileOptions: TEST262_COMPILE_OPTIONS,
    polyfill: null,
    lanes: {},
    summary: {},
  };

  // --- 1. ACQUIRE ----------------------------------------------------------
  const setup = setupTemporalPolyfill();
  report.polyfill = {
    version: setup.version,
    source: setup.pin.tarball,
    entryModule: setup.pin.entryModule,
    dependency: `${setup.pin.dependency.name}@${setup.pin.dependency.version}`,
  };
  log(
    `[dogfood] @js-temporal/polyfill@${setup.version} (pinned ${setup.pin.shasum.slice(0, 12)}…) ` +
      `+ ${setup.pin.dependency.name}@${setup.pin.dependency.version} ` +
      `(pinned ${setup.pin.dependency.shasum.slice(0, 12)}…)`,
  );

  // --- 2. LINK -------------------------------------------------------------
  const linked = linkPolyfillSource(setup);
  report.polyfill.linkedBytes = linked.source.length;
  log(
    `[dogfood] linked ESM lane: ${linked.jsbiBytes} B jsbi + ${linked.polyfillBytes} B polyfill ` +
      `= ${linked.source.length} B one module`,
  );

  // --- 3/4/5. COMPILE + VALIDATE + BUCKET ----------------------------------
  if (slices > 0) {
    report.lanes.slices = await measureSlices({
      source: linked.source,
      fileName: "temporal-polyfill.esm",
      perSlice: slices,
      skip: new Set(skipSlices),
      log,
    });
  }

  if (whole) {
    report.lanes.esm = await measure({
      label: "esm (linked, modern)",
      fileName: "temporal-polyfill.esm.mjs",
      source: linked.source,
      log,
      instantiate,
    });
  }

  if (umd) {
    report.lanes.umd = await measure({
      label: "umd (self-contained, ES5)",
      fileName: "temporal-polyfill.umd.js",
      source: readUmdSource(setup),
      log,
      instantiate,
    });
  }

  // --- SUMMARY -------------------------------------------------------------
  const esm = report.lanes.esm ?? {
    compile: { threw: null, success: false, errorCount: null, distinctReasons: null },
    validation: { validates: false },
    instantiation: { instantiated: false },
    compileMs: null,
  };
  report.summary = {
    headline:
      report.lanes.esm === undefined
        ? "esm lane NOT RUN (--no-whole) — this summary describes no measurement"
        : esm.compile.threw != null
          ? "compile() THREW on the polyfill"
          : !esm.compile.success
            ? `compile reported failure — ${esm.compile.errorCount} errors`
            : !esm.validation.validates
              ? "compiled, but binary INVALID"
              : esm.instantiation?.instantiated
                ? "compiled + validates + module init ran"
                : "compiled + validates, but module init THROWS",
    // The number #4628 exists to produce.
    compileErrorCount: esm.compile.errorCount,
    distinctReasons: esm.compile.distinctReasons ?? null,
    compileSuccess: esm.compile.success ?? false,
    binaryValidates: esm.validation.validates,
    // The gate the spike never reached. `false` here means Option A is blocked
    // no matter how the Temporal global is wired — see #4628 step 3.
    moduleInitRuns: esm.instantiation?.instantiated ?? false,
    moduleInitError: esm.instantiation?.error ?? null,
    compileMs: esm.compileMs,
    // #661's thresholds: <50 ship A · 50-200 staged A · >200 Option B.
    threshold661:
      esm.compile.errorCount == null
        ? "n/a (compile threw)"
        : esm.compile.errorCount < 50
          ? "<50 — fix them and ship Option A"
          : esm.compile.errorCount <= 200
            ? "50-200 — Option A, staged; CE list is the prioritized bug list"
            : ">200 — Option B (port engine262), keep the CE list as a backlog",
    umd: report.lanes.umd
      ? {
          compileErrorCount: report.lanes.umd.compile.errorCount,
          binaryValidates: report.lanes.umd.validation.validates,
          moduleInitRuns: report.lanes.umd.instantiation?.instantiated ?? false,
        }
      : null,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`\n[dogfood] === @js-temporal/polyfill surface report (#4628 spike) ===`);
  log(JSON.stringify(report.summary, null, 2));
  const reasons = esm.compile.topReasons ?? report.lanes.slices?.topReasons;
  if (reasons?.length) {
    log(`\n[dogfood] top rejection reasons (largest first):`);
    for (const r of reasons.slice(0, 20)) {
      log(`  ${String(r.count).padStart(6)}  [${r.category}] ${r.sample.slice(0, 120)}`);
    }
  }
  if (report.lanes.slices) {
    const c = report.lanes.slices.coverage;
    log(
      `\n[dogfood] slice-lane COVERAGE: ${c.slicesRun}/${report.lanes.slices.sliceCount} slices, ` +
        `${c.statementsCovered}/${c.statementsTotal} top-level statements ` +
        `(${c.slicesSkipped} slices skipped — partial coverage, not a whole-bundle number)`,
    );
  }
  log(`[dogfood] full report → ${REPORT_PATH}`);
  return report;
}

function numListArg(flag) {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return [];
  return arg
    .slice(flag.length + 1)
    .split(",")
    .filter(Boolean)
    .map(Number);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const sliceArg = process.argv.find((a) => a.startsWith("--slices"));
  const report = await runHarness({
    quiet: json,
    umd: !process.argv.includes("--no-umd"),
    whole: !process.argv.includes("--no-whole"),
    slices: sliceArg ? Number(sliceArg.split("=")[1] ?? 25) : 0,
    skipSlices: numListArg("--skip-slices"),
    instantiate: !process.argv.includes("--no-instantiate"),
  });
  if (json) process.stdout.write(JSON.stringify(report) + "\n");
}
