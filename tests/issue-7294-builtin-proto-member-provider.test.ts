// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7294 — `Object.getOwnPropertyDescriptor(<B>.prototype, "<m>")` and a
// `<B>.prototype.<m>` method value read lower to one call of the codegen
// support function legacy's own synthesis is built from, so the IR answers
// with the same singleton closure and descriptor (`desc.value ===
// Array.prototype.slice` holds across routes).
//
// VALUES: a script's verdict is whether it completes; each check throws a
// string (a throw the IR lowers, so the module-init stays on the IR route,
// which every value case asserts) when its value differs from the JS
// evaluation. Run on standalone and gc (WASI never takes this admission: it
// rides legacy's standalone-gated synthesis, and legacy's WASI identity
// answers are pre-existing, #7294 notes).
// ROUTES: the shapes the admission must decline, asserting the `<module-init>`
// route on standalone.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const VALUE_LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc (default)", options: {} },
];

async function run(source: string, options: CompileOptions) {
  const result = await compile(source, {
    fileName: "issue-7294.js",
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    ...options,
  });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const unit = result.irOutcomes?.find((o) => o.displayName === "<module-init>");
  expect(unit?.irBodyEmitted, unit?.detail).toBe(true);
  try {
    const instance =
      options.target === "standalone"
        ? (await WebAssembly.instantiate(result.binary, {})).instance
        : await instantiateWithRuntime(result);
    (instance.exports as Record<string, () => unknown>).__module_init?.();
    return "completed";
  } catch {
    return "threw";
  }
}

function scriptVerdict(source: string): string {
  try {
    new Function(source)();
    return "completed";
  } catch {
    return "threw";
  }
}

const VALUE_CASES: Record<string, string> = {
  "method descriptor and identity (Array.prototype.slice)": `var d = Object.getOwnPropertyDescriptor(Array.prototype, "slice");
if (d.value !== Array.prototype.slice) throw "mismatch";
if (d.writable !== true || d.enumerable !== false || d.configurable !== true) throw "mismatch";
if (Object.getOwnPropertyDescriptor(Array.prototype, "slice").value !== d.value) throw "mismatch";`,
  "String and Date members": `var s = Object.getOwnPropertyDescriptor(String.prototype, "toLocaleUpperCase");
if (s.value !== String.prototype.toLocaleUpperCase) throw "mismatch";
var t = Object.getOwnPropertyDescriptor(Date.prototype, "getTimezoneOffset");
if (t.value !== Date.prototype.getTimezoneOffset) throw "mismatch";
if (t.writable !== true || t.enumerable !== false) throw "mismatch";
if (Date.prototype.getTime === Date.prototype.getDay) throw "mismatch";`,
  "getter descriptor (RegExp.prototype.global)": `var g = Object.getOwnPropertyDescriptor(RegExp.prototype, "global");
if (typeof g.get !== "function" || g.set !== undefined) throw "mismatch";
if (g.enumerable !== false || g.configurable !== true) throw "mismatch";`,
  "a mismatching identity still fails": `var d = Object.getOwnPropertyDescriptor(Array.prototype, "slice");
if (d.value !== Array.prototype.splice) throw "mismatch";`,
};

const ROUTE_CASES: Record<string, { readonly source: string; readonly ir: boolean; readonly fileName?: string }> = {
  "descriptor and method value reads": {
    source: `var d = Object.getOwnPropertyDescriptor(Array.prototype, "slice");
var same = d.value === Array.prototype.slice;
var g = Object.getOwnPropertyDescriptor(RegExp.prototype, "global");
var t = Object.getOwnPropertyDescriptor(Date.prototype, "getTimezoneOffset");`,
    ir: true,
  },
  "an overridden member": {
    source: `Array.prototype.slice = function () { return 1; };
var d = Object.getOwnPropertyDescriptor(Array.prototype, "slice");`,
    ir: false,
  },
  "an inherited (not own) member": {
    source: `var d = Object.getOwnPropertyDescriptor(Array.prototype, "hasOwnProperty");`,
    ir: false,
  },
  "a getter read as a value (it would invoke the getter)": {
    source: `var f = RegExp.prototype.global === undefined;`,
    ir: false,
  },
  "a source Object shadow": {
    source: `var Object = { getOwnPropertyDescriptor: function () { return 7; } };
var d = Object.getOwnPropertyDescriptor(Array.prototype, "slice");`,
    ir: false,
  },
  "an ES module (prepared component)": {
    source: `const d = Object.getOwnPropertyDescriptor(Array.prototype, "slice");
export function test() { return d === undefined ? 0 : 1; }`,
    fileName: "issue-7294.ts",
    ir: false,
  },
};

// The selection-time query consults a builtin's native-proto glue; a unit the
// IR then declines (here: `with`) must compile to the same module as with the
// IR off, for every builtin prototype (#7294 review: Promise's glue reserved a
// dispatch function on registration).
const DECLINED_BUILTINS = [
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Date",
  "RegExp",
  "Promise",
  "Function",
  "Symbol",
  "BigInt",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "Iterator",
  "DisposableStack",
  "AsyncDisposableStack",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Float64Array",
];
// One declined unit per builtin: a combined unit can hide a leak, because the
// unit's own legacy registrations may then reserve the same functions in the
// same order. `%TypedArray%` is reached through the views, whose glue
// registers the intrinsic's.
function declinedSource(builtin: string): string {
  return `var d = Object.getOwnPropertyDescriptor(${builtin}.prototype, "then");
var v = ${builtin}.prototype.toString === ${builtin}.prototype.toString;
var o = {}; with (o) { d; v; }`;
}

async function binaryHash(source: string, options: CompileOptions, experimentalIR: boolean) {
  const result = await compile(source, {
    fileName: "issue-7294.js",
    skipSemanticDiagnostics: true,
    experimentalIR,
    ...options,
  });
  expect(result.success).toBe(true);
  return createHash("sha256").update(result.binary).digest("hex");
}

describe("#7294 builtin-prototype member support functions", () => {
  for (const lane of VALUE_LANES) {
    it(
      `a declined unit compiles as with the IR off, every builtin prototype (${lane.name})`,
      {
        timeout: 600_000,
      },
      async () => {
        const leaks: string[] = [];
        for (const builtin of DECLINED_BUILTINS) {
          const source = declinedSource(builtin);
          if ((await binaryHash(source, lane.options, true)) !== (await binaryHash(source, lane.options, false))) {
            leaks.push(builtin);
          }
          // Yield between compiles so the worker keeps answering the runner.
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(leaks).toEqual([]);
      },
    );
  }
  for (const [label, body] of Object.entries(VALUE_CASES)) {
    for (const lane of VALUE_LANES) {
      it(`${label} (${lane.name})`, async () => {
        expect(await run(body, lane.options)).toBe(scriptVerdict(body));
      });
    }
  }
  for (const [label, { source, ir, fileName }] of Object.entries(ROUTE_CASES)) {
    it(`route: ${label} → ${ir ? "IR" : "legacy"} (standalone)`, async () => {
      const result = await compile(source, {
        fileName: fileName ?? "issue-7294.js",
        target: "standalone",
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      });
      const unit = result.irOutcomes?.find((o) => o.displayName === "<module-init>");
      expect(unit?.irBodyEmitted, unit?.detail).toBe(ir);
    });
  }
});
