import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

/**
 * #3199 — default-lane Array fold accumulator type.
 *
 * `resolveReduceAccType` previously fell back to the numeric kind (f64) when
 * neither the callback return type nor its first parameter pinned the
 * accumulator — i.e. a void / untyped callback such as `function () {}`. With
 * an explicit *reference-typed* initial value (a string / object), that forced
 * the initial value through an f64 coercion (→ NaN), so
 * `[].reduce(function () {}, "seed")` returned NaN instead of the seed.
 *
 * The fix seeds the accumulator as `externref` when the explicit initial value
 * is a reference type and no callback type pins it. Numeric initial values keep
 * the numeric accumulator, so the fast numeric fold path is unchanged.
 */
async function run(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, Function>)[fn]!(...args);
}

describe("#3199 reduce/reduceRight accumulator type from initial value", () => {
  it("empty array + string initial value + void callback returns the seed (reduce)", async () => {
    // Mirrors test262 built-ins/Array/prototype/reduce/15.4.4.21-7-10.js
    const src = `export function test(): any { return [].reduce(function () {}, "initialValue is present"); }`;
    expect(await run(src)).toBe("initialValue is present");
  });

  it("empty array + string initial value + void callback returns the seed (reduceRight)", async () => {
    // Mirrors test262 built-ins/Array/prototype/reduceRight/15.4.4.22-7-10.js
    const src = `export function test(): any { return [].reduceRight(function () {}, "seed"); }`;
    expect(await run(src)).toBe("seed");
  });

  it("empty array + object initial value + void callback returns the seed object", async () => {
    // A statically-typed object literal seed resolves to the `object` tag via
    // the oracle, so the accumulator is seeded as externref (not the numeric
    // default). (`any`-typed seeds stay numeric — the oracle is conservative.)
    const src = `
      export function test(): any {
        const r: any = [].reduce(function () {}, { tag: 42 });
        return r.tag;
      }`;
    expect(await run(src)).toBe(42);
  });

  // ── Regression guards: numeric / typed folds must be unchanged ──

  it("numeric reduce with numeric initial value still folds numerically", async () => {
    const src = `export function test(): number { return [1, 2, 3].reduce((a: number, b: number): number => a + b, 10); }`;
    expect(await run(src)).toBe(16);
  });

  it("numeric reduce without an initial value still folds numerically", async () => {
    const src = `export function test(): number { return [1, 2, 3].reduce((a: number, b: number): number => a + b); }`;
    expect(await run(src)).toBe(6);
  });

  it("string reduce with a string initial value still concatenates", async () => {
    const src = `export function test(): any { return ["b", "c"].reduce((a: string, b: string): string => a + b, "a"); }`;
    expect(await run(src)).toBe("abc");
  });

  it("numeric reduceRight with numeric initial value is unchanged", async () => {
    const src = `export function test(): number { return [1, 2, 3].reduceRight((a: number, b: number): number => a + b, 10); }`;
    expect(await run(src)).toBe(16);
  });
});
