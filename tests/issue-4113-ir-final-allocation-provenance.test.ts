// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";

const { injectedMonomorphParents } = vi.hoisted(() => ({
  injectedMonomorphParents: new Set<string>(),
}));

// Production call tuples are normalized before the current monomorphization
// pass. This narrow wrapper supplies one contract-shaped clone so the final
// integration collection, rather than only the pass unit tests, can prove the
// required gate observes monomorphized artifacts.
vi.mock("../src/ir/passes/monomorphize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/passes/monomorphize.js")>();
  const { createDerivedIrUnitId } = await import("../src/ir/identity.js");
  const { forkAllocInInstr } = await import("../src/ir/passes/alloc-discipline.js");
  return {
    ...actual,
    monomorphize(...args: Parameters<typeof actual.monomorphize>) {
      const result = actual.monomorphize(...args);
      const cloneSignatures = new Map(result.cloneSignatures);
      const cloneOrigins = new Map(result.cloneOrigins);
      const cloneUnitProvenance = new Map(result.cloneUnitProvenance);
      const clones: (typeof result.module.functions)[number][] = [];
      for (const parent of result.module.functions) {
        if (!injectedMonomorphParents.has(parent.name)) continue;
        const returnType = parent.resultTypes[0];
        if (!returnType || parent.resultTypes.length !== 1) {
          throw new Error(`monomorphized final-gate fixture requires one result from ${parent.name}`);
        }
        const unitId = createDerivedIrUnitId({
          parentId: parent.unitId,
          role: "monomorphization-clone",
          ordinal: 0,
        });
        const name = `${parent.name}$final_alloc_test`;
        clones.push({
          ...parent,
          unitId,
          name,
          exported: false,
          blocks: parent.blocks.map((block) => ({
            ...block,
            instrs: block.instrs.map((instr) => forkAllocInInstr(instr, args[1])),
          })),
        });
        cloneSignatures.set(unitId, {
          name,
          params: parent.params.map((param) => param.type),
          returnType,
        });
        cloneOrigins.set(unitId, parent.unitId);
        cloneUnitProvenance.set(unitId, {
          id: unitId,
          parentId: parent.unitId,
          role: "monomorphization-clone",
          ordinal: 0,
        });
      }
      return {
        ...result,
        module: { functions: [...result.module.functions, ...clones] },
        cloneSignatures,
        cloneOrigins,
        cloneUnitProvenance,
      };
    },
  };
});

import { compile } from "../src/index.js";

const TRACKED_ENV = ["IR_VERIFY_ALLOC", "JS2WASM_TEST_INJECT_IR_FINAL_ALLOC_FAILURE"] as const;
const ORIGINAL_ENV = new Map(TRACKED_ENV.map((name) => [name, process.env[name]]));

afterEach(() => {
  injectedMonomorphParents.clear();
  for (const name of TRACKED_ENV) {
    const original = ORIGINAL_ENV.get(name);
    if (original === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = original;
  }
});

describe("#4113 final allocation-provenance gate", () => {
  it("accepts a normal final artifact with IR_VERIFY_ALLOC unset", async () => {
    Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
    const result = await compile(`export function value(): string { return "final"; }`, {
      fileName: "issue-4113-pass.ts",
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irOutcomes).toEqual([
      expect.objectContaining({ displayName: "value", kind: "emitted", irBodyEmitted: true }),
    ]);
  });

  it("rejects invalid final provenance with IR_VERIFY_ALLOC unset", async () => {
    Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
    process.env.JS2WASM_TEST_INJECT_IR_FINAL_ALLOC_FAILURE = "broken";
    const result = await compile(
      `
export function broken(): string { return "invalid"; }
export function independent(value: number): number { return value + 1; }
`,
      { fileName: "issue-4113-fail.ts", trackIrOutcomes: true },
    );

    expect(result.success).toBe(false);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "broken")).toMatchObject({
      kind: "invariant",
      code: "allocation-provenance-failure",
      stage: "verify",
      irBodyEmitted: false,
    });
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "independent")).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });
  });

  it("does not let a synthetic final artifact bypass the required gate", async () => {
    Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
    process.env.JS2WASM_TEST_INJECT_IR_FINAL_ALLOC_FAILURE = "synthetic";
    const result = await compile(
      `
export function outer(prefix: string): string {
  function append(value: string): string { return prefix + value; }
  return append("final");
}
`,
      { fileName: "issue-4113-synthetic.ts", trackIrOutcomes: true },
    );

    expect(result.success).toBe(false);
    expect(result.irOutcomes).toEqual([
      expect.objectContaining({
        displayName: "outer",
        kind: "invariant",
        code: "allocation-provenance-failure",
        stage: "verify",
        irBodyEmitted: false,
      }),
    ]);
  });

  it("does not let a monomorphized final artifact bypass the required gate", async () => {
    Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
    injectedMonomorphParents.add("cloneSource");
    process.env.JS2WASM_TEST_INJECT_IR_FINAL_ALLOC_FAILURE = "monomorphized";
    const result = await compile(`export function cloneSource(): string { return "clone"; }`, {
      fileName: "issue-4113-monomorphized.ts",
      trackIrOutcomes: true,
    });

    expect(result.success).toBe(false);
    expect(result.irOutcomes).toEqual([
      expect.objectContaining({
        displayName: "cloneSource",
        kind: "invariant",
        code: "allocation-provenance-failure",
        stage: "verify",
        irBodyEmitted: false,
      }),
    ]);
  });
});
