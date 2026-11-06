// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7253 — direct calls of the ambient `parseInt` / `parseFloat` / `escape` /
// `unescape` / `isNaN` no longer reject a unit as `select:external-call` on
// the host-free lanes. With string-typed text (and a number-typed radix /
// `isNaN` operand) the IR lowers each call to the SAME provider legacy calls:
// the native parse scanners (a missing radix is the provider's NaN sentinel),
// `__escape` / `__unescape`, and `n != n`. Untyped / non-string operands and a
// shadowing source binding keep the legacy call.
//
// Each case asserts the result on standalone, WASI and the default gc target
// against the JS evaluation of the same source, and the IR route of the
// `<module-init>` unit (or the named functions). The default gc lane takes the
// IR route too: it lowers with the native (standalone) regime (#5385), which
// is the regime the `native-global-function-call` capability projects.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

// `proc_exit` is how an uncaught throw leaves a WASI module: surface it.
const wasiStub = new Proxy(
  {},
  {
    get: (_target, name) =>
      name === "proc_exit"
        ? (code: number) => {
            throw new Error(`proc_exit(${code})`);
          }
        : () => 0,
  },
);

async function compileAndRun(source: string, options: CompileOptions, fileName: string) {
  const result = await compile(source, { fileName, trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instantiate = async () =>
    options.target === "standalone"
      ? (await WebAssembly.instantiate(result.binary, {})).instance
      : options.target === "wasi"
        ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
        : await instantiateWithRuntime(result);
  // A script exports nothing: its verdict is whether its body throws, which
  // may already happen in the start function during instantiation.
  if (!/\bexport\b/.test(source)) {
    try {
      ((await instantiate()).exports as Record<string, () => unknown>).__module_init?.();
      return { result, value: "completed" };
    } catch {
      return { result, value: "threw" };
    }
  }
  const exports = (await instantiate()).exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return { result, value: exports.test!() };
}

function scriptVerdict(source: string): string {
  try {
    new Function(source)();
    return "completed";
  } catch {
    return "threw";
  }
}

function irBody(result: Awaited<ReturnType<typeof compile>>, unit: string): boolean | undefined {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.irBodyEmitted;
}

interface Case {
  readonly source: string;
  readonly fileName?: string;
  /** Units that must take the IR body on the host-free lanes. */
  readonly irUnits?: readonly string[];
  /** The operand types are deliberately outside the lib signatures. */
  readonly skipSemanticDiagnostics?: boolean;
  /** Units that must keep the legacy body on every lane. */
  readonly legacyUnits?: readonly string[];
  /** Legacy already disagrees with node here (pre-#7253); only the route is asserted. */
  readonly preexistingValueMismatch?: boolean;
}

const CASES: Record<string, Case> = {
  "parseInt prefixes, trailing junk and whitespace": {
    source: `const r = parseInt("0x1A") * 1000000 + parseInt("12px") * 1000 + parseInt(" 42 ");
export function test() { return r; }`,
    irUnits: ["<module-init>"],
  },
  "parseInt radix 2 / 36 / 37 / 0 / NaN / fractional / -0": {
    source: `const a = parseInt("101", 2); const b = parseInt("z", 36); const c = parseInt("1", 37);
const d = parseInt("10", 0); const e = parseInt("10", NaN); const f = parseInt("ff", 16.9); const g = parseInt("7", -0);
export function test() { return a === 5 && b === 35 && c !== c && d === 10 && e === 10 && f === 255 && g === 7 ? 1 : 0; }`,
    irUnits: ["<module-init>"],
  },
  "parseInt empty, -0, Infinity, exponent": {
    source: `const a = parseInt(""); const b = 1 / parseInt("-0"); const c = parseInt("-Infinity"); const d = parseInt("  -17.9e2");
export function test() { return a !== a && b === -Infinity && c !== c && d === -17 ? 1 : 0; }`,
    irUnits: ["<module-init>"],
  },
  "parseFloat exponent junk, -0, Infinity, empty": {
    source: `const a = parseFloat("1e3x"); const b = 1 / parseFloat("-0"); const c = parseFloat("Infinity"); const d = parseFloat("");
export function test() { return a === 1000 && b === -Infinity && c === Infinity && d !== d ? 1 : 0; }`,
    irUnits: ["<module-init>"],
  },
  "unescape %uXXXX, %XX, truncated escapes, empty": {
    source: `export function test() {
  const a = unescape("%u0041%41b%");
  const b = unescape("%u00");
  return a === "AAb%" && b === "%u00" && unescape("") === "" ? a.length : -1;
}`,
    irUnits: ["test"],
  },
  "escape keeps the unescaped set, %XX and %uXXXX": {
    source: `export function test() {
  const a = escape("a b+\\u00fc\\u0100@*_-./") + unescape("%3c");
  return a === "a%20b+%FC%u0100@*_-./<" ? a.length : -1;
}`,
    irUnits: ["test"],
  },
  // A script — every test262 body is one — exports nothing; its verdict is
  // that the body completes, and its module-init takes the IR route.
  "escape / unescape / parse calls in a script's module-init": {
    source: `var a = unescape("%u0041%41b%"); var b = escape("<"); var c = parseInt("z", 36) + parseFloat("2.5");
var d = isNaN(c);`,
    irUnits: ["<module-init>"],
  },
  "escape in an ES module's module-init keeps the legacy unit": {
    source: `const a = escape("<a>");
export function test() { return a === "%3Ca%3E" ? 1 : 0; }`,
    legacyUnits: ["<module-init>"],
  },
  "isNaN of numbers": {
    source: `const a = isNaN(0 / 0); const b = isNaN(1); const c = isNaN(Infinity); const d = isNaN(Number.NaN / -0);
export function test() { return a && !b && !c && d ? 1 : 0; }`,
    irUnits: ["<module-init>"],
  },
  "typed calls inside functions": {
    fileName: "issue-7253.ts",
    source: `function f(s: string, r: number): number { return parseInt(s, r); }
function g(s: string): number { return parseFloat(s); }
function h(s: string): string { return unescape(s); }
function k(n: number): boolean { return isNaN(n); }
export function test(): number { return f("ff", 16) + g("1.5e1x") + h("%41%u0042").length + (k(0 / 0) ? 1000 : 0); }`,
    irUnits: ["f", "g", "h", "k"],
  },
  "a shadowing source parseInt keeps its own call": {
    source: `function parseInt(s) { return 99; }
var r = parseInt("5");
export function test() { return r; }`,
  },
  "a local parseInt binding keeps its own call": {
    source: `export function test() { const parseInt = (s) => 7; return parseInt("5"); }`,
  },
  // acorn's shape: an untyped operand keeps the pre-#7253 dynamic-carrier
  // route (the selector and from-ast read one admission, so neither demotes it).
  "acorn stringToNumber (regex-free) keeps its dynamic-carrier route": {
    source: `function stringToNumber(str, isLegacyOctalNumericLiteral) {
  if (isLegacyOctalNumericLiteral) { return parseInt(str, 8); }
  return parseFloat(str);
}
export function test() { return stringToNumber("1000.5x", false) + stringToNumber("17", true); }`,
  },
  "non-string operands keep legacy's ToString": {
    skipSemanticDiagnostics: true,
    source: `var x = 12; var y = parseInt(x); var z = parseFloat(true); var u = unescape(65); var w = parseInt("10", undefined);
export function test() { return y * 10 + (z !== z ? 1 : 0) + (u === "65" ? 100 : 0) + w * 1000; }`,
    legacyUnits: ["<module-init>"],
  },
};

// A script declaration of the same name MERGES with the lib's `declare
// function`, so only a lib-only binding is the built-in (#7118). Each shape
// must keep calling the source binding.
const SCRIPT_SHADOWS: Record<string, (name: string, args: string) => string> = {
  "function declaration": (n, a) =>
    `function ${n}(s) { return "U"; }\nfunction f() { return ${n}(${a}); }\nif (f() !== "U") throw new Error("x");`,
  "function declaration after the use": (n, a) =>
    `function f() { return ${n}(${a}); }\nif (f() !== "U") throw new Error("x");\nfunction ${n}(s) { return "U"; }`,
  "inner-scope function": (n, a) =>
    `function f() { function ${n}(s) { return "U"; } return ${n}(${a}); }\nif (f() !== "U") throw new Error("x");`,
  parameter: (n, a) =>
    `function f(${n}) { return ${n}(${a}); }\nif (f(function (s) { return "U"; }) !== "U") throw new Error("x");`,
  "var binding": (n, a) =>
    `var ${n} = function (s) { return "U"; };\nfunction f() { return ${n}(${a}); }\nif (f() !== "U") throw new Error("x");`,
  "let binding": (n, a) =>
    `let ${n} = function (s) { return "U"; };\nfunction f() { return ${n}(${a}); }\nif (f() !== "U") throw new Error("x");`,
};
const SHADOW_ARGS: Record<string, string> = {
  parseInt: `"12", 10`,
  parseFloat: `"1.5"`,
  escape: `"<"`,
  unescape: `"%41"`,
  isNaN: `1`,
};
// Measured on the pre-#7253 base: legacy misbinds these script shadows
// (#7253 follow-up); the IR must not make them worse, so only the route of the
// declaration shapes is asserted for them.
const LEGACY_MISBINDS = (name: string, shape: string): boolean =>
  shape.endsWith("binding") ||
  ((name === "parseInt" || name === "parseFloat" || name === "isNaN") && shape !== "parameter") ||
  (name === "isNaN" && shape === "parameter");
for (const name of Object.keys(SHADOW_ARGS)) {
  for (const [shape, make] of Object.entries(SCRIPT_SHADOWS)) {
    CASES[`script ${shape} named ${name} shadows the built-in`] = {
      source: make(name, SHADOW_ARGS[name]!),
      skipSemanticDiagnostics: true,
      preexistingValueMismatch: LEGACY_MISBINDS(name, shape),
      legacyUnits: shape.startsWith("function declaration") ? ["f"] : [],
    };
  }
}

describe("#7253 ambient global-function calls on the IR path", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    const fileName = testCase.fileName ?? "issue-7253.js";
    for (const lane of LANES) {
      it(`${label} (${lane.name})`, async () => {
        const expected = /\bexport\b/.test(testCase.source)
          ? evaluateAsJs(testCase.source).test!()
          : scriptVerdict(testCase.source);
        const options = testCase.skipSemanticDiagnostics
          ? { ...lane.options, skipSemanticDiagnostics: true }
          : lane.options;
        const { result, value } = await compileAndRun(testCase.source, options, fileName);
        if (!testCase.preexistingValueMismatch) expect(value).toBe(expected);
        for (const unit of testCase.irUnits ?? []) expect(irBody(result, unit), unit).toBe(true);
        for (const unit of testCase.legacyUnits ?? []) expect(irBody(result, unit), unit).toBe(false);
      });
    }
  }
});
