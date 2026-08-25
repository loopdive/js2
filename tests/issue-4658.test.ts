// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4658) `arguments`-object `length` / `callee` own-property descriptors,
// `--target standalone`.
//
// Two independent roots, pinned separately because they were measured
// separately:
//
//  1. **The vec companion value-seed was a CHAIN read.** `buildBagValueSeed`
//     sourced the pre-state it hands `__defineProperty_value` from
//     `__vec_prop_get`, whose miss tail has consulted the prototype-property
//     companions since #4176. For a key the #3537 bag does not hold, that
//     answers with `Object.prototype`'s value — so a define on a vec receiver
//     installed an INHERITED value as an OWN property, with `SEED_FLAGS`
//     (w/e/c all true). Fixed by gating the seed on `__carrier_bag_has`.
//
//  2. **`arguments` had no runtime brand,** so `__vec_gopd` answered its
//     `length` with §10.4.2's Array rules (`configurable: false`) instead of
//     §10.4.4's (`configurable: true`). Fixed by a dedicated WasmGC arguments
//     vec subtype whose mutable third field records the deleted-length state.
//
// ## Every pin EXECUTES the operation it guards
// The descriptor pins call `Object.getOwnPropertyDescriptor` and assert the
// individual attribute bits; the mutation pins perform the write or the delete
// and READ THE RESULT BACK. A pin that only asserts a shape cannot fail for the
// reason it exists (the wave-3 lesson in the campaign brief).
//
// ## Why every case returns a NUMBER
// A `string` returned across the standalone module boundary arrives as an
// opaque handle, and `expect(handle).toBe("…")` fails for THAT reason rather
// than the one the pin is about — which also makes an `it.fails` pin pass
// vacuously. Measured on the first cut of this file: 13 of 15 cases compared
// against `{}`. So each case encodes its answer as an integer bitfield and the
// expectation names the bits.
//
// ## Mode
// These compile as MODULES, so the code is strict and the arguments objects are
// UNMAPPED. That is deliberate and sufficient for what is pinned: §10.4.4 gives
// `length` `{writable: true, enumerable: false, configurable: true}` in
// CreateUnmappedArgumentsObject (step 4) exactly as in
// CreateMappedArgumentsObject (step 7), so the descriptor answers do not depend
// on the goal. The `callee` half of root 1 is SLOPPY-only (a strict arguments
// object gets the %ThrowTypeError% accessor instead of a data property), so it
// is pinned through root 1's own general shape — a define with no `[[Value]]`
// on a vec receiver under a tampered `Object.prototype` — which is what
// `language/arguments-object/10.6-13-a-1` actually exercised.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runModule(src: string): Promise<number> {
  const r = await compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

/** `<body>` as the body of `f()`, its result exported through `test`. */
function fn(body: string, call = "f()"): string {
  return `
    function f() {
${body}
    }
    var r = ${call};
    export function test() { return r; }`;
}

/**
 * A descriptor as a bitfield: 1 writable | 2 enumerable | 4 configurable, and
 * 8 when the descriptor itself is undefined. The VALUE is returned separately
 * by each case, because what counts as the right value differs per shape.
 */
const DESC_BITS = `
    function descBits(o, k) {
      var d = Object.getOwnPropertyDescriptor(o, k);
      if (d === undefined) { return 8; }
      return (d.writable ? 1 : 0) + (d.enumerable ? 2 : 0) + (d.configurable ? 4 : 0);
    }`;

describe("#4658 root 1 — a vec define must not inherit its own value", () => {
  // The measured base-state defect, verbatim (revert-verified): on a vec
  // receiver this answered `{value: 7, writable: false, enumerable: true,
  // configurable: true}`; on a plain object it already answered the spec's
  // `{value: undefined, writable: false, enumerable: false, configurable:
  // false}`. Encoded here as `100 * <bits> + <value marker>`, where the value
  // marker is 7 when the INHERITED value leaked in and 0 when it did not.
  const shape = (receiver: string): string => `${DESC_BITS}
    Object.defineProperty(Object.prototype, "zzz", { value: 7, writable: true, configurable: true });
    var o = ${receiver};
    Object.defineProperty(o, "zzz", { writable: false });
    var bits = descBits(o, "zzz");
    var leaked = (Object.getOwnPropertyDescriptor(o, "zzz").value === 7) ? 7 : 0;
    export function test() { return bits * 100 + leaked; }`;

  it("vec receiver: the new own property has value undefined, not the prototype's 7", async () => {
    // bits 0 (non-writable, non-enumerable, non-configurable), no leak.
    expect(await runModule(shape("[1, 2]"))).toBe(0);
  });

  // The positive control that made the defect legible: the SAME program on a
  // plain-object receiver was already correct on base, so the divergence is the
  // vec path's, not `ValidateAndApplyPropertyDescriptor`'s.
  it("plain-object control: identical answer, and it was already correct on base", async () => {
    expect(await runModule(shape("{}"))).toBe(0);
  });

  it("a key the bag DOES own is still seeded — #4010's seam is intact", async () => {
    // `o.q = 12` lands in the #3537 bag; the later define carries no [[Value]],
    // so §10.1.6.3 must PRESERVE 12. This is the case `buildBagValueSeed` was
    // written for, and the own-ness gate must not have narrowed it away.
    expect(
      await runModule(`
        var o = [1, 2];
        o.q = 12;
        Object.defineProperty(o, "q", { writable: false });
        var d = Object.getOwnPropertyDescriptor(o, "q");
        var out = (d.value === 12 ? 10 : 0) + (d.writable ? 1 : 0);
        export function test() { return out; }`),
    ).toBe(10);
  });
});

describe("#4658 root 2 — §10.4.4 length descriptor on an arguments object", () => {
  it("brands arguments by WasmGC type, never by per-call overlay registration", async () => {
    const r = await compile(
      `function f() { return Object.getOwnPropertyDescriptor(arguments, "length").configurable; }
       export function test() { var n = 0; for (var i = 0; i < 100; i++) if (f(i)) n++; return n; }`,
      { fileName: "test.js", allowJs: true, skipSemanticDiagnostics: true, target: "standalone" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(r.wat).toContain("__arguments_vec");
    expect(r.wat).not.toContain("__args_brand_mark");
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(100);
  });

  it("gOPD(arguments, 'length') reports writable+configurable, non-enumerable", async () => {
    // 1 writable | 4 configurable = 5; value 0 (no args passed) contributes 0.
    expect(
      await runModule(
        fn(`${DESC_BITS}
      var d = Object.getOwnPropertyDescriptor(arguments, "length");
      return descBits(arguments, "length") * 100 + d.value;`),
      ),
    ).toBe(500);
  });

  it("the same holds through a helper — the receiver is a dynamic value there", async () => {
    // `10.6-6-2` / `10.6-7-1` hand the object to `verifyProperty`, so the gOPD
    // site sees no `arguments` syntax at all. A syntactic arm cannot serve it;
    // this is why the fix is a runtime brand. 5 bits, value 3.
    expect(
      await runModule(`${DESC_BITS}
        function describeLength(o) { return descBits(o, "length") * 100 + Object.getOwnPropertyDescriptor(o, "length").value; }
        function f() { return describeLength(arguments); }
        var r = f(1, 2, 3);
        export function test() { return r; }`),
    ).toBe(503);
  });

  it("an ARRAY control keeps §10.4.2's configurable: false", async () => {
    // 1 writable only = 1; value 2.
    expect(
      await runModule(`${DESC_BITS}
        var out = descBits([1, 2], "length") * 100 + Object.getOwnPropertyDescriptor([1, 2], "length").value;
        export function test() { return out; }`),
    ).toBe(102);
  });

  it("Object.seal(arguments) takes the configurable bit back to false", async () => {
    // §7.3.14 still wins over the brand — the brand is ANDed with the integrity
    // answer, not substituted for it. Expect the configurable bit (4) clear.
    expect(
      await runModule(
        fn(`${DESC_BITS}
      Object.seal(arguments);
      return descBits(arguments, "length") & 4;`),
      ),
    ).toBe(0);
  });
});

describe("#4658 root 2 — the delete is observable, not just permitted", () => {
  it("delete arguments.length succeeds AND hasOwnProperty then answers false", async () => {
    // This is the round trip `propertyHelper.isConfigurable` performs, and the
    // reason a `configurable: true` descriptor alone did NOT make 10.6-6-2 /
    // 10.6-7-1 pass. Both halves are executed here, through helpers so neither
    // can be folded syntactically. 10 = delete returned true, +1 would mean the
    // property survived.
    expect(
      await runModule(`
        function del(o, n) { return delete o[n]; }
        function own(o, n) { return Object.prototype.hasOwnProperty.call(o, n); }
        function f() { return (del(arguments, "length") ? 10 : 0) + (own(arguments, "length") ? 1 : 0); }
        var r = f(1, 2);
        export function test() { return r; }`),
    ).toBe(10);
  });

  it("gOPD agrees with hasOwnProperty after the delete", async () => {
    // 8 = the descriptor is undefined, i.e. no own property remains.
    expect(
      await runModule(`${DESC_BITS}
        function del(o, n) { return delete o[n]; }
        function f() { del(arguments, "length"); return descBits(arguments, "length"); }
        var r = f(1, 2);
        export function test() { return r; }`),
    ).toBe(8);
  });

  it("an ARRAY control still REFUSES the delete and keeps its length", async () => {
    // The refusal is unchanged; the OBSERVATION of it differs by goal, and this
    // file is a module, so §13.5.1.2 step 5 turns the refused delete into a
    // thrown TypeError rather than a `false`. Encoded 900 (TypeError) + 20
    // (length still 2) + 1 (still an own property). 800 would be some other
    // throw, 100/200 a returned true/false.
    expect(
      await runModule(`
        function del(o, n) { return delete o[n]; }
        var a = [1, 2];
        var code = 0;
        try { code = del(a, "length") ? 1 : 2; } catch (e) { code = (e instanceof TypeError) ? 9 : 8; }
        var out = code * 100 + a.length * 10 + (Object.prototype.hasOwnProperty.call(a, "length") ? 1 : 0);
        export function test() { return out; }`),
    ).toBe(921);
  });

  it("`in` and the DYNAMIC read agree with hasOwnProperty after the delete", async () => {
    // Four surfaces read the same tombstone; a delete that only some of them
    // can see would be a new incoherence, not a fix. 0 = `"length" in args` is
    // false AND the dynamic read is undefined.
    expect(
      await runModule(`
        function del(o, n) { return delete o[n]; }
        function has(o, n) { return n in o; }
        function get(o, n) { return o[n]; }
        function f() {
          del(arguments, "length");
          return (has(arguments, "length") ? 10 : 0) + (get(arguments, "length") === undefined ? 0 : 1);
        }
        var r = f(1, 2);
        export function test() { return r; }`),
    ).toBe(0);
  });

  it('an ARRAY control keeps `"length" in arr` true', async () => {
    // Only `in` is asserted for the Array receiver. The dynamic READ of
    // `arr["length"]` is a SEPARATE pre-existing defect — see RESIDUAL 3 —
    // measured identical on base and on this branch, so pinning it here would
    // pin someone else's bug to this fix.
    expect(
      await runModule(`
        function has(o, n) { return n in o; }
        var a = [1, 2];
        var out = has(a, "length") ? 1 : 0;
        export function test() { return out; }`),
    ).toBe(1);
  });

  it("a later numeric write to length revives the property", async () => {
    expect(
      await runModule(`
        function del(o, n) { return delete o[n]; }
        function set(o, n, v) { o[n] = v; }
        function own(o, n) { return Object.prototype.hasOwnProperty.call(o, n); }
        function f() {
          del(arguments, "length");
          set(arguments, "length", 5);
          return (own(arguments, "length") ? 100 : 0) + arguments.length;
        }
        var r = f(1, 2);
        export function test() { return r; }`),
    ).toBe(105);
  });
});

describe("#4658 residuals — measured, NOT fixed here", () => {
  // RESIDUAL 1 (owner: the #3251 / #3537 arguments-representation work; the
  // remaining half of this issue's `S10.6_A5_T4` row).
  //
  // §10.4.4 makes `length` an ORDINARY data property, so `arguments.length =
  // "abc"` must stick and read back as the string. It does not: the write goes
  // through `__extern_set`'s vec `length` arm, which is ArraySetLength-lite —
  // a non-numeric value is a silent no-op — and a `.length` READ folds to a
  // `struct.get` on the vec's length FIELD, so there is nowhere for a
  // non-numeric length to live. Storing it in the bag would fix only the
  // dynamic read and leave the static fold answering the old value: two
  // surfaces disagreeing, which is worse than the current coherent miss. The
  // real fix is the `[[ParameterMap]]`/descriptor-sidecar representation
  // #3251 / #4622 defer.
  it.fails("RESIDUAL: a STRING write to arguments.length does not stick", async () => {
    expect(
      await runModule(
        fn(`      arguments.length = "abc";
      return (arguments.length === "abc") ? 1 : 0;`),
      ),
    ).toBe(1);
  });

  // Positive control for RESIDUAL 1: the numeric write DOES stick, so the pin
  // above is measuring the cross-TYPE half and not a dead write path.
  it("control: a NUMBER write to arguments.length does stick", async () => {
    expect(
      await runModule(
        fn(`      arguments.length = 42;
      return arguments.length;`),
      ),
    ).toBe(42);
  });

  // RESIDUAL 2 (owner: unclaimed — a separate defect this issue only
  // MEASURED). `Array.isArray(arguments)` must be `false`: an arguments object
  // is an ordinary Object, not an Array exotic object. It answers `true`
  // because the two share the `$Vec` representation and `__is_vec` is the
  // predicate behind `Array.isArray`.
  //
  // Load-bearing for whoever fixes it: `propertyHelper.isWritable` branches on
  // `__isArray(obj) && name === "length"` to choose a NUMERIC probe value, and
  // that branch is the only reason `10.6-6-2`'s `writable` check passes today.
  // Fixing `Array.isArray` sends that check down the `"unlikelyValue"` STRING
  // path, where it will need RESIDUAL 1 first.
  it.fails("RESIDUAL: Array.isArray(arguments) answers true", async () => {
    expect(await runModule(fn(`      return Array.isArray(arguments) ? 1 : 0;`))).toBe(0);
  });

  // Positive control for RESIDUAL 2 — `Array.isArray` is not simply broken.
  it("control: Array.isArray discriminates arrays from plain objects", async () => {
    expect(
      await runModule(`
        var out = (Array.isArray([1, 2]) ? 10 : 0) + (Array.isArray({}) ? 1 : 0);
        export function test() { return out; }`),
    ).toBe(10);
  });

  // RESIDUAL 3 (owner: unclaimed — found while building this file's Array
  // controls, NOT caused by this change; measured IDENTICAL on base
  // `74389b417` and on this branch, `RESULT: 1111` both arms).
  //
  // On an Array receiver the BRACKET form `arr["length"]` answers `arr[0]`.
  // The key is numeric-coerced (`ToNumber("length")` is NaN, `trunc_sat` takes
  // it to 0) and the index lane consumes it before any named-key lane sees it
  // — the exact shape `vec-props.ts` warns about in its `VEC_PROP_GET` header
  // ("that is right for an ordinary index and wrong for a §10.4.2.2 non-index
  // key"). All three spellings answer 1 for `[1, 2]`: a top-level
  // `a["length"]`, a generic `get(o, n)` helper, and an inline
  // `(function (o) { return o["length"]; })(a)`. The DOT form `a.length` is
  // correct (2) — it folds to the vec length field — which is why this hides.
  it.fails('RESIDUAL: arr["length"] answers arr[0] instead of the length', async () => {
    expect(
      await runModule(`
        var a = [1, 2];
        var out = a["length"];
        export function test() { return out; }`),
    ).toBe(2);
  });

  // Positive control for RESIDUAL 3: the DOT form is correct, so the pin above
  // is measuring the bracket/dynamic key lane and not a broken array literal.
  it("control: the DOT form arr.length is correct", async () => {
    expect(
      await runModule(`
        var a = [1, 2];
        var out = a.length;
        export function test() { return out; }`),
    ).toBe(2);
  });

  // RESIDUAL 4 (owner: same as RESIDUAL 1 — one representation, one fix).
  //
  // All four DYNAMIC own-property surfaces now agree the property is gone after
  // `delete args.length` (pinned above). A SYNTACTIC `arguments.length` in the
  // same function still folds to `struct.get` on the vec's length field and
  // answers the live length. Measured both arms: base `74389b417` returns 902
  // (the strict delete THREW, fold 2), this branch returns 102 (delete
  // succeeded, fold still 2) — so the fold is unchanged by this work, and only
  // the delete's own answer moved.
  it.fails("RESIDUAL: the compile-time .length fold survives the delete", async () => {
    expect(
      await runModule(`
        function del(o, n) { return delete o[n]; }
        function f() {
          del(arguments, "length");
          return arguments.length === undefined ? 1 : 0;
        }
        var r = f(1, 2);
        export function test() { return r; }`),
    ).toBe(1);
  });

  // Positive control for RESIDUAL 4: in the SAME program the dynamic read does
  // answer undefined, so the pin isolates the compile-time fold rather than a
  // tombstone that was never recorded.
  it("control: the dynamic read in that same program does answer undefined", async () => {
    expect(
      await runModule(`
        function del(o, n) { return delete o[n]; }
        function get(o, n) { return o[n]; }
        function f() {
          del(arguments, "length");
          return get(arguments, "length") === undefined ? 1 : 0;
        }
        var r = f(1, 2);
        export function test() { return r; }`),
    ).toBe(1);
  });
});
