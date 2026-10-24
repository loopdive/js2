// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";

afterEach(() => vi.unstubAllEnvs());
for (const gvn of [false, true])
  for (const decoded of [false, true])
    it(`retains a runtime callback parameter and common Call, GVN=${gvn}, decoded=${decoded}`, () => {
      vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
      const program = prepareGetterProgram(
        `
        type Resolve = (value: number) => void;
        export function makeThen(seed: number): (resolve: Resolve) => void {
          return function then(resolve: Resolve): void { resolve(seed); };
        }`,
        decoded,
      );
      const source = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
      expect(source.gaps).toEqual([]);
      expect(source.units).toHaveLength(1);
      const lifted = program.runtime[0]!.prepared.functions.find((fn) => fn.closureSubtype)!;
      expect(lifted.params[1]!.type).toMatchObject({ kind: "callable", signature: { returnType: null } });
      const invocation = planNativeInvocationRequirements(source, { utf8Storage: false })!;
      expect(invocation.gaps).toEqual([]);
      expect(invocation.uses.filter((use) => use.parameterIndex !== undefined)).toEqual([
        expect.objectContaining({ ownerUnitId: lifted.unitId, kind: "method", arity: 1, parameterIndex: 1 }),
      ]);
      let typedCalls = 0;
      for (const block of lifted.blocks)
        for (const instruction of block.instrs)
          forEachInstrDeep(instruction, (row) => {
            if (row.kind === "closure.call") typedCalls++;
          });
      expect(typedCalls).toBe(0);
    });

it("refuses to trust a numeric result annotation on a runtime-supplied callback", () => {
  expect(() =>
    prepareGetterProgram(`export function make(seed: number): (callback: (value: number) => number) => number {
    return function invoke(callback: (value: number) => number): number { return callback(seed); };
  }`),
  ).toThrow(/runtime-supplied callable result needs a value-preserving carrier/);
});
