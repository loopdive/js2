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
import { describe, expect, it } from "vitest";
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
  // honoured, so the result has the right SHAPE. The VALUE at an index past the
  // physical backing still reads back as `null` where §23.1.3.1 wants a hole
  // (`undefined`) — #6485 S2, diagnosed and NOT fixed here, see the issue's
  // Residuals. That part is deliberately not asserted rather than pinned wrong;
  // the presence assertions below are the half that is already correct.
  it("spreads an arguments object through the spec loop, absence included", async () => {
    await runScript(`${ASSERT}
      var args = (function(a, b, c) { return arguments; })(1, 2, 3);
      args[Symbol.isConcatSpreadable] = true;
      Object.defineProperty(args, "length", { value: 6 });
      var out = [].concat(args);
      eq(out.length, 6, "length");
      eq(out[0], 1, "out[0]");
      eq(out[2], 3, "out[2]");
      eq(3 in out, false, "index 3 is ABSENT");
      eq(5 in out, false, "index 5 is ABSENT");
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
});
