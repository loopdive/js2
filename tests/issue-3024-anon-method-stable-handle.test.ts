// (#3024) An anonymous object-literal method (e.g. a `valueOf` on a `{ valueOf() {} }`
// literal used as a property value) produced invalid Wasm when the module ALSO
// prepended env imports during the import-collector passes.
//
// Root cause: `ensureStructForType` pre-mints the method's defined function
// using the LIVE-REGIME index `numImportFuncs + functions.length`. That pre-mint
// runs during the DECLARATION SCAN — via the collectEmptyObjectWidening /
// collectGrowableObjectLiterals pre-passes' `resolveWasmType` — BEFORE the import
// collectors. A later `register()` in `collectUsedExternImports` (or any
// collector) prepends an `env` import via raw `addImport`, which does NOT shift
// existing defined-function indices. The pre-minted funcMap entry then points
// into the import range forever (no shift walker repairs a 0-based index once
// imports moved the boundary), so `definedFuncAt` fails to resolve it at
// literal-compile time (forking a duplicate method body) while the method
// trampoline keeps forwarding into the stale (now import) index — `call[0]
// expected externref/f64, found if of type (ref null N)`. This is the
// Array.prototype S15.4.4.x A2 `valueOf`-length cluster (pop/push/shift/unshift).
//
// Fix: mint the method with a STABLE handle (#1916 S3), which is
// layout-independent — every shift walker skips it and the concrete index is
// resolved at emit.
//
// `WebAssembly.compile` is load-bearing: the regression was a *validation*
// failure, so a compile()-succeeds assertion would not catch it.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileValid(source: string) {
  const r = await compile(source, { fileName: "test.ts", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
}

describe("#3024 anon object-literal method — stable-handle pre-mint", () => {
  it("obj.length = { valueOf() {} } with an element write validates", async () => {
    await compileValid(`export function test(): number {
      var obj: any = {};
      obj[0] = -1;
      obj.length = { valueOf() { return 1; } };
      return 1;
    }`);
  });

  it("Array.prototype.pop borrowed onto an array-like with a valueOf length validates", async () => {
    await compileValid(`export function test(): number {
      var obj: any = {};
      obj.pop = (Array.prototype as any).pop;
      obj[0] = -1;
      obj.length = { valueOf() { return 1; } };
      var pop = obj.pop();
      return 1;
    }`);
  });

  it("a user class declaration in the module (extra env imports) does not desync the anon-method index", async () => {
    await compileValid(`class Boxed { m: any; constructor(m: any) { this.m = m; } }
    export function test(): number {
      var obj: any = {};
      obj.pop = (Array.prototype as any).pop;
      obj[0] = -1;
      obj.length = { valueOf() { return 1; } };
      var pop = obj.pop();
      return 1;
    }`);
  });

  it("valueOf + toString sibling methods on the same literal validate", async () => {
    await compileValid(`export function test(): number {
      var obj: any = {};
      obj[0] = -1;
      obj.length = { valueOf() { return 1; }, toString() { return 0; } };
      return 1;
    }`);
  });

  it("control: plain object-literal method with no array-like receiver still validates", async () => {
    await compileValid(`export function test(): number {
      var o = { valueOf() { return 5; } };
      return (o as any).valueOf();
    }`);
  });
});
