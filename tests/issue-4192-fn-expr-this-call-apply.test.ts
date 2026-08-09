// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4192 — `f.call(thisArg)` / `f.apply(thisArg)` must install the receiver when
// `f` is a variable-held FUNCTION EXPRESSION.
//
// A function DECLARATION already worked (#3796/#4025 `.call`, #3983 `.apply` —
// `named-this-call.ts` reserves an exact-target trampoline that saves,
// installs and restores `__current_this`). A function EXPRESSION did not:
// `resolveDeclaration` there demands `ts.isFunctionDeclaration`, and the call
// site gates the whole named-`this` arm on `!closureInfo` — and
// `var f = function () {}` registers a `closureMap` entry. So the dominant JS
// shape fell into the legacy arm, which evaluates `thisArg` and DROPS it. A
// silent wrong answer, and present in BOTH lanes — hence every case below runs
// host and standalone.
//
// Compile through the SAME lane the test262 runner uses — literal JavaScript
// with `allowJs`; an annotated `.ts` receiver takes a different, statically
// typed member-call route and does not reproduce it.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Compile `body` at TOP LEVEL (where `var f = function () {…}` really is a
 * module-level binding — nesting it inside a probe function changes the
 * closure shape and does not reproduce the defect), record its verdict in
 * `__r`, and read that back through an exported `test()`.
 */
async function run(body: string, standalone: boolean): Promise<number> {
  const r = await compile(`var __r = 0;\n${body}\nexport function test() { return __r; }`, {
    ...(standalone ? { target: "standalone" as const } : {}),
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  if (standalone) expect(r.imports ?? [], "standalone must stay host-free").toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown>;
  const { instance } = await WebAssembly.instantiate(r.binary, imports as never);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  const exports = instance.exports as { __module_init?(): void; test(): number };
  exports.__module_init?.();
  return exports.test();
}

/** Assert the probe answers 1 on the JS-host lane AND on `--target standalone`. */
async function expectBoth(body: string): Promise<void> {
  expect(await run(body, false), "JS-host lane").toBe(1);
  expect(await run(body, true), "standalone lane").toBe(1);
}

describe("#4192 `this` through .call/.apply on a variable-held function expression", () => {
  it("writes through `this` (the test262 S15.3.4.4_A5_T5 shape)", async () => {
    await expectBoth(`
      var f = function () { this.touched = true; };
      var obj = {};
      f.call(obj);
      __r = obj.touched === true ? 1 : 0;
    `);
  });

  it("reads through `this` and returns the value", async () => {
    await expectBoth(`
      var g = function () { return this.v; };
      __r = g.call({ v: 9 }) === 9 ? 1 : 0;
    `);
  });

  it("keeps the bound args positional alongside the receiver", async () => {
    await expectBoth(`
      var h = function (a, b) { return String(this.v) + ":" + String(a) + String(b); };
      __r = h.call({ v: 7 }, "x", "y") === "7:xy" ? 1 : 0;
    `);
  });

  it("works through .apply with an array literal", async () => {
    await expectBoth(`
      var h = function (a) { return String(this.v) + ":" + String(a); };
      __r = h.apply({ v: 5 }, ["z"]) === "5:z" ? 1 : 0;
    `);
  });

  it("works through .apply with no argument array", async () => {
    await expectBoth(`
      var f = function () { this.touched = true; };
      var obj = {};
      f.apply(obj);
      __r = obj.touched === true ? 1 : 0;
    `);
  });

  it("a NULL receiver still yields `undefined` (the spec row that must not move)", async () => {
    await expectBoth(`
      var g = function () { return typeof this; };
      __r = g.call(null) === "undefined" ? 1 : 0;
    `);
  });

  // The install/restore PAIRING, not just the install: the outer receiver must
  // survive an inner `.call` that installed a different one.
  it("restores the previous receiver after the call", async () => {
    await expectBoth(`
      var inner = function () { return String(this.tag); };
      var outer = function () { return inner.call({ tag: "IN" }) + "/" + String(this.tag); };
      __r = outer.call({ tag: "OUT" }) === "IN/OUT" ? 1 : 0;
    `);
  });

  it("leaves a function DECLARATION on its existing (already correct) path", async () => {
    await expectBoth(`
      function d() { return String(this.v); }
      __r = d.call({ v: 3 }) === "3" ? 1 : 0;
    `);
  });

  // An arrow ignores the `.call` receiver by spec — its `this` is lexical — so
  // `planClosureReceiverInstall` refuses arrows outright. Installing for them
  // would be a behaviour change, not a fix.
  it("does NOT install a dynamic receiver for an arrow", async () => {
    await expectBoth(`
      var a = () => 42;
      __r = a.call({ v: 1 }) === 42 ? 1 : 0;
    `);
  });

  it("does not disturb a callee that never mentions `this`", async () => {
    await expectBoth(`
      var p = function (x) { return "p" + String(x); };
      __r = p.call({ v: 1 }, 8) === "p8" ? 1 : 0;
    `);
  });
});
