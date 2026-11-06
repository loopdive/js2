// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7287 — a script `var` holding a function expression (the test262 prelude's
// `var print = function (value) { console.log(value); }`) is resolvable and
// callable from IR units.
//
// Slice A: a script's top-level `var` whose name a lib global also declares
// (lib.dom's `declare function print`) binds as that `var`, as it does at run
// time, instead of to the lib declaration the checker picks.
//
// Slice B: a call whose callee is a script `var` in its dynamic module home
// lowers through the Stage-4 dynamic call (`__apply_closure` on the value the
// slot holds at call time), with legacy's TypeError text for a non-callable
// value. An ES module is unchanged: its `var`s have no script-var home.
//
// Each case compiles a script on standalone, WASI and the default gc target,
// compares its verdict (completes / throws) with node's and the IR-off
// compile's, and checks the route of the named units.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function verdict(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7287.js", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  try {
    const instance =
      options.target === "standalone"
        ? (await WebAssembly.instantiate(result.binary, {})).instance
        : options.target === "wasi"
          ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
          : await instantiateWithRuntime(result);
    const exports = instance.exports as Record<string, () => unknown>;
    (exports.__module_init ?? exports._start)?.();
    return { result, value: "completed" };
  } catch {
    return { result, value: "threw" };
  }
}

function route(result: Awaited<ReturnType<typeof compile>>, unit: string): boolean | undefined {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.irBodyEmitted;
}

interface Case {
  readonly source: string;
  /** The node verdict of the source, which the IR-off compile is also checked against. */
  readonly expected: "completed" | "threw";
  /** Units that take the IR body (on WASI too unless `wasiLegacy`). */
  readonly irUnits?: readonly string[];
  /** WASI keeps the legacy body for `irUnits`. */
  readonly wasiLegacy?: true;
  /** Units that keep the legacy body on every lane. */
  readonly legacyUnits?: readonly string[];
}

const CASES: Record<string, Case> = {
  "slice A: a function reads a lib-named script var as a value": {
    source: `var print = function (v) { return v; };
function h() { return typeof print; }
if (h() !== "function") throw "typeof";`,
    expected: "completed",
    irUnits: ["h"],
  },
  "slice A: a redeclared lib-named var stays unresolved": {
    source: `var print = function (v) { return v; };
var print = function (v) { return v; };
function h() { return typeof print; }
if (h() !== "function") throw "typeof";`,
    expected: "completed",
    legacyUnits: ["h"],
  },
  // Slice B: a call through the dynamic module home is the Stage-4 dynamic call.
  "slice B: the prelude's print called from a harness-style function": {
    source: `var got = 0;
var print = function (value) { got = value; };
function h() { print(7); print(8); }
h();
if (got !== 8) throw "print";`,
    expected: "completed",
    irUnits: ["h"],
  },
  "slice B: a function declared before the var it calls": {
    source: `var got = 0;
function h() { p(2); }
var p = function (v) { got = got + v; };
h(); h();
if (got !== 4) throw "p";`,
    expected: "completed",
    irUnits: ["h"],
  },
  "slice B: the slot read at call time sees a reassignment": {
    source: `var got = 0;
var p = function () { got = 1; };
function h() { p(); }
p = function () { got = 2; };
h();
if (got !== 2) throw "p";`,
    expected: "completed",
    irUnits: ["h"],
  },
  "slice B: arguments and missing parameters in the callee": {
    source: `var n = -1, b = 0;
var p = function (x, y) { n = arguments.length; b = y; };
function h() { p(1); }
h();
if (n !== 1 || b !== undefined) throw "args";`,
    expected: "completed",
    irUnits: ["h"],
  },
  "slice B: a call before the initializer runs throws": {
    source: `function h() { p(); }
try { h(); throw "no throw"; } catch (e) { if (!(e instanceof TypeError)) throw e; }
var p = function () {};`,
    expected: "completed",
    irUnits: ["h"],
  },
  "slice B: a throwing callee propagates": {
    source: `var p = function () { throw new RangeError("inner"); };
function h() { p(); }
try { h(); throw "no throw"; } catch (e) { if (!(e instanceof RangeError)) throw e; }`,
    expected: "completed",
    irUnits: ["h"],
  },
  "slice B: p.call / new p keep the legacy body": {
    source: `var got = 0;
var p = function (v) { got = v; };
function h() { p.call(null, 3); }
h();
if (got !== 3) throw "call";`,
    expected: "completed",
    legacyUnits: ["h"],
  },
};

describe("#7287 script-var closures callable from IR units", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} (${lane.name})`, async () => {
        const off = await verdict(testCase.source, { ...lane.options, experimentalIR: false });
        const { result, value } = await verdict(testCase.source, lane.options);
        expect(value).toBe(off.value);
        expect(value).toBe(testCase.expected);
        const irRoute = !(testCase.wasiLegacy && lane.options.target === "wasi");
        for (const unit of testCase.irUnits ?? []) expect(route(result, unit), unit).toBe(irRoute);
        for (const unit of testCase.legacyUnits ?? []) expect(route(result, unit), unit).toBe(false);
      });
    }
  }
});
