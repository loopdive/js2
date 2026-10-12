// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6950 — a top-level `o.F.prototype.m = …` whose constructor is held in a
// member of a top-level function (`SplayTree.Node = function…`, Octane splay)
// fell past every module-init keep arm and compiled to NOTHING, on both lanes.
// The same write inside a function body already worked.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "gc" | "standalone";

async function run(source: string, lane: Lane): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-6950.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as { main: () => unknown }).main();
}

// From #6943 neg12: the prototype read through the member and through an alias.
const TYPEOF_THROUGH_MEMBER = `
function o() {}
o.F = function (k) { this.key = k; };
o.F.prototype.get = function () { return this.key; };
export function main() {
  var f = o.F;
  var p1 = o.F.prototype;
  var p2 = f.prototype;
  return (typeof p1.get === "function" ? 1 : 0) + (typeof p2.get === "function" ? 2 : 0) +
    (p1 === p2 ? 4 : 0) + (o.F === f ? 8 : 0);
}
`;

// The splay shape: data + method members, the method carrying the JSDoc that
// types its parameter as the member-held constructor.
const SPLAY_SHAPE = `
function SplayTree() { this.root_ = null; }
SplayTree.Node = function (key, value) { this.key = key; this.value = value; };
SplayTree.Node.prototype.left = null;
/** @param {function(SplayTree.Node)} f Visitor function. */
SplayTree.Node.prototype.traverse_ = function (f) { return 7; };
export function main() {
  return (typeof SplayTree.Node.prototype.traverse_ === "function" ? 1 : 0) +
    (SplayTree.Node.prototype.left === null ? 2 : 0) + SplayTree.Node.prototype.traverse_(null) * 4;
}
`;

// Construct through an alias and call the method; plus an object-held ctor
// (rooted at a module global — already kept by the generic arm; control).
const CONSTRUCT_AND_CALL = `
function T() {}
T.Node = function (k) { this.key = k; };
T.Node.prototype.left = null;
T.Node.prototype.get = function () { return this.key; };
var o = {};
o.F = function (k) { this.k = k; };
o.F.prototype.m = function () { return this.k * 2; };
export function main() {
  var C = T.Node;
  var n = new C(3);
  var D = o.F;
  var d = new D(4);
  return n.get() * 100 + (n.left === null ? 10 : 0) + d.m();
}
`;

// Control: the same writes inside a function body (never dropped).
const IN_FUNCTION = `
function o() {}
o.F = function (k) { this.key = k; };
function setup() { o.F.prototype.get = function () { return this.key; }; }
export function main() {
  setup();
  return typeof o.F.prototype.get === "function" ? 1 : 0;
}
`;

describe("#6950 top-level member-held fnctor prototype writes are kept", () => {
  for (const lane of ["standalone", "gc"] as const) {
    it(`typeof through member and alias (${lane})`, async () => {
      expect(await run(TYPEOF_THROUGH_MEMBER, lane)).toBe(15);
    });
    it(`splay shape: data + JSDoc-typed method members (${lane})`, async () => {
      expect(await run(SPLAY_SHAPE, lane)).toBe(31);
    });
    it(`control: the write inside a function body (${lane})`, async () => {
      expect(await run(IN_FUNCTION, lane)).toBe(1);
    });
  }

  // gc's `new C(k)` through an alias of a member-held function is #6943's
  // construct path (not on this base), so the call check is standalone-only.
  it("construct through an alias and call the kept method (standalone)", async () => {
    expect(await run(CONSTRUCT_AND_CALL, "standalone")).toBe(318);
  });
});
