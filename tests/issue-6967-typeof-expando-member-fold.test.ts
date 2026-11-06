// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6967 — `typeof NS.m` was constant-folded from the checker's type of an
// EXPANDO member (`m` declared only by the JS assignment `NS.m = …`). That
// type is the member's EVENTUAL shape and says nothing about whether the write
// has run at the `typeof` site, so the Prototype-style namespace guard
// `if (typeof Flog.RT == "undefined") Flog.RT = {}` folded to `false`, the
// init never ran, and every later `Flog.RT.X` access hit undefined (Octane
// raytrace's first failure).
//
// Fix: `typeofOperandIsAssignmentDeclaredMember` (src/codegen/typeof-delete.ts)
// keeps the typeof dynamic when the member has only assignment declarations
// (the access/binary expression plus TS's container `Identifier` per nested
// `NS.m.<x> = …` write). Members with a real declaration (object-literal
// property, class field, …) still fold.
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

describe("#6967 typeof of an assignment-declared (expando) member is not folded", () => {
  it("guarded namespace init runs, later member writes land", async () => {
    const src = `var Flog = {};
if (typeof Flog.RT == "undefined") Flog.RT = {};
var r = 0;
try { Flog.RT.Color = 5; Flog.RT.other = { red: 7 }; r = Flog.RT.Color * 100 + Flog.RT.other.red; } catch (e) { r = -1; }
export function main() { return r; }`;
    expect(await runStandalone(src)).toBe(507);
  });

  it("nested container writes (TS records extra Identifier declarations)", async () => {
    const src = `var Flog = {};
if (typeof Flog.RT == "undefined") Flog.RT = {};
Flog.RT.Color = 5;
Flog.RT.Other = function () { this.red = 1; };
var r = 0;
try { r = Flog.RT.Color + (typeof Flog.RT.Other === "function" ? 10 : 0); } catch (e) { r = -1; }
export function main() { return r; }`;
    expect(await runStandalone(src)).toBe(15);
  });

  it("static expando on a function declaration: plain typeof and comparison", async () => {
    const src = `function F() {}
var t1 = typeof F.s;
var g = typeof F.s != "undefined" ? 1 : 0;
F.s = function () { return 1; };
var t2 = typeof F.s;
export function main() { return (t1 === "undefined" ? 1 : 0) + g * 10 + (t2 === "function" ? 100 : 0); }`;
    expect(await runStandalone(src)).toBe(101);
  });

  it("guard inside a function runs exactly once", async () => {
    const src = `var Q = {};
var guard = 0;
function init() { if (typeof Q.inner == "undefined") { Q.inner = {}; guard++; } }
init(); init();
Q.inner.v = 4;
export function main() { return guard * 100 + Q.inner.v; }`;
    expect(await runStandalone(src)).toBe(104);
  });

  // Negative controls: members with a real declaration keep folding and stay correct.
  it("control: object-literal member and literal-plus-assignment member", async () => {
    const src = `var o = { RT: { x: 1 } };
var lit = typeof o.RT == "undefined" ? 1 : 0;
var p = { a: 1 };
p.a = 2;
var mixed = typeof p.a;
export function main() { return lit + (mixed === "number" ? 10 : 0) + (typeof o.RT === "object" ? 100 : 0); }`;
    expect(await runStandalone(src)).toBe(110);
  });

  it("control: guard on a member with no later nested writes", async () => {
    const src = `var Flog = {};
if (typeof Flog.RT == "undefined") Flog.RT = {};
export function main() { return typeof Flog.RT === "object" ? 1 : 0; }`;
    expect(await runStandalone(src)).toBe(1);
  });
});
