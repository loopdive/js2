import { describe, expect, it } from "vitest";
import { compileToObject } from "../src/index.js";

describe("#4579 standalone physical route audit", () => {
  it("fails closed when relocatable object emission would bypass the target-aware pipeline", () => {
    const result = compileToObject(`export function main(): number { return 1; }`, {
      target: "standalone",
    });

    expect(result.success).toBe(false);
    expect(result.object).toHaveLength(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("relocatable object emission consumes the Prepared IR program"),
      }),
    ]);
  });
});
