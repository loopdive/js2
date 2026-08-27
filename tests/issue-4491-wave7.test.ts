// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4491 wave-7 — the §20.1.3.6 class tag on a DYNAMIC receiver (standalone).
 *
 * One root, measured: `Object.prototype.toString` has two lowerings and only
 * one of them can see a runtime value. The syntactic `…toString.call(v)` form
 * is owned by the #2501 compile-time fold, whose standalone ladder ends in a
 * `[object Object]` that is a FALLBACK, not a classification — and under
 * `allowJs` every `any` receiver lands there. So the tag was answered by a
 * constant that had never looked at the value:
 *
 * ```js
 * var t = function (v) { return Object.prototype.toString.call(v); };
 * t([1,2]); t(function(){}); t(null); t(new String("a")); t(1);
 * //  → "[object Object]" for all five, on the campaign base
 * ```
 *
 * while the same question with a syntactically-visible operand answered
 * correctly. The #4119 RUNTIME classifier could already prove most of them; it
 * was simply not reachable from this spelling.
 *
 * This slice makes it reachable — runtime answer when the classifier can PROVE
 * one, the fold's constant otherwise, never the other way round — and adds the
 * two arms the classifier was missing: the ORDINARY builtin prototypes
 * (`Error.prototype` / `Object.prototype` → `[object Object]`, which used to
 * THROW) and the `arguments` exotic (`[object Arguments]`, which used to read
 * `[object Array]` because both share `$Vec`).
 *
 * Every pin EXECUTES the classification through a receiver the fold cannot
 * read, and the receiver is produced by a helper call or a loop so no
 * compile-time fold can substitute for the path under test. The controls at the
 * end are the ones that must NOT move: a real array still tags `Array` (the
 * Arguments arm runs first, so this is what proves it did not steal the case),
 * a plain object still tags `Object` (the fallback survives), and a statically
 * named Date still folds to `Date` (the fold keeps precedence where it KNOWS,
 * because the classifier cannot prove a Date carrier and would fall back).
 *
 * `it.fails` pins the measured residuals with their owners.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * `deferTopLevelInit` + `hostBridge: "always"` are NOT decoration — they are the
 * options `tests/test262-runner.ts` compiles every standalone row with, and two
 * of the pins below are INSENSITIVE without them. Measured while verifying the
 * revert arm: the `Error.prototype` / `Object.prototype` refusal pins passed on
 * the reverted sources under the simpler option set, i.e. they were assertions
 * about the code rather than tests of it. Under the runner's options all four
 * spellings of the idiom (`Error.prototype.toString`, `.getClass`, through a
 * dynamic holder, and `Object.prototype.toString()`) throw on base — so the pin
 * fails on the arm it claims to test. Deferring top-level init means the module
 * body runs from `__module_init`, which the caller must invoke, exactly as the
 * runner does after `setInstance`.
 */
async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
  });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  expect(WebAssembly.validate(result.binary!), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary!, {});
  const exports = instance.exports as { main: () => unknown; __module_init?: () => unknown };
  if (typeof exports.__module_init === "function") exports.__module_init();
  return exports.main();
}

/**
 * Wrap a body that must set `RESULT` to 1. `tagOf` is the dynamic-receiver
 * spelling under test: a helper whose parameter the checker types `any`, which
 * is the shape that reached the fold's unproven terminal.
 */
const withTagOf = (body: string): string => `
  function tagOf(v) { return Object.prototype.toString.call(v); }
  ${body}
`;

describe("#4491 wave-7 — the runtime classifier is reachable from `.call(v)`", () => {
  it("tags an ARRAY through a dynamic receiver", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          var arr = [];
          for (var i = 0; i < 3; i++) arr[i] = i;
          var T = tagOf(arr);
          export function main() { return T === "[object Array]" ? 1 : 0; }
        `),
      ),
    ).toBe(1);
  });

  it("tags a FUNCTION value through a dynamic receiver", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          function f() { return 1; }
          var pick = [f];
          var T = tagOf(pick[0]);
          export function main() { return T === "[object Function]" ? 1 : 0; }
        `),
      ),
    ).toBe(1);
  });

  it("tags null and undefined through a dynamic receiver", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          var holder = {};
          holder.n = null;
          var A = tagOf(holder.n);
          var B = tagOf(holder.missing);
          export function main() {
            return (A === "[object Null]" && B === "[object Undefined]") ? 1 : 0;
          }
        `),
      ),
    ).toBe(1);
  });

  it("tags a boxed String / Number / Boolean object through a dynamic receiver", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          var box = {};
          box.s = new String("a");
          box.n = new Number(5);
          box.b = new Boolean(true);
          var A = tagOf(box.s), B = tagOf(box.n), C = tagOf(box.b);
          export function main() {
            return (A === "[object String]" && B === "[object Number]" && C === "[object Boolean]") ? 1 : 0;
          }
        `),
      ),
    ).toBe(1);
  });

  // `built-ins/Number/15.7.4-1.js` verbatim: §21.1.3 makes `Number.prototype`
  // itself a Number object. `Object.getPrototypeOf(...)` types as `any`, so the
  // fold answered its `[object Object]` fallback while the classifier's branded
  // `$NativeProto` arm already knew the right answer.
  it("tags Number.prototype reached through Object.getPrototypeOf", async () => {
    expect(
      await runStandalone(`
        var numProto = Object.getPrototypeOf(new Number(42));
        var s = Object.prototype.toString.call(numProto);
        export function main() { return s === "[object Number]" ? 1 : 0; }
      `),
    ).toBe(1);
  });
});

describe("#4491 wave-7 — the ORDINARY builtin prototypes stop throwing", () => {
  // `built-ins/Error/prototype/S15.11.4_A2.js`. On the base this THREW
  // "Object.prototype.toString is not yet implemented in --target standalone",
  // because `Error.prototype` is a `$NativeProto` that matched none of the five
  // exotic brands and fell out of the chain into the refusal.
  //
  // The receiver arrives through a DYNAMIC holder, and that detail is the whole
  // pin. Written the way the corpus row writes it —
  // `Error.prototype.toString = Object.prototype.toString; …toString()` — this
  // pin PASSES on the reverted sources: bare (un-harnessed) source takes a
  // lowering that answers `[object Object]` without ever consulting the
  // classifier, so the pin would have been an assertion about the code rather
  // than a test of it.
  //
  // Bisected on the revert arm across seven spellings. Refuse on base and
  // answer on the branch: via a dynamic holder, via a helper parameter. Refuse
  // on BOTH: the syntactic `X.prototype.m()` receiver and `m.call(X.prototype)`
  // — pinned as residuals below. Answer on both (so, insensitive): the corpus
  // spelling, and the corpus spelling plus an unrelated
  // `Object.prototype.toString.call(x)` fold site elsewhere in the module.
  // The corpus row refuses under the full test262 harness assembly; this is the
  // smallest source that refuses without it.
  it("Error.prototype answers [object Object] instead of refusing", async () => {
    expect(
      await runStandalone(`
        var box = {};
        box.p = Error.prototype;
        box.p.getClass = Object.prototype.toString;
        var t = box.p.getClass();
        export function main() { return t === "[object Object]" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  // `built-ins/Object/prototype/S15.2.4_A1_T2.js`'s first assertion, same
  // dynamic-holder shape for the same sensitivity reason.
  it("Object.prototype answers [object Object] instead of refusing", async () => {
    expect(
      await runStandalone(`
        var box = {};
        box.p = Object.prototype;
        box.p.getClass = Object.prototype.toString;
        var t = box.p.getClass();
        export function main() { return t === "[object Object]" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  // RegExp.prototype is the third member of the ordinary-prototype list that
  // the census did not point at, included so the list is exercised rather than
  // merely declared.
  it("RegExp.prototype answers [object Object] instead of refusing", async () => {
    expect(
      await runStandalone(`
        var box = {};
        box.p = RegExp.prototype;
        box.p.getClass = Object.prototype.toString;
        var t = box.p.getClass();
        export function main() { return t === "[object Object]" ? 1 : 0; }
      `),
    ).toBe(1);
  });
});

describe("#4491 wave-7 — the `arguments` exotic is not an Array", () => {
  // `built-ins/Object/defineProperties/15.2.3.7-2-16.js` and
  // `built-ins/Object/create/15.2.3.5-4-15.js` reduced: the descriptor-map
  // getter must observe `this` as the arguments object, and the ONLY way the
  // test can tell is the class tag. The receiver arrives at the classifier as a
  // bare externref, so nothing syntactic can answer it.
  it("a descriptor-map getter sees `this` as [object Arguments]", async () => {
    expect(
      await runStandalone(`
        var seen = "";
        var ran = 0;
        var Fun = function () { return arguments; };
        var props = new Fun();
        Object.defineProperty(props, "prop", {
          get: function () {
            ran = ran + 1;
            seen = Object.prototype.toString.call(this);
            return {};
          },
          enumerable: true
        });
        var obj = {};
        Object.defineProperties(obj, props);
        export function main() {
          return (ran === 1 && seen === "[object Arguments]" && obj.hasOwnProperty("prop")) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  // The same object read through the dynamic-receiver helper rather than as
  // `this`, so the two spellings cannot disagree about one value.
  it("tags a MOP-observable arguments object through a dynamic receiver", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          var Fun = function () { return arguments; };
          var argObj = new Fun(1, 2);
          Object.defineProperty(argObj, "p", { value: 1, enumerable: true });
          var T = tagOf(argObj);
          export function main() { return T === "[object Arguments]" ? 1 : 0; }
        `),
      ),
    ).toBe(1);
  });

  // A REFUTED hypothesis, kept as a pin rather than as a caveat. The arm reads
  // #4658's `OBJ_FLAG_ARGUMENTS`, which that slice mints only when its
  // observability proof says the object escapes — so "an arguments object that
  // never reaches a MOP call is unbranded and still reads `[object Array]`" was
  // written here as an `it.fails` residual. It does not reproduce: measured
  // across all five construction spellings (`(function(){return arguments})()`,
  // `new Fun()`, `new Fun(1,2)`, a declaration called with args, and
  // `arguments` read inside its own body), every one answers
  // `[object Arguments]` with no `defineProperty` anywhere in the module.
  // Merely being passed to a function is enough to make it observable. The
  // stated limit of the arm is therefore a code-level fact about #4658's gate,
  // not a measured failure — and this pin is what would catch it becoming one.
  it("tags a PLAIN arguments object (no MOP call anywhere in the module)", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          var Fun = function () { return arguments; };
          var a = new Fun(1, 2);
          function decl() { return arguments; }
          var b = decl(3);
          var T1 = tagOf(a), T2 = tagOf(b);
          export function main() {
            return (T1 === "[object Arguments]" && T2 === "[object Arguments]") ? 1 : 0;
          }
        `),
      ),
    ).toBe(1);
  });
});

describe("#4491 wave-7 — controls that must NOT move", () => {
  // The #4119 genericity family (`built-ins/Array/prototype/{slice,splice}`,
  // 71+ rows) is exactly this idiom. The Arguments test now runs BEFORE the
  // Array answer inside the same `$Vec` arm, so this is the pin that says the
  // reorder did not steal the array case.
  it("the ES5 `getClass` idiom on a real array still answers [object Array]", async () => {
    expect(
      await runStandalone(`
        var arr = [];
        for (var i = 0; i < 2; i++) arr[i] = i;
        arr.getClass = Object.prototype.toString;
        var t = arr.getClass();
        export function main() { return t === "[object Array]" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("a plain object through a dynamic receiver still answers [object Object]", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          var box = {};
          box.o = { x: 1 };
          var T = tagOf(box.o);
          export function main() { return T === "[object Object]" ? 1 : 0; }
        `),
      ),
    ).toBe(1);
  });

  // The fold keeps precedence where it KNOWS. A `Date`-typed receiver folds to
  // `[object Date]`; routing it to the classifier instead would answer the
  // fallback, because a Date carrier is one of the nominal structs the
  // classifier deliberately refuses. This is the pin for "runtime first" being
  // scoped to the UNPROVEN terminal and not applied blanket.
  it("a statically typed Date still folds to [object Date]", async () => {
    expect(
      await runStandalone(`
        var d = new Date(0);
        var t = Object.prototype.toString.call(d);
        export function main() { return t === "[object Date]" ? 1 : 0; }
      `),
    ).toBe(1);
  });
});

describe("#4491 wave-7 — measured residuals (it.fails)", () => {
  // The classifier has no arm for a Date / RegExp / Error INSTANCE — those are
  // nominal carriers it refuses — so a dynamic receiver still gets the fold's
  // fallback. Owner: whoever adds instance-carrier arms to
  // object-proto-tostring.ts. `Date` reached statically is covered by the
  // control above, which is why this only bites through an `any`.
  it.fails("a Date INSTANCE through a dynamic receiver still answers [object Object]", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          var box = {};
          box.d = new Date(0);
          var T = tagOf(box.d);
          export function main() { return T === "[object Date]" ? 1 : 0; }
        `),
      ),
    ).toBe(1);
  });

  // §21.3.1.9 / §25.5.3 give Math and JSON an own @@toStringTag. The FOLD knows
  // both (#4491 wave-5 T1's `symName` arms) but the classifier does not, so a
  // dynamic receiver falls back. Owner: the @@toStringTag step-15 arm.
  it.fails("Math through a dynamic receiver still answers [object Object]", async () => {
    expect(
      await runStandalone(
        withTagOf(`
          var box = {};
          box.m = Math;
          var T = tagOf(box.m);
          export function main() { return T === "[object Math]" ? 1 : 0; }
        `),
      ),
    ).toBe(1);
  });

  // The ordinary-prototype arms are reached only when the receiver arrives as a
  // runtime value. A SYNTACTIC `X.prototype` receiver — either as the call
  // receiver or as `m.call(X.prototype)` — is intercepted earlier and still
  // refuses on this branch, exactly as on base. Measured, not assumed: both
  // spellings THROW on both arms. Owner: whichever path owns the borrowed
  // `X.prototype` receiver (`transferred-proto-assignment.ts` / the #1888
  // borrowed-method dispatch), not this classifier.
  it.fails("a SYNTACTIC X.prototype receiver still refuses", async () => {
    expect(
      await runStandalone(`
        var m = Object.prototype.toString;
        var t = m.call(Object.prototype);
        export function main() { return t === "[object Object]" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  // §20.1.3.6 makes `Date.prototype` an ORDINARY object from ES2015 on, so this
  // must be `[object Object]`. It is not, on EITHER arm — the fold's
  // `symName === "Date"` arm is a proof as far as this slice is concerned, so
  // the receiver never reaches the classifier's ordinary-prototype arm and the
  // `Date` instance tag is emitted for the prototype. PRE-EXISTING: measured
  // identical on the reverted sources. Owner: the fold's `.prototype` handling,
  // which already has the four-exception table this case belongs in.
  it.fails("Date.prototype through a dynamic holder answers [object Object]", async () => {
    expect(
      await runStandalone(`
        var box = {};
        box.p = Date.prototype;
        box.p.getClass = Object.prototype.toString;
        var t = box.p.getClass();
        export function main() { return t === "[object Object]" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  // `built-ins/String/prototype/trim/15.5.4.20-2-51.js` — a DIFFERENT root, in
  // the borrowed-String-receiver coercion, not in the class tag. Arguments
  // shares the indexed vec carrier with Array, but its ordinary ToString is
  // the class tag rather than the elements joined by Array.prototype.toString.
  it("String.prototype.trim.call(<arguments>) observes the Arguments class tag", async () => {
    expect(
      await runStandalone(`
        var Fun = function () { return arguments; };
        var argObj = new Fun(1, 2, true);
        Object.defineProperty(argObj, "p", { value: 1, enumerable: true });
        var t = String.prototype.trim.call(argObj);
        export function main() { return t === "[object Arguments]" ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("keeps Array join coercion distinct from Arguments", async () => {
    expect(
      await runStandalone(`
        var arr = [1, 2, 3];
        var t = String.prototype.trim.call(arr);
        export function main() { return t === "1,2,3" ? 1 : 0; }
      `),
    ).toBe(1);
  });
});
