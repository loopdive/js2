// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7266 — a module-init condition (`if (x)`, `!x`) whose operand is a direct
// module binding with an f64 or dynamic representation no longer refuses the
// `<module-init>` unit as `condition-module-value-nonbool`. The IR lowers its
// §7.1.2 ToBoolean with the same carrier arms as every other condition
// (`lowerToBooleanForCondition`): f64 `abs(x) > 0`, dynamic `dyn.truthy`.
// String / class-instance / extern slots are nullable and stay refused.
//
// Each case asserts the result on standalone, WASI and the default gc target
// against the JS evaluation of the same source, and the `<module-init>` route.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./equivalence/helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions, fileName: string) {
  const result = await compile(source, { fileName, trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance =
    options.target === "standalone"
      ? (await WebAssembly.instantiate(result.binary, {})).instance
      : options.target === "wasi"
        ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
        : await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  if (exports.test === undefined) {
    try {
      exports.__module_init?.();
      return { result, value: "completed" };
    } catch {
      return { result, value: "threw" };
    }
  }
  exports.__module_init?.();
  return { result, value: exports.test() };
}

function scriptVerdict(source: string): string {
  try {
    new Function(source)();
    return "completed";
  } catch {
    return "threw";
  }
}

function moduleInitIsIr(result: Awaited<ReturnType<typeof compile>>): boolean | undefined {
  return result.irOutcomes?.find((o) => o.displayName === "<module-init>")?.irBodyEmitted;
}

interface Case {
  readonly source: string;
  readonly fileName: string;
  /** Whether `<module-init>` takes the IR body on the host-free lanes (unset: not asserted). */
  readonly ir?: boolean;
}

const CASES: Record<string, Case> = {
  "f64 bindings: 0, -0, NaN, 0.5 under if and !": {
    fileName: "issue-7266.ts",
    source: `let n = 0; let z = -0; let nan = 0 / 0; let half = 0.5; let r = 0;
if (n) r += 1; if (z) r += 2; if (nan) r += 4; if (half) r += 8; if (!nan) r += 16; if (!half) r += 32;
export function test() { return r; }`,
    ir: true,
  },
  "f64 binding as a ternary condition": {
    fileName: "issue-7266.ts",
    source: `let n = 0; let m = 3; let r = 0;
if (n ? true : false) r += 1; if (m ? true : false) r += 2;
export function test() { return r; }`,
    ir: true,
  },
  "any binding through 0 / '' / '0' / NaN / -0 / 7 / true": {
    fileName: "issue-7266.ts",
    source: `let a: any = 0; let r = 0;
if (a) r += 1; a = ""; if (a) r += 2; a = "0"; if (a) r += 16; a = 0 / 0; if (a) r += 64;
a = -0; if (!a) r += 128; a = 7; if (a) r += 256; a = true; if (!a) r += 512;
export function test() { return r; }`,
    ir: true,
  },
  // testTypedArray.js shape: a `var` declared bare, assigned a function in one
  // branch, then truthiness-tested. Its module-init still refuses on the
  // function expression; the verdict must not change.
  "script var conditionally holding a function": {
    fileName: "issue-7266.js",
    source: `var f; var g; var r = 0;
if (r === 0) { f = function (a) { return a; }; }
if (f) r = r + 1;
if (g) r = r + 10;
if (!g) r = r + 100;
if (!f) r = r + 1000;`,
  },
  "f64 binding in a !-guarded early exit": {
    fileName: "issue-7266.ts",
    source: `let count = 0; let r = 1;
if (!count) r = 2;
export function test() { return r; }`,
    ir: true,
  },
  "string binding truthiness keeps the legacy unit": {
    fileName: "issue-7266.ts",
    source: `let s = ""; let r = 0; if (s) r = 1;
export function test() { return r; }`,
    ir: false,
  },
};

describe("#7266 module-init truthiness of non-boolean module values", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} (${lane.name})`, async () => {
        const expected = /\bexport\b/.test(testCase.source)
          ? evaluateAsJs(testCase.source).test!()
          : scriptVerdict(testCase.source);
        const { result, value } = await compileAndRun(testCase.source, lane.options, testCase.fileName);
        expect(value).toBe(expected);
        if (testCase.ir !== undefined && lane.options.target !== undefined) {
          expect(moduleInitIsIr(result)).toBe(testCase.ir);
        }
      });
    }
  }
});
