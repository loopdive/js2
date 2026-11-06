// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7267 — `JSON.parse(text)` of a string-typed text no longer refuses its unit
// as `expr-ident-not-in-scope(JSON)` on the native-JSON-codec lanes. The IR
// lowers the call through the shared #7253 admission to the SAME provider
// legacy calls (`__json_parse_text`), whose value graph crosses onto the
// dynamic carrier with `extern.convert_any`. A reviver, an untyped or
// non-string text, an ES module's `<module-init>` and every source binding
// named `JSON` keep the legacy call.
//
// Each case asserts the verdict on standalone, WASI and the default gc target
// against the JS evaluation of the same source (a source `JSON` binding
// against the IR-off compile), and the route of the named units.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./equivalence/helpers.js";

// WASI keeps the legacy call: its IR member read does not answer for the codec's value graph.
const LANES: { name: string; options: CompileOptions; irRoute: boolean }[] = [
  { name: "standalone", options: { target: "standalone" }, irRoute: true },
  { name: "wasi", options: { target: "wasi" }, irRoute: false },
  { name: "gc (default)", options: {}, irRoute: true },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions, fileName: string) {
  const result = await compile(source, { fileName, trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // A script's body runs at instantiation (the start function); its verdict is whether it throws.
  try {
    const instance =
      options.target === "standalone"
        ? (await WebAssembly.instantiate(result.binary, {})).instance
        : options.target === "wasi"
          ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
          : await instantiateWithRuntime(result);
    const exports = instance.exports as Record<string, () => unknown>;
    // WASI runs a script's body from `_start` (its uncaught exception still unwinds through it).
    (exports.__module_init ?? exports._start)?.();
    return { result, value: exports.test === undefined ? "completed" : exports.test() };
  } catch {
    return { result, value: "threw" };
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

function route(result: Awaited<ReturnType<typeof compile>>, unit: string): boolean | undefined {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.irBodyEmitted;
}

/** The verdict of the same source with the IR overlay off: the legacy call a shadow must keep. */
async function legacyVerdict(source: string, options: CompileOptions, fileName: string): Promise<unknown> {
  return (await compileAndRun(source, { ...options, experimentalIR: false }, fileName)).value;
}

interface Case {
  readonly source: string;
  readonly fileName?: string;
  /** Units that take the IR body on standalone and gc, and keep legacy's on WASI. */
  readonly irUnits?: readonly string[];
  /** Units that must keep the legacy body on every lane. */
  readonly legacyUnits?: readonly string[];
  /** The operand types are deliberately outside the lib signatures. */
  readonly skipSemanticDiagnostics?: boolean;
  /**
   * A source binding named `JSON`: compared with the IR-off compile, not with
   * node — legacy already mis-answers several of these on standalone and gc
   * (identical on main), which is not this admission's to fix.
   */
  readonly shadow?: boolean;
}

const CASES: Record<string, Case> = {
  // A string throw keeps the checks themselves on the IR path.
  "object, array, string, number and literal texts in a script": {
    source: `var o = JSON.parse('{"a":1,"b":"x","c":[true,null]}');
if (o.a !== 1 || o.b !== "x") throw "object";
var p = JSON.parse("[1,2,3]");
if (p.length !== 3) throw "array";
var q = JSON.parse('"str"');
if (q !== "str") throw "string";
var n = JSON.parse(" 5e1 ");
if (n !== 50) throw "number";
if (JSON.parse("true") !== true || JSON.parse("null") !== null) throw "literal";`,
    irUnits: ["<module-init>"],
  },
  "a string-typed text read from a var": {
    source: `var text = '{"k":"v"}';
var o = JSON.parse(text);
if (o.k !== "v") throw "k";`,
    irUnits: ["<module-init>"],
  },
  "an invalid text throws": {
    source: `var r = JSON.parse("{");`,
    irUnits: ["<module-init>"],
  },
  // A statement-position member call enters from-ast through the method-call path, not `lowerCall`.
  "a statement-position call": {
    source: `JSON.parse("[1]");
JSON.parse("{");`,
    irUnits: ["<module-init>"],
  },
  "a typed function parameter": {
    fileName: "issue-7267.ts",
    source: `function f(s: string): any { return JSON.parse(s); }
export function test(): number { return f('{"n":7}').n === 7 ? 1 : 0; }`,
    irUnits: ["f"],
  },
  "an ES module's module-init keeps the legacy unit": {
    source: `const o = JSON.parse('{"a":3}');
export function test() { return o.a === 3 ? 1 : 0; }`,
    legacyUnits: ["<module-init>"],
  },
  "a reviver keeps legacy's reviver codec": {
    source: `var o = JSON.parse('{"a":1}', function (k, v) { return v; });
if (o.a !== 1) throw 0;`,
    legacyUnits: ["<module-init>"],
  },
  "a non-string text keeps legacy's ToString": {
    skipSemanticDiagnostics: true,
    source: `var o = JSON.parse(12);
if (o !== 12) throw 0;`,
    legacyUnits: ["<module-init>"],
  },
  // Every source binding of the name keeps its own call.
  "a script var JSON": {
    shadow: true,
    source: `var JSON = { parse: function (s) { return 7; } };
if (JSON.parse("1") !== 7) throw 0;`,
  },
  "a script function JSON": {
    shadow: true,
    source: `function JSON() {}
JSON.parse = function (s) { return 7; };
if (JSON.parse("1") !== 7) throw 0;`,
  },
  "a let JSON declared after use in a function": {
    shadow: true,
    source: `function f() { return JSON.parse("1"); }
let JSON = { parse: function (s) { return 7; } };
if (f() !== 7) throw 0;`,
  },
  "a JSON parameter": {
    source: `function f(JSON) { return JSON.parse("1"); }
if (f({ parse: function (s) { return 7; } }) !== 7) throw 0;`,
  },
  "an inner-scope JSON": {
    shadow: true,
    source: `function f() { var JSON = { parse: function (s) { return 7; } }; return JSON.parse("1"); }
if (f() !== 7) throw 0;`,
  },
};

describe("#7267 ambient JSON.parse on the IR path", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    const fileName = testCase.fileName ?? "issue-7267.js";
    for (const lane of LANES) {
      it(`${label} (${lane.name})`, async () => {
        const options = testCase.skipSemanticDiagnostics
          ? { ...lane.options, skipSemanticDiagnostics: true }
          : lane.options;
        const expected = testCase.shadow
          ? await legacyVerdict(testCase.source, options, fileName)
          : /\bexport\b/.test(testCase.source)
            ? evaluateAsJs(testCase.source).test!()
            : scriptVerdict(testCase.source);
        const { result, value } = await compileAndRun(testCase.source, options, fileName);
        expect(value).toBe(expected);
        for (const unit of testCase.irUnits ?? []) expect(route(result, unit), unit).toBe(lane.irRoute);
        for (const unit of testCase.legacyUnits ?? []) expect(route(result, unit), unit).toBe(false);
      });
    }
  }
});
