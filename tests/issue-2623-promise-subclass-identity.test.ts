// #2623 Slice B — `class extends Promise` identity unification.
//
// A `class MyPromise extends Promise` is externref-backed (#1366a/b): its
// instances are real host Promises, and it has NO `__class_<Name>` class-object
// singleton global (skipped in class-bodies.ts for builtin-parent classes).
// Two code paths used to materialize the constructor of such a class:
//
//   1. The combinator capability path (`Promise.all.call(Sub, …)`) routes the
//      receiver through the `__promise_subclass_ctor` host import, which
//      synthesizes + CACHES one real `class extends Promise {}` per class name.
//      V8 builds the instance from THAT constructor.
//   2. The bare identifier read-as-value (`Sub` on the RHS of `=== Sub`,
//      `instanceof Sub`, `Promise.withResolvers.call(Sub)`) fell through to the
//      `ref.null.extern` graceful-default, yielding `null`.
//
// So the constructor the user OBSERVED (path 2 → null) was a DIFFERENT object
// than the one used to BUILD the subclassed promise (path 1 → synthesized
// cached ctor): `instance.constructor === Sub` / `instance instanceof Sub` were
// always false.
//
// The fix (src/codegen/expressions/promise-subclass.ts, consumed by
// identifiers.ts value-read + calls.ts combinator receiver) unifies both onto
// the SAME cached `__promise_subclass_ctor` singleton — exactly one constructor
// object per Promise-subclass name. Flips test262
// built-ins/Promise/withResolvers/ctx-ctor.js fail→pass.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string): Promise<WebAssembly.Exports> {
  // (#6708) These identities are for the retired cached JS constructor path.
  // Keep them on the explicit rollback profile; native Promise-subclass
  // identity and capability construction are covered by #6651 D4.
  const r = await compile(src, { semanticProviders: "host-assisted" });
  if (!r.success) throw new Error("compile failed: " + JSON.stringify(r.errors));
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const m = await WebAssembly.instantiate(r.binary, imports);
  const setExports = (imports as unknown as { setExports?: (e: WebAssembly.Exports) => void }).setExports;
  if (typeof setExports === "function") setExports(m.instance.exports);
  return m.instance.exports;
}

describe("#2623 Slice B — Promise-subclass identity unification", () => {
  it("value-read of `class extends Promise` IS the capability constructor (one object)", async () => {
    // The instance built by the combinator and the value-read of the class
    // name must be the SAME constructor object. Returns 1 only when both the
    // `=== Sub` and `instanceof Sub` identities hold.
    const ex = await instantiate(`
      class SubPromise extends Promise<number> {}
      export function test(): number {
        const instance: any = Promise.all.call(SubPromise, []);
        let r = 0;
        if (instance.constructor === SubPromise) r += 1;
        if (instance instanceof SubPromise) r += 2;
        return r;
      }
    `);
    expect((ex.test as () => number)()).toBe(3);
  });

  it("withResolvers/ctx-ctor — instance.promise is an instance of the receiver (test262 row)", async () => {
    // Mirrors built-ins/Promise/withResolvers/ctx-ctor.js: a default-ctor
    // subclass, identity only (no executor body needed). Flips fail→pass.
    const ex = await instantiate(`
      class SubPromise extends Promise<number> {}
      export function test(): number {
        const instance: any = (Promise as any).withResolvers.call(SubPromise);
        let r = 0;
        if (instance.promise.constructor === SubPromise) r += 1;
        if (instance.promise instanceof SubPromise) r += 2;
        return r;
      }
    `);
    expect((ex.test as () => number)()).toBe(3);
  });

  it("chained subclass — `class B extends A`, `class A extends Promise` resolves the same singleton", async () => {
    const ex = await instantiate(`
      class A extends Promise<number> {}
      class B extends A {}
      export function test(): number {
        const instance: any = Promise.all.call(B, []);
        let r = 0;
        if (instance.constructor === B) r += 1;
        if (instance instanceof B) r += 2;
        return r;
      }
    `);
    expect((ex.test as () => number)()).toBe(3);
  });

  it("regression: a plain (non-Promise) class keeps its `__class_<Name>` identity", async () => {
    // `C === C` must stay a single class-object singleton — the Promise-subclass
    // value-read branch must NOT intercept ordinary classes.
    const ex = await instantiate(`
      class C { x: number = 1; }
      export function test(): number {
        const a: any = C;
        const b: any = C;
        return a === b ? 1 : 0;
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("regression: an Error subclass value-read is not routed to the Promise ctor", async () => {
    const ex = await instantiate(`
      class MyErr extends Error {}
      export function test(): number {
        const e = new MyErr("x");
        return (e instanceof MyErr) ? 1 : 0;
      }
    `);
    expect((ex.test as () => number)()).toBe(1);
  });

  it("regression: a local shadowing the class name wins over the Promise-subclass value-read", async () => {
    const ex = await instantiate(`
      class P extends Promise<number> {}
      export function test(): number {
        const P: number = 42;
        return P;
      }
    `);
    expect((ex.test as () => number)()).toBe(42);
  });

  it("regression: combinator capability path still resolves (the #1116b behavior)", async () => {
    const ex = await instantiate(`
      class P extends Promise<number> {}
      export async function main(): Promise<number> {
        await Promise.all.call(P, [Promise.resolve(1), Promise.resolve(2)]);
        return 1;
      }
    `);
    expect(await (ex.main as () => Promise<number>)()).toBe(1);
  });
});
