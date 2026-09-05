// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4620) Two standalone CRASH classes behind the ES5 `this`-binding bucket,
// plus the residuals they exposed.
//
// 1. **Opaque function replacer.** `String.prototype.replace(str, fn)` only had
//    a function arm for a replacer that compiles to a closure STRUCT (#4224).
//    A function VALUE — `var g = function () {…}`, or an IIFE's result, which
//    is what `language/function-code/10.4.3-1-102-s` passes — reaches the call
//    site as an opaque `externref`, declined that arm, and fell into the naive
//    `__str_replace` arm in `string-ops.ts`, which `ref.cast`s its replacement
//    operand to `$AnyString`: `RuntimeError: illegal cast in __module_init`.
//    Now routed through the `__apply_closure` bridge
//    (`replacer-apply-bridge.ts`).
//
// 2. **Concrete-ref `try_table` block type.** The receiver-install trampoline
//    in `named-this-call.ts` wrapped its call in
//    `try_table (result (ref null $T)) (catch $exc 0)`. On Node v22 / V8 12.4
//    that traps `unreachable` ON ENTRY (verified in a hand-built module with no
//    compiler involved; `i32` and `externref` block types are fine). Every
//    `foo.call(x)` on a named function that reads `this` and returns a string
//    or an object died there — `10.4.3-1-{1,2,4,5}-s`. The result is now parked
//    in a local inside the protected body.
//
// Every case runs its work in TOP-LEVEL statements: both defects live in
// `__module_init`, and the trampoline arm is chosen by the call site's shape.
// Note the module goal makes all code STRICT, so the sloppy half of §10.4.3
// (`this` → the global object) is not expressible here; it is covered by the
// test262 rows themselves (`__probe`-style script-goal runs).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runModule(src: string): Promise<number | string> {
  const r = await compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number | string }).test();
}

describe("#4620 opaque function replacer for String.prototype.replace", () => {
  it("calls a var-held function replacer instead of casting it to a string", async () => {
    expect(
      await runModule(`
      var g = function (m) { return "<" + m + ">"; };
      var r = "abc".replace("b", g);
      export function test() { return r === "a<b>c" ? 1 : 0; }
    `),
    ).toBe(1);
  });

  it("calls an IIFE-returned replacer (the 10.4.3-1-102-s shape) with an undefined this", async () => {
    expect(
      await runModule(`
      var x = 3;
      var r = "ab".replace("b", (function () { return function () { x = this; return "a"; } })());
      export function test() { return (r === "aa" ? 1 : 0) + (x === undefined ? 2 : 0); }
    `),
    ).toBe(3);
  });

  it("shows an under-arity replacer every argument through `arguments`", async () => {
    expect(
      await runModule(`
      var g = function () { return arguments.length + "|" + arguments[1] + "|" + arguments[2]; };
      var r = "abcb".replace("b", g);
      export function test() { return r === "a3|1|abcbcb" ? 1 : 0; }
    `),
    ).toBe(1);
  });

  it("ToStrings a non-string replacer result", async () => {
    expect(
      await runModule(`
      var g = function () { return 5; };
      var h = function () { };
      var r = "ab".replace("b", g) + "/" + "ab".replace("b", h);
      export function test() { return r === "a5/aundefined" ? 1 : 0; }
    `),
    ).toBe(1);
  });

  it("walks every match for replaceAll with an opaque replacer", async () => {
    expect(
      await runModule(`
      var g = function (m) { return "<" + m + ">"; };
      var r = "aba".replaceAll("a", g);
      export function test() { return r === "<a>b<a>" ? 1 : 0; }
    `),
    ).toBe(1);
  });

  it("keeps the plain string-replacement arm for a string replacement", async () => {
    expect(
      await runModule(`
      var s = "Z";
      var r = "ab".replace("b", s);
      export function test() { return r === "aZ" ? 1 : 0; }
    `),
    ).toBe(1);
  });
});

describe("#4620 receiver-install trampoline with a ref-typed result", () => {
  it("does not trap when the .call target returns a string", async () => {
    expect(
      await runModule(`
      function foo() { var t = this; return "a" + (typeof t); }
      var r = foo.call(1);
      export function test() { return r === "anumber" ? 1 : 0; }
    `),
    ).toBe(1);
  });

  it("does not trap when the .call target returns an object", async () => {
    expect(
      await runModule(`
      function foo() { return { seen: typeof this }; }
      var o = foo.call("s");
      export function test() { return o.seen === "string" ? 1 : 0; }
    `),
    ).toBe(1);
  });

  it("keeps a strict primitive receiver un-boxed (10.4.3-1-1-s, strict half)", async () => {
    expect(
      await runModule(`
      function foo() { return typeof this; }
      var a = foo.call(1), b = foo.call("s"), c = foo.call(true);
      export function test() { return (a === "number" ? 1 : 0) + (b === "string" ? 2 : 0) + (c === "boolean" ? 4 : 0); }
    `),
    ).toBe(7);
  });

  it("still restores the ambient receiver after the call", async () => {
    expect(
      await runModule(`
      function inner() { return typeof this; }
      function outer() { var before = typeof this; var mid = inner.call(1); return before + "/" + mid + "/" + (typeof this); }
      var r = outer.call("s");
      export function test() { return r === "string/number/string" ? 1 : 0; }
    `),
    ).toBe(1);
  });

  it("propagates a throw out of the trampoline with the receiver restored", async () => {
    expect(
      await runModule(`
      function boom() { if (this === 1) { throw "x"; } return "no"; }
      var caught = "none";
      try { boom.call(1); } catch (e) { caught = "" + e; }
      export function test() { return caught === "x" ? 1 : 0; }
    `),
    ).toBe(1);
  });
});
