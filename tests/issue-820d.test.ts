import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #820d — class/dstr async-gen-meth default-init `unresolvable` illegal cast.
//
// A method with a destructuring parameter whose default initializer references
// an unresolvable identifier (`{ x = unresolvableReference } = {}`) must throw a
// spec-correct ReferenceError when the parameter is `undefined`. Previously the
// closure-extracted method path (`var m = C.prototype.m; m();`) resolved the
// destructuring param to a struct ref at the call site, mismatching the
// externref slot the compiled method/trampoline actually uses. The trampoline
// funcref cast then trapped with `illegal cast` before the default expression
// could run, so the ReferenceError never surfaced.

async function compileOk(src: string) {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("Compile: " + r.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return instance.exports as any;
}

describe("#820d — destructuring method default-init unresolvable cast", () => {
  it("obj-ptrn-id-init-unresolvable throws ReferenceError (extracted method, no receiver)", async () => {
    const ex = await compileOk(`
      var C = class {
        async *method({ x = unresolvableReference } = {}) {}
      };
      var method = C.prototype.method;
      export function test(): number {
        try { method(); } catch (e) { return (e instanceof ReferenceError) ? 1 : 2; }
        return 3;
      }
    `);
    expect(ex.test()).toBe(1);
  });

  it("ary-ptrn-elem-init-unresolvable throws ReferenceError (extracted method, no receiver)", async () => {
    const ex = await compileOk(`
      var C = class {
        async *method([ x = unresolvableReference ] = []) {}
      };
      var method = C.prototype.method;
      export function test(): number {
        try { method(); } catch (e) { return (e instanceof ReferenceError) ? 1 : 2; }
        return 3;
      }
    `);
    expect(ex.test()).toBe(1);
  });

  it("statement-class async-gen method, array pattern", async () => {
    const ex = await compileOk(`
      class C {
        async *method([ x = unresolvableReference ] = []) {}
      }
      var method = C.prototype.method;
      export function test(): number {
        try { method(); } catch (e) { return (e instanceof ReferenceError) ? 1 : 2; }
        return 3;
      }
    `);
    expect(ex.test()).toBe(1);
  });

  it("object-literal async-gen method, object pattern", async () => {
    const ex = await compileOk(`
      var o = { async *method({ x = unresolvableReference } = {}) {} };
      var method = o.method;
      export function test(): number {
        try { method(); } catch (e) { return (e instanceof ReferenceError) ? 1 : 2; }
        return 3;
      }
    `);
    expect(ex.test()).toBe(1);
  });

  it("plain method (non-async) with destructuring default still traps→RefError on unresolvable", async () => {
    const ex = await compileOk(`
      class C {
        method({ x = unresolvableReference } = {}) { return x; }
      }
      var method = C.prototype.method;
      export function test(): number {
        try { method(); } catch (e) { return (e instanceof ReferenceError) ? 1 : 2; }
        return 3;
      }
    `);
    expect(ex.test()).toBe(1);
  });

  // Regression guards: resolvable defaults must still fire and explicit args pass through.
  it("resolvable object-pattern default fires when arg omitted (no throw)", async () => {
    const ex = await compileOk(`
      class C { method({ x = 7 } = {}) { return x; } }
      var method = C.prototype.method;
      export function test(): number { return method(); }
    `);
    expect(ex.test()).toBe(7);
  });

  it("explicit argument is destructured normally (extracted method)", async () => {
    const ex = await compileOk(`
      class C { method({ x = 7 } = {}) { return x; } }
      export function test(): number { return new C().method({ x: 42 }); }
    `);
    expect(ex.test()).toBe(42);
  });

  it("resolvable array-pattern default fires when arg omitted (extracted method)", async () => {
    const ex = await compileOk(`
      class C { method([ x = 11 ] = []) { return x; } }
      var method = C.prototype.method;
      export function test(): number { return method(); }
    `);
    expect(ex.test()).toBe(11);
  });
});
