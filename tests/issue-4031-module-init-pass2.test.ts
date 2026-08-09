import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #4031 — a module initializer whose first pass creates no new top-level
 * inlinable functions must not be compiled a second time. An under-applied
 * IIFE is deliberately used here because the ordinary IIFE fast path cannot
 * inline it and therefore leaves a visible synthetic function in the WAT.
 */
describe("#4031 module-init pass 2 reuse", () => {
  it("does not emit a duplicate IIFE when no intervening body changes inlining", async () => {
    const result = await compile(
      `var value: number = (function (a: number, b?: number): number {
        return a + (b ?? 0);
      })(1);`,
      { experimentalIR: false },
    );

    expect(result.success).toBe(true);
    expect(result.wat.match(/\(func \$__iife_/g) ?? []).toHaveLength(1);
  });

  it("keeps the second pass when a top-level body adds an inlinable function", async () => {
    const result = await compile(
      `var value: number = (function (a: number, b?: number): number {
        return a + (b ?? 0);
      })(1);
      export function read(): number { return 7; }`,
      { experimentalIR: false },
    );

    expect(result.success).toBe(true);
    expect(result.wat.match(/\(func \$__iife_/g) ?? []).toHaveLength(2);
  });
});
