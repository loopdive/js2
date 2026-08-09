// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native Number::toString integer fast path.
 *
 * Safe integers delegate to the radix-10 formatter. They must do so before the
 * generic Ryū path allocates its 256-code-unit scratch buffer; the scratch is
 * otherwise dead for the dominant counter/index formatting regime.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ENV_NAME = "JS2WASM_NUMBER_TO_STRING_INTEGER_FASTPATH";
const originalEnv = process.env[ENV_NAME];

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = originalEnv;
});

async function numberToStringWat(disabled: boolean): Promise<string> {
  if (disabled) process.env[ENV_NAME] = "0";
  else delete process.env[ENV_NAME];
  const result = await compile(
    `export function run(value: number): number {
       return value.toString().length;
     }`,
    {
      fileName: disabled ? "number-string-control.ts" : "number-string-fast.ts",
      target: "standalone",
      optimize: 4,
      emitWat: true,
      emitWatOnlyFunctions: ["number_toString"],
    },
  );
  expect(result.success, result.success ? "" : String(result.errors?.[0]?.message)).toBe(true);
  return result.wat ?? "";
}

describe("native Number::toString integer fast path", () => {
  it("returns safe integers before allocating the Ryū scratch buffer", async () => {
    const wat = await numberToStringWat(false);
    const integerCheck = wat.indexOf("f64.floor");
    const scratchAllocation = wat.indexOf("array.new_default");
    expect(integerCheck).toBeGreaterThanOrEqual(0);
    expect(scratchAllocation).toBeGreaterThan(integerCheck);
  });

  it("keeps a kill switch that restores the allocation-before-check control", async () => {
    const wat = await numberToStringWat(true);
    const integerCheck = wat.indexOf("f64.floor");
    const scratchAllocation = wat.indexOf("array.new_default");
    expect(scratchAllocation).toBeGreaterThanOrEqual(0);
    expect(integerCheck).toBeGreaterThan(scratchAllocation);
  });
});
