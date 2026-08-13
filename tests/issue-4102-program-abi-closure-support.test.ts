// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  canonicalProgramAbiClosureLayoutKey,
  canonicalProgramAbiClosureSignatureKey,
  canonicalProgramAbiObjectShapeKey,
  canonicalProgramAbiRefCellKey,
  type ProgramAbiClosureSupportLayoutRequest,
} from "../src/codegen/program-abi-type-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irSupportTypeRef, irTypeBindingKey } from "../src/ir/abi-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { irVal, type IrClosureSignature, type IrType } from "../src/ir/nodes.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { lowerPreparedClosureSupportType } from "../src/ir/prepared-closure-support.js";
import { ProgramAbiInvariantError } from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type FieldDef,
  type FuncTypeDef,
  type StructTypeDef,
  type TypeDef,
  type ValType,
} from "../src/ir/types.js";

const F64 = irVal({ kind: "f64" });
const EXTERNREF = irVal({ kind: "externref" });
const WRAPPER_FIELDS: readonly FieldDef[] = Object.freeze([
  Object.freeze({ name: "func", type: { kind: "funcref" }, mutable: false }),
  Object.freeze({ name: "$arity", type: { kind: "i32" }, mutable: false }),
  Object.freeze({ name: "$bag", type: { kind: "externref" }, mutable: true }),
]);

function physicalType(type: IrType): ValType {
  if (type.kind !== "val" || type.val.kind === "ref" || type.val.kind === "ref_null") {
    throw new Error(`test fixture cannot materialize ${type.kind}`);
  }
  return type.val;
}

function appendLayout(
  types: TypeDef[],
  input: {
    readonly signature: IrClosureSignature;
    readonly captures: readonly IrType[];
    readonly root?: StructTypeDef;
    readonly name: string;
  },
): ProgramAbiClosureSupportLayoutRequest {
  const root = input.root ?? {
    kind: "struct",
    name: `${input.name}_root`,
    fields: WRAPPER_FIELDS,
    superTypeIdx: -1,
  };
  if (!input.root) types.push(root);
  const rootIndex = types.indexOf(root);
  if (rootIndex < 0) throw new Error("closure root is not allocated");
  const wrapper: StructTypeDef = input.root
    ? {
        kind: "struct",
        name: `${input.name}_wrapper`,
        fields: WRAPPER_FIELDS,
        superTypeIdx: rootIndex,
      }
    : root;
  if (wrapper !== root) types.push(wrapper);
  const wrapperIndex = types.indexOf(wrapper);
  const lifted: FuncTypeDef = {
    kind: "func",
    name: `${input.name}_lifted`,
    params: [{ kind: "ref", typeIdx: rootIndex }, ...input.signature.params.map(physicalType)],
    results: input.signature.returnType === null ? [] : [physicalType(input.signature.returnType)],
  };
  types.push(lifted);
  const captured: StructTypeDef =
    input.captures.length === 0
      ? wrapper
      : {
          kind: "struct",
          name: `${input.name}_captured`,
          fields: [
            ...WRAPPER_FIELDS,
            ...input.captures.map((type, index) => ({
              name: `cap${index}`,
              type: physicalType(type),
              mutable: false,
            })),
          ],
          superTypeIdx: wrapperIndex,
        };
  if (captured !== wrapper) types.push(captured);
  return {
    signature: input.signature,
    captureFieldTypes: input.captures,
    wrapperRootType: root,
    allocationWrapperType: wrapper,
    liftedFuncType: lifted,
    capturedSubtypeType: captured,
  };
}

function fixture(options: Parameters<typeof createCodegenContext>[2] = {}) {
  const ast = analyzeSource(
    "export function owner(ms: number, value: number): number { return ms + value; }",
    "/repo/issue-4102-program-abi-closure-support.ts",
  );
  const inventory = buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker });
  const identityContext = buildIrPlanningIdentityContext(inventory);
  const module = createEmptyModule();
  const session = new ProgramAbiSession(inventory, module);
  const ctx = createCodegenContext(module, ast.checker, options, session, identityContext);
  if (!ctx.programAbiTypes) throw new Error("missing Program ABI type registry");
  return { ctx, module, session, registry: ctx.programAbiTypes };
}

function promiseLayouts(f: ReturnType<typeof fixture>) {
  const executorSignature: IrClosureSignature = { params: [EXTERNREF], returnType: null };
  const timerSignature: IrClosureSignature = { params: [], returnType: null };
  const executor = appendLayout(f.module.types, {
    signature: executorSignature,
    captures: [F64, F64],
    name: "executor",
  });
  const timer = appendLayout(f.module.types, {
    signature: timerSignature,
    captures: [EXTERNREF, F64],
    root: executor.wrapperRootType,
    name: "timer",
  });
  return { executor, timer };
}

function expectProgramAbiInvariant(action: () => unknown, code: string): ProgramAbiInvariantError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProgramAbiInvariantError);
  expect((caught as ProgramAbiInvariantError).code).toBe(code);
  return caught as ProgramAbiInvariantError;
}

describe("#4102 Program ABI prepared closure support types", () => {
  it("lowers an exact slotless host-string carrier through the prepared closure ABI", () => {
    const f = fixture();
    const carrierRef = f.registry.prepareStringCarrier();
    expect(lowerPreparedClosureSupportType(f.ctx, { kind: "string", carrierRef })).toEqual({ kind: "externref" });
    expect(lowerPreparedClosureSupportType(f.ctx, { kind: "string", carrierRef })).toEqual({ kind: "externref" });

    const unplanned = irSupportTypeRef(f.session.inventory.sources[0]!.id, "foreign-string-carrier", "foreign");
    expect(() => lowerPreparedClosureSupportType(f.ctx, { kind: "string", carrierRef: unplanned })).toThrow(
      /no exact Program ABI type plan/,
    );
  });

  it("lowers the exact slotted native-string carrier through its remappable type cell", () => {
    const f = fixture({ nativeStrings: true });
    const carrierRef = f.registry.prepareStringCarrier();
    expect(f.ctx.anyStrTypeIdx).toBeGreaterThanOrEqual(0);
    expect(lowerPreparedClosureSupportType(f.ctx, { kind: "string", carrierRef })).toEqual({
      kind: "ref",
      typeIdx: f.ctx.anyStrTypeIdx,
    });
  });

  it("plans semantic refs in sorted order and dedupes exact requests without allocating types", () => {
    const f = fixture();
    const { executor, timer } = promiseLayouts(f);
    const typeCount = f.module.types.length;

    const [timerLayout, executorLayout, duplicateExecutor] = f.registry.prepareClosureSupportLayouts([
      timer,
      executor,
      executor,
    ]);
    expect(f.module.types).toHaveLength(typeCount);
    expect(duplicateExecutor).toBe(executorLayout);
    expect(executorLayout!.wrapperRootRef).toBe(executorLayout!.allocationWrapperRef);
    expect(timerLayout!.wrapperRootRef).toBe(executorLayout!.wrapperRootRef);
    expect(timerLayout!.allocationWrapperRef).not.toBe(timerLayout!.wrapperRootRef);
    expect(
      new Set([
        irTypeBindingKey(executorLayout!.wrapperRootRef.binding),
        irTypeBindingKey(executorLayout!.liftedFuncRef.binding),
        irTypeBindingKey(executorLayout!.capturedSubtypeRef.binding),
        irTypeBindingKey(timerLayout!.allocationWrapperRef.binding),
        irTypeBindingKey(timerLayout!.liftedFuncRef.binding),
        irTypeBindingKey(timerLayout!.capturedSubtypeRef.binding),
      ]),
    ).toHaveLength(6);

    const expectedSignatureOrder = [
      canonicalProgramAbiClosureSignatureKey(executor.signature),
      canonicalProgramAbiClosureSignatureKey(timer.signature),
    ].sort();
    for (const layout of [executorLayout!, timerLayout!]) {
      expect(layout.semanticSignatureKey).not.toContain("typeIdx");
      expect(layout.semanticLayoutKey).not.toContain("typeIdx");
      expect(f.session.getDraft(layout.liftedFuncRef.binding.bindingId)?.structuralOrder.derivedOrdinal).toBe(
        expectedSignatureOrder.indexOf(layout.semanticSignatureKey),
      );
    }
    expect(f.registry.prepareClosureSupportLayouts([executor, timer])).toEqual([executorLayout, timerLayout]);
  });

  it("rejects one semantic layout mapping to different physical type objects before planning", () => {
    const f = fixture();
    const { executor } = promiseLayouts(f);
    const alternateSubtype: StructTypeDef = {
      ...executor.capturedSubtypeType,
      fields: [...executor.capturedSubtypeType.fields],
    };
    f.module.types.push(alternateSubtype);
    const alternate = { ...executor, capturedSubtypeType: alternateSubtype };

    expectProgramAbiInvariant(
      () => f.registry.prepareClosureSupportLayouts([executor, alternate]),
      "type-remap-mismatch",
    );
    expect(f.session.typeCellFor(executor.wrapperRootType)).toBeUndefined();
    expect(f.session.typeCellFor(executor.capturedSubtypeType)).toBeUndefined();
  });

  it("publishes semantic closure refs through an exact allocator-object remap", () => {
    const f = fixture();
    const { executor } = promiseLayouts(f);
    const [layout] = f.registry.prepareClosureSupportLayouts([executor]);
    const subtypeIndex = f.module.types.indexOf(executor.capturedSubtypeType);
    const replacement: StructTypeDef = {
      ...executor.capturedSubtypeType,
      name: "executor_captured_after_remap",
      fields: [...executor.capturedSubtypeType.fields],
    };
    const cell = f.session.typeCellFor(executor.capturedSubtypeType);
    expect(cell).toBeDefined();
    f.session.remapTypeObject(executor.capturedSubtypeType, replacement);
    f.module.types[subtypeIndex] = replacement;
    expect(cell!.current).toBe(replacement);

    f.registry.planRetained();
    const publication = f.session.publish(f.module);
    expect(publication.abi.resolveFinalIndex(layout!.wrapperRootRef.binding.bindingId)).toEqual({
      space: "type",
      index: f.module.types.indexOf(executor.wrapperRootType),
    });
    expect(publication.abi.resolveFinalIndex(layout!.liftedFuncRef.binding.bindingId)).toEqual({
      space: "type",
      index: f.module.types.indexOf(executor.liftedFuncType),
    });
    expect(publication.abi.resolveFinalIndex(layout!.capturedSubtypeRef.binding.bindingId)).toEqual({
      space: "type",
      index: subtypeIndex,
    });
    expect(layout!.semanticLayoutKey).toBe(
      canonicalProgramAbiClosureLayoutKey(executor.signature, executor.captureFieldTypes),
    );
  });

  it("plans, deduplicates, and remaps mutable-capture ref cells by semantic payload type", () => {
    const f = fixture();
    const f64Cell: StructTypeDef = {
      kind: "struct",
      name: "__ref_cell_f64",
      fields: [{ name: "value", type: { kind: "f64" }, mutable: true }],
    };
    const i32Cell: StructTypeDef = {
      kind: "struct",
      name: "__ref_cell_i32",
      fields: [{ name: "value", type: { kind: "i32" }, mutable: true }],
    };
    f.module.types.push(f64Cell, i32Cell);
    const f64Request = { innerType: F64, cellType: f64Cell };
    const i32Type = irVal({ kind: "i32" });
    const i32Request = { innerType: i32Type, cellType: i32Cell };

    const [f64Support, i32Support, duplicateF64] = f.registry.prepareRefCellSupportTypes([
      f64Request,
      i32Request,
      f64Request,
    ]);
    expect(duplicateF64).toBe(f64Support);
    expect(f64Support!.semanticInnerTypeKey).toBe(canonicalProgramAbiRefCellKey(F64));
    expect(i32Support!.semanticInnerTypeKey).toBe(canonicalProgramAbiRefCellKey(i32Type));
    expect(f.registry.prepareRefCellSupportTypes([i32Request, f64Request])).toEqual([i32Support, f64Support]);

    const originalIndex = f.module.types.indexOf(f64Cell);
    const replacement: StructTypeDef = { ...f64Cell, name: "__ref_cell_f64_after_remap", fields: [...f64Cell.fields] };
    f.session.remapTypeObject(f64Cell, replacement);
    f.module.types[originalIndex] = replacement;
    f.registry.planRetained();
    const publication = f.session.publish(f.module);
    expect(publication.abi.resolveFinalIndex(f64Support!.cellTypeRef.binding.bindingId)).toEqual({
      space: "type",
      index: originalIndex,
    });
  });

  it("rejects a non-canonical or conflicting physical ref-cell layout", () => {
    const f = fixture();
    const immutable: StructTypeDef = {
      kind: "struct",
      name: "bad_ref_cell",
      fields: [{ name: "value", type: { kind: "f64" }, mutable: false }],
    };
    f.module.types.push(immutable);
    expectProgramAbiInvariant(
      () => f.registry.prepareRefCellSupportTypes([{ innerType: F64, cellType: immutable }]),
      "type-remap-mismatch",
    );

    const first: StructTypeDef = {
      kind: "struct",
      name: "first_ref_cell",
      fields: [{ name: "value", type: { kind: "f64" }, mutable: true }],
    };
    const second: StructTypeDef = { ...first, name: "second_ref_cell", fields: [...first.fields] };
    f.module.types.push(first, second);
    expectProgramAbiInvariant(
      () =>
        f.registry.prepareRefCellSupportTypes([
          { innerType: F64, cellType: first },
          { innerType: F64, cellType: second },
        ]),
      "type-remap-mismatch",
    );
  });

  it("plans and remaps closed object layouts by semantic IR shape", () => {
    const f = fixture();
    const objectType = {
      kind: "object",
      shape: { fields: [{ name: "value", type: F64 }] },
    } as const satisfies Extract<IrType, { readonly kind: "object" }>;
    const structType: StructTypeDef = {
      kind: "struct",
      name: "__prepared_object",
      fields: [{ name: "value", type: { kind: "f64" }, mutable: true }],
    };
    f.module.types.push(structType);
    const request = { objectType, structType };

    const [support, duplicate] = f.registry.prepareObjectSupportTypes([request, request]);
    expect(duplicate).toBe(support);
    expect(support!.semanticShapeKey).toBe(canonicalProgramAbiObjectShapeKey(objectType));
    expect(f.registry.prepareObjectSupportTypes([request])).toEqual([support]);

    const originalIndex = f.module.types.indexOf(structType);
    const replacement: StructTypeDef = {
      ...structType,
      name: "__prepared_object_after_remap",
      fields: [...structType.fields],
    };
    f.session.remapTypeObject(structType, replacement);
    f.module.types[originalIndex] = replacement;
    f.registry.planRetained();
    const publication = f.session.publish(f.module);
    expect(publication.abi.resolveFinalIndex(support!.objectTypeRef.binding.bindingId)).toEqual({
      space: "type",
      index: originalIndex,
    });
  });
});
