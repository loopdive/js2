// Acorn DIFFERENTIAL CORPUS harness (#1712 umbrella) — maps the real remaining
// surface of the compiled-acorn parser by diffing compiled-acorn vs node-acorn
// across a BROAD feature corpus, instead of discovering gaps one real file at a
// time.
//
// Design (deliberate, recorded):
//   - Compile the pinned acorn entry module ONCE (skipSemanticDiagnostics: true
//     — acorn is plain JS, the TS-checker "Property does not exist" noise is
//     non-blocking, per #1679/#1690), instantiate, wrapExports, reuse the single
//     `parse` for every input. The 230 KB compile is the expensive step; we pay
//     it once.
//   - The SAME pinned tarball is the node-acorn ORACLE (`import()`-ed directly),
//     so there is ZERO parser-version skew — every divergence is a compiler bug.
//   - diffAst runs UNCAPPED (`maxDivergences: 100000`). The default cap of 8 hid
//     real divergences twice in prior sessions; a capped "equal" is worthless.
//   - Inputs = focused per-feature snippets (tests/dogfood/corpus/*.js) PLUS the
//     two real native-messaging files PLUS the acorn entry module itself as a
//     large-scale real-world stressor.
//   - Each divergence is CLASSIFIED:
//       QUIRK  — cosmetic host-marshalling artifacts that do NOT corrupt tree
//                structure: the `sourceFile` extra field, and booleans
//                marshalled as i32 0/1 (`optional`/`computed`/`static`/…).
//       REAL   — everything else (dropped nodes, missing fields, wrong kinds).
//   - REAL divergences are grouped by (reason + normalized node-path tail) so
//     distinct gaps are obvious in the summary.
//
// Invoke:  node --import tsx tests/dogfood/acorn-corpus.mjs            (human summary)
//          node --import tsx tests/dogfood/acorn-corpus.mjs --json     (machine report)
//          ACORN_CORPUS_NO_ACORN_SELF=1 …   (skip the slow acorn-self stress input)
//
// Pure tooling — fixes no compiler bug.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupAcorn } from "./setup-acorn.mjs";
import { diffAst } from "./ast-diff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CORPUS_DIR = join(HERE, "corpus");
const REPORT_PATH = join(HERE, "report", "acorn-corpus.json");

const MAX_DIVERGENCES = 100000; // UNCAPPED on purpose — see header.

// JSON-safe sanitizer — the shared ast-diff `snapshot()` returns raw primitives
// for non-object values, so a BigInt literal `value` survives as a real BigInt
// (JSON.stringify throws on it). Coerce BigInt → "<n>n" string before writing.
function jsonSafe(v) {
  if (typeof v === "bigint") return `${v}n`;
  return v;
}

// Extract a useful message from a thrown value. Compiled-acorn lowers JS
// `throw` to Wasm exception-handling, so a parse-error `this.raise(...)` or a
// runtime trap surfaces to the host as a `WebAssembly.Exception` whose default
// String() is the useless "[object WebAssembly.Exception]". Dig for a real
// message via .message/.stack and the EH payload args.
function describeThrow(e) {
  if (e == null) return String(e);
  const parts = [];
  if (typeof e.message === "string" && e.message) parts.push(e.message);
  if (typeof WebAssembly !== "undefined" && WebAssembly.Exception && e instanceof WebAssembly.Exception) {
    parts.push("WebAssembly.Exception");
    if (typeof e.stack === "string") {
      const first = e.stack.split("\n").find((l) => l.trim() && !/WebAssembly\.Exception/.test(l));
      if (first) parts.push(first.trim());
    }
  } else if (!parts.length) {
    parts.push(String(e));
  }
  return parts.join(" | ").slice(0, 200);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
// QUIRK vs REAL. A divergence is a cosmetic marshalling QUIRK iff it is one of:
//   (a) a compiled-only `sourceFile` extra field (acorn's `sourceFile` option is
//       unset for node-acorn here, but compiled-acorn marshals it as null), or
//   (b) a boolean marshalled across the host boundary as an i32 0/1 — node-acorn
//       emits a JS boolean, compiled-acorn emits the number 0 or 1. This is the
//       known `optional`/`computed`/`static`/`generator`/… representation quirk.
// Everything else CORRUPTS structure or drops identifiers/fields = REAL.
function classify(d) {
  if (d.reason === "extra-field" && /\.sourceFile$/.test(d.path)) return "quirk-sourceFile";
  if (typeof d.expected === "boolean" && (d.actual === 0 || d.actual === 1)) return "quirk-bool-as-i32";
  return "real";
}

// Normalize a JSONPath-ish pointer for grouping: collapse array indices so
// `$.body[3].declarations[0].id` and `$.body[7].declarations[2].id` share a
// pattern. Keeps field names (the semantic part) intact.
function normalizePath(path) {
  return path.replace(/\[\d+\]/g, "[*]");
}

// A compact "gap signature" for grouping distinct real gaps: reason + the last
// meaningful field segment of the path (the field/kind that diverged). E.g.
// `extra-field @ .attributes`, `array-length-mismatch @ .quasis`.
function gapSignature(d) {
  const segs = normalizePath(d.path).split(".");
  let tail = segs[segs.length - 1] || "$";
  tail = tail.replace(/\[\*\]/g, "");
  if (!tail) tail = segs[segs.length - 2] || "$";
  return `${d.reason} @ .${tail}`;
}

// ---------------------------------------------------------------------------
// Input assembly
// ---------------------------------------------------------------------------
function sourceTypeFor(name) {
  return /\.module\.js$/.test(name) ? "module" : "script";
}

function loadInputs({ includeAcornSelf, entryModulePath }) {
  const inputs = [];

  // 1. focused per-feature snippets
  for (const f of readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()) {
    inputs.push({
      name: `corpus/${f}`,
      group: "feature",
      src: readFileSync(join(CORPUS_DIR, f), "utf-8"),
      opts: { ecmaVersion: 2025, sourceType: sourceTypeFor(f) },
    });
  }

  // 2. real native-messaging files
  inputs.push({
    name: "real/background.js",
    group: "real",
    src: readFileSync(join(ROOT, "examples/native-messaging/background.js"), "utf-8"),
    opts: { ecmaVersion: 2025, sourceType: "script" },
  });
  inputs.push({
    name: "real/edge.js",
    group: "real",
    src: readFileSync(join(ROOT, "examples/native-messaging/edge.js"), "utf-8"),
    opts: { ecmaVersion: 2025, sourceType: "module" },
  });

  // 3. the acorn entry module itself — a ~230 KB real-world scale stressor
  if (includeAcornSelf) {
    inputs.push({
      name: "real/acorn.mjs",
      group: "scale",
      src: readFileSync(entryModulePath, "utf-8"),
      opts: { ecmaVersion: 2025, sourceType: "module" },
    });
  }

  return inputs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function runCorpus({ quiet = false, includeAcornSelf = true } = {}) {
  const log = quiet ? () => {} : (...a) => console.error(...a);

  const { entryModulePath, version } = setupAcorn();
  const acornSource = readFileSync(entryModulePath, "utf-8");

  log(`[corpus] compiling pinned acorn@${version} (skipSemanticDiagnostics)…`);
  const t0 = performance.now();
  const r = await compile(acornSource, { fileName: "acorn.mjs", skipSemanticDiagnostics: true });
  const compileMs = Math.round(performance.now() - t0);
  log(`[corpus] compile success=${r.success} in ${compileMs}ms — binary ${r.binary?.length ?? 0} bytes`);
  if (!r.binary?.length) {
    throw new Error("[corpus] no binary emitted — cannot run the differential");
  }

  await WebAssembly.compile(r.binary); // validate (throws on invalid)
  const io = r.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  // LOAD-BEARING — do NOT drop this line when copying this setup into a new probe.
  // The host runtime resolves dynamic method dispatch through
  // `callbackState.getExports()`. Until `__setInstance` hands it the instance's
  // exports, that returns `undefined`, dispatch silently mis-resolves, and the
  // runtime's method-not-a-function guard fires — so EVERY dynamic method reads
  // as missing. The failure is maximally misleading: `parse` looks broken
  // ("parse is not a function") when the compiler is perfectly fine.
  // This has cost real hours twice: #1694 (~30 min) and #3348 (filed as a
  // "compiled-acorn parse() regression", nearly triggered a 343-commit bisect —
  // resolved wont-fix; the only defect was a probe missing this line).
  io.__setInstance?.(instance);
  const exp = wrapExports(instance, { signatures: r.exportSignatures });
  if (typeof exp.parse !== "function") {
    throw new Error(`[corpus] compiled acorn exposes no callable parse — exports: ${Object.keys(exp).slice(0, 30)}`);
  }
  const compiledParse = (src, opts) => exp.parse(src, opts);
  const oracle = await import(pathToFileURL(entryModulePath).href);

  const inputs = loadInputs({ includeAcornSelf, entryModulePath });

  /** @type {any[]} */
  const perInput = [];
  // Aggregate REAL gaps across all inputs: signature -> {count, inputs:Set, examples:[]}
  const realGaps = new Map();

  for (const input of inputs) {
    const entry = { name: input.name, group: input.group, sourceType: input.opts.sourceType, bytes: input.src.length };

    let oracleAst, oErr;
    try {
      oracleAst = oracle.parse(input.src, input.opts);
    } catch (e) {
      oErr = e?.message ?? String(e);
    }
    let compiledAst, cErr;
    try {
      compiledAst = compiledParse(input.src, input.opts);
    } catch (e) {
      cErr = describeThrow(e);
    }

    if (oErr) {
      // The ORACLE failing means the snippet is invalid JS — a corpus bug, flag it.
      entry.status = "oracle-error";
      entry.oracleError = oErr;
      perInput.push(entry);
      log(`[corpus] ${input.name}: ORACLE-ERROR ${oErr}`);
      continue;
    }
    if (cErr) {
      entry.status = "compiled-parse-threw";
      entry.compiledError = cErr;
      perInput.push(entry);
      log(`[corpus] ${input.name}: COMPILED-THREW ${cErr}`);
      continue;
    }

    const d = diffAst(oracleAst, compiledAst, { ignorePositions: true, maxDivergences: MAX_DIVERGENCES });
    const classified = d.divergences.map((dv) => ({ ...dv, klass: classify(dv) }));
    const real = classified.filter((dv) => dv.klass === "real");
    const quirkCounts = {};
    for (const dv of classified) {
      if (dv.klass !== "real") quirkCounts[dv.klass] = (quirkCounts[dv.klass] ?? 0) + 1;
    }

    entry.parses = true;
    entry.structurallyEqual = d.equal;
    entry.realEqual = real.length === 0; // equal once cosmetic quirks are ignored
    entry.totalDivergences = classified.length;
    entry.realDivergenceCount = real.length;
    entry.quirkCounts = quirkCounts;
    entry.status = real.length === 0 ? (d.equal ? "equal" : "equal-modulo-quirks") : "real-divergence";

    // record up to 20 real divergences per input verbatim for triage
    entry.realDivergences = real.slice(0, 20).map((dv) => ({
      path: dv.path,
      reason: dv.reason,
      expected: jsonSafe(dv.expected),
      actual: jsonSafe(dv.actual),
    }));

    // aggregate into the cross-input gap map
    for (const dv of real) {
      const sig = gapSignature(dv);
      if (!realGaps.has(sig)) realGaps.set(sig, { signature: sig, count: 0, inputs: new Set(), examples: [] });
      const g = realGaps.get(sig);
      g.count++;
      g.inputs.add(input.name);
      if (g.examples.length < 4) {
        g.examples.push({
          input: input.name,
          path: dv.path,
          expected: jsonSafe(dv.expected),
          actual: jsonSafe(dv.actual),
        });
      }
    }

    perInput.push(entry);
    const tag =
      entry.status === "equal"
        ? "EQUAL"
        : entry.status === "equal-modulo-quirks"
          ? "EQUAL(±quirks)"
          : `REAL×${real.length}`;
    log(`[corpus] ${input.name}: ${tag}  (total=${classified.length}, quirks=${JSON.stringify(quirkCounts)})`);
  }

  const gapMap = [...realGaps.values()].map((g) => ({ ...g, inputs: [...g.inputs] })).sort((a, b) => b.count - a.count);

  const summary = {
    inputs: perInput.length,
    equal: perInput.filter((e) => e.status === "equal").length,
    equalModuloQuirks: perInput.filter((e) => e.status === "equal-modulo-quirks").length,
    realDivergence: perInput.filter((e) => e.status === "real-divergence").length,
    compiledThrew: perInput.filter((e) => e.status === "compiled-parse-threw").length,
    oracleError: perInput.filter((e) => e.status === "oracle-error").length,
    distinctRealGaps: gapMap.length,
  };

  const report = {
    umbrella: 1712,
    generatedAt: new Date().toISOString(),
    acornVersion: version,
    compileMs,
    binaryBytes: r.binary.length,
    maxDivergences: MAX_DIVERGENCES,
    summary,
    gapMap,
    perInput,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");

  if (!quiet) printHumanSummary(report);
  return report;
}

function printHumanSummary(report) {
  const s = report.summary;
  const out = (...a) => console.error(...a);
  out("");
  out("=== acorn differential corpus — gap map (#1712 umbrella) ===");
  out(`acorn@${report.acornVersion}  compiled in ${report.compileMs}ms (${(report.binaryBytes / 1024).toFixed(0)} KB)`);
  out(
    `inputs=${s.inputs}  equal=${s.equal}  equal±quirks=${s.equalModuloQuirks}  REAL=${s.realDivergence}  compiled-threw=${s.compiledThrew}  oracle-error=${s.oracleError}`,
  );
  out("");
  out("--- per-input ---");
  for (const e of report.perInput) {
    const flag =
      e.status === "equal"
        ? "  OK   "
        : e.status === "equal-modulo-quirks"
          ? " ~quirk"
          : e.status === "real-divergence"
            ? " REAL  "
            : e.status === "compiled-parse-threw"
              ? " THREW "
              : " ORACLE";
    const detail =
      e.status === "real-divergence"
        ? `real=${e.realDivergenceCount}`
        : e.status === "compiled-parse-threw"
          ? e.compiledError?.slice(0, 80)
          : e.status === "oracle-error"
            ? e.oracleError?.slice(0, 80)
            : `quirks=${Object.values(e.quirkCounts ?? {}).reduce((a, b) => a + b, 0)}`;
    out(`  [${flag}] ${e.name.padEnd(28)} ${detail}`);
  }
  out("");
  out(`--- distinct REAL gaps (${report.gapMap.length}) ---`);
  for (const g of report.gapMap) {
    out(`  ×${String(g.count).padStart(4)}  ${g.signature}`);
    out(`         inputs: ${g.inputs.join(", ")}`);
    const ex = g.examples[0];
    if (ex)
      out(`         e.g. ${ex.path}  expected ${JSON.stringify(ex.expected)}  actual ${JSON.stringify(ex.actual)}`);
  }
  out("");
  out(`full report → ${REPORT_PATH}`);
}

// CLI entry
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  const includeAcornSelf = process.env.ACORN_CORPUS_NO_ACORN_SELF !== "1";
  runCorpus({ quiet: jsonOnly, includeAcornSelf })
    .then((report) => {
      if (jsonOnly) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      process.exit(0);
    })
    .catch((e) => {
      console.error("[corpus] harness crashed:", e);
      process.exit(2);
    });
}
