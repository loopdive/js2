// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6485) `Array.prototype.concat` must perform `Get(E, @@isConcatSpreadable)`
// — §23.1.3.1 step 5.b via §23.1.3.1.1 — on `--target standalone`.
//
// The defect was ROUTING, not the spec loop: `compileArrayConcat` entered
// `array-concat-spec.ts` only behind `concatMustConsultPrototypeChain` or
// `arraySpeciesActive`, so a module that installs `@@isConcatSpreadable` on a
// STATICALLY ARRAY-TYPED operand kept the typed `array.copy` fast path, which
// spreads unconditionally and never reads the symbol. Measured on the base tree
// (`.tmp/6485/js/probe5.js`, standalone): `[1,2].concat(b)` with
// `b[Symbol.isConcatSpreadable] = false` answered length 4 where the spec says
// 3, and `c.concat()` with a non-spreadable receiver answered 2 where the spec
// says 1.
//
// Every probe below is a SLOPPY script that throws when an assertion fails, so
// "the module ran to completion" is the assertion — the same contract a test262
// row uses. `arguments` needs sloppiness anyway (§10.2.11 step 22.a: a mapped
// arguments object exists only for a non-strict simple-parameter function).
//
// Each case gets its own `it()`: a bare wasm trap carries no JS-side message, so
// one combined script would report "something threw" and nothing more.
//
// The NEGATIVE direction (`@@isConcatSpreadable = false` must NOT spread) is
// load-bearing: a fix that always spreads passes every positive pin vacuously.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";

const OPTS = {
  fileName: "test.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
} as const;

/**
 * Compile a sloppy standalone script, assert it needs ZERO host imports, and run
 * its top-level code. Throws iff the script does.
 */
async function runScript(src: string): Promise<void> {
  const r = await compile(src, OPTS);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(
    (r.imports ?? []).map((i) => `${i.module}::${i.name}`),
    "--target standalone must emit zero host imports",
  ).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
}

const ASSERT = `
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(what + ": expected " + expected + " got " + actual);
}
`;

/**
 * Did `scanForArrayHoles` ARM `isConcatSpreadableDirty` for this module?
 *
 * Read from the pre-scan's own `JS2WASM_DEBUG_6485` line rather than inferred
 * from behaviour or from binary size. Both of those alternatives are vacuous
 * here and that is the whole point of this helper (adversarial review r2,
 * 2026-09-16): a module in the EXCLUSION set behaves identically armed and
 * unarmed — arming only costs bytes — so a behavioural pin named for the
 * exclusion set would stay green against an implementation that armed on
 * everything. Size is no better: measured on this tree, adding an arming
 * construct to an already-armed module still moves the binary by 1,008–2,577
 * bytes, which overlaps the 1,480 that a genuinely clear module moves. The flag
 * itself is the only non-vacuous signal.
 */
async function gateArms(src: string, opts: Record<string, unknown> = OPTS): Promise<boolean> {
  const previous = process.env.JS2WASM_DEBUG_6485;
  process.env.JS2WASM_DEBUG_6485 = "1";
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  try {
    const r = await compile(src, opts as Parameters<typeof compile>[1]);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  } finally {
    spy.mockRestore();
    if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_DEBUG_6485");
    else process.env.JS2WASM_DEBUG_6485 = previous;
  }
  const reported = lines.filter((l) => l.startsWith("[6485] isConcatSpreadableDirty="));
  expect(reported.length, "the pre-scan must report the flag at least once").toBeGreaterThan(0);
  return reported.some((l) => l.endsWith("=true"));
}

/** Every arming probe ends in a concat, so the decision is not dead code. */
const CONCAT_TAIL = `
var out = [1, 2].concat([3]);
if (out.length !== 3) throw new Error("len");
`;

describe("#6485 Array.prototype.concat @@isConcatSpreadable (standalone)", () => {
  it("spreads a Boolean WRAPPER carrying @@isConcatSpreadable = true", async () => {
    await runScript(`${ASSERT}
      var bool = new Boolean(true);
      bool[Symbol.isConcatSpreadable] = true;
      bool.length = 3;
      bool[0] = 1; bool[1] = 2; bool[2] = 3;
      var out = [].concat(bool);
      eq(out.length, 3, "length");
      eq(out[1], 2, "out[1]");
    `);
  });

  // The negative direction. An ARRAY is spreadable by default, so this is the
  // only shape where the answer can only come from the symbol Get.
  it("does NOT spread an array whose @@isConcatSpreadable is false", async () => {
    await runScript(`${ASSERT}
      var a = [1, 2];
      var b = [3, 4];
      b[Symbol.isConcatSpreadable] = false;
      var out = a.concat(b);
      eq(out.length, 3, "length");
      eq(out[0], 1, "out[0]");
      eq(out[1], 2, "out[1]");
      eq(out[2] === b, true, "out[2] is b itself, not its elements");
    `);
  });

  it("does NOT spread a RECEIVER whose @@isConcatSpreadable is false", async () => {
    await runScript(`${ASSERT}
      var c = [5, 6];
      c[Symbol.isConcatSpreadable] = false;
      var out = c.concat();
      eq(out.length, 1, "length");
      eq(out[0] === c, true, "out[0] is c itself");
    `);
  });

  it("still spreads an ordinary array when the module can observe the symbol", async () => {
    await runScript(`${ASSERT}
      var probe = {};
      probe[Symbol.isConcatSpreadable] = true;
      var d = [7, 8];
      var e = [9];
      var out = d.concat(e, e);
      eq(out.length, 4, "length");
      eq(out[3], 9, "out[3]");
    `);
  });

  it("reads @@isConcatSpreadable once per operand, after ArraySpeciesCreate", async () => {
    await runScript(`${ASSERT}
      var calls = "";
      var arr = [];
      var arg = {};
      Object.defineProperty(arr, "constructor", {
        get: function() { calls += "constructor,"; return Array; },
        configurable: true
      });
      Object.defineProperty(arg, Symbol.isConcatSpreadable, {
        get: function() { calls += "isConcatSpreadable,"; return undefined; },
        configurable: true
      });
      var out = arr.concat(arg);
      eq(out.length, 1, "length");
      eq(out[0] === arg, true, "out[0] is arg");
      eq(calls, "constructor,isConcatSpreadable,", "observable Get order");
    `);
  });

  // An arguments object reaches the spec loop and its `length` override is
  // honoured, so the result has the right SHAPE.
  //
  // Neither the VALUE nor the PRESENCE at an index past the physical backing is
  // asserted, because both are the SAME unfixed defect — #6485 S2, see the
  // issue's Residuals. `__extern_has_idx` reports such an index PRESENT on an
  // arguments carrier, so the spec loop performs the `Get` and stores `null`
  // where §23.1.3.1 wants a `$Hole`; the result then reads back `out[3] === null`
  // (spec: `undefined`) and `3 in out === true` (spec: `false`).
  //
  // The presence half used to be asserted `false` here and passed — but only
  // because `in` with a numeric key never consulted anything for an externref
  // receiver (the R3 defect, fixed in this change-set). It was an accidental
  // right answer sitting on top of a wrong stored value, and pinning it again
  // would pin the accident. Recorded in prose instead, so an S2 fix has a
  // reference point.
  it("spreads an arguments object through the spec loop", async () => {
    await runScript(`${ASSERT}
      var args = (function(a, b, c) { return arguments; })(1, 2, 3);
      args[Symbol.isConcatSpreadable] = true;
      Object.defineProperty(args, "length", { value: 6 });
      var out = [].concat(args);
      eq(out.length, 6, "length");
      eq(out[0], 1, "out[0]");
      eq(out[2], 3, "out[2]");
    `);
  });

  // §23.1.3.1.1 step 1 (`Type(O) is not Object ⇒ false`) is exercised by the
  // test262 row `Array.prototype.concat_spreadable-boolean-wrapper.js`, which
  // this change flips from fail to pass: its last assertion sets
  // `Boolean.prototype[@@isConcatSpreadable] = true` and requires
  // `[].concat(true)` to still answer `[true]`. It is not duplicated here
  // because writing a well-known symbol onto a builtin prototype traps in a
  // bare standalone script without the test262 harness around it — a separate
  // defect, and pinning it here would make this file red for an unrelated
  // reason.

  it("spreads a sparse array-like whose indices are all absent", async () => {
    await runScript(`${ASSERT}
      var obj = { length: 5 };
      obj[Symbol.isConcatSpreadable] = true;
      var out = [].concat(obj);
      eq(out.length, 5, "length");
      eq(out[0], undefined, "out[0]");
      eq(0 in out, false, "index 0 is absent");
    `);
  });

  it("keeps an ordinary concat unchanged when the module never mentions the symbol", async () => {
    await runScript(`${ASSERT}
      var a = [1, 2];
      var out = a.concat([3], 4);
      eq(out.length, 4, "length");
      eq(out[2], 3, "out[2]");
      eq(out[3], 4, "out[3]");
    `);
  });

  // ── The gate must follow the INTRINSIC, not just the spelled name ────────
  //
  // A module can reach `@@isConcatSpreadable` without the string
  // "isConcatSpreadable" appearing anywhere: alias `Symbol` into a variable, or
  // pass it across a function boundary, then build the key at runtime. The
  // first cut of this gate matched only the literal name or `Symbol[expr]` on
  // the BARE identifier, so both shapes left the flag clear and kept the
  // wrong answer (adversarial review, 2026-09-16). Both pins are the NEGATIVE
  // direction, so a gate that armed on everything could not pass them vacuously
  // either — the length would still have to come out right.
  it("arms when `Symbol` is ALIASED into a variable and the key is computed", async () => {
    await runScript(`${ASSERT}
      var S = Symbol;
      var p1 = "isConcat", p2 = "Spreadable";
      var k = S[p1 + p2];
      eq(typeof k, "symbol", "k is the well-known symbol");
      var b = [3, 4];
      b[k] = false;
      var out = [1, 2].concat(b);
      eq(out.length, 3, "length — b must be appended whole");
      eq(out[0], 1, "out[0]");
      eq(out[1], 2, "out[1]");
    `);
  });

  it("arms when `Symbol` crosses a FUNCTION boundary", async () => {
    await runScript(`${ASSERT}
      function pick(o, key) { return o[key]; }
      var name = "isConcat" + "Spreadable";
      var b = [3, 4];
      b[pick(Symbol, name)] = false;
      var out = [1, 2].concat(b);
      eq(out.length, 3, "length — b must be appended whole");
    `);
  });

  // The other side of that widening: `Symbol.iterator` / `typeof Symbol` /
  // `Symbol["iterator"]` must NOT arm it. They are what the test262
  // `testTypedArray.js` harness prelude uses, and arming there would put ~2k
  // rows on the spec loop for nothing. Behaviour is what a test can see; the
  // flag itself is printed by `JS2WASM_DEBUG_6485` and counted out of band.
  it("stays clear for Symbol.iterator / typeof Symbol / a literal-keyed member", async () => {
    await runScript(`${ASSERT}
      var src = [1, 2];
      var obj = {};
      obj.length = 2;
      if (typeof Symbol !== "undefined" && Symbol.iterator) {
        obj[Symbol.iterator] = function () { return src[Symbol.iterator](); };
      }
      var it = Symbol["iterator"];
      eq(it === Symbol.iterator, true, "literal-keyed member is the same symbol");
      var out = [1].concat([2], [3]);
      eq(out.length, 3, "ordinary concat is unchanged");
      eq(out[2], 3, "out[2]");
    `);
  });

  // ── `in` on the dynamic concat carrier ──────────────────────────────────
  //
  // §13.10.1 step 6 is `HasProperty(rval, ToPropertyKey(lval))`. The call site
  // boxes a numeric key as a Number rather than the string "0", and every
  // index delegation in `__extern_has` sat behind `ref.test $AnyString`, so
  // `k in <concat result>` answered ABSENT for present indices. A vec-TYPED
  // receiver folds to an inline `idx < length` compare and never showed it;
  // only a receiver whose slot is externref — the #4655 dynamic carrier — does.
  // Measured on the base tree: `0 in [1].concat([2], [3])` was `false`.
  it("answers `in` correctly on a multi-argument concat result", async () => {
    await runScript(`${ASSERT}
      var m = [1].concat([2], [3]);
      eq(m.length, 3, "length");
      eq(0 in m, true, "index 0 present");
      eq(2 in m, true, "index 2 present");
      eq(3 in m, false, "index 3 absent");
      eq(m[2], 3, "value agrees with presence");
    `);
  });

  it("keeps `in` on a concat result identical with and without the gate armed", async () => {
    // Armed: the module can name the symbol, so every arity takes the spec loop.
    await runScript(`${ASSERT}
      var probe = {};
      probe[Symbol.isConcatSpreadable] = true;
      var u = [].concat(undefined);
      eq(u.length, 1, "length");
      eq(0 in u, true, "a stored undefined is PRESENT (§23.1.3.1 step 5.d)");
      eq(u[0], undefined, "value");
      var sp = [1].concat([1, , 3]);
      eq(sp.length, 4, "sp length");
      eq(1 in sp, true, "sp index 1 present");
      eq(2 in sp, false, "sp index 2 is the source's HOLE");
      eq(3 in sp, true, "sp index 3 present");
    `);
    // Unarmed twin: the same program minus the two probe lines.
    await runScript(`${ASSERT}
      var u = [].concat(undefined);
      eq(u.length, 1, "length");
      eq(0 in u, true, "a stored undefined is PRESENT");
      eq(u[0], undefined, "value");
      var sp = [1].concat([1, , 3]);
      eq(sp.length, 4, "sp length");
      eq(1 in sp, true, "sp index 1 present");
      eq(2 in sp, false, "sp index 2 is the source's HOLE");
      eq(3 in sp, true, "sp index 3 present");
    `);
  });

  // ── The `in` fix's blast radius, stated rather than left to be found ─────
  //
  // Routing a numeric key to `__extern_has_idx` changed the answer on THREE
  // common shapes, not only the `arguments` carrier above. `new Array(n)`,
  // `arr.length = n` and a write past the end all produce indices the compiler
  // models as PRESENT, so `k in arr` now answers `true` there where the base
  // tree answered `false`. Node says `false` for all three.
  //
  // Not a regression that can be fixed here, and the reason is measurable: the
  // rest of the MOP already answered PRESENT on those indices on BOTH trees
  // (`hasOwnProperty.call(new Array(5), 2)` is `true`,
  // `Object.keys(new Array(5)).length` is 5). The carrier keeps no hole record
  // for a grown backing at all — its tail slots hold plain wasm null, which is
  // also how a stored `undefined` looks — so `in` was answering `false` only
  // because it consulted nothing. The fix made `in` CONSISTENT with the rest of
  // the MOP; making all of them right is the #6485 S2 grow-path work.
  //
  // This pins the invariant that survives that fix — the three answers must
  // agree — so an S2 lane flips them together and this stays green, while a
  // change that moves `in` alone goes red.
  it("keeps `in`, hasOwnProperty and Object.keys agreeing on a hole-less carrier", async () => {
    await runScript(`${ASSERT}
      function has(o, k) { return (k in o) ? 1 : 0; }
      function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k) ? 1 : 0; }

      var a = new Array(5);
      eq(has(a, 2), own(a, 2), "new Array(5): in agrees with hasOwnProperty at 2");
      eq(Object.keys(a).length, 5, "new Array(5): every index is an own key (Node: 0)");

      var b = [1, 2];
      b.length = 5;
      eq(has(b, 3), own(b, 3), "length-extended: in agrees with hasOwnProperty at 3");
      eq(has(b, 0), 1, "length-extended: a real element is still present");

      var m = [1].concat([2], [3]);
      m[7] = 9;
      eq(m.length, 8, "grow-past-end length");
      eq(has(m, 5), own(m, 5), "grown carrier: in agrees with hasOwnProperty at 5");
      eq(has(m, 7), 1, "grown carrier: the written index is present");
      eq(m[7], 9, "grown carrier: value agrees with presence");
    `);
  });
});

// The gate's ARMING decision, asserted directly. Everything in this block is
// about which modules pay for the spec loop; none of it is about concat's
// answer, which is why it reads the flag instead of running a program.
describe("#6485 the @@isConcatSpreadable pre-scan gate", () => {
  const ARMS: Array<[string, string]> = [
    ["the canonical spelling", `var b = [3, 4]; b[Symbol.isConcatSpreadable] = false;`],
    ["`Symbol` ALIASED into a variable", `var S = Symbol; var k = S["isConcat" + "Spreadable"];`],
    [
      "`Symbol` across a function boundary",
      `function pick(o, k) { return o[k]; } var k = pick(Symbol, "isConcat" + "Spreadable");`,
    ],
    ["`Symbol` in an object literal SHORTHAND", `var bag = { Symbol }; var k = bag.Symbol["a" + "b"];`],
    ["`Symbol` as a callee", `var s = Symbol("d");`],
    ["a computed key on the intrinsic", `var p = "isConcat"; var k = Symbol[p + "Spreadable"];`],
    ["the global object's own `Symbol` property", `var k = globalThis.Symbol["a" + "b"];`],
  ];
  for (const [what, prelude] of ARMS) {
    it(`arms for ${what}`, async () => {
      expect(await gateArms(prelude + CONCAT_TAIL)).toBe(true);
    });
  }

  // The exclusion set. Each of these was measured ARMING before the review
  // (2026-09-16) except the first three, which are the shapes the design was
  // always meant to exclude — the test262 `testTypedArray.js` harness prelude
  // uses them, and arming there would route ~2,080 rows onto the spec loop.
  const STAYS_CLEAR: Array<[string, string]> = [
    ["a module that never mentions the symbol", ``],
    ["`typeof Symbol` and `Symbol.iterator`", `var ok = typeof Symbol !== "undefined" && !!Symbol.iterator;`],
    ["a LITERAL key on the intrinsic", `var it = Symbol["iterator"];`],
    ["a property NAME that happens to be `Symbol`", `var o = { Symbol: 1 }; var q = o.Symbol;`],
    ["a local binding that SHADOWS the global", `function f(Symbol) { return Symbol + 1; } var q = f(1);`],
    ["a PARENTHESIZED reference before a static member", `var it = (Symbol).iterator;`],
    ["the global object's `Symbol.iterator`", `var it = globalThis.Symbol.iterator;`],
  ];
  for (const [what, prelude] of STAYS_CLEAR) {
    it(`stays clear for ${what}`, async () => {
      expect(await gateArms(prelude + CONCAT_TAIL)).toBe(false);
    });
  }

  // TypeScript-only wrapper: the review's repro was a cast, and a cast reaches
  // the scanner as an `AsExpression` the `.js` pins above cannot produce.
  it("stays clear for a CAST reference before a static member", async () => {
    const armed = await gateArms(
      `const it: any = (Symbol as any).iterator;\nconst out: any = [1, 2].concat([3]);\nexport function n(): number { return out.length; }\n`,
      { fileName: "test.ts", skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(armed).toBe(false);
  });
});
