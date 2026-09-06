// #5250 — a NUMERIC `__sget_<name>` shape-miss (`0`) must read as ABSENT, the
// same way a ref-typed one's `null` already does.
//
// Reported as a Temporal error-semantics mismatch:
// `new Temporal.PlainYearMonth(2013, 6).until({ year: 1994 })` threw a
// `RangeError` through the #4628 linked provider where the SAME pinned
// `@js-temporal/polyfill@0.5.1` in node throws
// `TypeError: Either month or monthCode are required` — the error test262's
// `built-ins/Temporal/PlainYearMonth/prototype/until/arguments-missing-throws.js`
// asserts. Nothing about it is Temporal-specific, and the reduction below has
// no Temporal in sight.
//
// ROOT CAUSE (measured on base, 2026-09-05, `_resolveHostField`,
// src/runtime.ts). `__sget_<name>` is a per-shape `ref.test` dispatch ladder
// that never traps: for a receiver whose own shape lacks the field it falls
// through to a ZERO-INITIALIZED result. For a ref-typed field that is `null`,
// and `_resolveHostField` has consulted the field-name registry before
// believing a `null` since #3051. For a NUMERIC (or boolean) field the
// fall-through is `0`, which is not nullish — so it was returned as a real
// value, unconditionally.
//
// The getter is module-GLOBAL, so the defect is triggered by an unrelated
// shape elsewhere in the same module: `{ month: 11 }` anywhere in the program
// emits `__sget_month`, and from then on every struct reaching this resolver
// answers `month === 0` instead of `undefined`. `_resolveHostField` also backs
// the host proxy's `has` trap (`_wrapForHost`), so `"month" in { year: 1994 }`
// answered true as well — which is exactly the check the polyfill uses to
// choose between its TypeError and its range check.
//
// Measured through the Temporal provider (`JS2WASM_TEST262_TEMPORAL=1`), one
// literal changed in the program and nothing else:
//
//   second literal in the module   `jun13.until({ year: 1994 })` throws
//   ------------------------------ -------------------------------------------
//   (none)                         TypeError: Either month or monthCode …  ok
//   { month: 11 }                  RangeError: Cannot convert a number …   BASE
//   { month: 11, day: 2 }          RangeError: Cannot convert a number …   BASE
//   { zzz: 11 }                    TypeError: Either month or monthCode …  ok
//   { monthCode: "M11" }           TypeError: Either month or monthCode …  ok
//
// `{ zzz: 11 }` lowers to the SAME WasmGC struct type as `{ month: 11 }`
// (WasmGC types are structural — field names are compiler-side only) and does
// NOT reproduce. So this is a getter-NAME collision, not a structural type
// confusion, which is what makes the field-name registry the right gate.
//
// The fix consults `_structOwnFieldStatus` for the ONE requested key, and only
// when the value is `0` / `false` AND the registry can positively say the
// field is absent. Every other read — including a receiver whose shape cannot
// be named at all — keeps its previous cost and answer.
//
// ROUTE. The resolver is reached when a compiled struct has been wrapped for
// the host (`_wrapForHost`) and is then read back through the `extern_get`
// intent. `Reflect.get`/`Reflect.has` and a Map/Set round-trip take that
// route; a plain local member read does not (it is statically typed), which is
// why the probes below are written the way they are.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(source: string): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-5250.ts",
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

/**
 * `collide()` exists ONLY to make the module emit `__sget_month`. The receiver
 * under test is `{ year: 1994 }`, which never had a `month` field.
 */
const COLLIDER = `
function collide() { return { month: 11 }; }
export function keepAlive() { return collide().month; }
`;

describe("#5250 — a numeric __sget shape-miss reads as absent, not as 0", () => {
  it("Reflect.get on an absent numeric field answers undefined", async () => {
    // Base: "number" — the module-global `__sget_month` ladder's zero
    // fall-through was returned as a real value.
    expect(
      await run(`${COLLIDER}
        export function run() { const o = { year: 1994 }; return typeof Reflect.get(o, "month"); }`),
    ).toBe("undefined");
  });

  it("Reflect.has does not report the absent numeric field as present", async () => {
    // Base: true — `_resolveHostField` also backs the host proxy's `has` trap.
    expect(
      await run(`${COLLIDER}
        export function run() { const o = { year: 1994 }; return Reflect.has(o, "month") ? "yes" : "no"; }`),
    ).toBe("no");
  });

  it("a host round-trip through Map keeps the absent field absent", async () => {
    // Base: "yes". Only the `in` half is asserted here: the member READ
    // `o.month` is statically typed `number` on this route, so its miss lands
    // in an f64 slot and reads NaN on both sides — a real answer, but a
    // different question from the one this issue is about.
    expect(
      await run(`${COLLIDER}
        export function run() {
          const m = new Map(); m.set("k", { year: 1994 }); const o = m.get("k");
          return ("month" in o) ? "yes" : "no";
        }`),
    ).toBe("no");
  });

  it("the field the receiver DOES have still reads through the same route", async () => {
    expect(
      await run(`${COLLIDER}
        export function run() {
          const o = { year: 1994 };
          return String(Reflect.get(o, "year")) + "|" + (Reflect.has(o, "year") ? "yes" : "no");
        }`),
    ).toBe("1994|yes");
  });

  it("the shape that OWNS the field is unaffected", async () => {
    expect(
      await run(`${COLLIDER}
        export function run() {
          const o = { month: 11 };
          return String(Reflect.get(o, "month")) + "|" + (Reflect.has(o, "month") ? "yes" : "no");
        }`),
    ).toBe("11|yes");
  });

  it("a real 0 on the owning shape is still a value, not a miss", async () => {
    // The guard must not turn a genuine zero into an absence — this is the
    // reason the gate asks the field-name registry rather than just dropping
    // every `0`.
    expect(
      await run(`
        function other() { return { count: 7 }; }
        export function keepAlive() { return other().count; }
        export function run() {
          const o = { count: 0 };
          return String(Reflect.get(o, "count")) + "|" + (Reflect.has(o, "count") ? "yes" : "no");
        }`),
    ).toBe("0|yes");
  });

  it("a boolean field's `false` miss-default is gated the same way", async () => {
    // PASSES ON BASE — a control, not a reproduction. Measured 2026-09-05: a
    // boolean-only collider does not produce a `false` here, so the fix's
    // `v === false` arm is defensive rather than something this issue
    // observed. Kept so a lowering that does start answering `false` on a
    // shape miss is caught rather than silently believed.
    expect(
      await run(`
        function collide() { return { hit: false }; }
        export function keepAlive() { return collide().hit; }
        export function run() {
          const o = { ok: 1 };
          return typeof Reflect.get(o, "hit") + "|" + (Reflect.has(o, "hit") ? "yes" : "no");
        }`),
    ).toBe("undefined|no");
  });

  it("a real `false` on the owning shape survives the gate", async () => {
    expect(
      await run(`
        function other() { return { hit: true }; }
        export function keepAlive() { return other().hit; }
        export function run() {
          const o = { hit: false };
          return String(Reflect.get(o, "hit")) + "|" + (Reflect.has(o, "hit") ? "yes" : "no");
        }`),
    ).toBe("false|yes");
  });
});
