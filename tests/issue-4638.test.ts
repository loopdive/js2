// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4638) Array element / descriptor substrate — the four crash roots and the
// §10.4.4.2 mapped-arguments define ordering.
//
// Two harnesses, because the defects live on opposite sides of the strictness
// line:
//
//   * `runScript` compiles a SLOPPY script (no `export`, so the source file is
//     not a module and `isStrictContext` is false) and runs `__module_init`.
//     The script itself `throw`s when an assertion fails, so "the module ran to
//     completion" IS the assertion — the same contract every test262 row uses.
//     Sloppy is not cosmetic here: a mapped `arguments` object only exists for a
//     non-strict function with a simple parameter list (§10.2.11 step 22.a), and
//     script top-level `this` is the global object only outside a module.
//   * `runModule` compiles a module and calls an exported `test()` where the
//     shape does not depend on sloppiness.
//
// Each assertion gets its own `it()` — a bare wasm exception carries no JS-side
// message, so a combined script would report "something threw" and nothing more.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module, resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";

const OPTS = {
  fileName: "test.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone",
} as const;

/** Compile a sloppy script and run its top-level code. Throws iff the script does. */
async function runScript(src: string): Promise<void> {
  const r = await compile(src, OPTS);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
}

/** Same script probe, with the refusal provider attached for eval-value rows. */
async function runRuntimeEvalScript(src: string): Promise<void> {
  const previousEvalEngine = process.env.JS2WASM_EVAL_ENGINE;
  process.env.JS2WASM_EVAL_ENGINE = "interpreter";
  resetTest262RuntimeEvalProviderForTest();
  try {
    const r = await compile(src, OPTS);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
    const instance = await instantiateTest262Module(
      r.binary,
      {},
      { target: "standalone", providerLabel: "issue-4638" },
    );
    (instance.exports as { __module_init?: () => void }).__module_init?.();
  } finally {
    if (previousEvalEngine === undefined) Reflect.deleteProperty(process.env, "JS2WASM_EVAL_ENGINE");
    else process.env.JS2WASM_EVAL_ENGINE = previousEvalEngine;
    resetTest262RuntimeEvalProviderForTest();
  }
}

/** Compile a module and return its exported `test()` result. */
async function runModule(src: string): Promise<unknown> {
  const r = await compile(src, OPTS);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#4638 crash roots", () => {
  // Root 1 — `objectLiteralForcesHostPath`'s empty-string-key arm (#4616) had no
  // module-global / hoisted-`var` lockstep, so the value was an `$Object` while
  // the slot kept the checker's struct type. The guarded store missed, wrote
  // `ref.null`, and `obj[""]` did `struct.get` on null.
  // test262: built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-32.js
  it("reads an empty-string key off a module-global var without trapping", async () => {
    await runScript(`
      var obj = { "": 1 };
      if (obj[""] !== 1) { throw new Error("value"); }
      var d = Object.getOwnPropertyDescriptor(obj, "");
      if (!d || d.value !== 1) { throw new Error("descriptor"); }
    `);
  });

  it("answers hasOwnProperty for an empty-string key", async () => {
    await runScript(`
      var obj = { "": 1 };
      if (!obj.hasOwnProperty("")) { throw new Error("presence"); }
    `);
  });

  // Root 2 — a data-only object literal holding the realm GLOBAL OBJECT. The
  // checker types it `typeof globalThis`, which has no WasmGC struct, so the
  // field coercion's guarded `ref.test` missed and stored null; the descriptor
  // reify then materialized that null field and `struct.get` trapped.
  // test262: built-ins/Object/defineProperty/15.2.3.6-3-123.js
  it("passes a descriptor holding script-top-level `this` without trapping", async () => {
    await runScript(`
      var obj = {};
      var attr = { configurable: this };
      Object.defineProperty(obj, "property", attr);
      if (obj.hasOwnProperty("property") !== true) { throw new Error("not defined"); }
      delete obj.property;
      if (obj.hasOwnProperty("property") !== false) { throw new Error("not deleted"); }
    `);
  });

  it("keeps the global object as a value when a literal carries it", async () => {
    // The `globalThis` spelling of the same arm. Asserted in-script rather
    // than through an export: a `typeof` result crosses the boundary as a
    // native-string externref. The generous timeout is not a hang — naming
    // `globalThis` pulls in the whole realm-global materialization, measured
    // at 3.1 s warm / 23 s cold-and-loaded on this box.
    await runScript(`
        var attr = { g: globalThis };
        if (typeof attr.g !== "object") { throw new Error("typeof " + (typeof attr.g)); }
        if (!attr.g) { throw new Error("falsy"); }
      `);
  }, 180_000);

  // Root 3 — `arr.length = N` resolved its fast path from the CHECKER type, and
  // the checker types `Array.prototype` as `any[]`. The runtime value is the
  // prototype OBJECT, so the `ref.cast null (ref null $__vec_base)` in the
  // receiver `local.set` trapped `illegal cast`, uncatchably.
  // test262: built-ins/Object/defineProperty/15.2.3.6-4-117.js,
  //          built-ins/Object/defineProperties/15.2.3.7-6-a-113.js
  it("writes Array.prototype.length without trapping", async () => {
    await runScript(`
      Array.prototype.length = 0;
      if (Array.prototype.length !== 0) { throw new Error("length"); }
    `);
  });

  it("still sets length on a real array receiver", async () => {
    expect(
      await runModule(`
        var a = [1, 2, 3];
        a.length = 1;
        export function test() { return a.length; }
      `),
    ).toBe(1);
  });
});

describe("#4638 §10.4.4.2 mapped-arguments [[DefineOwnProperty]] ordering", () => {
  // Step 6.b.i writes the mapped parameter from `Desc.[[Value]]`; step 6.b.ii
  // only THEN removes the map entry for `[[Writable]]: false`. Recording the
  // severance first made the parameter write get skipped.
  // test262: built-ins/Object/defineProperty/15.2.3.6-4-{292-1,293-2,293-3,294-1,295-1,296-1}.js
  it("writes the mapped formal before severing the map for writable:false", async () => {
    await runScript(`
      (function (a, b, c) {
        Object.defineProperty(arguments, "0", {
          value: 20,
          writable: false,
          enumerable: false,
          configurable: false
        });
        if (a !== 20) { throw new Error("param not written"); }
      }(0, 1, 2));
    `);
  });

  it("records the stated attributes so gOPD reports them", async () => {
    await runScript(`
      (function (a, b, c) {
        Object.defineProperty(arguments, "0", {
          value: 20,
          writable: false,
          enumerable: false,
          configurable: false
        });
        var d = Object.getOwnPropertyDescriptor(arguments, "0");
        if (!d) { throw new Error("no descriptor"); }
        if (d.value !== 20) { throw new Error("value"); }
        if (d.writable !== false) { throw new Error("writable"); }
        if (d.enumerable !== false) { throw new Error("enumerable"); }
        if (d.configurable !== false) { throw new Error("configurable"); }
      }(0, 1, 2));
    `);
  });

  it("lets a value-only redefine update a non-writable but configurable index", async () => {
    await runScript(`
      (function (a, b, c) {
        Object.defineProperty(arguments, "0", { value: 10, writable: false });
        Object.defineProperty(arguments, "0", { value: 20 });
        if (a !== 10) { throw new Error("param must stay 10 after the map was severed"); }
        var d = Object.getOwnPropertyDescriptor(arguments, "0");
        if (!d || d.value !== 20) { throw new Error("descriptor value"); }
      }(0, 1, 2));
    `);
  });

  it("keeps a plain value define flowing into the formal (pre-#4638 behaviour)", async () => {
    await runScript(`
      (function (a) {
        Object.defineProperty(arguments, "0", { value: 5 });
        if (a !== 5) { throw new Error("param"); }
      }(0));
    `);
  });
});

describe("#4638 concat absent-tail", () => {
  // `array.new_default` zero-fills an f64 backing, and the copies that follow are
  // BACKING-clamped — so a sparse operand's untouched destination slots kept a
  // real `0` where the source had no element.
  // test262: built-ins/Array/prototype/concat/S15.4.4.4_A3_T2.js / _T3.
  it("does not invent a 0 element for a length-extended operand", async () => {
    await runScript(`
      var a = [0];
      a.length = 3;
      var b = a.concat();
      if (b.length !== 3) { throw new Error("length"); }
      if (b[0] !== 0) { throw new Error("b[0]"); }
      if (b[1] !== undefined) { throw new Error("b[1] = " + b[1]); }
      if (b[2] !== undefined) { throw new Error("b[2]"); }
    `);
  });

  it("reports the absent tail as an absent own property", async () => {
    await runScript(`
      var a = [0];
      a.length = 3;
      var b = a.concat();
      if (b.hasOwnProperty("1") !== false) { throw new Error("hasOwnProperty"); }
    `);
  });

  // A concat hole is copied only after HasProperty sees the inherited numeric
  // entry.  The result therefore owns the copied value, unlike the untouched
  // length-extended tail above.
  // test262: built-ins/Array/prototype/concat/S15.4.4.4_A3_T1.js.
  it("copies an inherited numeric index as an own result element", async () => {
    await runScript(`
      var a = [0];
      a.length = 2;
      Array.prototype[1] = 1;
      var b = a.concat();
      if (b[0] !== 0) { throw new Error("b[0]"); }
      if (b[1] !== 1) { throw new Error("b[1]"); }
      if (b.hasOwnProperty("1") !== true) { throw new Error("hasOwnProperty"); }
    `);
  });

  // The same marker must survive more than one spread operand: both source
  // holes count toward the result length while their reads remain undefined.
  // test262: built-ins/Array/prototype/concat/S15.4.4.4_A1_T4.js.
  it("preserves holes across multiple concat operands", async () => {
    await runScript(`
      var x = [, 1];
      var b = x.concat([], [, ]);
      if (b.length !== 3) { throw new Error("length"); }
      if (b[0] !== undefined) { throw new Error("b[0]"); }
      if (b[1] !== 1) { throw new Error("b[1]"); }
      if (b[2] !== undefined) { throw new Error("b[2]"); }
    `);
  });

  it("leaves a dense concat unchanged", async () => {
    expect(
      await runModule(`
        var a = [1, 2];
        var b = a.concat([3, 4]);
        export function test() { return b.length * 1000 + b[0] * 100 + b[2] * 10 + b[3]; }
      `),
    ).toBe(4 * 1000 + 1 * 100 + 3 * 10 + 4);
  });
});

describe("#4638 measured residuals", () => {
  // `Object.getOwnPropertyDescriptor(o, "")` MISSES once `o.hasOwnProperty("")`
  // has run in the same module — measured on this branch, and NOT introduced by
  // #4638 (each half is correct in isolation; only the pair fails). Recorded here
  // because the empty-string-key lockstep above is what makes the pair reachable
  // at all. Owner: the #4616 empty-key / `$Object` presence lane.
  it.fails("keeps gOPD working for an empty-string key after hasOwnProperty", async () => {
    await runScript(`
      var obj = { "": 1 };
      if (!obj.hasOwnProperty("")) { throw new Error("presence"); }
      var d = Object.getOwnPropertyDescriptor(obj, "");
      if (!d) { throw new Error("descriptor missing after hasOwnProperty"); }
    `);
  });

  // `Array.isArray(arguments)` and the arguments `length` descriptor both need a
  // RUNTIME brand on the arguments vec; the arguments object is the same
  // `$__vec_externref` an ordinary array uses. See the issue's Residuals section
  // for the `$__holey_array` subtype sketch and why it is not taken here.
  // test262: built-ins/Array/isArray/15.4.3.2-1-13.js
  it("answers false for Array.isArray(arguments)", async () => {
    await runScript(`
      var arg;
      (function fun() { arg = arguments; }(1, 2, 3));
      if (Array.isArray(arg) !== false) { throw new Error("isArray"); }
    `);
  });

  // test262: language/arguments-object/10.6-6-2.js
  it("reports arguments.length as configurable", async () => {
    await runScript(`
      (function () {
        var d = Object.getOwnPropertyDescriptor(arguments, "length");
        if (!d || d.configurable !== true) { throw new Error("configurable"); }
      }());
    `);
  });

  // `eval` reachable as a VALUE in the module turns on the runtime-eval boundary.
  // The filter callback now unwraps that boundary's AOT carrier before its
  // in-module call_ref dispatch (runtime-eval boundary lane #4442).
  // test262: built-ins/Array/prototype/filter/15.4.4.20-5-7.js
  it("passes eval as a filter thisArg", async () => {
    await runRuntimeEvalScript(`
      function cb(val, idx, obj) { return true; }
      var out = [11].filter(cb, eval);
      if (out[0] !== 11) { throw new Error("out[0]"); }
    `);
  });
});
