// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4625 — `x["toString"]()` under `--target standalone`.
 *
 * ## What the measurement found
 *
 * #4619 taught the property-access route about wrapper receivers, and the dot
 * spellings all answered. The bracket spelling did not, and it was NOT because
 * it reached that route and declined: it never reached it. Traced on
 * `9d9291db7`, the call is claimed several arms earlier by
 * `compileCallableElementAccessCall` (#1306) — the `fns[i](…)` arm — which
 * claims on "TypeScript reports a call signature for the element type". For
 * `false["toString"]` that signature comes from `interface Boolean` in
 * `lib.es5.d.ts`, so the test passes while its premise does not: the compiler
 * materialises no closure in that slot, the element read yields null, and the
 * arm's own `emitNullCheckThrow` produces
 * `TypeError: Cannot access property on null or undefined`.
 *
 * The fix routes a static identifier-shaped string-literal key naming an
 * AMBIENT member onto the property-access spelling — one canonical entry, the
 * same move `call-tail-dispatch.ts` already makes for native-strings method
 * calls (#3027).
 *
 * ## The controls are the point
 *
 * The arm sits AFTER every arm that already lowers a bracket call correctly, so
 * in the standalone lane `(1)["toString"]()`, `s["charAt"](0)` and
 * `a["join"]("-")` never reach it — they are pinned here as
 * passing-before-and-after, not as flips. Numeric and computed keys fail the
 * identifier-shape test, and a user-declared member fails the ambient test, so
 * `a[0]()`, `o["m"]()` and `o["a b"]()` keep the element chain.
 *
 * Measured base vs after over a 16-shape sha256 probe: standalone is
 * byte-identical for all 14 non-claimed shapes; host/gc is byte-identical for
 * 13 of 14. The one that moves is `s["charAt"](0)`, and it moves for a reason
 * worth stating — the `string_<method>` import the bracket string arm looks up
 * is not registered in that lane, so the arm declines there and the call
 * reaches this one. It is a route change, not a behaviour change: the host-lane
 * test262 sweep over the whole 209-file bracket-call population is +2/−0.
 *
 * | shape                                  | base   | after |
 * | -------------------------------------- | ------ | ----- |
 * | `false["toString"]()`                  | throws | 1     |
 * | `new Boolean(false)["toString"]()`     | throws | 1     |
 * | `new Number(1)["toFixed"](5)`          | throws | 1     |
 * | `(1)["toString"]()` (control)          | 1      | 1     |
 * | `a["join"]("-")` (control)             | 1      | 1     |
 * | `o["m"]()` (control, user member)      | 5      | 5     |
 * | `a[0]()` (control, numeric key)        | 7      | 7     |
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4625.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  // Standalone means standalone — no host bridge may leak in behind this arm.
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/**
 * The `sta.js` condition: ONE unrelated `.toString` assignment. It is what
 * every test262 file carries and what decides whether a `toString` call takes
 * the dynamic route at all (#1397's whole-file `sourceHasMethodReassignment`
 * scan). A pin written without it would be vacuous for exactly the rows this
 * issue unblocks.
 */
const STA = `function T262(){}\nT262.prototype.toString = function(){ return "T262"; };\n`;

function prog(body: string, withSta: boolean): string {
  return `${withSta ? STA : ""}/** @returns {number} */\nexport function f() {\n${body}\n}`;
}

async function bothLanes(body: string): Promise<{ plain: unknown; sta: unknown }> {
  return {
    plain: await runStandalone(prog(body, false)),
    sta: await runStandalone(prog(body, true)),
  };
}

describe("#4625 — element-access callee normalization (the shapes that flip)", () => {
  it('false["toString"]() is "false" (property-accessors S11.2.1_A3_T1 CHECK#2)', async () => {
    expect(await bothLanes(`return false["toString"]() === "false" ? 1 : 0;`)).toEqual({ plain: 1, sta: 1 });
  });

  it('new Boolean(false)["toString"]() is "false" (S11.2.1_A3_T1 CHECK#4)', async () => {
    expect(await bothLanes(`var b = new Boolean(false);\nreturn b["toString"]() === "false" ? 1 : 0;`)).toEqual({
      plain: 1,
      sta: 1,
    });
  });

  it('new Number(1)["toFixed"](5) is "1.00000" (S11.2.1_A3_T2 CHECK#6)', async () => {
    expect(await bothLanes(`var n = new Number(1);\nreturn n["toFixed"](5) === "1.00000" ? 1 : 0;`)).toEqual({
      plain: 1,
      sta: 1,
    });
  });

  it("the argument survives the rewrite (radix, not just arity)", async () => {
    expect(await bothLanes(`var n = new Number(255);\nreturn n["toString"](16) === "ff" ? 1 : 0;`)).toEqual({
      plain: 1,
      sta: 1,
    });
  });

  it("the receiver is evaluated exactly once", async () => {
    // §13.3.3: `x["k"]()` and `x.k()` share one MemberExpression evaluation.
    // A rewrite that re-compiled the receiver expression would run the counter
    // twice and answer 2 — the failure mode the arm must not have.
    expect(
      await bothLanes(`var n = 0;\nfunction recv() { n++; return new Number(1); }\nrecv()["toFixed"](2);\nreturn n;`),
    ).toEqual({ plain: 1, sta: 1 });
  });
});

describe("#4625 controls — shapes the arm must NOT claim", () => {
  it("a numeric-key element call still invokes the stored closure", async () => {
    expect(await bothLanes(`var a = [function(){ return 7; }];\nreturn a[0]();`)).toEqual({ plain: 7, sta: 7 });
  });

  it("a user-declared string member still takes the element chain", async () => {
    expect(await bothLanes(`var o = { m: function(){ return 5; } };\nreturn o["m"]();`)).toEqual({
      plain: 5,
      sta: 5,
    });
  });

  it("a non-identifier key keeps the element chain", async () => {
    expect(await bothLanes(`var o = { "a b": function(){ return 6; } };\nreturn o["a b"]();`)).toEqual({
      plain: 6,
      sta: 6,
    });
  });

  it("a runtime-key element call is untouched", async () => {
    expect(await bothLanes(`var o = { m: function(){ return 9; } };\nvar k = "m";\nreturn o[k]();`)).toEqual({
      plain: 9,
      sta: 9,
    });
  });

  it("a user class method by bracket still resolves", async () => {
    expect(
      await bothLanes(`function C(){}\nC.prototype.go = function(){ return 8; };\nvar c = new C();\nreturn c["go"]();`),
    ).toEqual({ plain: 8, sta: 8 });
  });

  it("a user-overridden ambient member still calls the user's function", async () => {
    // The one shape where the ambient-member condition admits a slot that
    // really does hold a user closure: `o` is typed `{}`, so `o["toString"]`
    // resolves to Object's lib-declared `toString` and this arm claims it —
    // handing it to the property-access route, where #4482's
    // `tryEmitStoredMemberClosureCall` is the dot-form handler for exactly this
    // shape. Measured base 1 / after 1; pinned so neither route can move it
    // silently.
    expect(
      await bothLanes(`var o = {};\no.toString = function(){ return "U"; };\nreturn o["toString"]() === "U" ? 1 : 0;`),
    ).toEqual({ plain: 1, sta: 1 });
  });

  it("the bracket shapes that already worked still work (they never reach this arm)", async () => {
    expect(await bothLanes(`return (1)["toString"]() === "1" ? 1 : 0;`)).toEqual({ plain: 1, sta: 1 });
    expect(await bothLanes(`var s = "xy";\nreturn s["charAt"](0) === "x" ? 1 : 0;`)).toEqual({ plain: 1, sta: 1 });
    expect(await bothLanes(`var a = [1,2];\nreturn a["join"]("-") === "1-2" ? 1 : 0;`)).toEqual({
      plain: 1,
      sta: 1,
    });
  });
});
