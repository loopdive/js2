// #4492 wave-5 — ToString / ToPrimitive on CALLABLE and BOXED-WRAPPER receivers
// in `--target standalone`.
//
// Four families, all measured failing on the campaign branch point `c42bdbe3e`
// by reverting this change-set's source files in the same worktree:
//
//  1. `Function.prototype.toString` / `Object.prototype.valueOf` had no
//     reflective body at all — reading either as a VALUE minted the #2984
//     Phase-2 "degrade to a catchable TypeError" closure, so a borrowed
//     `String.prototype.<m>` on a function receiver threw
//     "…is not yet implemented in --target standalone" instead of coercing.
//  2. ToString of a CALLABLE answered `"[object Object]"` for every dynamic
//     spelling (`String(f)`, `` `${f}` ``) while `f.toString()` and `"" + f`
//     answered correctly — one value, four renderings.
//  3. A `toString`/`valueOf` reachable only through the PROTOTYPE at runtime was
//     invisible to every compile-time dispatcher.
//  4. A boxed wrapper's `[[PrimitiveValue]]` short-circuit ran BEFORE the
//     §7.1.1.1 method walk, so an own `valueOf` on `new String(…)` could never
//     be observed — while `.length`, which genuinely must ignore that override,
//     was reading the same short-circuit and had to be moved off it.
//
// Every pin EXECUTES the operation it guards (a pin that only asserts a shape
// cannot fail for the reason it exists), and every expected value is built by a
// LOOP so no compile-time fold can answer the comparison without running the
// coercion under test.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const OPTS = {
  target: "standalone",
  allowJs: true,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
  hostBridge: "always",
  fileName: "test.ts",
} as const;

/** Compile `body` as a standalone module and run its exported `test()`. */
async function runStandalone(body: string): Promise<number> {
  const result: any = await compile(`export function test(): any { ${body} }`, OPTS as any);
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as any).test();
}

/**
 * Build `text` one character at a time through a loop-carried accumulator, so
 * the expected value is NOT a syntactic literal the peephole/fold could match
 * against the coercion's own constant. `chars` is a plain array literal, which
 * the fold cannot collapse into a string without running the loop.
 */
function loopBuilt(name: string, text: string): string {
  const chars = [...text].map((c) => JSON.stringify(c)).join(", ");
  return `var ${name} = ""; var ${name}__c = [${chars}]; for (var ${name}__i = 0; ${name}__i < ${name}__c.length; ${name}__i++) { ${name} = ${name} + ${name}__c[${name}__i]; }`;
}

describe("#4492 wave-5 — Function.prototype.toString / Object.prototype.valueOf as VALUES", () => {
  it("`Function.prototype.toString.call(f)` returns a string instead of throwing", async () => {
    // Base: TypeError "Function.prototype.toString is not yet implemented in
    // --target standalone" — the refusal that gated
    // built-ins/String/prototype/{slice,substring}/…_A1_T5.
    expect(
      await runStandalone(
        `function f() {} var g = Function.prototype.toString; var s = g.call(f);` +
          ` return (typeof s === "string" && s.length > 0) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  // GUARD (passes on BOTH arms by design — see the note above the residuals):
  // the base threw the "not yet implemented" refusal here, and the fix must
  // keep throwing, just for the spec reason instead.
  it("§20.2.3.5 step 4 — a NON-callable `this` still throws a TypeError", async () => {
    // The refusal must not be traded for a silent wrong answer in the other
    // direction: wiring the body may not make `…toString.call({})` return a string.
    expect(
      await runStandalone(
        `var threw = 0; var g = Function.prototype.toString;` +
          ` try { g.call({}); } catch (e) { threw = (e instanceof TypeError) ? 1 : 2; }` +
          ` return threw;`,
      ),
    ).toBe(1);
  });

  it("`Object.prototype.valueOf.call(o)` is the receiver, not a refusal", async () => {
    // §20.1.3.7 `return ? ToObject(this value)`. Base: TypeError
    // "Object.prototype.valueOf is not yet implemented in --target standalone".
    expect(
      await runStandalone(`var o = { a: 1 }; var g = Object.prototype.valueOf; return g.call(o) === o ? 1 : 0;`),
    ).toBe(1);
  });

  // GUARD (passes on both arms), same reason as the one above.
  it("§7.1.18 — `Object.prototype.valueOf` on a nullish `this` throws a TypeError", async () => {
    expect(
      await runStandalone(
        `var threw = 0; var g = Object.prototype.valueOf;` +
          ` try { g.call(null); } catch (e) { threw = (e instanceof TypeError) ? 1 : 2; }` +
          ` return threw;`,
      ),
    ).toBe(1);
  });
});

describe("#4492 wave-5 — ToString of a CALLABLE (§20.2.3.5, never Object.prototype.toString)", () => {
  it("`String(f)` honours an OWN toString on the function object", async () => {
    // Base: "[object Object]". `"" + f` was already right, which is what hid it.
    expect(
      await runStandalone(
        `${loopBuilt("want", "OWN_F_TS")}` +
          ` function f() {} f.toString = function () { return "OWN_F_TS"; };` +
          ` return String(f) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("a TEMPLATE substitution honours the same own toString", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "OWN_F_TS")}` +
          ` function f() {} f.toString = function () { return "OWN_F_TS"; };` +
          " return `${f}` === want ? 1 : 0;",
      ),
    ).toBe(1);
  });

  it("`String(f)` honours a `Function.prototype.toString` override (test262 S15.5.2.1_A1_T8)", async () => {
    // The override lands on the runtime prototype chain, where no compile-time
    // per-struct dispatcher can see it; `__extern_get` walks it.
    expect(
      await runStandalone(
        `${loopBuilt("want", "SHIFTED")}` +
          ` Function.prototype.toString = function () { return "SHIFTED"; };` +
          ` var f = function () {}; return String(f) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("§7.1.1.1 — an object-returning own toString falls through to own valueOf (S15.5.2.1_A1_T11)", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "true")}` +
          ` function obj() {} obj.valueOf = function () { return true; }; obj.toString = function () { return {}; };` +
          ` return String(obj) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  // NOTE — a `String(<plain function with no override>)` pin was written here and
  // REMOVED after the base run: it PASSED on the reverted tree, so it could not
  // fail for the reason it exists. In a module this small the receiver compiles
  // to an externref and reaches `__extern_toString`'s closure arm, which already
  // answered the NativeFunction form; the `[object Object]` measured in
  // `.tmp/probes/t6.js` needed the receiver to stay a concrete closure-struct
  // ref. Keeping it would have been a green assertion about the code rather than
  // a test of it.
});

describe("#4492 wave-5 — a PROTOTYPE-installed toString reaches the runtime ToPrimitive walk", () => {
  it("`Function.prototype.toString = …` is honoured through the EXTERNREF dispatcher too", async () => {
    // The `__extern_toString` twin of the `String(f)` override pin above: inside
    // an exported function the receiver compiles to an externref, so the #3540
    // closure arm claimed it and answered the NativeFunction constant. Measured
    // on base: length 29 ("function () { [native code] }") instead of 7.
    expect(
      await runStandalone(
        `${loopBuilt("want", "SHIFTED")}` +
          ` Function.prototype.toString = function () { return "SHIFTED"; };` +
          ` var f = function () {}; var s = String(f);` +
          ` return (s === want && s.length === 7) ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

describe("#4492 wave-5 — an OWN valueOf/toString shadows a wrapper's [[PrimitiveValue]]", () => {
  it("`new String(x) == …` observes an own valueOf (test262 S15.5.5.1_A5)", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "ed")}` +
          ` var s = new String("ABCABC"); s.valueOf = function () { return "ed"; };` +
          ` s.toString = function () { return "ed"; };` +
          ` return (s == want) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it('`"" + new String(x)` observes the same own valueOf', async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "ed")}` +
          ` var s = new String("ABCABC"); s.valueOf = function () { return "ed"; };` +
          ` return (("" + s) === want) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  // REGRESSION GUARD for the fix above (passes on both arms by construction —
  // it is the one this change-set was measured BREAKING mid-development).
  it("…but §22.1.4.1 `.length` still reads [[StringData]], NOT the override", async () => {
    // The regression guard for the fix above: `.length` used to be spelled as
    // `__to_primitive(recv, "string")`, and the moment ToPrimitive started
    // honouring the override, `new String("ABCABC").length` became 2. It is now
    // the bare `__wrapper_string_value` slot probe.
    expect(
      await runStandalone(
        `var n = 0; var s = new String("ABCABC");` +
          ` for (var i = 0; i < 1; i++) { s.valueOf = function () { return "ed"; }; s.toString = function () { return "ed"; }; }` +
          ` n = s.length; return n === 6 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("…and the String-exotic INDEX read is likewise unmoved by the override", async () => {
    // §10.4.3.5 StringGetOwnProperty reads [[StringData]] too; it shared the
    // same `__to_primitive` spelling and had to move with `.length`.
    expect(
      await runStandalone(
        `var s = new String("ABCABC"); s.toString = function () { return "ed"; };` +
          ` var got = ""; for (var i = 0; i < 3; i++) { got = got + s[i]; }` +
          ` ${loopBuilt("want", "ABC")} return got === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("a wrapper with NO override still reduces through its internal slot", async () => {
    // The gate must not cost the common case its answer.
    expect(
      await runStandalone(
        `var s = new String("XYZ"); var n = new Number(7); var b = new Boolean(true);` +
          ` ${loopBuilt("want", "XYZ")}` +
          ` return ((s == want) && (n == 7) && (b == true) && (n + 1) === 8 && s.length === 3) ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

// ── Measured RESIDUALS ───────────────────────────────────────────────────────
// Each of these still fails ON THIS CHANGE-SET and is recorded with its owner in
// `plan/issues/4492-es5-builtin-proto-exotic-receivers.md` (wave-5 results).
//
// Every POSITIVE pin above (except the three marked GUARD / REGRESSION GUARD)
// was verified failing on the branch point `c42bdbe3e` by checking out this
// change-set's six touched source files at that commit in the same worktree and
// re-running this file: 10 of them failed, log kept at `.tmp/pins-base-KEEP.log`.
// A pin nobody has seen fail is an assertion about the code, not a test of it.
describe("#4492 wave-5 — measured residuals", () => {
  it.fails("`String(new Array)` ignores an `Array.prototype.toString` override (test262 S15.5.1.1_A1_T8)", async () => {
    // Owner: #4556 bucket A / the `builtin-proto-member-override.ts` two-arm,
    // which today is wired only for Array METHOD CALLS, not for the ToString
    // coercion site. `String(<array>)` folds to the native join before any
    // consult of the #4176 companion the override was written to.
    //
    // The receiver spelling is load-bearing and was corrected after the base
    // run: with `var a = [1, 2]` this same assertion PASSES on both arms (the
    // literal's own dynamic index reads arm the module differently), so it would
    // have been a residual pin that is not a residual. `new Array` is the
    // census row's own spelling.
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")}` +
          ` Array.prototype.toString = function () { return "__ARRAY__"; };` +
          ` return String(new Array) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails(
    "`String(new F())` misses `F.prototype.toString` when the whole program is inside one function",
    async () => {
      // The `__class_to_primitive` runtime tail DOES fix this family — measured by
      // reverting `class-to-primitive.ts` alone, which flips `.tmp/probes/t3.js`
      // A-String and A-slice back to "[object Object]" — but only in a module
      // where the fnctor instance actually acquired a `$proto` link. Inside a
      // single exported function it stays a closed nominal struct with no chain
      // for `__extern_get` to walk, and adding a `"toString" in inst` (which flips
      // the whole module at test262 top level) does NOT help here.
      //
      // Owner: #2660 S3 / #2175 — the fnctor escape gate decides the receiver's
      // representation, and that decision is upstream of everything this
      // change-set touches. Same root as the unflipped census row
      // `built-ins/String/prototype/slice/S15.5.4.13_A3_T4`.
      expect(
        await runStandalone(
          `${loopBuilt("want", "v7")}` +
            ` function F(v) { this.value = v; } F.prototype.toString = function () { return "v" + this.value; };` +
            ` var inst = new F(7); var seen = "toString" in inst;` +
            ` return (seen && String(inst) === want) ? 1 : 0;`,
        ),
      ).toBe(1);
    },
  );

  it.fails("the DYNAMIC ToString of `Math` is not the §20.1.3.6 `[object Math]` tag", async () => {
    // `Object.prototype.toString.call(Math)` is already right (#4491 wave-5 T1,
    // a compile-time tag); the runtime `__any_to_string` terminal has no brand
    // classifier, so `String(Math)` answers "[object Object]". Owner: #4492
    // residual — needs the §20.1.3.6 classifier reachable from the terminal.
    expect(await runStandalone(`${loopBuilt("want", "[object Math]")} return String(Math) === want ? 1 : 0;`)).toBe(1);
  });

  it.fails("`String(new String(x))` ignores an own toString on the wrapper", async () => {
    // `String(<String wrapper>)` is lowered as the [[StringData]] coercion
    // (`__wrapper_string_value`), not as §7.1.17 → ToPrimitive, so the own
    // method is bypassed at that ONE spelling while `==` and `+` now honour it.
    // Owner: #4492 residual.
    expect(
      await runStandalone(
        `${loopBuilt("want", "ed")}` +
          ` var s = new String("ABCABC"); s.toString = function () { return "ed"; };` +
          ` return String(s) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});
