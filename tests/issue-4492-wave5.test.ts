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

describe("#4492 residual — builtin carriers observe transferred toString", () => {
  it("Array constructor uses Object.prototype.toString after Function prototype transfer", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "[object Function]")}` +
          ` Function.prototype.toString = Object.prototype.toString;` +
          ` var got = Array.toString(); return got === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("a RegExp own toString transfer observes the RegExp brand", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "[object RegExp]")}` +
          ` var re = new RegExp(); re.toString = Object.prototype.toString;` +
          ` var got = re.toString(); return got === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });
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
// was verified failing on the base arm by checking this change-set's touched
// source files out at the merge-base and re-running this file in the same
// worktree. A pin nobody has seen fail is an assertion about the code, not a
// test of it.
// Every `it.fails` below is paired with POSITIVE CONTROLS that must pass, chosen
// so this suite claims the SPECIFIC root rather than the general area (brief
// methodology 8). Each control was measured in its OWN single-purpose module —
// every one of these behaviours is module-sensitive, so a control read off a
// multi-case probe attributes the wrong cause.
describe("#4492 wave-5 — residual R1: an Array.prototype.toString override and the INLINE receiver", () => {
  // MEASURED RULE (this is a correction — see below): the deciding axis is the
  // RECEIVER SPELLING at the `String(...)` call, not the array's contents and
  // not "the ToString site never consults the override".
  //
  //   | receiver            | `String(x)` | `x.toString()` | `"" + x` |
  //   | `new Array` inline  | ✗           | —              | —        |
  //   | `[]` inline         | ✗           | —              | —        |
  //   | `[1, 2]` inline     | ✗           | —              | —        |
  //   | `var a = new Array` | ✓           | ✓              | ✗        |
  //   | `var a = [1, 2]`    | ✓           | —              | —        |
  //
  // Axes VARIED: receiver spelling (inline `new Array` / inline literal /
  // named var), array emptiness, operation (`String`, method call, `+`).
  // Axes held FIXED: `--target standalone`, the override installed at the top
  // of the same exported function, one exported function per module.
  //
  // CORRECTION to this file's first cut: it attributed the var form's success
  // to "the literal's own dynamic index reads arm the module differently".
  // Refuted — `var a = [1, 2]; String(a)` has no index read at all and still
  // passes, and `var a = new Array; String(a)` passes with no literal. Naming
  // the receiver is what changes the answer.
  //
  // SUSPECTED mechanism (NOT established): an inline array-typed receiver keeps
  // a concrete vec struct that the compile-time array→string lowering claims
  // before `__any_to_string`'s runtime consult is reachable; a named binding
  // widens it to externref. A WAT read did not settle this (the emitted names
  // are numeric), so it is recorded as a hypothesis.
  //
  // Owner: #4556 bucket A / `builtin-proto-member-override.ts` — the override
  // two-arm is wired for Array METHOD CALLS, and the coercion sites are the gap.
  // Census row: `built-ins/String/S15.5.1.1_A1_T8` (uses the inline spelling).

  it("CONTROL — a NAMED array receiver DOES honour the override", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")}` +
          ` Array.prototype.toString = function () { return "__ARRAY__"; };` +
          ` var a = new Array; return String(a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("CONTROL — a direct `a.toString()` on a named array honours it too", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")}` +
          ` Array.prototype.toString = function () { return "__ARRAY__"; };` +
          ` var a = new Array; return a.toString() === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails("`String(new Array)` — INLINE receiver ignores it (test262 S15.5.1.1_A1_T8)", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")}` +
          ` Array.prototype.toString = function () { return "__ARRAY__"; };` +
          ` return String(new Array) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails("`String([1, 2])` — an inline LITERAL receiver ignores it as well", async () => {
    // Pins the emptiness axis: the inline miss is not about `new Array` being
    // empty, so a fix that special-cases the empty vec does not close this.
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")}` +
          ` Array.prototype.toString = function () { return "__ARRAY__"; };` +
          ` return String([1, 2]) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it('`"" + a` honours the override with a NAMED receiver (FIXED by #4663)', async () => {
    // Was the SECOND residual, separable from the inline one: the `+` path
    // reaches `__to_primitive`'s vec arm (`array-to-primitive.ts`), whose whole
    // body was a hard-coded `join(",")` with no prototype consult. #4663 added
    // the gated Array-companion consult; full coverage in tests/issue-4663.test.ts.
    expect(
      await runStandalone(
        `${loopBuilt("want", "__ARRAY__")}` +
          ` Array.prototype.toString = function () { return "__ARRAY__"; };` +
          ` var a = new Array; return ("" + a) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

describe("#4492 wave-5 — residual R2: `F.prototype.toString` is unreachable FROM the instance", () => {
  // CORRECTION of this file's first cut, which said the fnctor instance "stays a
  // closed nominal struct with no chain for `__extern_get` to walk". Refuted by
  // the controls below: the prototype object carries the override, it is
  // callable, and `Object.getPrototypeOf(inst)` returns it. What is missing is
  // the instance→prototype edge that the RUNTIME property walk uses — which is
  // exactly the edge `__class_to_primitive`'s new tail asks `__extern_get` for.
  //
  // Measured, one module each: `"toString" in F.prototype` ✓, `typeof
  // F.prototype[k] === "function"` ✓, `F.prototype[k].call({value: 7}) === "v7"`
  // ✓, `hasOwnProperty` ✓, `Object.getPrototypeOf(inst) === F.prototype` ✓ —
  // but `"toString" in inst` ✗ and `inst[k]()` answers neither "v7" nor the
  // `[object Object]` tag. `inst.toString()` ✓ only because that spelling is a
  // COMPILE-TIME member dispatch that never consults the runtime chain.
  //
  // Owner: #2660 S3 / #2175 (fnctor instance representation). Same root as the
  // unflipped census row `built-ins/String/prototype/slice/S15.5.4.13_A3_T4`.
  const F_SETUP = ` function F(v) { this.value = v; } F.prototype.toString = function () { return "v" + this.value; };`;
  const KEY = `var k = ""; var kc = ["t","o","S","t","r","i","n","g"]; for (var ki = 0; ki < kc.length; ki++) { k = k + kc[ki]; }`;

  it("CONTROL — the PROTOTYPE object carries the override and it is callable", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "v7")} ${KEY}${F_SETUP}` +
          ` var p = F.prototype;` +
          ` return ((k in p) && typeof p[k] === "function" && p[k].call({ value: 7 }) === want) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("CONTROL — the instance's prototype LINK is the right object", async () => {
    expect(
      await runStandalone(
        `${F_SETUP} var inst = new F(7); return Object.getPrototypeOf(inst) === F.prototype ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("CONTROL — the compile-time member dispatch `inst.toString()` is correct", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "v7")}${F_SETUP} var inst = new F(7); return inst.toString() === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails('a RUNTIME lookup from the instance misses it — `"toString" in inst`', async () => {
    expect(await runStandalone(`${KEY}${F_SETUP} var inst = new F(7); return (k in inst) ? 1 : 0;`)).toBe(1);
  });

  it.fails("…so `String(new F())` cannot see it either", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "v7")}${F_SETUP} var inst = new F(7); return String(inst) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

describe("#4492 wave-5 — residual R3: no §20.1.3.6 brand classifier on the RUNTIME ToString terminal", () => {
  // The compile-time tag is right and every runtime coercion spelling is wrong,
  // which is what makes "the terminal has no brand classifier" the root rather
  // than "`Math` is untagged".
  it("CONTROL — `Object.prototype.toString.call(Math)` IS `[object Math]`", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "[object Math]")} return Object.prototype.toString.call(Math) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails("`String(Math)` is not", async () => {
    expect(await runStandalone(`${loopBuilt("want", "[object Math]")} return String(Math) === want ? 1 : 0;`)).toBe(1);
  });

  it.fails('`"" + Math` is not either — the miss is the terminal, not one call site', async () => {
    expect(
      await runStandalone(`${loopBuilt("want", "[object Math]")} var m = Math; return ("" + m) === want ? 1 : 0;`),
    ).toBe(1);
  });

  // Two more census rows reduce to this SAME missing classifier. Both were
  // probed, not inferred: each has the identical signature (compile-time tag
  // right, the other spelling wrong), which is what makes them one cluster.

  it("CONTROL — the ARGUMENTS object's compile-time tag is `[object Arguments]`", async () => {
    expect(
      await runStandalone(
        `${loopBuilt("want", "[object Arguments]")}` +
          ` var argObj = function () { return arguments; }(1, 2, true);` +
          ` return Object.prototype.toString.call(argObj) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("`String(<arguments>)` observes the Arguments tag (test262 trim/15.5.4.20-2-51)", async () => {
    // The census row is `String.prototype.trim.call(argObj)`; both spellings
    // must apply ordinary ToString to the Arguments carrier, not Array.join.
    expect(
      await runStandalone(
        `${loopBuilt("want", "[object Arguments]")}` +
          ` var argObj = function () { return arguments; }(1, 2, true);` +
          ` return String(argObj) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("CONTROL — `Object.prototype.toString.call(Number.prototype)` IS `[object Number]`", async () => {
    // Written as a NAME, the brand is resolved at compile time and is correct —
    // so the row below is not "Number.prototype is untagged".
    expect(
      await runStandalone(
        `${loopBuilt("want", "[object Number]")} return Object.prototype.toString.call(Number.prototype) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it.fails("…but the SAME object obtained via `Object.getPrototypeOf` is not (test262 Number/15.7.4-1)", async () => {
    // Identical receiver, runtime-only provenance: the classifier the
    // compile-time site uses is unavailable, and nothing answers at runtime.
    expect(
      await runStandalone(
        `${loopBuilt("want", "[object Number]")}` +
          ` var np = Object.getPrototypeOf(new Number(42));` +
          ` return Object.prototype.toString.call(np) === want ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});

describe("#4492 wave-5 — residual R4: the ONE `String(<wrapper>)` spelling bypasses ToPrimitive", () => {
  // Negative case probed first: the own method IS reachable — `s.toString()`,
  // `==`, `"" + s` and a template substitution all answer "ed" after this
  // change-set. Only `String(s)` does not, because that spelling is lowered as
  // the [[StringData]] coercion (`__wrapper_string_value`) rather than §7.1.17 →
  // ToPrimitive. Owner: #4492 residual.
  const SETUP = ` var s = new String("ABCABC"); s.valueOf = function () { return "ed"; }; s.toString = function () { return "ed"; };`;

  it("CONTROL — `s.toString()` answers the own method", async () => {
    expect(await runStandalone(`${loopBuilt("want", "ed")}${SETUP} return s.toString() === want ? 1 : 0;`)).toBe(1);
  });

  it("CONTROL — a template substitution answers it", async () => {
    expect(await runStandalone(`${loopBuilt("want", "ed")}${SETUP} return \`\${s}\` === want ? 1 : 0;`)).toBe(1);
  });

  it.fails("`String(new String(x))` does not", async () => {
    expect(await runStandalone(`${loopBuilt("want", "ed")}${SETUP} return String(s) === want ? 1 : 0;`)).toBe(1);
  });
});
