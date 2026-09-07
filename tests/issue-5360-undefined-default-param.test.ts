// #5360 — a parameter defaulted with the literal `undefined` must still receive
// the argument its caller passed.
//
// ROOT CAUSE (both halves are needed; either alone leaves the row failing):
//
//   Under the deliberately-pinned `strictNullChecks: true` (#2748) TypeScript
//   infers `b` in `function f(a, b = undefined)` as the TYPE `undefined` — a
//   statement about TS callers, not about the values a JavaScript caller
//   passes. Two independent parts of codegen then trusted it:
//
//   1. THE SLOT. `resolveWasmType(undefined)` is a numeric slot ("void → no
//      result"), so the object-literal-method / class-method / arrow /
//      function-expression lanes gave `b` an i32/f64 parameter and the
//      argument was coerced away at the call boundary — `typeof b` answered
//      "number"/"boolean" and `String(b)` answered "0". (The free-function
//      lane escaped this only because call-site inference overrides its
//      registered signature.)
//   2. THE FOLDS. `typeof b` and `String(b)` both drop the carrier and
//      substitute the constant "undefined" when the static type carries
//      `TypeFlags.Undefined`.
//
// Measured on the test262 `intl402/Temporal` calendar family (the 123-row
// #5249 list, provider-linked): `temporalHelpers.js` declares
// `assertPlainDate(date, …, description = "", era = undefined, eraYear =
// undefined)`. Every non-ISO calendar assertion routed `era` through that
// slot, so `canonicalizeCalendarEra` saw `typeof eraName === "number"` and the
// harness threw `eraName must be string or undefined in
// canonicalizeCalendarEra` — 21 rows, of which the 5 that node-on-the-pinned-
// polyfill passes are the compiler's. All 21 clear this guard after the fix.
//
// NOT in scope (measured, still wrong, reported in the issue file):
//   * `const U = undefined; function f(a, b = U)` — the default is an
//     identifier, not the literal, so neither half fires.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

/**
 * Every lane reports `typeof b + ":" + String(b)`. The argument is handed in
 * through an `any`-typed export parameter, which is exactly how the harness
 * reaches these functions — and the only way to write the call site at all,
 * since TS itself rejects `f(1, "heisei")` against the inferred `undefined`.
 */
const LANES = `
function decl(a, b = undefined) { return typeof b + ":" + String(b); }
const arrow = (a, b = undefined) => typeof b + ":" + String(b);
const fexpr = function (a, b = undefined) { return typeof b + ":" + String(b); };
const objLit = {
  m(a, b = undefined) { return typeof b + ":" + String(b); },
};
const voidDefault = (a, b = void 0) => typeof b + ":" + String(b);

export function viaDecl(x) { return decl(1, x); }
export function viaArrow(x) { return arrow(1, x); }
export function viaFexpr(x) { return fexpr(1, x); }
export function viaObjLit(x) { return objLit.m(1, x); }
export function viaVoidDefault(x) { return voidDefault(1, x); }

export function omittedDecl() { return decl(1); }
export function omittedArrow() { return arrow(1); }
export function omittedObjLit() { return objLit.m(1); }

// Controls — these lanes were always correct and must stay correct.
function emptyDefault(a, b = "") { return typeof b + ":" + String(b); }
function noDefault(a, b) { return typeof b + ":" + String(b); }
export function viaEmptyDefault(x) { return emptyDefault(1, x); }
export function viaNoDefault(x) { return noDefault(1, x); }
export function omittedEmptyDefault() { return emptyDefault(1); }
`;

describe("#5360 — `= undefined` parameter default must not discard the argument", () => {
  it("delivers a passed string in every function lane", async () => {
    const ex = await run(LANES);
    const observed: Record<string, unknown> = {};
    for (const name of ["viaDecl", "viaArrow", "viaFexpr", "viaObjLit", "viaVoidDefault"]) {
      observed[name] = (ex[name] as (x: unknown) => unknown)("heisei");
    }
    // Base (all five): "undefined:undefined" for the declaration lane and
    // "boolean:0" / "number:0" for the closure lanes.
    expect(observed).toEqual({
      viaDecl: "string:heisei",
      viaArrow: "string:heisei",
      viaFexpr: "string:heisei",
      viaObjLit: "string:heisei",
      viaVoidDefault: "string:heisei",
    });
  });

  it("delivers a passed number, not just a string", async () => {
    const ex = await run(LANES);
    expect((ex.viaObjLit as (x: unknown) => unknown)(12)).toBe("number:12");
    expect((ex.viaDecl as (x: unknown) => unknown)(12)).toBe("number:12");
  });

  it("still yields undefined when the argument is omitted", async () => {
    const ex = await run(LANES);
    for (const name of ["omittedDecl", "omittedArrow", "omittedObjLit"]) {
      expect((ex[name] as () => unknown)(), name).toBe("undefined:undefined");
    }
  });

  it("still yields undefined when the argument is an explicit undefined", async () => {
    const ex = await run(LANES);
    expect((ex.viaObjLit as (x: unknown) => unknown)(undefined)).toBe("undefined:undefined");
    expect((ex.viaDecl as (x: unknown) => unknown)(undefined)).toBe("undefined:undefined");
  });

  it("leaves non-`undefined` defaults and undefaulted parameters alone", async () => {
    const ex = await run(LANES);
    expect((ex.viaEmptyDefault as (x: unknown) => unknown)("heisei")).toBe("string:heisei");
    expect((ex.viaNoDefault as (x: unknown) => unknown)("heisei")).toBe("string:heisei");
    expect((ex.omittedEmptyDefault as () => unknown)()).toBe("string:");
  });

  it("reproduces the harness shape that surfaced this: a trailing defaulted `era`", async () => {
    // `TemporalHelpers.assertPlainDate`'s exact parameter list, reduced. The
    // failure was NOT in the last slot — `description = ""` bound correctly
    // while the two `= undefined` slots after it did not, which is what made
    // this look like an argument-shifting bug rather than a type-directed one.
    const ex = await run(`
      const H = {
        assertish(date, year, month, monthCode, day, description = "", era = undefined, eraYear = undefined) {
          return [
            typeof date, typeof year, typeof month, typeof monthCode, typeof day,
            typeof description + ":" + String(description),
            typeof era + ":" + String(era),
            typeof eraYear + ":" + String(eraYear),
          ].join("|");
        },
      };
      export function call8(d, e, ey) { return H.assertish(d, 2000, 1, "M01", 1, "after setting day", e, ey); }
    `);
    expect((ex.call8 as (d: unknown, e: unknown, ey: unknown) => unknown)({}, "heisei", 12)).toBe(
      // Base: "…|string:after setting day|number:undefined|number:undefined"
      "object|number|number|string|number|string:after setting day|string:heisei|number:12",
    );
  });
});
