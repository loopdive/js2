// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import * as canonical from "../src/shared/contracts/prepared-ir-data.js";
import * as compatibility from "../src/ir/program/data.js";
import { PreparedIrProgramInvariantError } from "../src/shared/contracts/prepared-ir-invariant-error.js";
import { PreparedIrProgramInvariantError as CompatibilityError } from "../src/ir/program/errors.js";
import { IR_CLASS_SHAPE_CELL } from "../src/shared/contracts/ir-class-shape-marker.js";
import { IR_CLASS_SHAPE_CELL as compatibilityMarker } from "../src/ir/core/types.js";

describe("canonical shared prepared DATA ownership", () => {
  it("retains every existing callable binding and unique class marker", () => {
    expect(Object.keys(compatibility).sort()).toEqual(Object.keys(canonical).sort());
    for (const key of Object.keys(canonical) as (keyof typeof canonical)[]) {
      expect(compatibility[key]).toBe(canonical[key]);
    }
    expect(compatibilityMarker).toBe(IR_CLASS_SHAPE_CELL);
    expect(CompatibilityError).toBe(PreparedIrProgramInvariantError);
  });

  it("throws the same authentic invariant class through both API homes", () => {
    for (const api of [canonical, compatibility]) {
      try {
        api.assertPreparedIrData({ forbidden: () => 1 });
        throw new Error("executable DATA was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(CompatibilityError);
        expect((error as PreparedIrProgramInvariantError).code).toBe("invalid-prepared-data");
      }
    }
  });

  it("preserves immutable maps and recursive class-shape cells with the moved marker", () => {
    const shape: Record<PropertyKey, unknown> = {
      [compatibilityMarker]: true,
      classId: "ir-class:v1:identity-control",
      className: "Recursive",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    shape.fields = [{ name: "self", type: { kind: "class", shape } }];
    const frozen = canonical.freezePreparedIrValue({ shapes: new Map([["recursive", shape]]) }) as {
      shapes: ReadonlyMap<string, Record<PropertyKey, unknown>>;
    };
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.shapes.get("recursive")![IR_CLASS_SHAPE_CELL]).toBe(true);
    expect(canonical.preparedIrDataMismatch(frozen, compatibility.freezePreparedIrValue(frozen))).toBeUndefined();
    canonical.assertPreparedIrData(frozen);
    expect("set" in frozen.shapes).toBe(false);
  });
});
