import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const recursivePredicate = `
export function recursive(node: any): any {
  return node.type === "Leaf" ||
    node.type === "Wrap" && recursive(node.expression);
}
`;

describe("#2949 recursive boolean results with a dynamic ABI", () => {
  it.each(["gc", "standalone"] as const)("emits the predicate through IR on the %s target", async (target) => {
    const result = await compile(recursivePredicate, {
      fileName: "recursive-boolean.ts",
      target,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("recursive");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("preserves recursive true, short-circuit, and false results through the host dynamic carrier", async () => {
    const result = await compile(recursivePredicate, {
      fileName: "recursive-boolean-runtime.ts",
      target: "gc",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("recursive");

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const recursive = instance.exports.recursive as (node: unknown) => unknown;
    expect(recursive({ type: "Leaf" })).toBe(true);
    expect(recursive({ type: "Wrap", expression: { type: "Leaf" } })).toBe(true);
    expect(recursive({ type: "Wrap", expression: { type: "Other" } })).toBe(false);
  });

  it("keeps mixed-value logical results on the legacy path", async () => {
    const result = await compile(`export function mixed(value: any): any { return value || 42; }`, {
      fileName: "mixed-logical.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "mixed")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "logical-value-unsupported",
      irBodyEmitted: false,
      legacyBodyEmitted: true,
    });
  });
});
