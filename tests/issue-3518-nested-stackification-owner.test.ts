// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  stackifyMovableNestedValues,
  type NestedStackificationInput,
} from "../src/ir/analysis/nested-stackification.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { asValueId, irVal, type IrInstr, type IrValueId } from "../src/ir/core/nodes.js";
import {
  stackifyMovableNestedValues as compatibilityStackify,
  type NestedStackificationInput as CompatibilityInput,
} from "../src/ir/nested-stackification.js";

const value = asValueId(1),
  unrelated = asValueId(99),
  F64 = irVal({ kind: "f64" });
type Point = { region: number; index: number; consumer?: IrInstr };
function call(result: IrValueId | null, args: IrValueId[] = []): IrInstr {
  return {
    kind: "call",
    target: irRuntimeFuncRef("nestedOwnerControl"),
    args,
    result,
    resultType: result === null ? null : F64,
  };
}
function constant(): IrInstr {
  return { kind: "const", value: { kind: "f64", value: 2 }, result: asValueId(2), resultType: F64 };
}
function slotRead(slotIndex: number, string = true): IrInstr {
  return { kind: "slot.read", slotIndex, result: value, resultType: string ? { kind: "string" } : F64 };
}
function fixture(def: IrInstr = call(value), between: IrInstr[] = []) {
  const consumer: IrInstr = { kind: "slot.write", slotIndex: 5, value, result: null, resultType: null };
  const instructions = [def, ...between, consumer];
  return {
    crossBlock: new Set([value, unrelated]),
    needsLocal: new Set([value, unrelated]),
    anchorEager: new Set<IrValueId>(),
    totalUses: new Map([[value, 1]]),
    definitions: new Map([[value, def]]),
    definitionPoints: new Map([[value, { region: -1, index: 0 }]]),
    usePoints: new Map<IrValueId, Point[]>([[value, [{ region: -1, index: instructions.length - 1, consumer }]]]),
    instructionsByRegion: new Map<number, IrInstr[]>([[-1, instructions]]),
  } satisfies NestedStackificationInput;
}
type Input = ReturnType<typeof fixture>;
function retained(input: Input): void {
  stackifyMovableNestedValues(input);
  expect([...input.crossBlock]).toEqual([value, unrelated]);
  expect([...input.needsLocal]).toEqual([value, unrelated]);
}
function removed(input: Input): void {
  const crossBlock = input.crossBlock,
    needsLocal = input.needsLocal;
  stackifyMovableNestedValues(input);
  expect(input.crossBlock).toBe(crossBlock);
  expect(input.needsLocal).toBe(needsLocal);
  expect([...crossBlock]).toEqual([unrelated]);
  expect([...needsLocal]).toEqual([unrelated]);
}

describe("nested stackification analysis owner", () => {
  it("forwards the same callable and preserves both public input types", () => {
    expect(compatibilityStackify).toBe(stackifyMovableNestedValues);
    const input: CompatibilityInput = fixture();
    const canonical: NestedStackificationInput = input;
    compatibilityStackify(canonical);
    expect([...input.crossBlock]).toEqual([unrelated]);
    expect([...input.needsLocal]).toEqual([unrelated]);
  });
  it("deletes only a movable effectful value from both original sets across pure work", () => {
    removed(fixture(call(value), [constant()]));
  });
  it.each([
    [
      "top-level region",
      (input: Input) => {
        input.definitionPoints.set(value, { region: 0, index: 0 });
      },
    ],
    [
      "different use region",
      (input: Input) => {
        input.usePoints.get(value)![0]!.region = -2;
      },
    ],
    [
      "use preceding definition",
      (input: Input) => {
        input.usePoints.get(value)![0]!.index = 0;
      },
    ],
    [
      "multiple uses",
      (input: Input) => {
        input.usePoints.get(value)!.push({ ...input.usePoints.get(value)![0]! });
        input.totalUses.set(value, 2);
      },
    ],
    [
      "missing definition",
      (input: Input) => {
        input.definitions.delete(value);
      },
    ],
    [
      "missing definition point",
      (input: Input) => {
        input.definitionPoints.delete(value);
      },
    ],
    [
      "missing region instructions",
      (input: Input) => {
        input.instructionsByRegion.clear();
      },
    ],
    [
      "missing consumer",
      (input: Input) => {
        const point = input.usePoints.get(value)![0]!;
        input.usePoints.set(value, [{ region: point.region, index: point.index }]);
      },
    ],
  ] as const)("retains local materialization for %s", (_label, edit) => {
    const input = fixture();
    edit(input);
    retained(input);
  });
  it("leaves a pure definition to the existing pure-expression scheduler", () => {
    const pure = constant();
    retained(fixture({ ...pure, result: value }));
  });
  it("does not move an effectful result across another call", () => {
    retained(fixture(call(value), [call(null)]));
  });
  it("follows a sole-use pure chain to an in-place terminal consumer", () => {
    const input = fixture(call(value), [constant()]),
      result = asValueId(3);
    const pure: IrInstr = { kind: "binary", op: "f64.add", lhs: value, rhs: asValueId(2), result, resultType: F64 };
    const terminal: IrInstr = { kind: "slot.write", slotIndex: 5, value: result, result: null, resultType: null };
    input.instructionsByRegion.set(-1, [input.definitions.get(value)!, constant(), pure, terminal]);
    input.usePoints.set(value, [{ region: -1, index: 2, consumer: pure }]);
    input.usePoints.set(result, [{ region: -1, index: 3, consumer: terminal }]);
    input.totalUses.set(result, 1);
    removed(input);
  });
  it("retains a chain whose terminal would cross an effect barrier", () => {
    const input = fixture(),
      result = asValueId(3);
    const pure: IrInstr = { kind: "binary", op: "f64.add", lhs: value, rhs: unrelated, result, resultType: F64 };
    const terminal = call(null, [result]);
    input.instructionsByRegion.set(-1, [input.definitions.get(value)!, pure, call(null), terminal]);
    input.usePoints.set(value, [{ region: -1, index: 1, consumer: pure }]);
    input.usePoints.set(result, [{ region: -1, index: 3, consumer: terminal }]);
    input.totalUses.set(result, 1);
    retained(input);
  });
  it("recognizes an eagerly anchored result consumer as in-place", () => {
    const input = fixture(),
      result = asValueId(3),
      consumer = call(result, [value]);
    input.anchorEager.add(result);
    input.instructionsByRegion.set(-1, [input.definitions.get(value)!, consumer]);
    input.usePoints.set(value, [{ region: -1, index: 1, consumer }]);
    removed(input);
  });
  it("moves independent string slot reads together without changing instructions", () => {
    const first = slotRead(0),
      second = { ...slotRead(1), result: asValueId(2) };
    const input = fixture(first, [second]);
    const consumer = call(null, [value, asValueId(2)]);
    input.instructionsByRegion.get(-1)![2] = consumer;
    input.usePoints.set(value, [{ region: -1, index: 2, consumer }]);
    input.crossBlock.add(asValueId(2));
    input.needsLocal.add(asValueId(2));
    input.definitions.set(asValueId(2), second);
    input.definitionPoints.set(asValueId(2), { region: -1, index: 1 });
    input.usePoints.set(asValueId(2), [{ ...input.usePoints.get(value)![0]! }]);
    input.totalUses.set(asValueId(2), 1);
    const instructions = input.instructionsByRegion.get(-1)!;
    removed(input);
    expect(input.instructionsByRegion.get(-1)).toBe(instructions);
    expect(instructions[0]).toBe(first);
    expect(instructions[1]).toBe(second);
  });
  it("retains a string snapshot across a conflicting slot write", () => {
    const write: IrInstr = { kind: "slot.write", slotIndex: 0, value: unrelated, result: null, resultType: null };
    retained(fixture(slotRead(0), [write]));
  });
  it("retains a string snapshot across an intervening call", () => {
    retained(fixture(slotRead(0), [call(null)]));
  });
  it("retains a non-string slot read across an independent slot read", () => {
    retained(fixture(slotRead(0, false), [{ ...slotRead(1), result: asValueId(2) }]));
  });
  it.each([true, false])("limits pure-chain region-end motion to string slots (string=%s)", (string) => {
    const input = fixture(slotRead(0, string)),
      result = asValueId(3);
    const pure: IrInstr = { kind: "coerce.to_externref", value, result, resultType: irVal({ kind: "externref" }) };
    input.instructionsByRegion.set(-1, [input.definitions.get(value)!, pure]);
    input.usePoints.set(value, [{ region: -1, index: 1, consumer: pure }]);
    input.usePoints.set(result, [{ region: -1, index: 2 }]);
    input.totalUses.set(result, 1);
    if (string) removed(input);
    else retained(input);
  });
});
