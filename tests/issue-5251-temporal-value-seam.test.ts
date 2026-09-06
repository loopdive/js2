// #5251 — two value-fidelity defects that made the compiled
// `@js-temporal/polyfill` compute WRONG NUMBERS (never trap) on every non-ISO
// calendar built from a property bag. Neither reduction below has any Temporal
// in it: both are general compiled-object read defects.
//
// Measured 2026-09-05 against the #4628 linked provider, on the 123-row #5249
// calendar list, stacked on #5250 + #5352.
//
// ── A. destructuring `this` on a SIDECAR-BACKED class instance ──────────────
//
// `compileObjectDestructuring` resolves the initializer's Wasm struct type and
// hands the pattern to `destructureParamObject`'s TYPED arm, which reads each
// property with `struct.get`. A property the struct does not declare is bound
// as `undefined` (`emitAbsentStructPropertyBinding`, #5221) on the inference
// "not a declared field ⇒ absent property".
//
// That inference is sound for a CLOSED anonymous object literal — its struct
// enumerates every property it has — and UNSOUND for a class instance, whose
// properties can live entirely outside the struct. A class that takes any write
// the shape analysis cannot place (a computed key, `Object.assign`, a write
// through a helper function) is lowered to
// `(struct (field $__tag i32) (field $__shape_brand …))` — no data fields at
// all — with the instance state in the sidecar. Every `const { x } = this` in
// such a class bound `undefined` while `this.x`, `this[k]`, `Reflect.get` and
// `{...this}` all read the real value.
//
// In the polyfill this was `const { anchorEra: i } = this` in
// `GregorianBaseHelper.estimateIsoDate`. The `undefined` reached
// `n + i.isoEpoch.year` as NaN/Infinity and surfaced from the polyfill's own
// guards as `RangeError: Invalid ISO date: 0NaN-12-01` (ethiopic/coptic) or
// `infinity is out of range` (gregory/japanese/roc) — 66 of the 123 rows.
//
// The externref arm of the same function has carried the equivalent check
// since #1016; the fix applies that rule to the arm that already holds a
// typed struct ref.
//
// ── B. an ABSENT numeric property read as NaN-the-number ────────────────────
//
// The Phase-3 narrowing (#1269, property-access-dispatch.ts) collapses a
// dynamic property read to `f64` when every struct candidate's field is `f64`.
// The receiver on that path is DYNAMIC, so the dispatcher's terminal is
// `__extern_get`, which correctly answers `undefined` when the property is
// ABSENT — and f64 cannot hold `undefined`. The narrowing unboxed it to plain
// NaN, and the caller re-boxed that as a NUMBER: `typeof x === "number"` while
// `x !== undefined`.
//
// One numeric literal anywhere in the module arms it, the way #5250's
// `__sget_month` collider did. The polyfill's options reader
// `Ft(e){ let t = e.roundingIncrement; if (t === undefined) return 1; … }`
// hit exactly that, so every `.until()` / `.since()` on a non-ISO calendar
// died in ToIntegerWithTruncation with `RangeError: invalid number value`
// (17 rows of the 123; 43 in the #5251 census).
//
// The fix brands the narrowed f64 `undefSentinel: true` and gives the
// externref→f64 coercion the inverse of the sentinel-aware boxing arm that
// already existed (#2864/#2979): `undefined` encodes as `UNDEF_F64_BITS`, and
// the caller's f64→externref boxing resurrects it. Numeric consumers are
// untouched — they read a plain f64, and NaN is the correct
// `ToNumber(undefined)`.
//
// NOT fixed here, reported with its measurement: the remaining 66 rows fail in
// `Intl.DateTimeFormat` (#5206). Measured from the consumer,
// `new Intl.DateTimeFormat("en-US", …)` answers a value that is `=== undefined`
// while `typeof` says "object", and `.format()` / `.formatToParts()` return
// `undefined` — a shell. Only the calendars that need no real
// `formatToParts` (gregory / japanese / roc, whose `isoToCalendarDate` is
// arithmetic) work; buddhist, indian, ethiopic and coptic cannot until Intl is
// real.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-5251.ts",
    skipSemanticDiagnostics: true,
    allowJs: true,
    emitWat: false,
  });
  expect(result.success).toBe(true);
  const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
  const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as { run?: () => unknown }).run?.();
}

/** Reads the same property twice: destructured, then by member access. */
const READ_BOTH = `m(){ const { a } = this; return String(a && a.code) + "|" + String(this.a && this.a.code); }`;

describe("#5251 A — destructuring a sidecar-backed class instance", () => {
  it("a computed-key write still destructures off `this`", async () => {
    // Base: "undefined|x" — the member read saw it, the destructure did not.
    expect(
      await run(`class B { constructor(x){ const k = "a"; this[k] = x; } ${READ_BOTH} }
        export function run() { return new B({ code: "x" }).m(); }`),
    ).toBe("x|x");
  });

  it("an Object.assign-populated instance still destructures off `this`", async () => {
    // Base: "undefined|x".
    expect(
      await run(`class B { constructor(x){ Object.assign(this, { a: x }); } ${READ_BOTH} }
        export function run() { return new B({ code: "x" }).m(); }`),
    ).toBe("x|x");
  });

  it("a field written through a helper function still destructures off `this`", async () => {
    // Base: "undefined|x". This is the polyfill's shape — `GregorianBaseHelper`
    // fills `this` from a plain function it calls with `this`.
    expect(
      await run(`function fill(o, x){ o.a = x; }
        class B { constructor(x){ fill(this, x); } ${READ_BOTH} }
        export function run() { return new B({ code: "x" }).m(); }`),
    ).toBe("x|x");
  });

  it("the inherited method's destructure sees a base-class field on a subclass instance", async () => {
    // Base: "undefined|x". Three levels with method-shadowing own props, the
    // `OrthodoxBaseHelper → GregorianBaseHelper` arrangement.
    expect(
      await run(`const mix = { f(){ return 1; } };
        class Base { constructor(x){ (function(o, v){ o.a = v; o.id = "b"; })(this, x); } f(){ return 0; } ${READ_BOTH} }
        class Mid extends Base { constructor(x){ super(x); this.f = mix.f; } }
        class Leaf extends Mid { constructor(){ super({ code: "x" }); } }
        export function run() { return new Leaf().m(); }`),
    ).toBe("x|x");
  });

  it("a genuinely absent property on a closed object literal stays undefined (#5221 unchanged)", async () => {
    expect(await run(`export function run() { const { month } = { year: 1994 }; return typeof month; }`)).toBe(
      "undefined",
    );
  });
});

/**
 * `mk()` exists only to make the module declare `inc` as an f64 struct field,
 * which is what arms the Phase-3 narrowing at every dynamic `.inc` read.
 */
const NUMERIC_COLLIDER = `
function mk() { return { inc: 5, other: "x" }; }
export function keepAlive() { return mk().inc; }
`;

describe("#5251 B — an absent numeric property reads as undefined, not NaN", () => {
  it("typeof an absent narrowed-numeric property is undefined", async () => {
    // Base: "number" (the value was NaN).
    //
    // The read is bound to a local first because that is the shape that was
    // measured. A DIRECT `typeof o.inc` takes its own read route and still
    // answers "number" on this branch — reported, not fixed, in the issue file.
    expect(
      await run(`${NUMERIC_COLLIDER}
        function read(o) { const t = o.inc; return typeof t; }
        export function run() { return read({ other: "y" }); }`),
    ).toBe("undefined");
  });

  it("an absent narrowed-numeric property compares === undefined", async () => {
    // Base: "no". This is the exact shape of the polyfill's options reader.
    expect(
      await run(`${NUMERIC_COLLIDER}
        function read(o) { const t = o.inc; return t === undefined ? "yes" : "no"; }
        export function run() { return read({}); }`),
    ).toBe("yes");
  });

  it("a PRESENT narrowed-numeric property is still a number", async () => {
    expect(
      await run(`${NUMERIC_COLLIDER}
        function read(o) { const t = o.inc; return typeof t; }
        export function run() { return read({ inc: 7 }); }`),
    ).toBe("number");
  });

  it("a present narrowed-numeric property keeps its value through the sentinel branding", async () => {
    expect(
      await run(`${NUMERIC_COLLIDER}
        function read(o) { return o.inc + 1; }
        export function run() { return String(read({ inc: 7 })); }`),
    ).toBe("8");
  });

  it("a genuine computed NaN still boxes as a number, not undefined", async () => {
    // The #3315 hazard in the other direction: the sentinel must not swallow a
    // real arithmetic NaN.
    expect(
      await run(`${NUMERIC_COLLIDER}
        function read(o) { const t = o.inc; return t; }
        export function run() { const v = read({ inc: 0 / 0 }); return typeof v; }`),
    ).toBe("number");
  });
});
