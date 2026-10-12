// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6968 — standalone: `<dynamic ctor>.prototype = { … }` where the constructor
// is NOT a resolvable user fnctor (a closure returned from a call, a
// member-held `Class.create()` ctor, …). The RHS literal was built as a CLOSED
// struct; the native construct driver's `__object_create(proto)` only links a
// `$Object` proto (`$proto = proto is $Object ? proto : null`), so every
// instance was silently reparented to `%Object.prototype%` and lost the
// prototype's methods (Octane raytrace: `this.initialize.apply` → undefined).
//
// Fix: `scanForDynamicProto` (src/codegen/dynamic-proto.ts) marks the
// `.prototype =` RHS (a direct literal, or a literal-initialized binding) when
// the left side resolves to no fnctor symbol, so it builds as an open `$Object`.
//
// Expected values are node's (each fixture is plain JS run as a module).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const result = await compile(src, {
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    runtimeEvalProvider: false,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { main: () => unknown }).main();
}

const CREATE = `function create() { return function () { this.y = 1; }; }\n`;
const SCORE = `(Object.getPrototypeOf(p) === P.prototype ? 1 : 0) + (p.init ? 10 : 0) + (Object.getPrototypeOf(p) === Object.prototype ? 100 : 0)`;

describe("#6968 dynamic-ctor .prototype = literal links the instance prototype (standalone)", () => {
  it("closure ctor, inline literal RHS", async () => {
    const src = `${CREATE}var P = create();
P.prototype = { init: function () { return 5; } };
export function main() { var p = new P(); return ${SCORE}; }`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("closure ctor, literal-initialized binding RHS", async () => {
    const src = `var X = { init: function () { return 5; } };
${CREATE}var P = create();
P.prototype = X;
export function main() { var p = new P(); return ${SCORE} + (Object.getPrototypeOf(p) === X ? 1000 : 0); }`;
    expect(await runStandalone(src)).toBe(1011);
  });

  it("closure ctor, parenthesized literal; inherited method is callable with the instance as this", async () => {
    const src = `${CREATE}var P = create();
P.prototype = ({ k: 3, init: function () { return this.y + this.k; } });
export function main() { var p = new P(); return p.init() * 100 + ${SCORE}; }`;
    expect(await runStandalone(src)).toBe(411);
  });

  it("instances share the one prototype object; own writes shadow it", async () => {
    const src = `${CREATE}var P = create();
P.prototype = { v: 1 };
export function main() {
  var a = new P(), b = new P();
  a.v = 7;
  return (Object.getPrototypeOf(a) === Object.getPrototypeOf(b) ? 1 : 0) + a.v * 10 + b.v * 100 + P.prototype.v * 1000;
}`;
    expect(await runStandalone(src)).toBe(1171);
  });

  // Controls: resolvable fnctors already promoted the literal (fnctor-prototype.ts),
  // and a user-level Object.create / an $Object RHS never needed the mark.
  it("control: function declaration ctor", async () => {
    const src = `var X = { init: function () { return 5; } };
function P() { this.y = 1; }
P.prototype = X;
export function main() { var p = new P(); return ${SCORE}; }`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("control: function-expression binding ctor", async () => {
    const src = `var X = { init: function () { return 5; } };
var P = function () { this.y = 1; };
P.prototype = X;
export function main() { var p = new P(); return ${SCORE}; }`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("control: Object.create(literal)", async () => {
    const src = `var X = { init: function () { return 5; } };
export function main() {
  var o = Object.create(X);
  return (Object.getPrototypeOf(o) === X ? 1 : 0) + (o.init ? 10 : 0) + (Object.getPrototypeOf(o) === Object.prototype ? 100 : 0);
}`;
    expect(await runStandalone(src)).toBe(11);
  });

  it("control: closure ctor with an Object.create($Object) prototype", async () => {
    const src = `var X = Object.create(Object.prototype); X.init = function () { return 5; };
${CREATE}var P = create();
P.prototype = X;
export function main() { var p = new P(); return ${SCORE}; }`;
    expect(await runStandalone(src)).toBe(11);
  });
});
