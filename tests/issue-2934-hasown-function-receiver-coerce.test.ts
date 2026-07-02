// #2934 slice 2 — `<fn>.hasOwnProperty(k)` / `<fn>.propertyIsEnumerable(k)` on a
// FUNCTION-valued receiver emitted invalid Wasm in standalone.
//
// Root cause: the `object-ops.ts` externref-receiver branch for
// hasOwnProperty/propertyIsEnumerable pushed the receiver via `compileExpression`
// WITHOUT coercing it — it assumed the STATIC type (externref) matched the
// compiled value. But a builtin function value like `RegExp.prototype.test`
// compiles to a concrete funcref-holder `struct` `(ref $N)`, so the
// `__hasOwnProperty` / `__propertyIsEnumerable` helper (externref receiver) got a
// bare GC ref → "call[0] expected type externref, found struct.new of (ref N)".
//
// Fix: coerce the receiver ref→externref (extern.convert_any), exactly as the key
// argument already is. Flips 12 standalone test262 files invalid→valid
// (RegExp.prototype.{exec,test,toString}.{hasOwnProperty,propertyIsEnumerable}),
// no regressions.
//
// NOTE: this fixes the BINARY validity (#2934's invalid→valid acceptance). A
// SEPARATE, pre-existing semantic gap remains — the standalone function-object
// property model does not track a function's own `length`, so
// `fn.hasOwnProperty("length")` currently answers `false` (should be `true`).
// That is out of scope here (a valid module that runs beats an invalid binary
// that cannot instantiate at all).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string) {
  return compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
}

describe("#2934 — hasOwnProperty/propertyIsEnumerable on a function receiver (standalone valid Wasm)", () => {
  const cases: Record<string, string> = {
    hasOwnProperty: `export function test(): number { return RegExp.prototype.test.hasOwnProperty("length") ? 1 : 0; }`,
    propertyIsEnumerable: `export function test(): number { return RegExp.prototype.test.propertyIsEnumerable("length") ? 1 : 0; }`,
    hasOwnProperty_toString: `export function test(): number { return RegExp.prototype.toString.hasOwnProperty("name") ? 1 : 0; }`,
  };

  for (const [name, src] of Object.entries(cases)) {
    it(`compiles ${name} on a function receiver to valid standalone Wasm`, async () => {
      const r = await compileStandalone(src);
      expect(r.success).toBe(true);
      // Previously rejected with "call[0] expected externref, found struct.new";
      // must now be an engine-acceptable module.
      await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    });
  }
});
