// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#874) The ONE driver source every Octane lane consumes.
//
//   PRELUDE (declared-global shims) + base.js + <bench>.js (verbatim) + EPILOGUE
//
// The prelude only declares globals that Octane assigns as sloppy implicit
// globals (`alert = …` in base.js, `setupEngine = …` in crypto.js) or reads
// before declaring (`performance` in base.js). No benchmark body is edited.
// base.js's own `alert = function(s){ throw … }` override is kept on purpose: it
// turns deltablue's `alert("Chain test failed.")` into a thrown error.
//
// The epilogue walks `BenchmarkSuite.suites`, so multi-benchmark suites
// (crypto = Encrypt+Decrypt, earley-boyer = Earley+Boyer) run every part, as
// Octane does. Its only js2-specific syntax is `export`; `forScript()` strips it
// for the node / Porffor lanes.
import { readFileSync } from "node:fs";

import { cachePath, MANIFEST } from "./fetch.mjs";

const BASE_PRELUDE = "var alert; var print = function () {}; var performance = { now: function () { return 0; } };";

// The JSDoc @param is load-bearing: raytrace's standalone compile failed on the
// implicit-any of a bare `reps`.
//
// Setup runs ONCE (lazily, inside the first call) and TearDown once at the end,
// exactly as Octane's RunStep does (ResetRNG → Setup → many runs → TearDown).
// Running Setup/TearDown around every call is wrong: box2d's TearDown sets
// `Box2D = null`, so a second call dies with "Cannot read properties of null".
const EPILOGUE = `
var __octane_ready = false;
/** @param {number} reps */
export function octane_run(reps) {
  var suites = BenchmarkSuite.suites;
  if (!__octane_ready) {
    BenchmarkSuite.ResetRNG();
    for (var s0 = 0; s0 < suites.length; s0++) {
      for (var b0 = 0; b0 < suites[s0].benchmarks.length; b0++) suites[s0].benchmarks[b0].Setup();
    }
    __octane_ready = true;
  }
  var count = 0;
  for (var s = 0; s < suites.length; s++) {
    var suite = suites[s];
    for (var b = 0; b < suite.benchmarks.length; b++) {
      var bench = suite.benchmarks[b];
      for (var r = 0; r < reps; r++) { bench.run(); count++; }
    }
  }
  return count;
}
export function octane_teardown() {
  var suites = BenchmarkSuite.suites;
  for (var s = 0; s < suites.length; s++) {
    for (var b = 0; b < suites[s].benchmarks.length; b++) suites[s].benchmarks[b].TearDown();
  }
  return 0;
}
`;

/**
 * Build the driver source for one benchmark.
 * @param {string} bench manifest benchmark key
 * @param {{ tamper?: boolean }} [opts] `tamper` appends the manifest's
 *   validation-breaking snippet (self-test: a validated bench must then report
 *   `wrong-result`, proving a wrong answer cannot score).
 * @returns {string}
 */
export function buildDriver(bench, opts = {}) {
  const meta = MANIFEST.benchmarks[bench];
  if (!meta) throw new Error(`unknown Octane benchmark: ${bench}`);
  const read = (f) => readFileSync(cachePath(f), "utf-8");
  const prelude = BASE_PRELUDE + meta.preludeVars.map((v) => ` var ${v};`).join("");
  const parts = [prelude, read("base.js"), ...meta.files.map(read)];
  if (opts.tamper) {
    if (!meta.tamper) throw new Error(`benchmark ${bench} has no tamper snippet in manifest.json`);
    parts.push(meta.tamper);
  }
  parts.push(EPILOGUE);
  return parts.join("\n");
}

/** Plain-script form of a driver (no `export`), exposing `globalThis.__octane_run` / `__octane_teardown`. */
export function forScript(driver) {
  const body = driver.replace(/^export function octane_/gm, "function octane_");
  return `${body}\nglobalThis.__octane_run = octane_run;\nglobalThis.__octane_teardown = octane_teardown;\n`;
}
