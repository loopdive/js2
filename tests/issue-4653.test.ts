// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4653) `language/statements/function` residual — the three families this
// issue originally closed, plus executable pins for the remaining measured
// roots. The call-dispatch residual is repaired by the focused alias arm below.
//
// Scoped sweep, standalone lane, over `language/statements/function` +
// `language/statements/{return,try}` (668 files), run by the same driver on
// both arms (`runTest262File(…, "standalone")`):
//
//   | state                    | pass | fail | compile_error |
//   | ------------------------ | ---- | ---- | ------------- |
//   | base (c42bdbe3e)         | 611  |  56  |       1       |
//   | this branch, as swept    | 604  |  53  |      11       |
//   | this branch, CORRECTED   | 614  |  53  |       1       |
//
// +3 flips, zero regressions. The correction is not a rounding: the raw
// after-sweep reported ten `pass -> compile_error` rows, every one of them a
// `compilation timeout` at 24-54 s with the box at load 17-21 (five lanes
// sweeping). A timeout is a measurement failure, not a status, and
// `runTest262File`'s timeout is post-hoc — it cannot interrupt a slow compile.
// All ten were re-run SERIALLY at 120 s on BOTH arms and pass on both; the
// three flips were re-run in the same pass and hold in both directions.
//
// Every pin here compiles a SCRIPT and runs its `__module_init`, not a wrapped
// `export function test()`. That is load-bearing for two of the three families:
// the fnctor recogniser admits only a TOP-LEVEL `var F; F = function(){}`, and
// the redeclared-function slot is a MODULE global. A pin wrapped in a function
// would compile a different program from the one the defect lives in.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
import { extractWasmExceptionMessage, runTest262File } from "./test262-runner.js";

/**
 * Compile `source` as a standalone SCRIPT and run its top-level initializer.
 * Resolves to `null` when it completed, or the thrown message. The scripts below
 * `throw` on a wrong answer, so the pin's assertion is `null`.
 */
async function runScript(source: string): Promise<string | null> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4653.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  let instance: WebAssembly.Instance;
  try {
    instance = await instantiateTest262Module(
      result.binary,
      {},
      {
        target: "standalone",
        providerLabel: "#4653",
      },
    );
  } catch (err) {
    return `instantiate: ${err instanceof Error ? err.message : String(err)}`;
  }
  const moduleInit = (instance.exports as Record<string, unknown>).__module_init;
  if (typeof moduleInit !== "function") return "no __module_init export";
  try {
    moduleInit();
  } catch (err) {
    const decoded = extractWasmExceptionMessage(err, instance);
    return decoded || (err instanceof Error ? err.message : String(err));
  }
  return null;
}

/** A runtime-carried counter, so no arm below can be constant-folded away. */
const LOOP_CARRIED = `var __n = 0; for (var __i = 0; __i < 3; __i++) { __n += __i; } /* __n === 3 */`;

describe("#4653 E — the for-in shadow set is written OWN-ONLY", () => {
  // `__object_keys_forin` marks every own key into a private `seen` table. That
  // table is a null-$proto `$Object` — the same representation as an ordinary
  // object literal — so `__extern_set` ran out of explicit links and probed the
  // IMPLICIT Object.prototype companion. Measured on base: `data` became the
  // string "constructor", i.e. a bare `for (x in o)` invoked a user setter with
  // the enumerated key. Flipped `13.2-17-1`.
  it("does not invoke an Object.prototype setter while enumerating", async () => {
    expect(
      await runScript(`
        ${LOOP_CARRIED}
        var data = "data";
        Object.defineProperty(Object.prototype, "constructor", {
          get: function () { return 100 + __n; },
          set: function (v) { data = v; },
          configurable: true
        });
        var fun = function () {};
        var visited = 0;
        for (var k in fun.prototype) { visited++; }
        if (data !== "data") {
          throw new Error("for-in invoked the inherited setter: data=" + String(data));
        }
      `),
    ).toBe(null);
  });

  // The OTHER half of the same write. A refused mark leaves `seen` empty, so a
  // name owned at two chain levels is yielded twice. This half needs no
  // accessor at all — it is the shadow table's whole job.
  it("still yields a two-level own name exactly once", async () => {
    expect(
      await runScript(`
        ${LOOP_CARRIED}
        var proto = { a: 1, b: 2 };
        var child = Object.create(proto);
        child.a = __n;
        var aCount = 0, total = 0;
        for (var k in child) { total++; if (k === "a") aCount++; }
        if (aCount !== 1) throw new Error("shadowed key yielded " + aCount + " times");
        if (total !== 2) throw new Error("expected 2 keys, saw " + total);
      `),
    ).toBe(null);
  });

  // NEGATIVE CONTROL: the mark must still HAPPEN. Switching to an own-only
  // write must not turn into skipping the write, which would regress the pin
  // above; this one checks the non-enumerable case that only the mark covers —
  // a non-enumerable own property shadows an enumerable inherited one.
  it("lets a NON-enumerable own property shadow an inherited enumerable one", async () => {
    expect(
      await runScript(`
        ${LOOP_CARRIED}
        var proto = { hidden: 1 };
        var child = Object.create(proto);
        Object.defineProperty(child, "hidden", { value: __n, enumerable: false, configurable: true });
        var seen = 0;
        for (var k in child) { if (k === "hidden") seen++; }
        if (seen !== 0) throw new Error("non-enumerable own key did not shadow; seen=" + seen);
      `),
    ).toBe(null);
  });
});

describe("#4653 F — `var F; … F = function(){}` is a fnctor declaration", () => {
  // Base: the escape gate saw no ctor for the name, minted `__fnctor_proto_F`
  // for the `.prototype` reads/writes, and `new F()` could not route to the
  // fnctor lowering — `Object.getPrototypeOf(new A())` was null while
  // `A.prototype.shape` was "cube". Flipped `S13.2.2_A4_T2`.
  it("links `new F()` to the object assigned to F.prototype", async () => {
    expect(
      await runScript(`
        ${LOOP_CARRIED}
        var CUBE, FACTORY, device;
        CUBE = "cube" + __n;
        FACTORY = function () {};
        FACTORY.prototype = { shape: CUBE, printShape: function () { return this.shape; } };
        device = new FACTORY();
        if (device.printShape === undefined) throw new Error("printShape is undefined");
        if (device.printShape() !== CUBE) throw new Error("printShape() === " + device.printShape());
        if (Object.getPrototypeOf(device) !== FACTORY.prototype) throw new Error("[[Prototype]] is not F.prototype");
      `),
    ).toBe(null);
  });

  // NEGATIVE CONTROL 1: the spelling that already worked must be unchanged.
  it("leaves `var F = function(){}` alone", async () => {
    expect(
      await runScript(`
        ${LOOP_CARRIED}
        var B = function () {};
        B.prototype = { shape: "cube" + __n, printShape: function () { return this.shape; } };
        var b = new B();
        if (b.printShape() !== "cube3") throw new Error("printShape() === " + b.printShape());
      `),
    ).toBe(null);
  });

  // NEGATIVE CONTROL 2: TWO assignments must DECLINE. The admission rule's whole
  // point is that a second write could put a different value in the slot, so the
  // recogniser must not claim this shape — and, declining, must not miscompile
  // it either: the live constructor is still the last one assigned.
  it("declines a twice-assigned binding without breaking it", async () => {
    expect(
      await runScript(`
        ${LOOP_CARRIED}
        var C;
        C = function () { this.tag = "first"; };
        C = function () { this.tag = "second" + __n; };
        var c = new C();
        if (c.tag !== "second3") throw new Error("tag === " + String(c.tag));
      `),
    ).toBe(null);
  });
});

describe("#4653 D — a var initialized from a REDECLARED function gets a neutral slot", () => {
  // ES §14.1.23: the LAST `function f(){}` wins for every call, including one
  // written above it. TypeScript resolves `f()` through the FIRST signature, so
  // the module global was typed `(mut f64)` and the emitted string result
  // coerced to NaN — on BOTH reads. Flipped `S13_A6_T1`.
  it("stores the LAST declaration's result, not the first signature's type", async () => {
    expect(
      await runScript(`
        ${LOOP_CARRIED}
        function dup() { return 1; }
        var storedFn = dup;
        var first = dup();
        function dup() { return "A" + __n; }
        var second = dup();
        if (storedFn !== dup) throw new Error("the two declarations are not one binding");
        if (first !== second) throw new Error("first=" + String(first) + " second=" + String(second));
        if (second !== "A3") throw new Error("second === " + String(second));
      `),
    ).toBe(null);
  });

  // NEGATIVE CONTROL: a SINGLE declaration must keep its numeric slot — the
  // widening is keyed on two or more BODY-bearing declarations, so an ordinary
  // numeric helper (and a TS overload set, where only the implementation has a
  // body) is untouched.
  it("leaves a singly-declared numeric helper on its numeric slot", async () => {
    expect(
      await runScript(`
        ${LOOP_CARRIED}
        function once() { return 2 + __n; }
        var n = once();
        if (n + 1 !== 6) throw new Error("n + 1 === " + (n + 1));
        if (typeof n !== "number") throw new Error("typeof n === " + typeof n);
      `),
    ).toBe(null);
  });
});

describe("#4653 P/V — raw arguments and omitted actuals", () => {
  // ROW S13_A15_T3. A formal named `arguments` is an ordinary JavaScript
  // binding: when the call omits it, the value is `undefined`, not the null
  // zero of a nullable reference ABI. Keep both the omitted and supplied
  // cases live so the widening cannot simply special-case zero arguments.
  it("keeps an omitted named `arguments` parameter undefined", async () => {
    expect(
      await runScript(`
        var arguments = "The Ultimate Question";
        function __func(arguments) { return arguments; }
        if (typeof __func() !== "undefined") throw new Error("typeof __func() was not undefined");
        if (__func("The Ultimate Question") !== "The Ultimate Question") {
          throw new Error("supplied arguments value was not preserved");
        }
      `),
    ).toBe(null);
  });

  // ROW S13_A2_T2. The surplus string is visible through the function's
  // implicit arguments object, so `+` must perform ToPrimitive at runtime
  // instead of taking the numeric fast path inferred from `arg`.
  it("concatenates a surplus string through an arguments-observing IIFE", async () => {
    expect(
      await runScript(`
        var x = (function __func(arg) { return arg + arguments[1]; })(1, "1");
        if (x !== "11") throw new Error("x === " + String(x));
        if (typeof __func !== "undefined") throw new Error("IIFE name leaked");
      `),
    ).toBe(null);
  });
});

// ───────────────────────── measured residuals ─────────────────────────
//
// Each of the remaining rows below reproduces an #4653 behavior this change
// does NOT fix, with the root measured on this branch. They are `it.fails` so
// the suite records the current answer and flips loudly when the owning lane
// lands.

describe("#4653 fixed arguments.callee binding", () => {
  // ROWS S13.2.2_A18_T1 / _T2. `callee` is a real, writable own property of
  // the standalone arguments vec (§10.6 step 13.a). The dynamic `with`
  // HasBinding arm now consults that descriptor through the arguments subtype,
  // so the assignment lands on the arguments object instead of the outer
  // binding. The exact upstream pair and declaration/expression identity
  // controls live in es5-function-callee-with.test.ts.
  it("(#4653) `with (arguments)` resolves the non-enumerable `callee`", async () => {
    expect(
      await runScript(`
        var callee = 0;
        var obj = { callee: "a" };
        var result = (function () {
          with (arguments) { callee = 1; }
          return arguments;
        })(obj);
        if (callee !== 0) throw new Error("outer callee === " + callee);
        if (result.callee !== 1) throw new Error("arguments.callee === " + String(result.callee));
      `),
    ).toBe(null);
  });
});

describe("#4653 residuals — measured standalone", () => {
  // ROW S13.2.2_A19_T8. Two `with` blocks over a RE-DECLARED `var obj` share one
  // static target proof, keyed off the FIRST initializer's key set, so a name
  // only the second literal owns falls through to the outer lexical binding.
  // Measured: identical program with two DISTINCT target variables is correct.
  it("(#4653 residual, with-scope) a re-declared `with` target re-proves its key set", async () => {
    expect(
      await runScript(`
        var a = 1, b = "a";
        var obj = { a: 2 };
        with (obj) { var f = function () { return a; }; }
        var first = f();
        var obj = { a: 3, b: "b" };
        with (obj) { var f = function () { return b; }; }
        if (first !== 2) throw new Error("first === " + String(first));
        if (f() !== "b") throw new Error("second === " + String(f()));
      `),
    ).toBe(null);
  });

  // ROW S13.2.2_A17_T3. A `var f = function(){}` declared INSIDE a `with` body,
  // where the target owns the same name, traps: "dereferencing a null pointer
  // in __module_init". The #4264 hoisted-var widening gives the slot an
  // externref, but the closure that the with-routed write installs is never
  // reachable from the outer read.
  it.fails("(#4653 residual, with-scope) `with(o) { var f = function(){} }` does not trap", async () => {
    expect(
      await runScript(`
        p1 = "alert";
        this.obj = { p1: 1, getRight: function () { return "right"; } };
        var getRight = function () { return "napravo"; };
        var out = (function () {
          with (obj) {
            p1 = "w1";
            var getRight = function () { return false; };
            return p1;
          }
        })();
        if (p1 !== "alert") throw new Error("global p1 === " + String(p1));
        if (getRight() !== "napravo") throw new Error("outer getRight() === " + String(getRight()));
        if (out !== "w1") throw new Error("out === " + String(out));
      `),
    ).toBe(null);
  });

  // ROW S13.2.2_A2. Calling a NON-callable instance must throw TypeError
  // (§7.3.14 Call step 1). The single-assignment `new FACTORY()` alias used
  // to fall through to undefined; the call-dispatch arm now proves that its
  // constructor returns an ordinary, non-callable object.
  it("(#4653 call-dispatch) calling a non-callable instance throws TypeError", async () => {
    expect(
      await runScript(`
        function PROTO() {}
        PROTO.type = "flower";
        function FACTORY() {}
        FACTORY.prototype = PROTO;
        var rose = new FACTORY();
        var kind = "no-throw";
        try { rose(); } catch (e) { kind = (e instanceof TypeError) ? "TypeError" : "other:" + String(e); }
        if (kind !== "TypeError") throw new Error("threw " + kind);
      `),
    ).toBe(null);
  });

  it("keeps a reassigned instance alias callable", async () => {
    expect(
      await runScript(`
        function FACTORY() {}
        var rose = new FACTORY();
        rose = function () { return "callable"; };
        if (rose() !== "callable") throw new Error("rose() was not callable");
      `),
    ).toBe(null);
  });

  // ROW S13.2.2_A8_T3 — root corrected TWICE; see the issue file for both
  // superseded versions and why each was wrong. Final measured rule: inside
  // eval'd / minted code, UPDATE expressions must resolve bindings in every
  // supported environment. #4662 landed independently while this branch was
  // being rebased, so these former expected-failure pins are now positive
  // controls for that upstream behavior.
  //
  // This is the row's own shape: `++` on a Function-mint parameter.
  it("(#4662) `++` on a Function-mint PARAMETER resolves", async () => {
    expect(
      await runScript(`
        function host() { return new Function("p", "p++; return p;")(1); }
        if (host() !== 2) throw new Error("host() === " + String(host()));
      `),
    ).toBe(null);
  });

  // The gate is NOT "there is an enclosing function": the same mint at module
  // top level throws too, because a Function parameter is always bound in a
  // function environment. This pin is what falsifies the enclosing-function
  // reading, so it must stay separate from the one above.
  it("(#4662) `++` on a mint parameter resolves at MODULE TOP LEVEL too", async () => {
    expect(
      await runScript(`
        var mint = new Function("p", "p++; return p;");
        if (mint(1) !== 2) throw new Error("mint(1) === " + String(mint(1)));
      `),
    ).toBe(null);
  });

  // The most common real-world shape, and the one both earlier readings of this
  // root missed: the name is a local of the ENCLOSING function — neither
  // eval-local nor module-level. No loop, so this also rules out the
  // "loop-test position" reading on its own.
  it("(#4662) `++` on an ENCLOSING-FUNCTION local resolves inside eval", async () => {
    expect(
      await runScript(`
        function host() { var d = 0; eval("d++;"); return d; }
        if (host() !== 1) throw new Error("host() === " + String(host()));
      `),
    ).toBe(null);
  });

  // Same environment, eval-local spelling.
  it("(#4662) `++` on an eval-LOCAL var resolves inside a function", async () => {
    expect(
      await runScript(`
        function host() { return eval("var i = 0; i++; i"); }
        if (host() !== 1) throw new Error("host() === " + String(host()));
      `),
    ).toBe(null);
  });

  // Additional positive controls distinguish update-expression resolution from
  // ordinary reads and assignments through the same environments.
  it("binds a Function parameter for a plain read and for `p = p + 1`", async () => {
    expect(
      await runScript(`
        function host() {
          if (new Function("p", "return p;")(7) !== 7) throw new Error("plain read");
          if (new Function("p", "return p + 1;")(1) !== 2) throw new Error("read + add");
          if (new Function("p", "p = p + 1; return p;")(1) !== 2) throw new Error("compound assign");
          if (new Function("x", "y", "return y;")(1, 2) !== 2) throw new Error("two params");
          return 1;
        }
        if (host() !== 1) throw new Error("host() === " + String(host()));
      `),
    ).toBe(null);
  });

  // A MODULE-environment binding — this is the cell that passes, and mislabelling
  // it "outer binding" is what produced the second wrong rule. It is not "outer",
  // it is "bound in the module environment"; an enclosing function's own local is
  // equally "outer" relative to the eval and it throws (pin above).
  it("increments a MODULE-environment binding from inside an eval in a function", async () => {
    expect(
      await runScript(`
        var d = 0;
        function host() { eval("while (d < 3) { d++; }"); return d; }
        if (host() !== 3) throw new Error("d === " + String(host()));
      `),
    ).toBe(null);
  });

  // Reads and compound assignment on a function-env binding work — the operator
  // half of the rule, pinned separately from the environment half.
  it("reads and compound-assigns a function-env binding from inside an eval", async () => {
    expect(
      await runScript(`
        function host() {
          var d = 41;
          if (eval("d + 1") !== 42) throw new Error("read");
          var e = 0;
          eval("e = e + 1;");
          if (e !== 1) throw new Error("compound assign, e === " + String(e));
          return 1;
        }
        if (host() !== 1) throw new Error("host() === " + String(host()));
      `),
    ).toBe(null);
  });

  // ROW 13.2-18-1. Keep this sentinel on the exact upstream file: smaller
  // `runScript` approximations now pass and would falsely report this row as
  // closed, while the propertyHelper-backed Test262 program remains red.
  it("(#4491) `fun.prototype` is an own property, not an inherited accessor", async () => {
    const result = await runTest262File(
      resolve("test262/test/language/statements/function/13.2-18-1.js"),
      "issue-4653-residual",
      120_000,
      "standalone",
    );
    expect(result.status, result.error).toBe("pass");
  });

  it("keeps ordinary-function prototype descriptors distinct from arrows", async () => {
    expect(
      await runScript(`
        var ordinary = function () {};
        var own = Object.getOwnPropertyDescriptor(ordinary, "prototype");
        if (!own || own.value !== ordinary.prototype) throw new Error("missing value");
        if (own.writable !== true || own.enumerable !== false || own.configurable !== false) {
          throw new Error("wrong attributes");
        }
        var arrow = () => 1;
        if (Object.getOwnPropertyDescriptor(arrow, "prototype") !== undefined) {
          throw new Error("arrow acquired prototype");
        }
      `),
    ).toBe(null);
  });

  it("really deletes a configurable Function.prototype expando", async () => {
    expect(
      await runScript(`
        Object.defineProperty(Function.prototype, "prototype", {
          get: function () { return 17; }, configurable: true
        });
        if (Function.prototype.prototype !== 17) throw new Error("getter missing");
        if (!delete Function.prototype.prototype) throw new Error("delete refused");
        if (Object.getOwnPropertyDescriptor(Function.prototype, "prototype") !== undefined) {
          throw new Error("descriptor survived delete");
        }
        if (Function.prototype.prototype !== undefined) throw new Error("value survived delete");
      `),
    ).toBe(null);
  });

  it.fails("routes a with-scoped var function initializer through the object environment", async () => {
    const result = await runTest262File(
      resolve("test262/test/language/statements/function/S13.2.2_A17_T3.js"),
      "issue-4653-residual",
      120_000,
      "standalone",
    );
    expect(result.status, result.error).toBe("pass");
  });

  it("captures each redeclared with environment in its function expression", async () => {
    const result = await runTest262File(
      resolve("test262/test/language/statements/function/S13.2.2_A19_T8.js"),
      "issue-4653-residual",
      120_000,
      "standalone",
    );
    expect(result.status, result.error).toBe("pass");
  });

  // Adjacent to F, and NOT closed by it: `new F()` now links the assigned
  // prototype, but `instanceof` still answers false for the same binding.
  it.fails("(#4653 residual) `instanceof` follows a late-assigned fnctor's prototype", async () => {
    expect(
      await runScript(`
        var A;
        A = function () {};
        A.prototype = { shape: "cube" };
        var a = new A();
        if (!(a instanceof A)) throw new Error("a instanceof A === false");
      `),
    ).toBe(null);
  });
});
