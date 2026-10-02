/**
 * #6651 cluster A, slice A13 — single generator rows A10/A11 left open, each
 * root-caused from the emitted WAT. Every case runs `--target standalone` and
 * asserts the binary imports NOTHING. Cases are RED on the base commit except
 * the ones marked GUARD, which pin the neighbouring behaviour that must not move
 * (green on base too).
 *
 * 1. `g() instanceof g` for a `function*` DECLARATION
 *    (`statements/generators/has-instance.js`). The #3962 host-free
 *    user-constructor arm treated `g` as a function constructor and walked the
 *    chain for the per-fnctor prototype global it mints. No generator inherits
 *    from that object — a generator object inherits from the function's own
 *    `prototype` property — so the answer was false. The arm now declines for a
 *    `function*` binding and the dynamic path reads the real `prototype`.
 *
 * 2. `var obj = null; function f() { obj = {…}; } f();
 *    Object.prototype.hasOwnProperty.call(obj, k)`
 *    (`object/method-definition/name-prop-name-yield-expr.js`, whose write runs
 *    in a resumed generator). TypeScript narrows `obj` to `null` from its
 *    initializer and keeps that across the call, and the static
 *    nullish-receiver fold compiled the call to a TypeError. A binding with a
 *    nullish initializer that is written anywhere else now takes the #5197
 *    runtime path (which still throws when the value IS nullish).
 *
 * 4. `super.x` in a method of an object literal that stays a CLOSED STRUCT
 *    (`method-definition/{generator,name}-super-prop-param.js`,
 *    `name-super-prop-body.js`). The #4688 lowering reads the home object from
 *    a closure capture only the open-`$Object` literal path installs, so a
 *    struct method declined and answered `null`. Such a literal's [[Prototype]]
 *    is statically %Object.prototype%, which is now the super base.
 *
 * 3. `new TA(generatorObject)` through a dynamic constructor
 *    (`TypedArrayConstructors/ctors/object-arg/as-generator-iterable-returns.js`).
 *    §23.2.5.1 step 6 consults `@@iterator` for every Object argument; the arm
 *    that does so was gated on `$Object` or a callable, and a native generator
 *    object is a state struct, so it fell to the count form (ToIndex → 0).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(src: string, js = false, noImports = true): Promise<unknown> {
  const r = (await compile(src, {
    fileName: js ? "t.js" : "t.ts",
    allowJs: js,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  if (noImports) expect(r.imports ?? []).toEqual([]);
  const imports = noImports ? {} : { env: { __to_property_key: (k: unknown) => k } };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 A13 · 1 · `instanceof` a generator function", () => {
  it("`g() instanceof g` for a generator declaration", async () => {
    const src = `function* g() {}
export function test(): any { return g() instanceof g ? 1 : 0; }`;
    expect(await run(src)).toBe(1);
  });

  it("a generator object is not an instance of another generator function", async () => {
    const src = `function* g() {}
function* h() {}
export function test(): any { return (g() instanceof g ? 1 : 0) + (g() instanceof h ? 10 : 0); }`;
    expect(await run(src)).toBe(1);
  });

  it("GUARD: generator expression binding (already dynamic)", async () => {
    const src = `var g = function* () {};
export function test(): any { return g() instanceof g ? 1 : 0; }`;
    expect(await run(src)).toBe(1);
  });

  it("GUARD: plain function constructor keeps the host-free fnctor arm", async () => {
    const src = `function F(this: any) { this.x = 1; }
export function test(): any {
  var f: any = new (F as any)();
  var o: any = {};
  return (f instanceof F ? 1 : 0) + (o instanceof F ? 10 : 0);
}`;
    expect(await run(src)).toBe(1);
  });
});

// Every use here is at TOP LEVEL: inside a function body TypeScript does not
// narrow a captured module `var`, so only a top-level use reaches the fold.
describe("#6651 A13 · 2 · a `null`-initialised var written elsewhere is not provably nullish", () => {
  it("hasOwnProperty.call on a var written inside a function", async () => {
    const src = `var obj = null;
function f() { obj = { k: 1 }; }
f();
var r = Object.prototype.hasOwnProperty.call(obj, "k") ? 1 : 0;
export function test() { return r; }`;
    expect(await run(src, true)).toBe(1);
  });

  it("propertyIsEnumerable.call on a var written inside a function", async () => {
    const src = `var obj = undefined;
function f() { obj = { k: 1 }; }
f();
var r = Object.prototype.propertyIsEnumerable.call(obj, "k") ? 1 : 0;
export function test() { return r; }`;
    expect(await run(src, true)).toBe(1);
  });

  // Not a pure GUARD: base throws too, but through the static fold, whose
  // `env::__to_property_key` import this module has no native twin for — so
  // base fails the no-imports assertion. The runtime path throws host-free.
  it("the same binding still throws while it IS null, without an import", async () => {
    const src = `var obj = null;
function f() { obj = { k: 1 }; }
var r = 0;
try { Object.prototype.hasOwnProperty.call(obj, "k"); } catch (e) { r = e instanceof TypeError ? 1 : 2; }
f();
export function test() { return r; }`;
    expect(await run(src, true)).toBe(1);
  });

  it("GUARD: an unwritten null var keeps the static TypeError", async () => {
    // The static fold's ToPropertyKey is `env::__to_property_key` in a module
    // that registers no native one — a pre-existing leak, identical on base, so
    // this GUARD alone links a stand-in and skips the no-imports assertion.
    const src = `var obj = null;
var r = 0;
try { Object.prototype.hasOwnProperty.call(obj, "k"); } catch (e) { r = e instanceof TypeError ? 1 : 2; }
export function test() { return r; }`;
    expect(await run(src, true, false)).toBe(1);
  });
});

describe("#6651 A13 · 3 · `new TA(generatorObject)` iterates it", () => {
  it("a generator object is read through @@iterator", async () => {
    const src = `function build(TA: any): any {
  var obj = (function* () { yield 7; yield 42; })();
  var t: any = new TA(obj);
  return t.length * 1000 + t[0] * 10 + t[1];
}
export function test(): any { return build(Float64Array); }`;
    expect(await run(src)).toBe(2112);
  });

  it("an abrupt completion out of the generator propagates", async () => {
    const src = `function build(TA: any): any {
  var obj = (function* () { yield 0; throw new RangeError("x"); })();
  try { new TA(obj); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; }
}
export function test(): any { return build(Int8Array); }`;
    expect(await run(src)).toBe(1);
  });

  it("GUARD: an array-like object and a plain array are unchanged", async () => {
    const src = `function build(TA: any): any {
  var a: any = new TA({ length: 2, 0: 3, 1: 4 });
  var b: any = new TA([5, 6, 7]);
  return a.length * 100 + b.length * 10 + b[2];
}
export function test(): any { return build(Float64Array); }`;
    expect(await run(src)).toBe(237);
  });
});

// JavaScript, unannotated: an `any`-typed binding sends the literal down the
// open-`$Object` path, which already carries the home object.
describe("#6651 A13 · 4 · `super` in a closed-struct object literal method", () => {
  it("`super.toString` in a method body", async () => {
    const src = `var obj = { m() { return super.toString; } };
export function test() { return obj.m() === Object.prototype.toString ? 1 : 0; }`;
    expect(await run(src, true)).toBe(1);
  });

  it("`super.toString` in a generator method's parameter default ignores an own override", async () => {
    const src = `var obj = { *foo(a = super.toString) { return a; } };
obj.toString = null;
export function test() { return obj.foo().next().value === Object.prototype.toString ? 1 : 0; }`;
    expect(await run(src, true)).toBe(1);
  });

  it("`super[key]` with a computed key", async () => {
    const src = `var obj = { m() { var k = "toStr" + "ing"; return super[k]; } };
export function test() { return obj.m() === Object.prototype.toString ? 1 : 0; }`;
    expect(await run(src, true)).toBe(1);
  });

  it("an arrow inside the method sees the same super base", async () => {
    const src = `var obj = { m() { return (() => super.valueOf)(); } };
export function test() { return obj.m() === Object.prototype.valueOf ? 1 : 0; }`;
    expect(await run(src, true)).toBe(1);
  });

  it("an absent key reads undefined, not a TypeError", async () => {
    const src = `var obj = { m() { return super.nope; } };
export function test() { return obj.m() === undefined ? 1 : 0; }`;
    expect(await run(src, true)).toBe(1);
  });

  it("GUARD: a `__proto__:` literal keeps its home-object read", async () => {
    const src = `var proto = { x: 1 };
var obj = { __proto__: proto, m() { return super.x; } };
export function test() { return obj.m(); }`;
    expect(await run(src, true)).toBe(1);
  });
});
