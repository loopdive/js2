// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7009) A function-constructor STRUCT instance as `[[Prototype]]` of an
 * ordinary `$Object` under `--target standalone`.
 *
 * TypeScript's `__extends` stores `new __()` (a non-empty helper constructor, so
 * a `$__fnctor___` struct) as the subclass prototype. A runtime-VALUE `new I()`
 * seeds the instance with `__object_create(I.prototype)`, which stored the struct
 * as null: every inherited method was lost. The fix links the struct the way
 * #6766 links a Proxy (`src/codegen/object-model/struct-proto-link.ts`).
 *
 * "RED on base" pins fail on `origin/main` @ 47d9ff23b5; guards pass on both.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const EXTENDS = `
var __extends = function (d, b) {
  function __() { this.constructor = d; }
  __.prototype = b.prototype; d.prototype = new __();
};
function AST(n) { this.nodeType = n; }
AST.prototype.kind = function () { return this.nodeType; };
function Identifier() { this.nodeType = 7; }
__extends(Identifier, AST);
var I = Identifier;
`;

async function run(body: string): Promise<unknown> {
  const result = await compile(`${EXTENDS}\n${body}`, {
    target: "standalone",
    fileName: "issue-7009.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const exports = instance.exports as { __module_init?: () => void; run: () => unknown };
  exports.__module_init?.();
  return exports.run();
}

describe("#7009 — a fnctor struct as [[Prototype]] survives a runtime-value `new`", () => {
  it("RED on base (throws): `new I().kind()` reaches the inherited method", async () => {
    expect(await run(`export function run() { return new I().kind(); }`)).toBe(7);
  });

  it("RED on base (0): getPrototypeOf answers the struct prototype itself", async () => {
    expect(
      await run(`export function run() {
        var o = new I();
        return (I.prototype === Identifier.prototype ? 1 : 0) + (Object.getPrototypeOf(o) === Identifier.prototype ? 10 : 0);
      }`),
    ).toBe(11);
  });

  it("RED on base: `constructor` comes from the helper ctor's own field", async () => {
    expect(await run(`export function run() { return new I().constructor === Identifier ? 1 : 0; }`)).toBe(1);
  });

  it("RED on base: instanceof and `in` follow the chain through the struct", async () => {
    expect(
      await run(`export function run() {
        var o = new I();
        return (o instanceof Identifier ? 1 : 0) + (o instanceof AST ? 10 : 0) + ("kind" in o ? 100 : 0)
          + (o instanceof Array ? 1000 : 0);
      }`),
    ).toBe(111);
  });

  it("RED on base: Object.create of a `new F()` struct keeps the chain", async () => {
    expect(
      await run(`function F() { this.x = 1; }
      F.prototype.y = 2;
      var w = {}; w.p = new F();
      export function run() {
        var c = Object.create(w.p);
        return (Object.getPrototypeOf(c) === w.p ? 1 : 0) + c.x * 10 + c.y * 100;
      }`),
    ).toBe(211);
  });

  it("guard: the static `new Identifier()` fnctor fast path is intact", async () => {
    expect(
      await run(`function P(x) { this.x = x; }
      export function run() {
        var s = new Identifier();
        return s.kind() + new P(3).x * 10 + (s instanceof AST ? 100 : 0);
      }`),
    ).toBe(137);
  });

  it("guard: an empty-body helper ctor still works through a runtime-value `new`", async () => {
    expect(
      await run(`function K() {}
      function Sub() { this.nodeType = 9; }
      K.prototype = AST.prototype; Sub.prototype = new K();
      var S = Sub;
      export function run() { var o = new S(); return o.kind() + (o instanceof AST ? 100 : 0); }`),
    ).toBe(109);
  });

  it("RED on base: own writes on the instance do not leak onto the shared prototype", async () => {
    expect(
      await run(`export function run() {
        var a = new I(), b = new I();
        a.nodeType = 3;
        return a.kind() * 10 + b.kind();
      }`),
    ).toBe(37);
  });

  it("RED on base: Proxy links keep working beside struct links", async () => {
    expect(
      await run(`var proxy = new Proxy({}, { get: function (t, k, r) { return 5; } });
      export function run() {
        var heir = Object.create(proxy);
        return heir.anything + new I().kind() * 10 + (Object.getPrototypeOf(heir) === proxy ? 100 : 0);
      }`),
    ).toBe(175);
  });
});
