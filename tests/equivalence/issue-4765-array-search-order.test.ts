// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4765 — observable order of `Array.prototype.{includes,indexOf,lastIndexOf}`,
// and the spec `length` of an Array.prototype method read off an array value.
//
// The search family splits argument EVALUATION from argument CONVERSION:
// `fromIndex` is evaluated with the call like any argument, but
// ToIntegerOrInfinity(fromIndex) is step 4, after step 3 has already returned
// for `len = 0` (§23.1.3.16 / .17 / .20). The inlined vec lowerings each got
// one half wrong — `includes` ran a `valueOf` on `[]` (test262
// `includes/length-zero-returns-false.js`), `indexOf`/`lastIndexOf` skipped
// evaluating the argument expression altogether.
//
// `values-are-not-cached` pins the other order the issue names: the generic
// algorithm reads each index fresh inside the loop, so an element written by an
// earlier getter is seen.
//
// Every case runs in BOTH lanes (JS host and `target: "standalone"`) and is
// compared against native JS. Results are numbers so the standalone lane can
// return them without a host string bridge.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

async function runLane(source: string, standalone: boolean): Promise<Record<string, () => unknown>> {
  const result = await compile(source, {
    fileName: "issue-4765.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(standalone ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  if (!standalone) return (await instantiateWithRuntime(result)).exports as Record<string, () => unknown>;
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return exports;
}

/** Compile `source` in both lanes and assert every listed export equals native JS. */
async function assertBothLanes(source: string, fns: string[]): Promise<void> {
  const js = evaluateAsJs(source);
  for (const standalone of [false, true]) {
    const wasm = await runLane(source, standalone);
    for (const fn of fns) {
      expect([standalone ? "standalone" : "host", fn, wasm[fn]!()]).toEqual([
        standalone ? "standalone" : "host",
        fn,
        js[fn]!(),
      ]);
    }
  }
}

const COUNTER = `
var calls = 0;
function counting(n) { return { valueOf: function () { calls++; return n; } }; }
`;

describe("#4765 search-family fromIndex: evaluate always, convert only when len != 0", () => {
  it("does not convert fromIndex on an empty array (includes/length-zero-returns-false)", async () => {
    await assertBothLanes(
      COUNTER +
        `
export function includesEmpty() { calls = 0; var a = []; a.includes(0, counting(0)); return calls; }
export function indexOfEmpty() { calls = 0; var a = []; a.indexOf(0, counting(0)); return calls; }
export function lastIndexOfEmpty() { calls = 0; var a = []; a.lastIndexOf(0, counting(0)); return calls; }
export function includesEmptyResult() { var a = []; return a.includes(0, counting(0)) ? 1 : 0; }`,
      ["includesEmpty", "indexOfEmpty", "lastIndexOfEmpty", "includesEmptyResult"],
    );
  }, 120_000);

  // The counting object is a literal in each function, not `counting(n)`: a
  // ToNumber of an object whose `valueOf` closure captures a PARAMETER runs that
  // `valueOf` twice (`+counting(0)` counts 2, in both lanes, on main), a
  // separate defect recorded on the issue. It would mask this ordering check.
  it("converts fromIndex exactly once on a non-empty array", async () => {
    await assertBothLanes(
      `
var calls = 0;
export function includesOnce() { calls = 0; var a = [5]; var fi = { valueOf: function () { calls++; return 0; } }; a.includes(5, fi); return calls; }
export function indexOfOnce() { calls = 0; var a = [5]; var fi = { valueOf: function () { calls++; return 0; } }; a.indexOf(5, fi); return calls; }
export function lastIndexOfOnce() { calls = 0; var a = [5]; var fi = { valueOf: function () { calls++; return 0; } }; a.lastIndexOf(5, fi); return calls; }`,
      ["includesOnce", "indexOfOnce", "lastIndexOfOnce"],
    );
  }, 120_000);

  it("still EVALUATES the fromIndex expression on an empty array", async () => {
    await assertBothLanes(
      `
var hits = 0;
function f() { hits++; return 0; }
export function evaluated() {
  hits = 0;
  var a = [];
  a.includes(0, f());
  a.indexOf(0, f());
  a.lastIndexOf(0, f());
  return hits;
}`,
      ["evaluated"],
    );
  }, 120_000);

  it("uses the converted fromIndex value (positive, negative, out of range)", async () => {
    await assertBothLanes(
      `
function at(n) { return { valueOf: function () { return n; } }; }
export function incSkip() { return [1, 2, 3].includes(1, at(1)) ? 1 : 0; }
export function incNeg() { return [1, 2, 3].includes(3, at(-1)) ? 1 : 0; }
export function incNegInf() { return [1, 2].includes(1, at(-Infinity)) ? 1 : 0; }
export function iofNeg() { return [1, 2, 3].indexOf(3, at(-1)); }
export function iofPast() { return [1, 2, 3].indexOf(2, at(5)); }
export function liofNeg() { return [1, 2, 3, 1].lastIndexOf(1, at(-2)); }
export function liofInf() { return [1, 2].lastIndexOf(2, at(Infinity)); }
export function numericFrom() { var a = [1, 2, 3]; var k = 1; return a.indexOf(1, k) + (a.includes(3, -1) ? 10 : 0); }`,
      ["incSkip", "incNeg", "incNegInf", "iofNeg", "iofPast", "liofNeg", "liofInf", "numericFrom"],
    );
  }, 120_000);

  it("throws on a Symbol fromIndex only when the array is non-empty", async () => {
    await assertBothLanes(
      `
function probe(thunk) { try { thunk(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }
export function incEmpty() { return probe(function () { var a = []; a.includes(1, Symbol()); }); }
export function incFull() { return probe(function () { var a = [7]; a.includes(7, Symbol("1")); }); }
export function iofEmpty() { return probe(function () { var a = []; a.indexOf(1, Symbol()); }); }
export function iofFull() { return probe(function () { var a = [7]; a.indexOf(7, Symbol()); }); }
export function liofFull() { return probe(function () { var a = [7]; a.lastIndexOf(7, Symbol()); }); }`,
      ["incEmpty", "incFull", "iofEmpty", "iofFull", "liofFull"],
    );
  }, 120_000);
});

describe("#4765 generic array-like scan reads each index fresh (values-are-not-cached)", () => {
  it("sees an element a previous getter wrote", async () => {
    await assertBothLanes(
      `
function clean() {
  var obj = {};
  Object.defineProperty(obj, "length", {
    get: function () {
      Object.defineProperty(obj, "0", {
        get: function () { obj[1] = "ecma262"; obj[2] = "cake"; return "tc39"; },
      });
      return 2;
    },
  });
  return obj;
}
export function first() { return [].includes.call(clean(), "tc39") ? 1 : 0; }
export function written() { return [].includes.call(clean(), "ecma262") ? 1 : 0; }
export function beyondLength() { return [].includes.call(clean(), "cake") ? 1 : 0; }
export function iofWritten() { return [].indexOf.call(clean(), "ecma262"); }`,
      ["first", "written", "beyondLength", "iofWritten"],
    );
  }, 120_000);
});

describe("#4765 Array.prototype method VALUES read off an array", () => {
  it("are callable, named, and answer the generic algorithm over an array-like", async () => {
    await assertBothLanes(
      `
var like = { length: 3, 0: "a", 1: "b", 2: NaN };
export function isFn() { var f = [].includes; return typeof f === "function" ? 1 : 0; }
export function named() { return [].includes.name === "includes" && [].indexOf.name === "indexOf" ? 1 : 0; }
export function viaValue() { var f = [].includes; return f.call(like, NaN) ? 1 : 0; }
export function iof() { return [].indexOf.call(like, "b"); }
export function liof() { return [].lastIndexOf.call({ length: 3, 0: "y", 1: "y", 2: "z" }, "y"); }
export function sameFn() { return [].includes === Array.prototype.includes ? 1 : 0; }`,
      ["isFn", "named", "viaValue", "iof", "liof", "sameFn"],
    );
  }, 120_000);

  it("report the spec length, not the lib signature's required-parameter count", async () => {
    await assertBothLanes(
      `
export function lengths() {
  var a = [1, 2];
  return [
    [].includes.length, [].indexOf.length, [].lastIndexOf.length, a.slice.length, [].splice.length,
    [].push.length, [].pop.length, [].unshift.length, [].reverse.length, [].concat.length,
  ].join(",") === "1,1,1,2,2,1,0,1,0,1" ? 1 : 0;
}
export function sliceLen() { return [].slice.length; }
export function spliceLen() { return [].splice.length; }
export function pushLen() { return [].push.length; }
export function concatLen() { return [].concat.length; }
export function aliasLen() { var s = [].slice; return s.length; }`,
      ["lengths", "sliceLen", "spliceLen", "pushLen", "concatLen", "aliasLen"],
    );
  }, 120_000);
});
