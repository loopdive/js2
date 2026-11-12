// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7194 S1 — loose `==` / `!=` between an Object held in a dynamic carrier and
// a primitive applies ToPrimitive (§7.2.14 steps 11–12) in the one provider,
// `__extern_loose_eq`, on the host-free lanes.
//
// Measured on main `aba1b90ffc` (standalone): `{}` / an object with `valueOf`
// or `toString` / an array / a function / a wrapper against a number or a
// boolean trapped (`illegal cast in __str_to_number`), and against a string it
// answered wrong where ToPrimitive would match (`[2] != "2"` was `true`).
//
// Every row is checked against node running the same source.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

type Target = "standalone" | "wasi" | "gc";
type Result = Awaited<ReturnType<typeof compile>>;

const CARRIERS = [
  "{}",
  "{ valueOf: function () { return 2; } }",
  '{ toString: function () { return "2"; } }',
  "[2]",
  "function () {}",
  "new Number(2)",
  'new String("2")',
  "new Boolean(true)",
  "null",
  "undefined",
  '"2"',
  "2",
  "true",
];
const LITERALS = ["2", "0", '"2"', '""', '"[object Object]"', "true", "false", "null", "undefined"];
const SECONDS = ["2", '"2"', "true", "null", "undefined", "{}"];

/** One function per comparison form; the unit under test is the function, its operand a carrier. */
const FORMS = LITERALS.flatMap((lit) => [`c == ${lit}`, `${lit} == c`, `c != ${lit}`]);

function switchOf(name: string, values: readonly string[]): string {
  return `/** @param {number} i */\nfunction ${name}(i) { switch (i) { ${values.map((v, i) => `case ${i}: return ${v};`).join(" ")} } }`;
}

/**
 * The matrix as one module: `cell(form, carrier)` and `pair(carrier, second,
 * reversed)`, each answering 1 / 0. Every form function is first called with a
 * string and a number (as the #7194 matrix does), so its parameter is a carrier.
 */
const MATRIX_SOURCE = [
  switchOf("mk", CARRIERS),
  switchOf("mk2", SECONDS),
  ...FORMS.map((form, i) => `function form${i}(c) { return ${form}; }\nform${i}("x"); form${i}(1);`),
  `function both(c, d) { return c == d; }\nboth("x", 1); both(1, "x");`,
  `/** @param {number} f @param {number} i */\nexport function cell(f, i) { var c = mk(i); switch (f) { ${FORMS.map((_, i) => `case ${i}: return form${i}(c) ? 1 : 0;`).join(" ")} } return -1; }`,
  `/** @param {number} i @param {number} j @param {number} rev */\nexport function pair(i, j, rev) { var c = mk(i); var d = j < 0 ? c : mk2(j); return (rev ? both(d, c) : both(c, d)) ? 1 : 0; }`,
].join("\n");

interface MatrixExports {
  cell(f: number, i: number): number;
  pair(i: number, j: number, rev: number): number;
}

function nodeMatrix(): MatrixExports {
  return new Function(`${MATRIX_SOURCE.replace(/^export /gm, "")}\nreturn { cell, pair };`)() as MatrixExports;
}

function targetOptions(target: Target) {
  return target === "gc" ? {} : { target };
}

async function instantiate(result: Result, target: Target): Promise<WebAssembly.Instance> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  let imports = (result.importObject ?? {}) as WebAssembly.Imports;
  if (target === "wasi") {
    const { WASI } = await import("node:wasi");
    imports = { ...imports, wasi_snapshot_preview1: new WASI({ version: "preview1" }).wasiImport };
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (result.importObject as { __setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.__setInstance?.(instance);
  return instance;
}

function compileJs(source: string, target: Target, experimentalIR = true): Promise<Result> {
  return compile(source, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    emitWat: true,
    experimentalIR,
    ...targetOptions(target),
  });
}

function answer(run: () => number): string {
  try {
    return String(run());
  } catch (e) {
    return e instanceof WebAssembly.RuntimeError ? "trap" : "throw";
  }
}

/** Every matrix cell whose answer differs from node's, as `label: got → want`. */
function mismatches(wasm: MatrixExports, node: MatrixExports): string[] {
  const out: string[] = [];
  CARRIERS.forEach((carrier, i) => {
    FORMS.forEach((form, f) => {
      const got = answer(() => wasm.cell(f, i));
      const want = answer(() => node.cell(f, i));
      if (got !== want) out.push(`(${form.replace("c", carrier)}): ${got} → ${want}`);
    });
    for (let j = -1; j < SECONDS.length; j++) {
      for (const rev of [0, 1]) {
        const got = answer(() => wasm.pair(i, j, rev));
        const want = answer(() => node.pair(i, j, rev));
        const second = j < 0 ? "<same>" : SECONDS[j];
        if (got !== want) out.push(`pair(${carrier}, ${second}${rev ? ", reversed" : ""}): ${got} → ${want}`);
      }
    }
  });
  return out;
}

/**
 * `both(c, c)` with `c` an object literal carrying a method: legacy reifies the
 * struct to a fresh `$Object` per `any` argument, so the two arguments are
 * different objects before the comparison runs (the plan's "Not covered").
 */
const REIFIED_IDENTITY = [
  "pair({ valueOf: function () { return 2; } }, <same>): 0 → 1",
  "pair({ valueOf: function () { return 2; } }, <same>, reversed): 0 → 1",
  'pair({ toString: function () { return "2"; } }, <same>): 0 → 1',
  'pair({ toString: function () { return "2"; } }, <same>, reversed): 0 → 1',
];

describe("#7194 — carrier loose equality matrix against node", () => {
  const node = nodeMatrix();

  it("standalone, IR: every cell answers as node", async () => {
    const result = await compileJs(MATRIX_SOURCE, "standalone");
    const wasm = (await instantiate(result, "standalone")).exports as unknown as MatrixExports;
    expect(mismatches(wasm, node).filter((m) => !REIFIED_IDENTITY.includes(m))).toEqual([]);
    // The comparing units are claimed: the fix is in the provider, not a fallback.
    const claimed = new Set((result.irOutcomes ?? []).filter((o) => o.irBodyEmitted).map((o) => o.displayName));
    expect(claimed.has("both")).toBe(true);
    FORMS.forEach((form, i) => {
      if (!form.includes("null")) expect(claimed.has(`form${i}`), form).toBe(true);
    });
  }, 120_000);

  it("standalone, legacy: every one-carrier cell answers as node", async () => {
    // Legacy's two-carrier `any == any` is not on this provider: `emitLooseEq`
    // (coercion-engine.ts) calls `__any_eq` directly and still traps on an
    // Object against a number, as on main. That is #7194 S3.
    const result = await compileJs(MATRIX_SOURCE, "standalone", false);
    const wasm = (await instantiate(result, "standalone")).exports as unknown as MatrixExports;
    expect(mismatches(wasm, node).filter((m) => !m.startsWith("pair("))).toEqual([]);
  }, 120_000);

  it("wasi, IR: every cell whose ToPrimitive the WASI runtime models answers as node", async () => {
    const result = await compileJs(MATRIX_SOURCE, "wasi");
    const wasm = (await instantiate(result, "wasi")).exports as unknown as MatrixExports;
    // WASI's `__to_primitive` has no function arm (#7153: the vec arm only), so
    // a function operand comes back unreduced and `__any_eq` still traps on it.
    const residual = mismatches(wasm, node).filter(
      (m) => !REIFIED_IDENTITY.includes(m) && !m.includes("function () {}"),
    );
    expect(residual).toEqual([]);
  }, 120_000);
});

describe("#7194 — ToPrimitive is applied exactly when the spec says", () => {
  const SOURCE = `
function f(a, b) { return a == b; }
function g(a, b) { return a != b; }
f("x", 1); f(1, "x"); g("x", 1);
export function noCallAgainstNullishOrObject() {
  var calls = 0;
  var o = { valueOf: function () { calls++; return 2; } };
  var r = f(o, null) || f(undefined, o) || f(o, {}) || f({}, o) || g(o, undefined) === false;
  return r ? -1 : calls;
}
export function oneCallPerComparison() {
  var calls = 0;
  var o = { valueOf: function () { calls++; return 2; } };
  return f(o, 2) && f("2", o) && !g(o, 2) ? calls : -1;
}
export function throwingValueOfPropagates() {
  var t = { valueOf: function () { throw new RangeError("v"); } };
  try { f(t, 1); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; }
}
export function throwingValueOfReversed() {
  var t = { valueOf: function () { throw new RangeError("v"); } };
  try { g(1, t); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; }
}
export function toStringAfterObjectValueOf() {
  var b = { valueOf: function () { return {}; }, toString: function () { return "7"; } };
  return f(b, 7) && f("7", b) ? 1 : 0;
}
export function bothObjectResultsIsTypeError() {
  var b = { valueOf: function () { return {}; }, toString: function () { return {}; } };
  try { f(b, 1); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }
}
export function symbolToPrimitive() {
  var tp = {}; tp[Symbol.toPrimitive] = function (hint) { return hint === "default" ? 3 : 4; };
  return f(tp, 3) && !g(3, tp) ? 1 : 0;
}
export function symbolResultIsCompared() {
  var s = Symbol("k");
  var tp = {}; tp[Symbol.toPrimitive] = function () { return s; };
  return f(tp, s) && f(Object(s), s) ? 1 : 0;
}
export function dateUsesToString() {
  var d = new Date(0);
  return f(d, d.toString()) && !f(d, 0) ? 1 : 0;
}
export function objectsCompareByIdentity() {
  var a = [2], b = [2];
  return f(a, a) && !f(a, b) && g(a, b) ? 1 : 0;
}`;
  const expected = new Function(`${SOURCE.replace(/^export /gm, "")}
return { noCallAgainstNullishOrObject, oneCallPerComparison, throwingValueOfPropagates, throwingValueOfReversed,
  toStringAfterObjectValueOf, bothObjectResultsIsTypeError, symbolToPrimitive, symbolResultIsCompared,
  dateUsesToString, objectsCompareByIdentity };`)() as Record<string, () => number>;

  it("node agrees with every row", () => {
    expect(Object.values(expected).map((row) => row())).toEqual([0, 3, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("standalone, IR: the same answers", async () => {
    const result = await compileJs(SOURCE, "standalone");
    const claimed = new Set((result.irOutcomes ?? []).filter((o) => o.irBodyEmitted).map((o) => o.displayName));
    expect(claimed.has("f") && claimed.has("g")).toBe(true);
    const exports = (await instantiate(result, "standalone")).exports as Record<string, () => number>;
    for (const [name, row] of Object.entries(expected)) expect(answer(exports[name]!), name).toBe(String(row()));
  }, 120_000);
});

describe("#7194 — a script var compared in <module-init>", () => {
  // (on main: `o == 1` trapped, `illegal cast in __str_to_number`)
  const BODY = `var o = {};
var r1 = (o == 1); var r2 = (o != "[object Object]"); var r3 = (o != true);
if (r1 !== false || r2 !== false || r3 !== true) throw new Test262Error("o");`;

  it("node agrees", () => {
    expect(() => new Function("Test262Error", BODY)(Error)).not.toThrow();
  });

  it("standalone: <module-init> is claimed and passes", async () => {
    const source = `/*---\ndescription: 7194 module-init\n---*/\n${BODY}\n`;
    const result = await compile(assembleOriginalHarness(source, parseMeta(source) as never).primary.source, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      deferTopLevelInit: true,
      target: "standalone",
    });
    const init = (result.irOutcomes ?? []).find((o) => o.displayName === "<module-init>");
    expect(init?.irBodyEmitted).toBe(true);
    const instance = await instantiate(result, "standalone");
    expect(() => (instance.exports.__module_init as () => void)()).not.toThrow();
  }, 120_000);
});

describe("#7194 — a native Map.get result under loose equality", () => {
  const SOURCE = `
const m = new Map<string, any>();
m.set("a", { valueOf() { return 1; } });
m.set("b", [2]);
export function eqA(): number { return m.get("a") == 1 ? 1 : 0; }
export function neB(): number { return m.get("b") != "2" ? 1 : 0; }`;

  it("standalone: the object value is reduced with ToPrimitive", async () => {
    const result = await compile(SOURCE, { fileName: "test.ts", target: "standalone" });
    const exports = (await instantiate(result, "standalone")).exports as Record<string, () => number>;
    expect([exports.eqA!(), exports.neB!()]).toEqual([1, 0]);
  }, 120_000);
});

describe("#7194 — the JavaScript environment keeps its helper body", () => {
  it("__extern_loose_eq is the unreduced two-classifier call on the gc target", async () => {
    const result = await compileJs(
      `function f(c) { return c == 2; }\nf("x"); f(1);\nexport function run() { return f({}) ? 1 : 0; }`,
      "gc",
    );
    expect(result.success).toBe(true);
    const wat = result.wat ?? "";
    const start = wat.indexOf("(func $__extern_loose_eq");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = wat.slice(start, wat.indexOf("\n  (func $", start + 1));
    // No Object classification locals; the body opens with the two
    // `__any_from_extern` calls (`__any_eq` itself may be inlined).
    expect(body).not.toContain("$a_is_object");
    const instrs = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("(local") && !line.startsWith("(func"));
    expect(instrs.slice(0, 4)).toEqual(["local.get 0", instrs[1], "local.get 1", instrs[1]]);
    expect(instrs[1]).toMatch(/^call \d+$/);
  }, 120_000);
});
