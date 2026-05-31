// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #1701 — Assignment destructuring residuals.
 *
 * Two spec defects in `src/codegen/expressions/assignment.ts`:
 *
 * A. ArrayAssignmentPattern `[…] = primitive` must throw TypeError per
 *    §13.15.5.2 step 1 (GetIterator(value)). Numbers and booleans lack a
 *    [Symbol.iterator] so the iterator-get throws. Previously the codegen
 *    boxed the primitive via __box_number and recursed; the lenient runtime
 *    then silently produced an empty array. The fix drops the value and
 *    throws directly.
 *
 * B. ObjectAssignmentPattern `{…} = null|undefined` must throw TypeError per
 *    §13.15.5.2 step 1 (RequireObjectCoercible(value)). The earlier
 *    empty-pattern carve-out (#225) bypassed the throw even for `{} = null`,
 *    which is wrong: the RequireObjectCoercible call fires BEFORE the
 *    property list is walked. The fix removes the `length > 0` gate on the
 *    null/undefined guard.
 */

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    setExports?: (e: unknown) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (typeof imports.setExports === "function") imports.setExports(instance.exports);
  const fn = (instance.exports as Record<string, unknown>).test as (() => unknown) | undefined;
  if (typeof fn !== "function") throw new Error("no test() export");
  return fn();
}

describe("#1701 array assignment destructure throws on non-iterable primitive", () => {
  it("[] = true throws", async () => {
    const src = `
      export function test(): number {
        let threw = 0;
        try { (0, [] = true); } catch (e: any) { threw = 1; }
        return threw;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("[] = 5 throws", async () => {
    const src = `
      export function test(): number {
        let threw = 0;
        try { (0, [] = 5); } catch (e: any) { threw = 1; }
        return threw;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("[,] = 1 (elision-only pattern) throws", async () => {
    const src = `
      export function test(): number {
        let threw = 0;
        try { (0, [,] = 1); } catch (e: any) { threw = 1; }
        return threw;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});

describe("#1701 object assignment destructure throws on null/undefined RHS for empty pattern", () => {
  it("{} = undefined throws", async () => {
    const src = `
      export function test(): number {
        let threw = 0;
        try { (0, {} = undefined); } catch (e: any) { threw = 1; }
        return threw;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("{} = null throws", async () => {
    const src = `
      export function test(): number {
        let threw = 0;
        try { (0, {} = null); } catch (e: any) { threw = 1; }
        return threw;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});

describe("#1701 no regression — valid destructuring still works", () => {
  it("[] = [] succeeds and returns RHS", async () => {
    const src = `
      export function test(): number {
        const v: any = [];
        const r: any = ([] = v);
        return r === v ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("({} = {}) succeeds and returns RHS", async () => {
    const src = `
      export function test(): number {
        const v: any = {};
        const r: any = ({} = v);
        return r === v ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("[a] = [42] still binds correctly", async () => {
    const src = `
      export function test(): number {
        let a: any = 0;
        ([a] = [42]);
        return a === 42 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("({x} = {x: 7}) still binds correctly", async () => {
    const src = `
      export function test(): number {
        let x: any = 0;
        ({x} = {x: 7});
        return x === 7 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("({} = {x: 1}) succeeds — empty object pattern matches any object", async () => {
    const src = `
      export function test(): number {
        const v: any = {x: 1};
        const r: any = ({} = v);
        return r === v ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
