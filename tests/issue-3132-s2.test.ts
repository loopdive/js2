// #3132 S2a — bounded async-generator CLASS METHOD drive (standalone).
//
// A class method `async *m() { … }` whose body never touches `this`/`super`/
// `arguments` routes through the same driven native producer as function
// declarations/expressions (`emitAsyncGenerator`), instead of the legacy
// eager-buffer HOST runtime — dropping the `__gen_*`/`__create_async_generator`
// import leak (the `method:zero-yield` bucket alone is 1,725 corpus files).
// Receiver-touching bodies keep the legacy path (correct-or-legacy).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.errors ?? []).toEqual([]);
  return result;
}

/** (#7010) A non-drivable async-gen method is a compile error naming #7010 (no host buffer). */
async function compileRefused(source: string) {
  const result = await compile(source, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success).toBe(false);
  expect(result.errors.map((e) => e.message).join("\n")).toMatch(/#7010/);
  return result;
}

function genImportNames(result: { imports?: { name?: string; field?: string }[] }): string[] {
  return (result.imports ?? [])
    .map((i) => String(i.name ?? i.field ?? ""))
    .filter((n) => /__gen_|__create_generator|__create_async_generator/.test(n));
}

async function runStandalone(source: string): Promise<number> {
  const result = await compileStandalone(source);
  const imports = buildImports(result.imports, undefined, result.stringPool, {}) as unknown as {
    setExports?: (e: unknown) => void;
  } & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports);
  return (instance.exports.test as () => number)();
}

describe("#3132 S2a — bounded async-gen class-method drive", () => {
  it("zero-yield instance method compiles host-free", async () => {
    const r = await compileStandalone(`
      class C { async *m() {} }
      function go() { new C().m(); }
      export function test() { go(); return 1; }
    `);
    expect(genImportNames(r)).toEqual([]);
  });

  it("plain-yield instance method drives for-await host-free", async () => {
    const r = await compileStandalone(`
      let n = 0;
      class C { async *m() { yield 4; yield 5; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(genImportNames(r)).toEqual([]);
    const imports = buildImports(r.imports, undefined, r.stringPool, {}) as unknown as {
      setExports?: (e: unknown) => void;
    } & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports);
    expect((instance.exports.test as () => number)()).toBe(9);
  });

  it("STATIC async-gen method drives host-free (the #2938 landmine path)", async () => {
    const ret = await runStandalone(`
      let n = 0;
      class C { static async *m() { yield 3; } }
      function go() {
        var it = C.m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(3);
  });

  it("yield* array-literal method body drives host-free (S1 unroll applies)", async () => {
    const ret = await runStandalone(`
      let n = 0;
      class C { async *m() { yield* [[6], [1]]; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const [v] of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(7);
  });

  it("a this-reading INSTANCE method body now drives host-free (S2 receiver threading)", async () => {
    // (#3132 S2) The receiver is the synthetic param 0 (`this`), captured into
    // the frame as a param field and restored BY NAME in the resume fn, so a
    // `this`-reading instance method body drives — no `__gen_*` imports.
    const r = await compileStandalone(`
      let n = 0;
      class C { v = 9; async *m() { yield this.v; yield this.v + 1; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(genImportNames(r)).toEqual([]);
    const imports = buildImports(r.imports, undefined, r.stringPool, {}) as unknown as {
      setExports?: (e: unknown) => void;
    } & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports);
    expect((instance.exports.test as () => number)()).toBe(19);
  });
});

describe("#3132 S2 — receiver threading + object-literal async-gen method drive", () => {
  it("this-WRITING instance method drives and mutates through the receiver", async () => {
    const ret = await runStandalone(`
      let n = 0;
      class C { v = 1; async *m() { this.v = this.v + 5; yield this.v; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(6);
  });

  it("object-literal async-gen method drives host-free", async () => {
    const r = await compileStandalone(`
      let n = 0;
      const o = { async *m() { yield 4; yield 5; } };
      function go() {
        var it = o.m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(genImportNames(r)).toEqual([]);
    const imports = buildImports(r.imports, undefined, r.stringPool, {}) as unknown as {
      setExports?: (e: unknown) => void;
    } & WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    imports.setExports?.(instance.exports);
    expect((instance.exports.test as () => number)()).toBe(9);
  });

  it("object-literal method reading this drives with correct values", async () => {
    const ret = await runStandalone(`
      let n = 0;
      const o = { v: 7, async *m() { yield this.v; yield this.v + 2; } };
      function go() {
        var it = o.m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(16);
  });

  it("a capturing object-literal method drives (captures promote to globals)", async () => {
    const ret = await runStandalone(`
      let n = 0;
      function go() {
        let k = 8;
        const o = { async *m() { yield k; } };
        var it = o.m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(8);
  });

  it("a drivable-method-only module keeps the native $Promise carrier — fully host-free", async () => {
    // (#3132 S2 lockstep) The pre-pass (`import-collector.ts`) now judges
    // drivable methods drivable, so the module keeps the carrier ON and even
    // the `Promise_resolve`/`Promise_reject`/`__get_caught_exception` residue
    // disappears — zero imports.
    const r = await compileStandalone(`
      let n = 0;
      class C { v = 9; async *m() { yield this.v; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect((r.imports ?? []).map((i) => String(i.name ?? ""))).toEqual([]);
  });

  it("yield await in a this-reading method settles under the carrier", async () => {
    const ret = await runStandalone(`
      let n = 0;
      class C { v = 6; async *m() { yield await Promise.resolve(this.v); yield 1; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(7);
  });

  it("a STATIC method reading this is refused, not lowered to the host buffer (#7010)", async () => {
    const r = await compileRefused(`
      class C { static v = 3; static async *m() { yield this.v; } }
      function go() { C.m(); }
      export function test() { go(); return 1; }
    `);
    expect(genImportNames(r)).toEqual([]);
  });

  it("a super-reading method is refused, not lowered to the host buffer (#7010)", async () => {
    const r = await compileRefused(`
      class B { f() { return 2; } }
      class C extends B { async *m() { yield super.f(); } }
      function go() { new C().m(); }
      export function test() { go(); return 1; }
    `);
    expect(genImportNames(r)).toEqual([]);
  });

  it("an arguments-reading method is refused, not lowered to the host buffer (#7010)", async () => {
    const r = await compileRefused(`
      class C { async *m(a: number) { yield arguments.length; } }
      function go() { new C().m(1); }
      export function test() { go(); return 1; }
    `);
    expect(genImportNames(r)).toEqual([]);
  });

  it("a mixed module (drivable + non-drivable method) is refused at the non-drivable method (#7010)", async () => {
    // Before #7010 the static `this`-reading method fell to the eager host
    // buffer (unsatisfiable `__gen_*` imports in any host-free build) and the
    // driven half ran with the carrier off. Now the module is a compile error.
    const r = await compileRefused(`
      let n = 0;
      class C {
        v = 4;
        async *m() { yield this.v; }
        static async *s() { yield this ? 1 : 2; }
      }
      function go() {
        var it = new C().m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(genImportNames(r)).toEqual([]);
  });

  it("class-expression and nested-class methods drive with correct values", async () => {
    // NOTE: the two receiver classes carry DISTINCT field shapes on purpose.
    // Two async-gen producers whose $AsyncFrame structs are structurally
    // IDENTICAL canonicalize to one Wasm type, so the consumer's ref.test
    // type-switch dispatches both to the first producer's driver — a
    // PRE-EXISTING hazard on main (two identical zero-param fn-decl async
    // gens misdispatch the same way), tracked as a follow-up, not an S2
    // regression.
    const ret = await runStandalone(`
      let n = 0;
      const A = class { x = 1; async *m() { yield 4; } };
      function go() {
        class B { y = "s"; z = 2; async *m2() { yield 5; } }
        var ia = new A().m(); var ib = new B().m2();
        async function fn() {
          for await (const v of ia) { n += v; }
          for await (const v of ib) { n += 10 * v; }
        }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(54);
  });

  it("yield* array-literal composes with this in a method body (S1 x S2)", async () => {
    const ret = await runStandalone(`
      let n = 0;
      class C { v = 2; async *m() { yield* [this.v, 3]; } }
      function go() {
        var it = new C().m();
        async function fn() { for await (const v of it) { n += v; } }
        fn();
      }
      export function test() { go(); return n; }
    `);
    expect(ret).toBe(5);
  });
});
