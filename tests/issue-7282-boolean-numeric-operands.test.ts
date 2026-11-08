// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7282 — a numeric reader (`& | ^ << >> >>> - * / % < > <= >=`) ToNumbers a
// boolean operand beside a number, `null`, `undefined` or the dynamic carrier
// (ToNumber(true) = 1, ToNumber(false) = 0). The selector and from-ast share
// one predicate (`booleanReadAsNumber`); from-ast converts the boolean to an
// f64 before the existing number / carrier arms. `+` and the equalities keep
// their own rules.
//
// Each case asserts the result on standalone, WASI and the default gc target
// against the JS evaluation of the same source.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./equivalence/helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function run(source: string, options: CompileOptions, fileName: string) {
  const result = await compile(source, { fileName, trackIrOutcomes: true, skipSemanticDiagnostics: true, ...options });
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

function irRoute(result: Awaited<ReturnType<typeof compile>>, unit: string): boolean | undefined {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.irBodyEmitted;
}

/** A prepared module-init is refused at selection, never claimed and withdrawn later. */
function refusedAtSelection(result: Awaited<ReturnType<typeof compile>>, unit: string): boolean {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.detail?.includes("rejected by IR selection") === true;
}

interface Case {
  readonly source: string;
  readonly fileName: string;
  /** Units that must take the IR body on the host-free lanes. */
  readonly irUnits?: readonly string[];
  /** Units that must keep the legacy body on the host-free lanes. */
  readonly legacyUnits?: readonly string[];
}

const CASES: Record<string, Case> = {
  // test262 language/expressions/bitwise-and/S11.10.1_A3_T2.8.js shape; a
  // script's verdict is only that it completes, so the values are checked by
  // the module cases below.
  "script: true & undefined, undefined & true": {
    fileName: "issue-7282.js",
    source: `var a = true & undefined; var b = undefined & true; var c = (false | null) + (true - undefined);`,
    irUnits: ["<module-init>"],
  },
  // The `undefined` operands' module-init keeps legacy in an ES module for a
  // reason that predates #7282 (`1 & undefined` does too): values only.
  "module: undefined and null beside booleans": {
    fileName: "issue-7282.ts",
    source: `const a = true & undefined; const b = null | true; const c = true - undefined; const d = false * null;
export function test(): number { return a * 1 + b * 10 + (c !== c ? 100 : 0) + (d === 0 ? 1000 : 0); }`,
  },
  "module: null beside booleans": {
    fileName: "issue-7282.ts",
    source: `const b = null | true; const d = false * null; const e = true >= null;
export function test(): number { return b + (d === 0 ? 10 : 0) + (e ? 100 : 0); }`,
    irUnits: ["<module-init>"],
  },
  "bitwise and shifts with booleans": {
    fileName: "issue-7282.ts",
    source: `export function test(): number {
  const t = true; const f = false; const n = 7;
  return (t & 3) + (3 | f) * 10 + (t ^ 1) * 100 + (t << 31) + (t >>> 0) * 1000 + (n >> t);
}`,
    irUnits: ["test"],
  },
  "arithmetic with booleans: -0, NaN, Infinity": {
    fileName: "issue-7282.ts",
    source: `export function test(): number {
  const t = true; const f = false; const nan = 0 / 0;
  const a = 1 / (f * -1); // -Infinity: false * -1 is -0
  const b = t - nan; // NaN
  const c = t / f; // Infinity
  const d = f % t; // 0
  return (a === -Infinity ? 1 : 0) + (b !== b ? 10 : 0) + (c === Infinity ? 100 : 0) + (d === 0 ? 1000 : 0);
}`,
    irUnits: ["test"],
  },
  "relational with booleans, null and NaN": {
    fileName: "issue-7282.ts",
    source: `export function test(): number {
  const t = true; const f = false; const nan = 0 / 0;
  return (t > 0 ? 1 : 0) + (f < 1 ? 10 : 0) + (t >= 1 ? 100 : 0) + (f <= nan ? 1000 : 0) + (t > null ? 10000 : 0);
}`,
  },
  "2^32 wrap: ToInt32 of a number beside a boolean": {
    fileName: "issue-7282.ts",
    source: `export function test(): number {
  const t = true; const big = 4294967297; // 2^32 + 1
  return (big & t) + (t | 4294967296) * 10 + (-1 >>> t);
}`,
  },
  "a boolean beside the dynamic carrier": {
    fileName: "issue-7282.ts",
    source: `function f(x: any, b: boolean): number { return (b - x) + (x * b) * 10 + (8 >> b) * 100; }
export function test(): number { return f(3, true) + f("2", false) * 10000; }`,
  },
  // test262 less-than/S11.8.1_A3.1_T1.1 and greater-than/S11.8.2_A3.1_T1.1
  // shapes: the boolean is converted beside the wrapper's carrier too.
  "script: fresh Boolean wrapper beside a boolean": {
    fileName: "issue-7282.js",
    source: `var a = new Boolean(true) < true; var b = true < new Boolean(true);
var c = new Boolean(false) >= false; var d = true > new Boolean(false);`,
    irUnits: ["<module-init>"],
  },
  "module: fresh Boolean wrapper beside a boolean (values)": {
    fileName: "issue-7282.ts",
    source: `const a = new Boolean(true) < true; const b = true < new Boolean(true);
const c = new Boolean(false) >= false; const d = true > new Boolean(false);
export function test() { return (a ? 1 : 0) + (b ? 10 : 0) + (c ? 100 : 0) + (d ? 1000 : 0); }`,
    legacyUnits: ["<module-init>"],
  },
  // A prepared component (an ES module's module-init) has no identity for the
  // carrier supports, so selection refuses the boolean beside the carrier.
  "module: a boolean beside undefined keeps the legacy module-init": {
    fileName: "issue-7282.ts",
    source: `const a = true < undefined; const b = undefined >= false;
export function test() { return (a ? 1 : 0) + (b ? 10 : 0); }`,
    legacyUnits: ["<module-init>"],
  },
  "module: a boolean beside an `any` binding keeps the legacy module-init": {
    fileName: "issue-7282.ts",
    source: `let d: any = 3; let mt: boolean = true; const a = mt < d; const b = true >= d;
export function test() { return (a ? 1 : 0) + (b ? 10 : 0); }`,
    legacyUnits: ["<module-init>"],
  },
  // #7106 lever B boxes both sides into the carrier, which ToNumbers each.
  "a boolean beside a string lowers through the carrier": {
    fileName: "issue-7282.ts",
    source: `export function test(): number { const t = true; return t & ("3" as any); }`,
    irUnits: ["test"],
  },
};

describe("#7282 boolean operands of numeric readers", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} (${lane.name})`, async () => {
        const isModule = /\bexport\b/.test(testCase.source);
        const expected = isModule ? evaluateAsJs(testCase.source).test!() : scriptVerdict(testCase.source);
        const { result, value } = await run(testCase.source, lane.options, testCase.fileName);
        expect(value).toBe(expected);
        if (lane.options.target !== undefined) {
          for (const unit of testCase.irUnits ?? []) expect(irRoute(result, unit), unit).toBe(true);
          for (const unit of testCase.legacyUnits ?? []) {
            expect(irRoute(result, unit), unit).toBe(false);
            if (unit === "<module-init>") expect(refusedAtSelection(result, unit), unit).toBe(true);
          }
        }
      });
    }
  }
});
