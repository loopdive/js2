import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const MUTABLE_DYNAMIC_SOURCE = `
export function assignNumber(value: any): number {
  value = 41.5;
  return +value;
}

export function assignString(value: any): number {
  value = "ready";
  return value === "ready" ? 1 : 0;
}

export function assignBoolean(value: any, number: number): number {
  value = number > 0;
  return value === true ? 1 : 0;
}

export function defaultNumber(value: any): number {
  if (value === void 0) value = 7;
  return +value;
}
`;

async function compileTarget(target: "gc" | "standalone") {
  const result = await compile(MUTABLE_DYNAMIC_SOURCE, {
    fileName: "issue-3789-ir-dynamic-param-slots.ts",
    target,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toEqual(
    expect.arrayContaining(["assignNumber", "assignString", "assignBoolean", "defaultNumber"]),
  );
  return result;
}

describe("#3789 IR mutable dynamic parameter slots", () => {
  it.each(["gc", "standalone"] as const)("uses the backend dynamic carrier on %s", async (target) => {
    const result = await compileTarget(target);
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const exports = instance.exports as {
      assignNumber: (value: unknown) => number;
      assignString: (value: unknown) => number;
      assignBoolean: (value: unknown, number: number) => number;
      defaultNumber: (value: unknown) => number;
    };

    expect(exports.assignNumber("ignored")).toBe(41.5);
    expect(exports.assignString(0)).toBe(1);
    expect(exports.assignBoolean("ignored", 1)).toBe(1);
    expect(exports.assignBoolean("ignored", -1)).toBe(0);
    if (target === "gc") {
      expect(exports.defaultNumber(undefined)).toBe(7);
    } else {
      // Standalone exports receive JS values through the numeric fast wrapper;
      // an external `undefined` arrives as NaN rather than a boxed Undefined
      // partition. The function is still IR-emitted with the native carrier,
      // while the host lane above exercises the `void 0` branch by value.
      expect(exports.defaultNumber(undefined)).toBeNaN();
    }
    expect(exports.defaultNumber(9)).toBe(9);
  });

  it("keeps unsupported assignments and loose void-zero comparison on direct codegen", async () => {
    const result = await compile(
      `
      export function assignObject(value: any): any {
        value = { answer: 42 };
        return value;
      }

      export function looseVoidZero(value: any): number {
        if (value == void 0) value = 1;
        return +value;
      }
      `,
      {
        fileName: "issue-3789-ir-dynamic-object-assignment.ts",
        target: "gc",
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).not.toContain("assignObject");
    expect(result.irCompiledFuncs ?? []).not.toContain("looseVoidZero");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
