// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4619 family D — `<wrapper>.toString()` under `--target standalone`.
 *
 * ## What the measurement found (and how it differs from the issue text)
 *
 * #4619 filed these rows as "wrapper-method VALUE calls": read the method off
 * the prototype, then call the read value. The failing rows do not do that.
 * `built-ins/Boolean/prototype/toString/S15.6.4.2_A1_T1`,
 * `built-ins/Number/prototype/toString/S15.7.4.2_A1_T01` and
 * `language/expressions/property-accessors/S11.2.1_A3_T1` call
 * `<wrapper>.toString()` and `<Builtin>.prototype.toString()` DIRECTLY, and on
 * base every one of them reported `TypeError: called value is not a function`
 * while the `valueOf` twin already passed.
 *
 * ## The `STA` half of every case is the whole point
 *
 * The wrapper call only goes DYNAMIC when the module assigns
 * `<anything>.toString` somewhere — #1397's `sourceHasMethodReassignment`, a
 * whole-file scan. In test262 that condition is universal, because `sta.js`,
 * prepended to every file in the corpus, contains
 * `Test262Error.prototype.toString = function () {…}`. A plain vitest module
 * has no such line, takes the STATIC path instead, and **passed on base** for
 * most of these shapes — so a pin written without it would be vacuous.
 *
 * Every case is therefore compiled twice. The base/after matrix, measured by
 * A/B file-copy on this branch (`-N` = a thrown Error whose message is N
 * chars; 30 = "called value is not a function", 71/72 = the member's
 * "not yet implemented" refusal):
 *
 * | case                       | base plain | base STA | after |
 * | -------------------------- | ---------- | -------- | ----- |
 * | `new Boolean(true).toString()` | 1      | −30      | 1     |
 * | `new Number(0).toString()`     | 1      | −30      | 1     |
 * | `new String("ab").toString()`  | 1      | −30      | 1     |
 * | `Boolean.prototype.toString()` | 1      | −30      | 1     |
 * | `var NP = Number.prototype; NP.toString()` | 1 | −71 | 1 |
 * | `Boolean.prototype.toString.call(true)`    | 0 | 0  | 1     |
 * | `o.g = Boolean.prototype.toString; o.g()`  | −72 | −72 | 1   |
 * | `Number.prototype.toString.call(new String("x"))` | no throw | no throw | TypeError |
 *
 * The last row is the one that would be easiest to lose: on base the brand
 * mismatch did not throw at ALL (§21.1.3.6 step 1 → §21.1.3.7 step 3 requires
 * a TypeError), so the body's brand check is load-bearing, not decoration.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, fn = "f"): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4619.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary as BufferSource);
  // Standalone means standalone — no host bridge may leak in behind these arms.
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { exports } = await WebAssembly.instantiate(mod, {});
  return (exports as Record<string, () => unknown>)[fn]!();
}

/** The `sta.js` condition: ONE unrelated `.toString` assignment. */
const STA = `function T262(){}\nT262.prototype.toString = function(){ return "T262"; };\n`;

/** Wrap a statement body as the exported `f`, in one of the two module shapes. */
function prog(body: string, withSta: boolean): string {
  return `${withSta ? STA : ""}/** @returns {number} */\nexport function f() {\n${body}\n}`;
}

/**
 * Run `body` in BOTH module shapes. A throw is reported as `-<message.length>`
 * so a regression names WHICH error came back rather than collapsing every
 * failure to "threw".
 */
async function bothLanes(body: string): Promise<{ plain: unknown; sta: unknown }> {
  const guarded = `try {\n${body}\n} catch (e) { return -e.message.length; }`;
  return {
    plain: await runStandalone(prog(guarded, false)),
    sta: await runStandalone(prog(guarded, true)),
  };
}

describe("#4619 D1 — wrapper-object receiver", () => {
  it('new Boolean(true).toString() is "true" (S15.6.4.2_A1_T1 shape)', async () => {
    const r = await bothLanes(`var b = new Boolean(true);\nreturn b.toString() === "true" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it('new Number(0).toString() is "0" (S15.7.4.2_A1_T01)', async () => {
    const r = await bothLanes(`var n = new Number(0);\nreturn n.toString() === "0" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it('new Number(NaN).toString() is "NaN"', async () => {
    const r = await bothLanes(`var n = new Number(NaN);\nreturn n.toString() === "NaN" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it('new String("ab").toString() is "ab"', async () => {
    const r = await bothLanes(`var s = new String("ab");\nreturn s.toString() === "ab" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it("the radix argument survives the dynamic route", async () => {
    const r = await bothLanes(`var n = new Number(255);\nreturn n.toString(16) === "ff" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });
});

describe("#4619 D2 — the prototype object is an instance of its own type", () => {
  // §20.3.3 / §21.1.3 / §22.1.3: `<Brand>.prototype` carries the brand's own
  // [[…Data]] slot, so these are constants, not TypeErrors. This is arm 3 of the
  // shared `this<X>Value` ladder, and the arm whose `$NativeProto` type must be
  // REGISTERED (not merely read) for it to exist at all — see the module note
  // in wrapper-proto-value-of.ts.
  it('Boolean.prototype.toString() is "false"', async () => {
    const r = await bothLanes(`return Boolean.prototype.toString() === "false" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it('Number.prototype.toString() is "0"', async () => {
    const r = await bothLanes(`return Number.prototype.toString() === "0" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it('String.prototype.toString() is ""', async () => {
    const r = await bothLanes(`return String.prototype.toString() === "" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it("…and through a binding, which is the ordering control", async () => {
    // `var NP = Number.prototype` MATERIALIZES the prototype before the call is
    // compiled, so it registers `$NativeProto` as a side effect. The inline
    // spelling above does not. Base answered "0" here and threw there — one
    // expression, two answers, purely from emission order. Keeping both in the
    // suite is what would catch that regressing again.
    const r = await bothLanes(`var NP = Number.prototype;\nreturn NP.toString() === "0" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });
});

describe("#4619 D3 — the VALUE call the issue predicted", () => {
  // These two assert the STA shape ONLY — the corpus condition, and the one
  // this issue moved (base 0 → after 1). The plain shape is unchanged at 0 and
  // is pinned as residual R4 below rather than asserted here, because 0 is a
  // wrong answer and an expectation that spells it out reads as an endorsement.
  it('Boolean.prototype.toString.call(true) is "true"', async () => {
    // `lib.es5.d.ts` declares no `toString` on `interface Boolean`, so the
    // receiver's SYMBOL is Object's; the syntactic spelling is what resolves
    // this to the Boolean brand.
    const body = `try { return Boolean.prototype.toString.call(true) === "true" ? 1 : 0; } catch (e) { return -e.message.length; }`;
    expect(await runStandalone(prog(body, true))).toBe(1);
  });

  it('Number.prototype.toString.call(9) is "9"', async () => {
    const body = `try { return Number.prototype.toString.call(9) === "9" ? 1 : 0; } catch (e) { return -e.message.length; }`;
    expect(await runStandalone(prog(body, true))).toBe(1);
  });

  it("transferred onto a wrapper's own slot (the ES5 genericity idiom)", async () => {
    const r = await bothLanes(
      `var o = new Boolean(true);\no.g = Boolean.prototype.toString;\nreturn o.g() === "true" ? 1 : 0;`,
    );
    expect(r).toEqual({ plain: 1, sta: 1 });
  });
});

describe("#4619 D4 — the brand check is not optional", () => {
  /** 1 = real TypeError, 2 = threw something else, 100 = did not throw. */
  const throwsTypeError = (body: string): string =>
    `try {\n${body}\nreturn 100;\n} catch (e) {\nreturn (e instanceof TypeError) ? 1 : 2;\n}`;

  it('Number.prototype.toString.call(new String("x")) throws a TypeError', async () => {
    // §21.1.3.6 step 1 → thisNumberValue → §21.1.3.7 step 3. The slot EXISTS on
    // the receiver but holds a string, so classifying the slot VALUE — not
    // merely finding the slot — is what makes this a throw. Base: no throw at
    // all, in both module shapes.
    const body = throwsTypeError(`var s = new String("x");\nNumber.prototype.toString.call(s);`);
    expect({
      plain: await runStandalone(prog(body, false)),
      sta: await runStandalone(prog(body, true)),
    }).toEqual({ plain: 1, sta: 1 });
  });

  it("a plain object receiver throws a TypeError", async () => {
    const body = throwsTypeError(`var o = {};\no.g = Number.prototype.toString;\no.g();`);
    expect({
      plain: await runStandalone(prog(body, false)),
      sta: await runStandalone(prog(body, true)),
    }).toEqual({ plain: 1, sta: 1 });
  });

  it("an out-of-range radix throws a RangeError (§21.1.3.6 step 4)", async () => {
    const body = `try {\nvar n = new Number(5);\nn.toString(1);\nreturn 100;\n} catch (e) {\nreturn (e instanceof RangeError) ? 1 : 2;\n}`;
    expect({
      plain: await runStandalone(prog(body, false)),
      sta: await runStandalone(prog(body, true)),
    }).toEqual({ plain: 1, sta: 1 });
  });

  it("an undefined radix means 10, NOT a RangeError (#3175's carve-out)", async () => {
    const r = await bothLanes(`var n = new Number(5);\nreturn n.toString(undefined) === "5" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });
});

describe("#4619 controls — the neighbours this must not move", () => {
  it("valueOf keeps its #4491/#4582 answers", async () => {
    const r = await bothLanes(
      `var b = new Boolean(true);\nvar n = new Number(7);\nreturn (b.valueOf() === true && n.valueOf() === 7) ? 1 : 0;`,
    );
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it("primitive receivers keep their existing (working) lowerings", async () => {
    const r = await bothLanes(
      `return (true.toString() === "true" && (5).toString() === "5" && (255).toString(16) === "ff" && "ab".toString() === "ab") ? 1 : 0;`,
    );
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it("Object.prototype.toString keeps the #2501 tag classifier", async () => {
    const r = await bothLanes(
      `var a = [1, 2];\nreturn Object.prototype.toString.call(a) === "[object Array]" ? 1 : 0;`,
    );
    expect(r).toEqual({ plain: 1, sta: 1 });
  });
});

describe("#4619 residuals (measured base==after, pinned so a later change cannot move them silently)", () => {
  it('R1 (CLOSED by #4625) — the element-access spelling `x["toString"]()`', async () => {
    // `language/expressions/property-accessors/S11.2.1_A3_T1` CHECK#2/#4 and
    // `_T2` CHECK#3/#4. On this issue's base and after, both threw the same
    // 43-char "Cannot access property on null or undefined": the static-key
    // ElementAccess callee has its own dispatch (call-tail-dispatch.ts) and
    // never reached the property-access route this issue fixed.
    //
    // #4625 found WHY it never reached it — `compileCallableElementAccessCall`
    // (#1306) claims the call because `interface Boolean` declares a callable
    // `toString`, then reads a value the compiler never materialises — and
    // normalised the ambient-member bracket spelling onto the property-access
    // route. Flipped positive there, in the same change, per this pin's design.
    const r = await bothLanes(`var b = new Boolean(false);\nreturn b["toString"]() === "false" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it.fails("R2 — an inherited member borrowed off a wrapper prototype", async () => {
    // `Boolean.prototype.hasOwnProperty.call(o, "k")` answers falsy — base AND
    // after, in both module shapes, so this issue neither fixed nor broke it.
    // Recorded because the syntactic-spelling override added here deliberately
    // does NOT claim inherited members, and this is the row that proves the
    // decline is not what makes it fail.
    const r = await bothLanes(`var o = { k: 1 };\nreturn Boolean.prototype.hasOwnProperty.call(o, "k") ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });

  it.fails("R4 — `<Brand>.prototype.<m>.call(…)` answers NULL in a module with no `.toString` install", async () => {
    // Base AND after: the value is null, and the `typeof` fold says `"string"`
    // over it — #4481's R2 masking trap, one level down. Only the PLAIN module
    // shape is affected; the corpus always carries `sta.js`, which is why the
    // test262 rows this issue fixed do not see it. Owner: standalone-gap,
    // unclaimed. Whoever takes it should start from WHICH arm claims the call
    // when `sourceHasMethodOverride` is false, not from the closure factory.
    const body = `try { return Boolean.prototype.toString.call(true) === "true" ? 1 : 0; } catch (e) { return -e.message.length; }`;
    expect(await runStandalone(prog(body, false))).toBe(1);
  });

  it.fails("R3 — a module with no `__typeof_<brand>` predicate keeps the refusal", async () => {
    // The `this<X>Value` ladder needs the brand predicate to classify a
    // receiver; a module that never reaches one declines the whole body and the
    // member keeps its catchable "not yet implemented" refusal (72 chars).
    // Measured: identical on base. Only the PLAIN shape is affected — the STA
    // shape passes — so the corpus, which always carries sta.js, never sees it.
    const r = await bothLanes(`var g = Boolean.prototype.toString;\nreturn g.call(true) === "true" ? 1 : 0;`);
    expect(r).toEqual({ plain: 1, sta: 1 });
  });
});
