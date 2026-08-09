// #3486 — JS-host lane: a fnctor instance's `.constructor` resolved to `Array`.
//
// ROOT CAUSE (proved by instrumentation, NOT the hypothesis recorded in the
// issue file — the throw/catch marshaling path is not involved at all; a plain
// `new MyError()` that is never thrown reproduced identically):
//
//   1. `src/runtime.ts`'s `extern_get` answered the `constructor` key for ANY
//      WasmGC struct with `Array`, because its vec discriminator was
//      `typeof __vec_len(obj) === "number"` — and `__vec_len`'s not-a-vec
//      DEFAULT is `0` (see the ref.test dispatch chain built in
//      `codegen/vec-access-exports.ts`; it returns 0, it does not throw). The
//      test is therefore vacuously true for every struct. #2836 replaced this
//      exact vacuity with the positive `__is_vec` discriminator at the other
//      `__vec_len` call sites; the `.constructor` arm was missed.
//
//   2. Even with (1) fixed the answer was `undefined`, because the #1712
//      instance → ctor-closure link was never registered for this shape: the
//      ctor-prologue registration required a closure global that only exists
//      after an earlier identifier-as-VALUE read, and in the test262 shape
//      (`assert.throws(DummyError, function(){ … new DummyError() … })`) the
//      callback body compiles BEFORE the argument, so the gate missed and the
//      once-synthesized ctor was permanently link-less.
//
// The value handed back is the RAW closure struct, not a `_wrapCallableForHost`
// wrapper: compiled `===` on two externrefs reaches `__host_eq` in some shapes
// (which unwraps a wrapper) but `ref.eq` in others (which does not), and only
// the raw struct satisfies both. Measured: with the wrapper, the through-a-
// parameter comparison passed but the direct one still returned 0.
//
// Every assertion below is on an OBSERVABLE value, and each was confirmed to
// FAIL against the pre-fix compiler (`ctorIdentity` 0 / `ctorName` "Array").
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#3486 — fnctor instance .constructor identity (JS-host lane)", () => {
  it("a caught custom-error instance's .constructor is its real constructor, not Array", async () => {
    const exp = await run(`
      // @ts-nocheck
      function MyError(message) { this.message = message; }
      function OtherError() {}
      export function caughtIdentity() {
        var caught;
        try { throw new MyError("boom"); } catch (e) { caught = e; }
        return caught.constructor === MyError ? 1 : 0;
      }
      export function caughtCrossCheck() {
        var caught;
        try { throw new MyError("boom"); } catch (e) { caught = e; }
        return caught.constructor === OtherError ? 1 : 0;
      }
      export function caughtCtorName() {
        var caught;
        try { throw new MyError("boom"); } catch (e) { caught = e; }
        return String(caught.constructor && caught.constructor.name);
      }
    `);
    // Pre-fix: 0 / 0 / "Array".
    expect(exp.caughtIdentity()).toBe(1);
    // Genuine, not vacuous: a DIFFERENT compiled constructor stays false, so
    // this cannot be a null≡null / everything-matches tautology.
    expect(exp.caughtCrossCheck()).toBe(0);
    // The wrong "Array" answer is gone. `.name` read DYNAMICALLY off a closure
    // struct is a separate, pre-existing host gap (a bare `MyError.name` folds
    // statically and works; `f(MyError).name` through a parameter is already
    // `undefined` on unmodified main) — asserted here only as "no longer
    // Array", so this test cannot silently start passing for that reason.
    expect(exp.caughtCtorName()).not.toBe("Array");
  });

  it("the link does not depend on the throw — a plain instance behaves identically", async () => {
    const exp = await run(`
      // @ts-nocheck
      function MyError(message) { this.message = message; }
      export function plainIdentity() {
        var inst = new MyError("x");
        return inst.constructor === MyError ? 1 : 0;
      }
    `);
    // The issue file hypothesised an exception-marshaling defect; this case
    // never throws and reproduced identically pre-fix (returned 0).
    expect(exp.plainIdentity()).toBe(1);
  });

  it("holds through a function parameter — the shape test262's assert.throws uses", async () => {
    const exp = await run(`
      // @ts-nocheck
      function DummyError() { }
      function throwsCheck(expectedErrorConstructor, func) {
        try {
          func();
        } catch (thrown) {
          if (typeof thrown !== "object" || thrown === null) return "not-object";
          if (thrown.constructor !== expectedErrorConstructor) return "mismatch";
          return "ok";
        }
        return "no-throw";
      }
      export function harnessShape() {
        var base = null;
        var prop = function () { throw new DummyError(); };
        var expr = function () { return 1; };
        return throwsCheck(DummyError, function () {
          base[prop()] *= expr();
        });
      }
      export function harnessShapeWrongCtor() {
        function OtherError() {}
        return throwsCheck(OtherError, function () { throw new DummyError(); });
      }
    `);
    // This is verbatim the S11.13.2_A7.* / S11.4.x_A6 shape. Pre-fix: "mismatch".
    expect(exp.harnessShape()).toBe("ok");
    expect(exp.harnessShapeWrongCtor()).toBe("mismatch");
  });

  it("the compile-order trap is closed: constructing BEFORE the first value read still links", async () => {
    const exp = await run(`
      // @ts-nocheck
      function MyError(message) { this.message = message; }
      export function constructBeforeValueRead() {
        // \`new MyError()\` compiles (and RUNS) before \`MyError\` is ever
        // evaluated as a value — the ordering that left the ctor permanently
        // link-less before #3486.
        var caught;
        try { throw new MyError("boom"); } catch (e) { caught = e; }
        return caught.constructor === MyError ? 1 : 0;
      }
    `);
    expect(exp.constructBeforeValueRead()).toBe(1);
  });

  it("a genuine vec still reports .constructor === Array (the #1057 behaviour is preserved)", async () => {
    const exp = await run(`
      // @ts-nocheck
      export function splitResult() {
        var a = "a,b".split(",");
        var f = function (t) { return t.constructor === Array ? 1 : 0; };
        return f(a);
      }
      export function mapResult() {
        var a = [1, 2, 3].map(function (x) { return x * 2; });
        var f = function (t) { return t.constructor === Array ? 1 : 0; };
        return f(a);
      }
      export function literalArray() {
        var a = [1, 2, 3];
        var f = function (t) { return t.constructor === Array ? 1 : 0; };
        return f(a);
      }
    `);
    // The `__is_vec` swap must not narrow the genuine-vec answer: `__is_vec`
    // ref.tests exactly the same registered vec types `__vec_len` does, so the
    // ONLY behavioural delta is the not-a-vec default.
    expect(exp.splitResult()).toBe(1);
    expect(exp.mapResult()).toBe(1);
    expect(exp.literalArray()).toBe(1);
  });

  it("own fields and enumeration are untouched; prototype-method lookup now works in this shape too", async () => {
    const exp = await run(`
      // @ts-nocheck
      function MyError(message) { this.message = message; }
      export function ownField() {
        return String(new MyError("hello").message);
      }
      export function protoMethod() {
        MyError.prototype.describe = function () { return "d:" + this.message; };
        return String(new MyError("q").describe());
      }
      export function ownKeys() {
        return Object.keys(new MyError("q")).join(",");
      }
    `);
    // Own-field read and own-key enumeration are byte-for-byte the pre-fix
    // answers — the registration must not add an enumerable own property or
    // shadow a typed struct field.
    expect(exp.ownField()).toBe("hello");
    expect(exp.ownKeys()).toBe("message");
    // `protoMethod` is a DELIBERATE behaviour change, recorded rather than
    // glossed: the #1712 instance → ctor link now also fires when `new F()`
    // compiles before F's first identifier-as-value read, so `_fnctorProtoLookup`
    // resolves the prototype method here where pre-fix it threw
    // "describe is not a function". That is the spec-correct direction
    // (§10.2.5 OrdinaryCreateFromConstructor), and it is #1712's own stated
    // intent — it was simply gated on a compile-order accident.
    expect(exp.protoMethod()).toBe("d:q");
  });
});
