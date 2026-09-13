// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6419 — four defects an A/B sweep found already red on `main`, each with its
 * own root cause and each invisible to CI.
 *
 * 1. **Module-eval import cycle.** `src/codegen/collections-brand.ts` read
 *    `COLLECTION_KIND` in a TOP-LEVEL initializer (`KIND_OF`) across the cycle
 *    `map-runtime → statements/nested-declarations → … → expressions/calls →
 *    collections-brand → map-runtime`. Entering that cycle from the
 *    `nested-declarations` side evaluated `collections-brand` while
 *    `map-runtime` was still mid-evaluation, so the binding was `undefined`
 *    and the file died at COLLECTION time with
 *    `Cannot read properties of undefined (reading 'MAP')`. Order-dependent,
 *    hence green in CI and red standalone.
 * 2. **Absent array element ≠ `undefined` on the host lane.** A short/empty
 *    array literal pads a tuple slot with the canonical `undefined` producer,
 *    but on the host lane that producer is an IMPORT and
 *    `canonicalUndefinedExternInstrs` only LOOKS IT UP — degrading to
 *    `ref.null.extern`, i.e. JS `null`. §8.5.3 defaults fire on `undefined`
 *    only, so the default never ran.
 * 3. **Generator/async METHOD value routed into the construct bridge.**
 *    `{ *m(){} }.m` has no `[[Construct]]` (§15.x), but the `any`-typed
 *    binding reached the dynamic-ctor gate and `__construct_closure`
 *    constructed it.
 * 4. **Prepared class-layout descriptor read as stale on a benign commit.**
 *    Two prepared components depending on the same class made the second one
 *    fail with `descriptor is stale`, because the first had committed the
 *    layout in between — an identical layout, only now committed.
 */
// (#6419) THIS IMPORT MUST STAY FIRST. It is the 1058 file's own entry into
// the cycle; a later import of anything heavier resolves `map-runtime` first
// and the regression stops reproducing. Do not sort it below the vitest
// import, and do not add an import above it.
import { transitiveSiblingCaptures } from "../src/codegen/statements/nested-declarations.js";

import { describe, expect, it } from "vitest";

import { isCollectionReflectiveCallShape } from "../src/codegen/collections-brand.js";
import { COLLECTION_KIND } from "../src/codegen/collection-kind.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source, { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const setExports = (imports as { setExports?: (e: unknown) => void }).setExports;
  if (typeof setExports === "function") setExports(instance.exports);
  return (instance.exports as { test: () => unknown }).test();
}

async function emitsConstructClosure(source: string): Promise<boolean> {
  const result = await compile(source, {});
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return (result.imports ?? []).some((i: { name?: string; intent?: { name?: string } }) => {
    return (i.name ?? i.intent?.name) === "__construct_closure";
  });
}

describe("#6419 (1) collections-brand module-eval cycle", () => {
  it("loads collections-brand when the cycle is entered from nested-declarations", () => {
    // Reaching this assertion at all is the test: on the parent the FILE could
    // not be collected, so no `it` ran. The two reads keep both modules live
    // so a future re-entangling cannot be optimized away.
    expect(typeof transitiveSiblingCaptures).toBe("function");
    expect(typeof isCollectionReflectiveCallShape).toBe("function");
  });

  it("resolves the collection brand tags the top-level KIND_OF table is built from", () => {
    // The exact read that threw `Cannot read properties of undefined`.
    expect(COLLECTION_KIND.MAP).toBe(0);
    expect(COLLECTION_KIND.SET).toBe(1);
    expect(COLLECTION_KIND.WEAKMAP).toBe(2);
    expect(COLLECTION_KIND.WEAKSET).toBe(3);
  });
});

describe("#6419 (2) an absent array element is `undefined`, not `null`", () => {
  // Anti-vacuity control: `[undefined]` already fired the default on the
  // parent, so a test that only covered it would have passed there.
  it("fires the default for an explicit `undefined` element (control — passes on the parent)", async () => {
    expect(
      await runHost(`
        export function test(): any { let [ a = ({ z: 1 } as any) ] = [undefined] as any[]; return (a as any).z; }
      `),
    ).toBe(1);
  });

  it("does NOT fire the default for a genuine `null` element (control — null is not undefined)", async () => {
    expect(
      await runHost(`
        export function test(): any { let [ a = 9 ] = [null] as any[]; return a; }
      `),
    ).toBe(null);
  });

  it("throws the §13.3.1 ReferenceError for a self-referencing default past the end (let)", async () => {
    expect(
      await runHost(`
        export function test(): number {
          try { let [ y = y ] = []; return 0; } catch (e) { return 1; }
        }
      `),
    ).toBe(1);
  });

  it("throws the §13.3.1 ReferenceError for a self-referencing default past the end (const)", async () => {
    expect(
      await runHost(`
        export function test(): number {
          try { const [ y = y ] = []; return 0; } catch (e) { return 1; }
        }
      `),
    ).toBe(1);
  });

  it("throws for a self-referencing default in a LATER slot of a shorter source", async () => {
    expect(
      await runHost(`
        export function test(): number {
          try { let [ x, y = y ] = [1]; return 0; } catch (e) { return 1; }
        }
      `),
    ).toBe(1);
  });
});

describe("#6419 (3) a generator/async method value is not constructable", () => {
  it("does NOT route a generator-method value through the construct bridge", async () => {
    expect(
      await emitsConstructClosure(`
        const gen: any = { *m() {} }.m;
        export function test(): number { const x: any = new gen(); return 0; }
      `),
    ).toBe(false);
  });

  it("does NOT route an async-method value through the construct bridge", async () => {
    expect(
      await emitsConstructClosure(`
        const am: any = { async m() {} }.m;
        export function test(): number { const x: any = new am(); return 0; }
      `),
    ).toBe(false);
  });

  it("DOES still route a plain function value through the construct bridge (control)", async () => {
    expect(
      await emitsConstructClosure(`
        function mk() { return function C(x: number) { (this as any).x = x; }; }
        const C = mk();
        export function test(): number { const i: any = new C(1); return i.x; }
      `),
    ).toBe(true);
  });

  it("keeps a PLAIN method value on the bridge (control — deliberately unchanged)", async () => {
    expect(
      await emitsConstructClosure(`
        const pm: any = { m() {} }.m;
        export function test(): number { const x: any = new pm(); return 0; }
      `),
    ).toBe(true);
  });
});

describe("#6419 (4) a class committed between describe and prepare is not stale", () => {
  it("compiles a captured method call on a class instance (was: descriptor is stale)", async () => {
    // The arrow is the second prepared component that depends on `C`'s layout;
    // without it the class body alone compiles on the parent too.
    const result = await compile(
      `
        function assertThrows(fn: () => void): number {
          try { fn(); return 0; } catch (e) { return 1; }
        }
        class C {
          val: number = 10;
          doSomething(): number { return this.val + 1; }
        }
        export function test(): number {
          const o = new C();
          return assertThrows(() => o.doSomething());
        }
      `,
      {},
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("compiles the same shape with a constructor-assigned field", async () => {
    const result = await compile(
      `
        function assertThrows(fn: () => void): number {
          try { fn(); return 0; } catch (e) { return 1; }
        }
        class C {
          val: number;
          constructor() { this.val = 10; }
          doSomething(): number { return this.val + 1; }
        }
        export function test(): number {
          const o = new C();
          return assertThrows(() => o.doSomething());
        }
      `,
      {},
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });

  it("compiles the class without the capturing arrow (control — passes on the parent)", async () => {
    const result = await compile(
      `
        class C {
          val: number = 10;
          doSomething(): number { return this.val + 1; }
        }
        export function test(): number { const o = new C(); return o.doSomething(); }
      `,
      {},
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
