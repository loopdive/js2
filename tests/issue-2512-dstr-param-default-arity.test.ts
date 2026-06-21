// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2512 — nested destructuring-param default object emitted a `struct.new` one
 * operand short of the field-unified struct type → invalid Wasm
 * ("not enough arguments on the stack for struct.new (need 3, got 2)").
 *
 * Root cause (same bug CLASS as #2158): the nested-pattern default object is
 * built into a DETACHED `if.then` buffer swapped onto `fctx.body` (registered in
 * `ctx.liveBodies`, not `fctx.savedBodies`). When a later same-shape object
 * grows the anon struct's field set, `patchStructNewForAddedField` retro-pads
 * the existing `struct.new`s — but it never traversed `ctx.liveBodies`, so the
 * earlier struct.new in the orphaned buffer stayed short. Fix: add the
 * `ctx.liveBodies` loop to the patch.
 *
 * These cases assert the module COMPILES TO VALID WASM (the invalid-Wasm CE is
 * the 24-test bucket this fixes). The destructured VALUE correctness when the
 * outer default object fires is a separate, deeper bug tracked as #2513 — so
 * these tests deliberately assert validity, not values.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compilesValid(src: string): Promise<boolean> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  return WebAssembly.validate(r.binary);
}

describe("#2512 — nested dstr-param default object struct.new arity", () => {
  it("class method: nested object-pattern default with partial outer default object", async () => {
    expect(
      await compilesValid(`
        class C {
          method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, z: 7 } }): number {
            return z;
          }
        }
        export function test(): number { new C().method(); return 0; }
      `),
    ).toBe(true);
  });

  it("class EXPRESSION static method (the issue repro shape)", async () => {
    expect(
      await compilesValid(`
        const C = class {
          static method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, z: 7 } }): number {
            return x + z;
          }
        };
        export function test(): number { (C as any).method(); return 0; }
      `),
    ).toBe(true);
  });

  it("plain function with nested object-pattern default", async () => {
    expect(
      await compilesValid(`
        function f({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, z: 7 } }): number { return x + z; }
        export function test(): number { f(); return 0; }
      `),
    ).toBe(true);
  });

  it("generator method with nested object-pattern default", async () => {
    expect(
      await compilesValid(`
        class C {
          *method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, z: 7 } }): Generator<number> {
            yield x + z;
          }
        }
        export function test(): number { new C().method(); return 0; }
      `),
    ).toBe(true);
  });

  it("value-undef variant (inner default fires) still compiles valid", async () => {
    expect(
      await compilesValid(`
        class C {
          method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: undefined }): number { return x + z; }
        }
        export function test(): number { return new C().method(); }
      `),
    ).toBe(true);
  });
});
