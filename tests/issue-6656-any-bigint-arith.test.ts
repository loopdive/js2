// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6656 slice 3 (#5383 S74b) — `any`-typed BigInt ARITHMETIC under
// `--target standalone`.
//
// WHAT WAS BROKEN. In untyped JS — the vendored Temporal polyfill, and every
// test262 `.js` body — a helper like `function mul(a, b) { return a * b; }`
// called with bigints gets bigint-branded i64 PARAMETER slots from call-site
// inference, while TypeScript types both parameters `any` and therefore types
// `a * b` as `number`. Three consequences, each measured on the base
// (`.tmp/s74b/bi5.mts`, standalone, `hostBridge: "off"`):
//
//   mul(6n, 7n)                     NaN                      → 42n
//   mul(1234567890123456789n, 7n)   NaN                      → 8641975230864197523n
//   add(9007199254740992n, 1n)      90071992547409921        → 9007199254740993n
//   sub / div / mod                 NaN                      → exact
//   neg(9007199254740993n)          NaN                      → -9007199254740993n
//   typeof mul(6n, 7n)              "number"                 → "bigint"
//
// `add` is the loudest: `+` reached the `$AnyValue` dispatch, which boxes each
// operand with `__any_box_f64` — both sides were rounded to doubles and then
// CONCATENATED as strings before `__any_add` ever ran.
//
// THE THREE FIXES, and what each one is:
//   1. the numeric hint (`binary-ops.ts`) — two proven bigint carriers keep an
//      i64 hint instead of f64, so the existing i64/i64 arm in
//      `compileTypedBinaryDispatch` reaches `compileI64BinaryOp`;
//   2. the result type (`declarations.ts`) — a proven BigInt kernel gets a
//      branded i64 result, so the exact i64 is not converted back at the
//      return;
//   3. `===` and `typeof` — both folded from the static type alone and
//      answered the constants `false` and `"number"`.
//
// CONTROLS WITH TEETH. The first cut of fix 3 gated the equality on "the i64
// hint produced an i64", which is not evidence — a `number` operand under an
// i64 hint is also an i64 — and it made `0n === 0` answer TRUE, breaking
// §7.2.15 step 1. `strictEqBigIntVsNumber` below is that regression; it fails
// on the intermediate version and passes here and on the base.
//
// Host-free: `hostBridge: "off"` and an EMPTY import object. Every probe
// answers a NUMBER, because a standalone module's string is a WasmGC array the
// host cannot decode — every comparison happens INSIDE the module.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function singleModule(source: string): Promise<Record<string, () => unknown>> {
  const entry = "/__main.js";
  const result = await compileMulti({ [entry]: source }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...STANDALONE,
  } as never);
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (i: unknown) => void }).__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, () => unknown>;
}

// 1 = the spec answer, 0 = any other value, -1 = threw.
const ARITHMETIC = `
  function mul(a, b) { return a * b; }
  function add(a, b) { return a + b; }
  function sub(a, b) { return a - b; }
  function div(a, b) { return a / b; }
  function mod(a, b) { return a % b; }
  function neg(a)    { return -a; }

  export function mulSmall()  { try { return mul(6n, 7n) === 42n ? 1 : 0; } catch (e) { return -1; } }
  // 19 significant digits — past an f64's ~15.95, so an f64 round trip answers
  // a different number and this row pins the exact i64 operator.
  export function mulLarge()  { try { return mul(1234567890123456789n, 7n) === 8641975230864197523n ? 1 : 0; } catch (e) { return -1; } }
  // 2^53 + 1: the smallest integer an f64 cannot represent. The base answered
  // the string "90071992547409921" — two rounded doubles concatenated.
  export function addPast53() { try { return add(9007199254740992n, 1n) === 9007199254740993n ? 1 : 0; } catch (e) { return -1; } }
  export function subPast53() { try { return sub(9007199254740993n, 1n) === 9007199254740992n ? 1 : 0; } catch (e) { return -1; } }
  // §6.1.6.2.5 — BigInt division TRUNCATES toward zero; f64.div does not.
  export function divTrunc()  { try { return div(9007199254740993n, 3n) === 3002399751580331n ? 1 : 0; } catch (e) { return -1; } }
  // §6.1.6.2.6 — the remainder takes the DIVIDEND's sign.
  export function modExact()  { try { return mod(9007199254740993n, 10n) === 3n ? 1 : 0; } catch (e) { return -1; } }
  export function modNegative(){ try { return mod(-7n, 3n) === -1n ? 1 : 0; } catch (e) { return -1; } }
  export function negPast53() { try { return neg(9007199254740993n) === -9007199254740993n ? 1 : 0; } catch (e) { return -1; } }
  export function typeofCall(){ try { return typeof mul(6n, 7n) === "bigint" ? 1 : 0; } catch (e) { return -1; } }
  // A literal operand on one side — the shape the minified polyfill uses most.
  export function literalRhs(){ try { return mul(1234567890123456789n, 2n) === 2469135780246913578n ? 1 : 0; } catch (e) { return -1; } }
`;

// Every one of these already answered correctly on the base. They are asserted
// rather than assumed because all three fixes prepend an arm to a path that
// ordinary numbers and strings also take.
const CONTROLS = `
  function mul(a, b) { return a * b; }
  function add(a, b) { return a + b; }
  function mulBig(a, b) { return a * b; }

  // §7.2.15 step 1 — a BigInt and a Number are never strictly equal, whatever
  // their mathematical values. This is the regression the first cut caused.
  export function strictEqBigIntVsNumber() {
    const a = 0n;
    const b = 0;
    let result = 0;
    if (!(a === b)) result += 1;
    if (a !== b) result += 2;
    return result === 3 ? 1 : 0;
  }
  // Ordinary f64 arithmetic through the same untyped helpers.
  export function numberMul()  { try { return mul(6, 7) === 42 ? 1 : 0; } catch (e) { return -1; } }
  export function numberAdd()  { try { return add(0.1, 0.2) === 0.30000000000000004 ? 1 : 0; } catch (e) { return -1; } }
  export function numberDiv()  { try { return mul(1, 7) / 2 === 3.5 ? 1 : 0; } catch (e) { return -1; } }
  // §13.15.4 — the plus operator with a string operand CONCATENATES, and does
  // so for a bigint side too. The bigint arm must not capture this.
  export function stringConcat(){ try { return add("x", 1) === "x1" ? 1 : 0; } catch (e) { return -1; } }
  // PRE-EXISTING RESIDUAL, measured identical on base and branch: one untyped
  // \`add\` shared by a number call site and a bigint one monomorphises to a
  // single signature, so the bigint call arrives converted. Asserted at its
  // BASE value so a future change to it shows up here rather than silently.
  export function bigIntConcat(){ try { return add("v", 12n) === "v12" ? 1 : 0; } catch (e) { return -1; } }
  // A statically-typed bigint pair keeps the path it already had.
  export function staticBigInt() {
    const a: bigint = 1234567890123456789n;
    return a * 7n === 8641975230864197523n ? 1 : 0;
  }
  export function typeofNumber(){ try { return typeof mulBig(6, 7) === "number" ? 1 : 0; } catch (e) { return -1; } }
`;

describe("#6656 slice 3 — any-typed BigInt arithmetic (standalone)", () => {
  it("computes every arithmetic operator exactly, past 2^53", async () => {
    const exports = await singleModule(ARITHMETIC);
    for (const name of [
      "mulSmall",
      "mulLarge",
      "addPast53",
      "subPast53",
      "divTrunc",
      "modExact",
      "modNegative",
      "negPast53",
      "typeofCall",
      "literalRhs",
    ]) {
      expect(exports[name]!(), `${name} did not answer the spec value`).toBe(1);
    }
  });

  it("leaves Number arithmetic, string concatenation and cross-type equality unchanged", async () => {
    const exports = await singleModule(CONTROLS);
    for (const name of [
      "strictEqBigIntVsNumber",
      "numberMul",
      "numberAdd",
      "numberDiv",
      "stringConcat",
      "staticBigInt",
      "typeofNumber",
    ]) {
      expect(exports[name]!(), `${name} changed behaviour`).toBe(1);
    }
    // The residual above: 0 on the base and 0 here — recorded, not hidden.
    expect(exports.bigIntConcat!(), "bigIntConcat moved off its measured base value").toBe(0);
  });
});
