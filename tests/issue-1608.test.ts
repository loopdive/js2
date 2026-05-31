// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1608 — codegen crash "Cannot set properties of undefined (setting 'typeIdx')"
// in compileObjectLiteralForStruct.
//
// Sibling object literals that share a struct dedup-key share the same method
// `fullName` (e.g. `__anon_0_valueOf`). The first literal records a funcIdx in
// `ctx.funcMap`; a later sibling looked that index up and indexed into
// `ctx.mod.functions` blindly. When the recorded index pointed into the import
// range (after late-import index shifting), the local index went negative,
// `ctx.mod.functions[localIdx]` was `undefined`, and writing `.typeIdx` on it
// threw. The five test262 Array `A2_T*` "apply mutator to non-array this" tests
// all hit this through repeated `obj.length = { valueOf() {...} }`. The fix
// treats an unresolvable funcMap slot as "no existing function" and synthesizes
// a fresh one.
//
// The crash only manifests through the full test262 preamble (which adds the
// late imports that shift indices), so this test wraps the real test262 bodies
// via `wrapTest` + `skipSemanticDiagnostics` exactly as the runner does.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { parseMeta, wrapTest } from "./test262-runner.js";

async function compilesWithoutInternalError(body: string): Promise<boolean> {
  const meta = parseMeta(body);
  const { source } = wrapTest(body, meta);
  const r = await compile(source, { fileName: "test.ts", sourceMap: true, skipSemanticDiagnostics: true });
  return !r.errors?.some((e) => /Internal error compiling|typeIdx/.test(e.message));
}

describe("#1608 sibling object literals sharing a method name must not crash codegen", () => {
  // Reduced from built-ins/Array/prototype/push/S15.4.4.7_A2_T3.js: repeated
  // assignment of object literals carrying same-named methods to a property.
  it("repeated `obj.length = { valueOf() {...} }` compiles without internal crash", async () => {
    const body = `
      var obj = {};
      obj.push = Array.prototype.push;
      obj.length = { valueOf() { return 3; } };
      var p1 = obj.push();
      obj.length = { valueOf() { return 3; }, toString() { return 1; } };
      var p2 = obj.push();
      obj.length = { toString() { return 1; } };
      var p3 = obj.push();
      obj.length = { valueOf() { return {}; }, toString() { return 1; } };
      var p4 = obj.push();
    `;
    expect(await compilesWithoutInternalError(body)).toBe(true);
  });

  it("many distinct same-shaped literals with shared method name compile", async () => {
    const body = `
      var o = {};
      o.a = { valueOf() { return 1; } };
      o.b = { valueOf() { return 2; } };
      o.c = { valueOf() { return 3; } };
      o.d = { valueOf() { return 4; } };
      assert.sameValue(typeof o.a, 'object');
    `;
    expect(await compilesWithoutInternalError(body)).toBe(true);
  });
});
