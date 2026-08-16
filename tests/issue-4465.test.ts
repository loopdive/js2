// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4465 — `String.prototype` generic-method receiver / argument coercion in
 * `--target standalone`.
 *
 * §15.5.4 (§22.1.3) String methods are GENERIC: step 1–2 of each is
 * `RequireObjectCoercible(this)` + `ToString(this)`, and every integer argument
 * goes through `ToIntegerOrInfinity(ToNumber(arg))`. Two defects are fixed
 * here, both the same shape — **the RUNTIME coercion walker is missing a case
 * the STATIC path already has**:
 *
 *  1. **RegExp receiver.** `String(re)` and `` `${re}` `` already answer
 *     `"/src/flags"` because `emitStandaloneRegExpToStringFromExpr` reads the
 *     receiver EXPRESSION. A reflective `String.prototype.<m>` body has no
 *     expression — the receiver is a bare externref closure param — so
 *     `ToString(this)` fell to `__to_primitive` → `$__any_to_string`, whose
 *     terminal for an unrecognized ref is the literal `"[object Object]"`.
 *     That is the whole `S15.5.4.1[6789]_A1_T14` family
 *     (`__reg.toLowerCase = String.prototype.toLowerCase; __reg.toLowerCase()`
 *     → `"[object object]"` instead of `"/abc/"`).
 *  2. **Object-valued integer arguments.** The reflective `substring`/`slice`
 *     bound path and the `charAt`/`charCodeAt`/`at`/`indexOf`-family position
 *     path called `__unbox_number` DIRECTLY, skipping ToPrimitive.
 *     `__unbox_number` re-discriminates the shape it was handed and answers
 *     NaN for any object, so `substring(new Array(), new Boolean(1))` read
 *     `0, 0` (→ `""`) instead of `0, 1` (→ `"f"`) and a user `valueOf` was
 *     never called at all. Both sites now emit the canonical
 *     `__to_primitive(v,"number")` + `__unbox_number` pair
 *     (tonumber-fast-paths.ts), which early-outs on an already-primitive value
 *     — so a number/string/boolean argument is unchanged.
 *
 * The order group below is not decoration: making the position coercion able to
 * run user code made its EMISSION POINT observable, and the first measured pass
 * regressed `indexOf`/`lastIndexOf` `A4_T4`/`A4_T5` (they assert which of two
 * throwing coercions wins). Those cases pin the splice/defer fix.
 *
 * Harness note, inherited from the #4439 suite: compile as JAVASCRIPT
 * (`allowJs` + a `.js` fileName). The borrowed-method shapes lower differently
 * in the TypeScript lane, so a TS-worded version would assert nothing about the
 * code under test. Each case is a COMPLETE source (not an expression spliced
 * into a wrapper) because these bodies need statements, and `f` carries an
 * explicit return annotation so the implicit-any diagnostic does not mask a
 * real failure as a compile error.
 *
 * The `it.fails` block at the bottom pins the four residual root causes this
 * issue measured but deliberately did not fix — see `## Residuals` in
 * plan/issues/4465-string-proto-generic-receiver-coercion.md. They are
 * executable, so each pin FAILS (and the residual gets closed) the day someone
 * fixes the cause.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4465.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  // Standalone means standalone: no host bridge may leak in behind these arms.
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/** Wrap a statement body as the exported `f`, returning 1 on success. */
function prog(body: string): string {
  return `/** @returns {number} */\nexport function f() {\n${body}\n}`;
}

describe("#4465 G1 — a RegExp receiver goes through §22.2.6.14, not [object Object]", () => {
  it.each([
    // The four failing test262 rows, one per case-conversion member.
    [
      "toLowerCase",
      `var r = new RegExp("ABC"); r.toLowerCase = String.prototype.toLowerCase;
       return r.toLowerCase() === "/abc/" ? 1 : 0;`,
    ],
    [
      "toUpperCase",
      `var r = new RegExp("abc"); r.toUpperCase = String.prototype.toUpperCase;
       return r.toUpperCase() === "/ABC/" ? 1 : 0;`,
    ],
    [
      "toLocaleLowerCase",
      `var r = new RegExp("ABC"); r.toLocaleLowerCase = String.prototype.toLocaleLowerCase;
       return r.toLocaleLowerCase() === "/abc/" ? 1 : 0;`,
    ],
    [
      "toLocaleUpperCase",
      `var r = new RegExp("abc"); r.toLocaleUpperCase = String.prototype.toLocaleUpperCase;
       return r.toLocaleUpperCase() === "/ABC/" ? 1 : 0;`,
    ],
    // The renderer reads the FLAGS field too — a flagged RegExp would still
    // read "/abc/" if the arm hardcoded an empty suffix.
    [
      "carries the flags, not just the source",
      `var r = new RegExp("abc", "gi"); r.toLowerCase = String.prototype.toLowerCase;
       return r.toLowerCase() === "/abc/gi" ? 1 : 0;`,
    ],
    // A DIFFERENT reflective body (the numeric-search family) — the arm lives
    // in the shared `emitStringProtoToStringFlat`, not in the case-conversion
    // body, so one member per family is what actually pins that.
    // `"/ab/".indexOf("b") === 2`.
    [
      "shared with the search family",
      `var r = new RegExp("ab"); r.indexOf = String.prototype.indexOf;
       return r.indexOf("b") === 2 ? 1 : 0;`,
    ],
    // NOTE on a spelling that is NOT here: the direct
    // `String.prototype.m.call(re)` form keeps a static receiver EXPRESSION and
    // was already served by `emitStandaloneRegExpToStringFromExpr`, so it
    // passes with or without this fix and would assert nothing.
  ])("%s", async (_label, body) => {
    expect(await runStandalone(prog(body))).toBe(1);
  });

  it("leaves a NON-RegExp receiver on the generic ToString walk", async () => {
    // The arm is a guarded `ref.test`, so an ordinary object receiver must
    // still reach its own `toString` — the no-collateral guard.
    const src = prog(`var o = { toString: function () { return "XY"; } };
      o.toLowerCase = String.prototype.toLowerCase;
      return o.toLowerCase() === "xy" ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4465 G2 — object-valued integer arguments run ToPrimitive(number)", () => {
  it.each([
    // S15.5.4.15_A3_T11 verbatim: new Array() → "" → 0, new Boolean(1) → 1,
    // receiver `new Boolean()` → "false", so [0,1) is "f".
    [
      "substring bounds",
      `var i = new Boolean(); i.substring = String.prototype.substring;
       return i.substring(new Array(), new Boolean(1)) === "f" ? 1 : 0;`,
    ],
    [
      "slice bounds",
      `var i = new Boolean(); i.slice = String.prototype.slice;
       return i.slice(new Array(), new Boolean(1)) === "f" ? 1 : 0;`,
    ],
    // A user valueOf is what ToPrimitive(number) is FOR. "false".substring(1,3).
    [
      "substring bounds with a user valueOf",
      `var i = new Boolean(); i.substring = String.prototype.substring;
       var lo = { valueOf: function () { return 1; } };
       var hi = { valueOf: function () { return 3; } };
       return i.substring(lo, hi) === "al" ? 1 : 0;`,
    ],
    // "false".charAt(2) === "l".
    [
      "charAt position with a user valueOf",
      `var i = new Boolean(); i.charAt = String.prototype.charAt;
       var p = { valueOf: function () { return 2; } };
       return i.charAt(p) === "l" ? 1 : 0;`,
    ],
    // "false".indexOf("s", 1) === 3 — the search family shares the arg path.
    [
      "indexOf position with a user valueOf",
      `var i = new Boolean(); i.indexOf = String.prototype.indexOf;
       var p = { valueOf: function () { return 1; } };
       return i.indexOf("s", p) === 3 ? 1 : 0;`,
    ],
  ])("%s", async (_label, body) => {
    expect(await runStandalone(prog(body))).toBe(1);
  });

  it("keeps primitive arguments equivalent (ToPrimitive early-outs on them)", async () => {
    const src = prog(`var i = new Boolean(true);
      i.substring = String.prototype.substring;
      i.charAt = String.prototype.charAt;
      return (i.substring(1, 3) === "ru" && i.charAt(0) === "t" && i.substring(2) === "ue") ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  it("propagates an abrupt completion out of an argument's valueOf", async () => {
    // §7.1.1 is `? ToPrimitive` — a throwing valueOf is observable, and before
    // the fix it was never called at all.
    const src = prog(`var i = new Boolean(); i.substring = String.prototype.substring;
      var bad = { valueOf: function () { throw "boom"; } };
      try { i.substring(bad); return 0; }
      catch (e) { return e === "boom" ? 1 : 2; }`);
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4465 RC2b — the position coercion runs AFTER both ToStrings", () => {
  // S15.5.4.7_A4_T4 / S15.5.4.8_A4_T4 in miniature. Making the position
  // coercion able to throw made its emission point observable; emitting it in
  // the late-import prologue (where it had always been, harmlessly) regressed
  // these four rows in the first measured pass. §22.1.3.8 step order is
  // ToString(this) → ToString(searchString) → ToIntegerOrInfinity(position).
  it.each([
    ["indexOf", "indexOf"],
    ["lastIndexOf", "lastIndexOf"],
  ])("%s: the searchString's throw wins over the position's", async (_label, member) => {
    const src = prog(`var i = new Boolean(); i.m = String.prototype.${member};
      var needle = { toString: function () { throw "intostr"; } };
      var pos = { valueOf: function () { throw "intoint"; } };
      try { i.m(needle, pos); return 0; }
      catch (e) { return e === "intostr" ? 1 : 2; }`);
    expect(await runStandalone(src)).toBe(1);
  });

  it("charAt: the receiver's throw wins over the position's", async () => {
    const src = prog(`var o = { toString: function () { throw "recv"; } };
      o.charAt = String.prototype.charAt;
      var pos = { valueOf: function () { throw "pos"; } };
      try { o.charAt(pos); return 0; }
      catch (e) { return e === "recv" ? 1 : 2; }`);
    expect(await runStandalone(src)).toBe(1);
  });
});

describe("#4465 residuals — measured, NOT fixed (each pin fails when its cause is fixed)", () => {
  // R1 has NO executable pin here, deliberately. The cause is that
  // `registerModuleGlobal` seeds every externref module global with
  // `ref.null.extern` (src/codegen/module-global-registration.ts) while the
  // reflective closure ABI uses null as its "argument not passed" pad, so a
  // trailing `undefined` read from a not-yet-declared `var` is dropped
  // (test262 concat A1_T10 / A4_T1, replace A1_T2 / A1_T10 / A1_T9). It needs
  // TOP-LEVEL SCRIPT code — the reading statement in the module body, before
  // the `var` statement — and this harness compiles an exported function, in
  // which the local hoister seeds `undefined` explicitly (#737) and the bug
  // does not reproduce. Writing an `it.fails` that passes anyway would assert
  // the opposite of the finding; the five test262 rows are the pin, and
  // reproducing it here is part of R1's own follow-up.

  // R2. A function-constructor instance's OWN `this.toString = function(){}`
  // field is not reachable as a method: `i.toString()` dispatches to
  // Object.prototype.toString (the `propAccess.name.text === "toString"`
  // fallback in expressions/call-receiver-method.ts never consults the struct
  // field), and `__to_primitive` misses it too. Blocks test262 charAt A1.1,
  // charCodeAt A1.1, substring A3_T10, slice A3_T4.
  it.fails("R2: a ctor instance's own toString field is used by ToString(this)", async () => {
    const src = prog(`function F(v) { this.v = v; this.toString = function () { return this.v + ""; }; }
      var i = new F("hello");
      i.substring = String.prototype.substring;
      return i.substring(0, 3) === "hel" ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  // R3. An INHERITED `toString` (`Ctor.prototype = protoWithToString`) is not
  // found by `__to_primitive`'s OrdinaryToPrimitive probe. Blocks test262
  // trim/15.5.4.20-2-43.
  it.fails("R3: an inherited toString is found by ToString(this)", async () => {
    const src = prog(`var proto = { toString: function () { return "abc"; } };
      var Con = function () {};
      Con.prototype = proto;
      return String.prototype.trim.call(new Con()) === "abc" ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });

  // R4. The reflective `split` body has no RegExp separator lane — it only does
  // ToString(separator), unlike #4439's two-lane match/search dispatch. Blocks
  // test262 split/argument-is-regexp-and-instance-is-number, and (same missing
  // lane) the two declined replace compile errors A1_T5 / A1_T6.
  it.fails("R4: a reflective split accepts a RegExp separator", async () => {
    const src = prog(`var o = new Object(1011);
      o.split = String.prototype.split;
      var parts = o.split(/0/);
      return (parts.length === 2 && parts[0] === "1" && parts[1] === "11") ? 1 : 0;`);
    expect(await runStandalone(src)).toBe(1);
  });
});
