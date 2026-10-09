// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";
import { IR_CLASS_SHAPE_CELL, type IrClassShape, type IrType } from "../src/ir/core/types.js";
import { freezePreparedIrValue, freezePreparedIrRuntimeValue } from "../src/ir/program/data.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { buildCodecFixture } from "./helpers/ir-whole-program-codec-fixture.js";

const apis = [
  ["copy", freezePreparedIrValue],
  ["in-place", freezePreparedIrRuntimeValue],
] as const;
const fields = [IR_CLASS_SHAPE_CELL, "classId", "className", "fields", "methods", "constructorParams"] as const;

function recursiveCell() {
  return buildCodecFixture([{ backend: "wasmgc", target: "standalone" }]).classShape;
}

function lateGetter(field: PropertyKey) {
  const real = recursiveCell();
  const cycle: Record<PropertyKey, unknown> = {};
  // Put the back edge before every factory field, so the active-cycle predicate
  // encounters the late accessor before the ordinary descriptor walk reaches it.
  cycle.self = cycle;
  for (const key of fields) cycle[key] = Object.getOwnPropertyDescriptor(real, key)!.value;
  const getter = vi.fn(() => Object.getOwnPropertyDescriptor(real, field)!.value);
  Object.defineProperty(cycle, field, { enumerable: true, configurable: true, get: getter });
  return { cycle, getter };
}

describe.each(apis)("IR class-cycle own DATA (%s)", (name, freeze) => {
  it.each(fields)("rejects a late %s getter without executing it", (field) => {
    const { cycle, getter } = lateGetter(field);
    expect(() => freeze(cycle)).toThrow(PreparedIrProgramInvariantError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("preserves the valid canonical recursive cell, its brand, back edge and frozen graph", () => {
    const original = recursiveCell();
    for (const key of fields) expect(Object.hasOwn(original, key)).toBe(true);
    const result = freeze(original) as IrClassShape;
    expect(result.classId).toBe(original.classId);
    expect(result.className).toBe("Node");
    expect(result[IR_CLASS_SHAPE_CELL]).toBe(true);
    const next = result.fields.find((field) => field.name === "next")!.type as Extract<IrType, { kind: "class" }>;
    expect(next.shape).toBe(result);
    for (const item of [result, result.fields, result.methods, result.constructorParams, next])
      expect(Object.isFrozen(item)).toBe(true);
    if (name === "in-place") expect(result).toBe(original);
    else expect(result).not.toBe(original);
  });
});
