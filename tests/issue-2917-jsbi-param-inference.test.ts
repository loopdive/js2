// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2917 — call-site parameter inference must not narrow a parameter from the
 * sites it can read when another site passes a value it cannot vouch for.
 *
 * Every shape below is lifted from the standalone Temporal polyfill (287
 * test262 rows answered "Convert JSBI instances to native numbers using
 * `toNumber`", and the rows behind them failed on the same inference):
 *
 *  - `scalar`: `ApplyUnsignedRoundingMode(r1, r2, …)` is called with numbers by
 *    one helper and with JSBI values (checker: `any`) by another. The number
 *    sites pinned `r1`/`r2` to f64; the JSBI call then ran ToNumber on the
 *    instance — whose `valueOf` throws. An opaque `any` site now withdraws a
 *    scalar narrowing the same way #4530 already withdrew a ref narrowing.
 *  - `forwarded` / `destructured`: `Vn(…, cond ? "minute" : "auto")` agreed on
 *    a native string, while `nr(…, n)` forwarded its own parameter and
 *    `Instant#toString` passed `const { precision: a } = At(…)` — both `any`,
 *    both "trusted". The number 6 arrived as a null string and
 *    `"123987000".slice(0, precision)` answered "".
 *  - `iifeComma`: an inlined IIFE ending `return x && (…), { … }` typed its
 *    return local from the TS struct type while the literal lowered to an open
 *    object; the guarded cast answered null (`m.duration` → "Cannot access
 *    property on null or undefined" in `Duration#round` / `since` / `until`).
 */
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

const MAIN = `
class Big extends Array {
  constructor(v) { super(1); this[0] = v; }
  valueOf() { throw new Error("Convert Big instances to native numbers"); }
  tag() { return this[0]; }
}
function id(x) { return x; }

// scalar
function pick(r1, r2, cmp) { return cmp < 0 ? r1 : r2; }
function roundNum(q) { const r1 = Math.floor(q); return pick(r1, r1 + 1, 1); }
function roundBig() { const r1 = id(new Big(5)), r2 = id(new Big(6)); return pick(r1, r2, -1); }
export function scalar() {
  try { return roundNum(3.5) === 4 && roundBig().tag() === 5 ? 1 : 0; } catch (e) { return -1; }
}

// forwarded / destructured
function frac(e, t) { if ("auto" === t) return "." + e; if (0 === t) return ""; return "." + String(e).slice(0, t); }
function time(h, o) { let i = "" + h; return "minute" === o || (i += frac(123987000, o)), i; }
function iso(h, n) { return "T" + time(h, n); }
function other(h, m) { return time(h, 0 === m ? "minute" : "auto"); }
function At(u, d) { switch (u) { case "minute": return { precision: "minute" }; case "micro": return { precision: 6 }; } return { precision: d }; }
export function forwarded() {
  const { precision: a } = At("micro", undefined);
  return iso(1, a) === "T1.123987" && other(1, 2) === "1.123987000" ? 1 : 0;
}
export function destructured() {
  const { precision: a } = At("micro", undefined);
  return time(1, a) === "1.123987" && time(1, "minute") === "1" ? 1 : 0;
}

// iifeComma
function Vt(r) { return r; }
function nudge(t, r, o) {
  let m;
  return m = o ? function (x) { return { duration: { date: 7, time: x }, n: 1 }; }(t)
    : function (t, r) { let y = 0, p = t; return "date" === Vt(r) && (y = 1, p = t + 1), { duration: { date: y, time: p }, n: 5 }; }(t, r),
    m.duration.time;
}
function sole(t) { let m; m = function (x) { return 0, { d: { time: x } }; }(t); return m.d.time; }
export function iifeComma() {
  try { return nudge(5, "x", false) === 5 && nudge(5, "date", false) === 6 && sole(5) === 5 ? 1 : 0; } catch (e) { return -1; }
}
`;

const NAMES = ["scalar", "forwarded", "destructured", "iifeComma"];

describe("#2917 — call-site param inference soundness (standalone)", () => {
  it("keeps opaque/forwarded/destructured arguments out of the agreement", { timeout: 120_000 }, async () => {
    const result = (await compileMulti({ "/main.js": MAIN }, "/main.js", {
      target: "standalone",
      hostBridge: "off",
      allowJs: true,
      skipSemanticDiagnostics: true,
    } as never)) as unknown as { success: boolean; errors: { message: string }[]; binary: Uint8Array };
    expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);

    const module = new WebAssembly.Module(result.binary);
    const imports: Record<string, Record<string, () => null>> = {};
    for (const imported of WebAssembly.Module.imports(module)) {
      (imports[imported.module] ??= {})[imported.name] = () => null;
    }
    const exports = (await WebAssembly.instantiate(module, imports)).exports as Record<string, () => number>;
    exports.__module_init?.();
    const answers: Record<string, number | string> = {};
    for (const name of NAMES) {
      try {
        answers[name] = exports[name]!();
      } catch (e) {
        answers[name] = `trap: ${(e as Error).message}`;
      }
    }
    expect(answers).toEqual({ scalar: 1, forwarded: 1, destructured: 1, iifeComma: 1 });
  });
});
