// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2106 value-rep P3 — slice S0: `any[]` array-element tag recovery (host mode).
 *
 * A boolean (or any non-string primitive) stored in an `any[]` ARRAY LITERAL lost
 * its JS type tag on read-back: `[true]` built a `__vec_i32`, which was later
 * coerced to the `any[]` externref vec by Wasm KIND (`f64.convert_i32_s;
 * __box_number`) — so a boolean came back boxed as a JS *number*.
 *   - `typeof [true][0]` → "number"  (should be "boolean")
 *   - `"" + [true][0]`   → "1"       (should be "true")
 * The VALUE survived (`[true][0] === true`); only the TAG was wrong.
 *
 * Fix (literals.ts, compileArrayLiteral): when the array literal's contextual
 * element type is `any`, widen the element ValType to externref so each element
 * is boxed by its own static type at construction (`compileExpression(el,
 * externref)` already routes booleans → `__box_boolean`, numbers → `__box_number`,
 * strings → native), instead of after-the-fact Wasm-kind coercion. This is the
 * same path the (already-correct) `a.push(true)` route uses.
 *
 * Scoped strictly to `any[]` literals — number[]/string[]/struct[] are untouched.
 * Standalone/WASI `any`-boolean tag recovery is a separate, pre-existing gap
 * (S1/S3 of this issue), not covered here.
 */

async function runStr(src: string): Promise<string | number | undefined> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.binary).toBeTruthy();
  const { instance } = await WebAssembly.instantiate(r.binary, (r.importObject ?? {}) as WebAssembly.Imports);
  return (instance.exports.test as () => string | number | undefined)?.();
}

describe("#2106 S0 — any[] array-element tag recovery (host)", () => {
  it("typeof of a boolean element is 'boolean', not 'number'", async () => {
    expect(await runStr(`export function test(): string { const a: any[] = [true]; return typeof a[0]; }`)).toBe(
      "boolean",
    );
  });

  it("stringifying a boolean element gives 'true'/'false', not '1'/'0'", async () => {
    expect(await runStr(`export function test(): string { const a: any[] = [true]; return "" + a[0]; }`)).toBe("true");
    expect(await runStr(`export function test(): string { const a: any[] = [false]; return "" + a[0]; }`)).toBe(
      "false",
    );
  });

  it("the boolean VALUE is preserved (=== true)", async () => {
    expect(await runStr(`export function test(): boolean { const a: any[] = [true]; return a[0] === true; }`)).toBe(1);
  });

  it("string and number elements keep their tags (controls)", async () => {
    expect(await runStr(`export function test(): string { const a: any[] = ["x"]; return typeof a[0]; }`)).toBe(
      "string",
    );
    expect(await runStr(`export function test(): string { const a: any[] = [42]; return typeof a[0]; }`)).toBe(
      "number",
    );
  });

  it("each element of a heterogeneous any[] literal is tagged by its own type", async () => {
    const src = (i: number) =>
      `export function test(): string { const a: any[] = [true, 1, "x"]; return typeof a[${i}]; }`;
    expect(await runStr(src(0))).toBe("boolean");
    expect(await runStr(src(1))).toBe("number");
    expect(await runStr(src(2))).toBe("string");
  });

  it("numeric elements still round-trip their value through the any[] vec", async () => {
    expect(await runStr(`export function test(): number { const a: any[] = [42]; return a[0]; }`)).toBe(42);
    expect(await runStr(`export function test(): number { const a: any[] = [1.5]; return a[0]; }`)).toBe(1.5);
  });

  it("non-any number[] literals are unaffected (no behavior change)", async () => {
    expect(
      await runStr(`export function test(): number { const a: number[] = [1, 2, 3]; return a[0] + a[1] + a[2]; }`),
    ).toBe(6);
  });
});
