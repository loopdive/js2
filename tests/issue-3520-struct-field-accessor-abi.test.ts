// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import {
  programAbiCallableRoleOrdinalsAreDistinct,
  PROGRAM_ABI_CALLABLE_ROLE,
} from "../src/codegen/program-abi-planning.js";
import {
  STRUCT_FIELD_ACCESSOR_ROLE,
  STRUCT_FIELD_ACCESSOR_KIND,
  STRUCT_FIELD_ACCESSOR_KIND_STRIDE,
  structFieldAccessorDerivedOrdinal,
  structFieldAccessorFieldOrder,
  type StructFieldAccessorKind,
} from "../src/codegen/struct-field-accessor-abi.js";
import { irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createIrBindingId } from "../src/ir/identity.js";
import { emitBinary } from "../src/emit/binary.js";

// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const RETAINED_MODULE_FUNCTION_ROLE = "retained-module-function";

const POINT_SOURCE = `
class Point {
  x: number;
  y: number;
  visible: boolean;
  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.visible = true;
  }
}
export function make(a: number, b: number): Point {
  return new Point(a, b);
}
export function shift(p: Point): number {
  p.x = p.x + 1;
  return p.x;
}
`;

/** Same struct shape, but three extra source functions ahead of the accessors. */
const POINT_SOURCE_WITH_EXTRA_FUNCTIONS = `${POINT_SOURCE}
export function extraOne(v: number): number {
  return v + 1;
}
export function extraTwo(v: number): number {
  return v + 2;
}
export function extraThree(v: number): number {
  return v + 3;
}
`;

interface AbiEntryView {
  readonly id: string;
  readonly displayName?: string;
  readonly intent?: { readonly kind?: string };
}

function hardErrors(result: ReturnType<typeof generateModule>) {
  return result.errors.filter((error) => error.severity !== "warning");
}

function compileFixture(source: string, fileName: string, trackIrOutcomes = true) {
  const ast = analyzeSource(source, fileName);
  const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes });
  expect(
    hardErrors(result),
    hardErrors(result)
      .map((error) => error.message)
      .join("\n"),
  ).toEqual([]);
  return result;
}

function abiEntries(result: ReturnType<typeof generateModule>): readonly AbiEntryView[] {
  const publication = (result as unknown as { programAbi?: { abi: { entries(): readonly AbiEntryView[] } } })
    .programAbi;
  expect(publication, "compilation published no Program ABI").toBeDefined();
  return publication!.abi.entries();
}

function entrySourceId(source: string, fileName: string): string {
  const ast = analyzeSource(source, fileName);
  return buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  }).sources.find((candidate) => candidate.kind === "entry")!.id;
}

function accessorBindingId(sourceId: string, kind: StructFieldAccessorKind, fieldOrderPosition: number): string {
  return createIrBindingId({
    ownerId: sourceId as never,
    domain: "support",
    role: STRUCT_FIELD_ACCESSOR_ROLE,
    ordinal: fieldOrderPosition * STRUCT_FIELD_ACCESSOR_KIND_STRIDE + STRUCT_FIELD_ACCESSOR_KIND[kind],
  });
}

/**
 * Callable rows only. An export alias carries the same `displayName` as the
 * callable it aliases, so an unfiltered name match sees two rows per accessor.
 */
function callableRowsForRole(entries: readonly AbiEntryView[], role: string): readonly AbiEntryView[] {
  return entries.filter((entry) => entry.intent?.kind === "callable" && String(entry.id).includes(`:${role}:`));
}

describe("#3520 C34 per-field host accessor Program ABI ownership", () => {
  it("gives every emitted per-field accessor an exact entry-source structural owner", () => {
    const result = compileFixture(POINT_SOURCE, "issue-3520-struct-field-accessor.ts");
    const entries = abiEntries(result);
    const sourceId = entrySourceId(POINT_SOURCE, "issue-3520-struct-field-accessor.ts");

    // Canonical sorted field order for this fixture: visible(0), x(1), y(2).
    const expected = new Map<string, string>([
      ["__sget_visible", accessorBindingId(sourceId, "get", 0)],
      ["__sset_visible", accessorBindingId(sourceId, "set", 0)],
      ["__sbool_visible", accessorBindingId(sourceId, "bool", 0)],
      ["__sget_x", accessorBindingId(sourceId, "get", 1)],
      ["__sset_x", accessorBindingId(sourceId, "set", 1)],
      ["__sget_y", accessorBindingId(sourceId, "get", 2)],
      ["__sset_y", accessorBindingId(sourceId, "set", 2)],
    ]);

    const emittedAccessors = result.module.functions
      .map((func) => func.name)
      .filter((name) => /^__(sget|sset|shas|sbool)_/.test(name));
    expect(new Set(emittedAccessors)).toEqual(new Set(expected.keys()));

    for (const [displayName, bindingId] of expected) {
      const owners = entries.filter((entry) => entry.intent?.kind === "callable" && entry.displayName === displayName);
      expect(
        owners.map((entry) => entry.id),
        `callable owners for ${displayName}`,
      ).toEqual([bindingId]);
    }

    // The whole family left the positional fallback: no accessor is generic.
    const genericAccessorRows = callableRowsForRole(entries, RETAINED_MODULE_FUNCTION_ROLE).filter((entry) =>
      /^__(sget|sset|shas|sbool)_/.test(entry.displayName ?? ""),
    );
    expect(genericAccessorRows).toEqual([]);
  });

  it("derives the ordinal from canonical field order, never from emission order", () => {
    const forward = structFieldAccessorFieldOrder(["y", "x", "visible"]);
    const reversed = structFieldAccessorFieldOrder(["visible", "x", "y"].reverse());
    expect(forward).toEqual(["visible", "x", "y"]);
    expect(reversed).toEqual(forward);

    // Kinds occupy distinct low components inside one field's reserved stride.
    expect(structFieldAccessorDerivedOrdinal(forward, "get", "visible")).toBe(0);
    expect(structFieldAccessorDerivedOrdinal(forward, "set", "visible")).toBe(1);
    expect(structFieldAccessorDerivedOrdinal(forward, "has", "visible")).toBe(2);
    expect(structFieldAccessorDerivedOrdinal(forward, "bool", "visible")).toBe(3);
    expect(structFieldAccessorDerivedOrdinal(forward, "get", "x")).toBe(4);
    expect(structFieldAccessorDerivedOrdinal(forward, "get", "y")).toBe(8);
    expect(structFieldAccessorDerivedOrdinal(forward, "get", "absent")).toBeUndefined();

    // Elision invariance: dropping a field from the SURVIVING set must not be
    // allowed to renumber its neighbours. `observeStructFieldAccessorAbi`
    // derives the order from the pre-elision record for exactly this reason —
    // deriving it from survivors would give `y` a different ordinal purely
    // because `x` was eliminated.
    const survivorsOnly = structFieldAccessorFieldOrder(["visible", "y"]);
    expect(structFieldAccessorDerivedOrdinal(survivorsOnly, "get", "y")).toBe(4);
    expect(structFieldAccessorDerivedOrdinal(forward, "get", "y")).toBe(8);

    // Every kind fits inside the reserved stride, so no two fields overlap.
    for (const kind of Object.values(STRUCT_FIELD_ACCESSOR_KIND)) {
      expect(kind).toBeLessThan(STRUCT_FIELD_ACCESSOR_KIND_STRIDE);
    }
  });

  it("keeps accessor identity fixed while unrelated growth moves every final index", () => {
    const base = compileFixture(POINT_SOURCE, "issue-3520-struct-field-accessor-stability.ts");
    const grown = compileFixture(POINT_SOURCE_WITH_EXTRA_FUNCTIONS, "issue-3520-struct-field-accessor-stability.ts");

    const accessorIds = (result: ReturnType<typeof generateModule>) =>
      callableRowsForRole(abiEntries(result), STRUCT_FIELD_ACCESSOR_ROLE)
        .map((entry) => entry.id)
        .sort();

    expect(accessorIds(base)).toHaveLength(7);
    // Same struct shape ⇒ identical accessor identities, even though the module
    // now contains three more source functions ahead of them.
    expect(accessorIds(grown)).toEqual(accessorIds(base));

    // Control: the positions really did move. Under the old positional
    // `retained-module-function` fallback the derived ordinal IS the final
    // index, so this shift is exactly what used to rewrite the identity.
    const finalIndexOf = (result: ReturnType<typeof generateModule>, name: string) =>
      result.module.functions.findIndex((func) => func.name === name);
    expect(grown.module.functions.length).toBeGreaterThan(base.module.functions.length);
    expect(finalIndexOf(grown, "__sget_x")).not.toBe(finalIndexOf(base, "__sget_x"));
  });

  it("keys the binding by role and ordinal only — the display label is not part of it", () => {
    const sourceId = entrySourceId(POINT_SOURCE, "issue-3520-struct-field-accessor-label.ts");
    const labelled = irSupportFuncRef(sourceId as never, STRUCT_FIELD_ACCESSOR_ROLE, "__sget_x", 4);
    const differentLabel = irSupportFuncRef(sourceId as never, STRUCT_FIELD_ACCESSOR_ROLE, "totally-unrelated", 4);
    expect(labelled.binding.kind).toBe("support");
    expect(differentLabel.binding.kind).toBe("support");
    if (labelled.binding.kind !== "support" || differentLabel.binding.kind !== "support") return;
    expect(differentLabel.binding.bindingId).toBe(labelled.binding.bindingId);

    // A different ordinal is a different binding — the ordinal really is the key.
    const otherOrdinal = irSupportFuncRef(sourceId as never, STRUCT_FIELD_ACCESSOR_ROLE, "__sget_x", 5);
    if (otherOrdinal.binding.kind !== "support") return;
    expect(otherOrdinal.binding.bindingId).not.toBe(labelled.binding.bindingId);
  });

  it("reserves a distinct callable role ordinal", () => {
    expect(programAbiCallableRoleOrdinalsAreDistinct()).toBe(true);
    expect(PROGRAM_ABI_CALLABLE_ROLE.structFieldAccessor).toBe(14);
  });

  it("keeps tracked and untracked binaries byte-identical", () => {
    const untracked = compileFixture(POINT_SOURCE, "issue-3520-struct-field-accessor-bytes.ts", false);
    const tracked = compileFixture(POINT_SOURCE, "issue-3520-struct-field-accessor-bytes.ts", true);
    expect(Buffer.from(emitBinary(tracked.module))).toEqual(Buffer.from(emitBinary(untracked.module)));
  });

  /**
   * Deliberately NOT an absolute-count census.
   *
   * The C30–C33 slices each pinned literal five-entry denominators (166 defined
   * functions, 45 generic, 26 closure, …). Every one of those numbers has since
   * drifted on main and those suites are red, which means they now report the
   * playground corpus changing rather than the property they were written to
   * defend. This asserts the invariant instead: whatever the corpus contains,
   * every emitted per-field accessor is owned by the structural role and none
   * is left on the positional fallback. The denominators themselves live in the
   * issue file, where a stale number is a stale note rather than a red gate.
   */
  it("leaves no per-field accessor on generic ownership across the five host entries", () => {
    const ACCESSOR_NAME = /^__(sget|sset|shas|sbool)_/;
    let emittedAccessorFunctions = 0;
    let accessorRows = 0;
    let genericAccessorRows = 0;

    for (const entry of SINGLE_HOST_ENTRIES) {
      const source = readFileSync(resolve(entry), "utf8");
      const ast = analyzeSource(source, entry);
      const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
      expect(
        hardErrors(result),
        `${entry}\n${hardErrors(result)
          .map((error) => error.message)
          .join("\n")}`,
      ).toEqual([]);
      emittedAccessorFunctions += result.module.functions.filter((func) => ACCESSOR_NAME.test(func.name)).length;
      const entries = abiEntries(result);
      accessorRows += callableRowsForRole(entries, STRUCT_FIELD_ACCESSOR_ROLE).length;
      genericAccessorRows += callableRowsForRole(entries, RETAINED_MODULE_FUNCTION_ROLE).filter((row) =>
        ACCESSOR_NAME.test(row.displayName ?? ""),
      ).length;
    }

    // Anti-vacuity: the corpus must actually contain accessors, or "none are
    // generic" is trivially true. Measured at origin/main 540064dfb this is 25.
    expect(emittedAccessorFunctions).toBeGreaterThan(0);
    // Every emitted accessor has exactly one structural callable owner...
    expect(accessorRows).toBe(emittedAccessorFunctions);
    // ...and none of them is left on the positional fallback.
    expect(genericAccessorRows).toBe(0);
  });
});
