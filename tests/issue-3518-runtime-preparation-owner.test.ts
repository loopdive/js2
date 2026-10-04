// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeAll, describe, expect, it } from "vitest";
import * as compatibility from "../src/ir/intrinsic-support.js";
import * as owner from "../src/ir/runtime/intrinsic-preparation.js";
import {
  asValueId,
  forEachInstrDeep,
  mapNestedBuffers,
  type IrInstr,
  type IrInstrIntrinsic,
} from "../src/ir/core/nodes.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import type { PreparedIrFunction } from "../src/ir/runtime/contracts/prepared.js";
import { sourcePacket } from "./helpers/typed-program-fixtures.js";

const POLICY = { target: "host", backend: "wasmgc" } as const;
let semantic: PreparedIrFunction;

beforeAll(() => {
  const { packet } = sourcePacket({
    "./entry.ts": "export function main(x: number): number { return Math.abs(x) + Math.sin(x); }",
  });
  const fn = packet.ir.functions.find((candidate) => candidate.name === "main");
  if (!fn) throw new Error("missing real source fixture owner");
  semantic = fn;
});

function input(fn: PreparedIrFunction = semantic): owner.PrepareIrRuntimeManifestInput {
  return {
    functions: [fn],
    sourceFile: "entry.ts",
    sourceLocationsByUnit: new Map([[fn.unitId, { file: "entry.ts", line: 1, column: 0 }]]),
    policy: POLICY,
  };
}

function intrinsics(fn: PreparedIrFunction): IrInstrIntrinsic[] {
  const result: IrInstrIntrinsic[] = [];
  for (const block of fn.blocks) {
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.kind === "intrinsic") result.push(instr);
      });
    }
  }
  return result;
}

function changeIntrinsic(
  id: IrInstrIntrinsic["id"],
  change: (instr: IrInstrIntrinsic) => IrInstrIntrinsic,
): PreparedIrFunction {
  let changed = 0;
  const visit = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, (buffer) => buffer.map(visit));
    if (nested.kind !== "intrinsic" || nested.id !== id) return nested;
    changed++;
    return change(nested);
  };
  const result = {
    ...semantic,
    blocks: semantic.blocks.map((block) => ({ ...block, instrs: block.instrs.map(visit) })),
  };
  if (changed !== 1) throw new Error(`expected one real ${id} use, got ${changed}`);
  return result;
}

function expectOwnerFailure(fn: PreparedIrFunction, message: RegExp): void {
  let failure: unknown;
  try {
    owner.prepareIrRuntimeManifest(input(fn));
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(owner.IrRuntimeFunctionPreparationError);
  expect(failure).toBeInstanceOf(compatibility.IrRuntimeFunctionPreparationError);
  const located = failure as owner.IrRuntimeFunctionPreparationError;
  expect(located.unitId).toBe(fn.unitId);
  expect(located.message).toMatch(message);
  expect(located.cause).toBeInstanceOf(Error);
}

describe("runtime preparation canonical owner", () => {
  it("retains every compatibility value as the same implementation", () => {
    expect(Object.keys(compatibility).sort()).toEqual(Object.keys(owner).sort());
    for (const name of Object.keys(compatibility) as Array<keyof typeof compatibility>) {
      expect(compatibility[name]).toBe(owner[name]);
    }
    expect(compatibility.prepareIrRuntimeManifest).toBe(owner.prepareIrRuntimeManifest);
    expect(compatibility.IrRuntimeFunctionPreparationError).toBe(owner.IrRuntimeFunctionPreparationError);
    expect(compatibility.verifyIrIntrinsicInstruction).toBe(owner.verifyIrIntrinsicInstruction);
  });

  it("prepares real semantic math uses with the same frozen providers through either path", () => {
    const uses = intrinsics(semantic);
    expect(uses.map((instr) => instr.id)).toEqual(["math.abs", "math.sin"]);
    expect(uses.every((instr) => instr.provider === undefined)).toBe(true);
    const demands: compatibility.IrRuntimeManifestDemands = {};
    const oldInput: compatibility.PrepareIrRuntimeManifestInput = { ...input(), ...demands };
    const oldResult: compatibility.PreparedIrRuntimeManifest | undefined =
      compatibility.prepareIrRuntimeManifest(oldInput);
    const newResult: owner.PreparedIrRuntimeManifest | undefined = owner.prepareIrRuntimeManifest(oldInput);
    if (!oldResult || !newResult) throw new Error("real math demand must freeze a manifest");
    expect(oldResult).toEqual(newResult);
    expect(Object.isFrozen(newResult)).toBe(true);
    expect(Object.isFrozen(newResult.manifest)).toBe(true);
    expect(newResult.manifest.intrinsicUses.map((use) => use.id)).toEqual(["math.abs", "math.sin"]);
    expect(intrinsics(newResult.functions[0]!).map((instr) => instr.provider)).toEqual([
      { kind: "backend-op", opcode: "f64.abs" },
      { kind: "callable", target: irIntrinsicFuncRef("math.sin", "Math_sin") },
    ]);
    expect(intrinsics(semantic).every((instr) => instr.provider === undefined)).toBe(true);
    const replay = owner.prepareIrRuntimeManifest(input(newResult.functions[0]!));
    expect(replay).toEqual(newResult);
  });

  it("retains both optional and includeEmpty overloads on both paths", () => {
    const empty: owner.PrepareIrRuntimeManifestInput = { functions: [], sourceFile: "empty.ts", policy: POLICY };
    const oldOptional: compatibility.PreparedIrRuntimeManifest | undefined =
      compatibility.prepareIrRuntimeManifest(empty);
    const newOptional: owner.PreparedIrRuntimeManifest | undefined = owner.prepareIrRuntimeManifest(empty);
    expect(oldOptional).toBeUndefined();
    expect(newOptional).toBeUndefined();
    const oldRequired: compatibility.PreparedIrRuntimeManifest = compatibility.prepareIrRuntimeManifest({
      ...empty,
      includeEmpty: true,
    });
    const newRequired: owner.PreparedIrRuntimeManifest = owner.prepareIrRuntimeManifest({
      ...empty,
      includeEmpty: true,
    });
    expect(oldRequired).toEqual(newRequired);
    expect(newRequired.functions).toEqual([]);
    expect(newRequired.manifest.providers).toEqual([]);
  });

  it("retains located refusal of an untyped intrinsic argument", () => {
    expectOwnerFailure(
      changeIntrinsic("math.abs", (instr) => ({ ...instr, args: [asValueId(999)] })),
      /math\.abs references an untyped SSA value 999/,
    );
  });

  it("retains located refusal of a result outside the semantic signature", () => {
    expectOwnerFailure(
      changeIntrinsic("math.abs", (instr) => ({ ...instr, resultType: { kind: "val", val: { kind: "i32" } } })),
      /math\.abs has a result outside its semantic signature/,
    );
  });

  it.each(["math.abs", "math.sin"] as const)("refuses a substituted %s provider", (id) => {
    expectOwnerFailure(
      changeIntrinsic(id, (instr) => ({
        ...instr,
        provider:
          id === "math.abs"
            ? { kind: "backend-op", opcode: "f64.sqrt" }
            : { kind: "callable", target: irRuntimeFuncRef("__unbox_number") },
      })),
      /already carries a different prepared provider/,
    );
  });

  it("retains the semantic owner when its source location is missing", () => {
    expect(() => owner.prepareIrRuntimeManifest({ ...input(), sourceLocationsByUnit: new Map() })).toThrowError(
      owner.IrRuntimeFunctionPreparationError,
    );
    expect(() => compatibility.prepareIrRuntimeManifest({ ...input(), sourceLocationsByUnit: new Map() })).toThrowError(
      /IR runtime preparation has no source location/,
    );
  });
});
