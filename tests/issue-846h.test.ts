import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #846h — a derived class whose explicit constructor never calls super(...)
// never initialises `this`; constructing it must throw (ReferenceError per
// ES §10.2.2 / §13.3.7.1). The test262 harness's assert.throws only checks
// that *something* throws, so the conformance contract is "construction throws".
describe("#846h derived constructor must call super()", () => {
  it("derived ctor with no super() throws on construction (user parent)", async () => {
    const exports = await compileToWasm(`
      class P { x: number; constructor() { this.x = 1; } }
      class C extends P { constructor() {} }
      export function test(): number {
        try { const c = new C(); return 0; } catch (e) { return 1; }
      }`);
    expect(exports.test()).toBe(1);
  });

  it("derived ctor that calls super() does NOT throw", async () => {
    // Guard must NOT fire: a lexical super() is present. Asserting "no throw"
    // (return 0, not the -1 catch sentinel) isolates the #846h guard from the
    // separate super field-initializer propagation behaviour.
    const exports = await compileToWasm(`
      class P { x: number = 42; }
      class C extends P { constructor() { super(); } }
      export function test(): number {
        try { const c = new C(); return 0; } catch (e) { return -1; }
      }`);
    expect(exports.test()).toBe(0);
  });

  it("derived class with no explicit ctor uses implicit super() (no throw)", async () => {
    const exports = await compileToWasm(`
      class P { x: number; constructor() { this.x = 5; } }
      class C extends P {}
      export function test(): number {
        try { const c = new C(); return c.x; } catch (e) { return -1; }
      }`);
    expect(exports.test()).toBe(5);
  });

  it("non-derived class with empty ctor does NOT throw", async () => {
    const exports = await compileToWasm(`
      class P { x: number; constructor() {} }
      export function test(): number {
        try { const p = new P(); return 7; } catch (e) { return -1; }
      }`);
    expect(exports.test()).toBe(7);
  });

  it("derived ctor with body but no super() still throws", async () => {
    const exports = await compileToWasm(`
      class P { x: number; constructor() { this.x = 1; } }
      class C extends P { constructor() { let y: number = 3; } }
      export function test(): number {
        try { const c = new C(); return 0; } catch (e) { return 1; }
      }`);
    expect(exports.test()).toBe(1);
  });

  it("derived class extending a builtin (Array) with no super() throws", async () => {
    // The dominant test262 pattern: class A extends Array { constructor() {} }
    // (test/language/statements/class/subclass/builtin-objects/*/super-must-be-called.js)
    const exports = await compileToWasm(`
      class A extends Array { constructor() {} }
      export function test(): number {
        try { const a = new A(); return 0; } catch (e) { return 1; }
      }`);
    expect(exports.test()).toBe(1);
  });

  it("derived ctor calling super() inside both branches does NOT throw", async () => {
    const exports = await compileToWasm(`
      class P { x: number = 9; }
      class C extends P {
        constructor(flag: boolean) { if (flag) { super(); } else { super(); } }
      }
      export function test(): number {
        try { const c = new C(true); return 0; } catch (e) { return -1; }
      }`);
    expect(exports.test()).toBe(0);
  });
});
