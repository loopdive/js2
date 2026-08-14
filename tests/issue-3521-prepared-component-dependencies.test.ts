// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  irClassTypeRef,
  irGlobalBindingKey,
  irImportGlobalRef,
  irModuleGlobalRef,
  irSupportTypeRef,
  irTypeBindingKey,
} from "../src/ir/abi-bindings.js";
import {
  irCallableBindingKey,
  irImportFuncRef,
  irIntrinsicFuncRef,
  irSupportFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
} from "../src/ir/callable-bindings.js";
import {
  buildIrUnitInventory,
  createDerivedIrUnitId,
  createIrBindingId,
  type IrClassId,
  type IrSourceId,
  type IrTerminalUnitRecord,
  type IrUnitId,
} from "../src/ir/identity.js";
import {
  asBlockId,
  asValueId,
  irVal,
  irVec,
  type IrClassShape,
  type IrClosureSignature,
  type IrFunction,
  type IrInstr,
  type IrType,
  type IrTypeRef,
} from "../src/ir/nodes.js";
import {
  derivePreparedComponentDependencies,
  type PreparedComponentAbiEntry,
  type PreparedComponentAbiLookup,
} from "../src/ir/prepared-component-dependencies.js";
import { attachIrStringCarrier } from "../src/ir/string-carrier.js";
import { attachIrStringSupport } from "../src/ir/string-support.js";
import {
  IR_STRING_CHAR_AT_FN,
  IR_STRING_CHAR_CODE_AT_FN,
  IR_STRING_CONCAT_FN,
  IR_STRING_CONCAT_OWNED_FN,
  IR_STRING_EQUALS_FN,
  IR_STRING_ITERATOR_CHAR_AT_FN,
  IR_STRING_LITERAL_MATERIALIZE_FN,
} from "../src/ir/string-runtime.js";
import { attachIrVecLayouts } from "../src/ir/vec-layout.js";
import {
  IR_VEC_ELEM_SET_PREFIX,
  IR_VEC_NEW_SIZED_PREFIX,
  irVecElemSetSymbol,
  irVecNewSizedSymbol,
  parseIrVectorRuntimeElement,
} from "../src/ir/vector-runtime.js";
import { ts } from "../src/ts-api.js";

const VOID_SIGNATURE = Object.freeze({ params: Object.freeze([]), results: Object.freeze([]) });

interface Fixture {
  readonly inventory: ReturnType<typeof buildIrUnitInventory>;
  readonly sourceId: IrSourceId;
  readonly first: IrTerminalUnitRecord;
  readonly second: IrTerminalUnitRecord;
  readonly moduleInit: IrTerminalUnitRecord;
  readonly nestedClassId: IrClassId;
  readonly nestedMethod: { readonly id: IrUnitId; readonly displayName: string };
}

function fixture(): Fixture {
  const source = ts.createSourceFile(
    "/repo/prepared-component.ts",
    `
      const shared = 0;
      function first(): void {
        class LocalBox { run(): void {} }
      }
      function second(): void {}
    `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([source], { entrySource: source });
  const first = inventory.terminalUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "first",
  );
  const second = inventory.terminalUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "second",
  );
  const moduleInit = inventory.terminalUnits.find((unit) => unit.kind === "module-init");
  const nestedClass = inventory.classes.find((record) => record.displayName === "LocalBox");
  const nestedMethod = inventory.allUnits.find(
    (unit) => unit.kind === "class-instance-method" && unit.lexicalOwnerId === nestedClass?.id,
  );
  if (!first || !second || !moduleInit || !nestedClass || !nestedMethod) {
    throw new Error("invalid prepared-component fixture");
  }
  return {
    inventory,
    sourceId: inventory.sources[0]!.id,
    first,
    second,
    moduleInit,
    nestedClassId: nestedClass.id,
    nestedMethod,
  };
}

function irFunction(
  unit: Pick<IrTerminalUnitRecord, "id" | "displayName">,
  instrs: readonly IrInstr[] = [],
): IrFunction {
  return {
    unitId: unit.id,
    name: unit.displayName,
    params: [],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [] },
      },
    ],
    exported: false,
    valueCount: instrs.reduce((count, instr) => Math.max(count, (instr.result ?? -1) + 1), 0),
  };
}

function sourceCallableEntry(unitId: IrUnitId): PreparedComponentAbiEntry {
  return {
    id: irUnitCallableBindingId(unitId),
    structuralReferenceKey: irCallableBindingKey({ kind: "unit", unitId }),
    slotPolicy: "required",
    intent: {
      kind: "callable",
      origin: "source",
      signature: VOID_SIGNATURE,
      unitId,
    },
  };
}

function abiLookup(entries: readonly PreparedComponentAbiEntry[]): PreparedComponentAbiLookup {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
  return {
    get: (id) => byId.get(id),
    entries: () => entries,
  };
}

function supportTypeEntry(ref: IrTypeRef): PreparedComponentAbiEntry {
  return {
    id: ref.binding.bindingId,
    structuralReferenceKey: irTypeBindingKey(ref.binding),
    slotPolicy: "required",
    intent: { kind: "type", shapeKey: `test:${ref.name}` },
  };
}

function supportCallableEntry(ref: ReturnType<typeof irSupportFuncRef>, classId: IrClassId): PreparedComponentAbiEntry {
  if (ref.binding.kind !== "support") throw new Error("expected support callable fixture");
  return {
    id: ref.binding.bindingId,
    structuralReferenceKey: irCallableBindingKey(ref.binding),
    slotPolicy: "required",
    intent: {
      kind: "callable",
      origin: "support",
      signature: VOID_SIGNATURE,
      classId,
    },
  };
}

describe("#3521 post-pass prepared-component dependency evidence", () => {
  it("closes a local direct-call edge into one exact terminal component", () => {
    const f = fixture();
    const call: IrInstr = {
      kind: "call",
      result: null,
      resultType: null,
      target: irUnitFuncRef({ unitId: f.second.id, name: "second" }),
      args: [],
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [irFunction(f.first, [call]), irFunction(f.second)] },
      terminalUnitIds: new Set([f.first.id, f.second.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), sourceCallableEntry(f.second.id)]),
    });

    expect(report.components).toHaveLength(1);
    expect(report.components[0]!.status).toBe("complete");
    expect(new Set(report.components[0]!.terminalUnitIds)).toEqual(new Set([f.first.id, f.second.id]));
    expect(report.components[0]!.unitDependencies).toEqual([
      expect.objectContaining({
        ownerUnitId: f.first.id,
        referencedUnitId: f.second.id,
        terminalOwnerUnitId: f.second.id,
        programAbiBindingId: irUnitCallableBindingId(f.second.id),
      }),
    ]);
  });

  it("keeps the local component atomic when the callee ABI reservation is missing", () => {
    const f = fixture();
    const call: IrInstr = {
      kind: "call",
      result: null,
      resultType: null,
      target: irUnitFuncRef({ unitId: f.second.id, name: "second" }),
      args: [],
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [irFunction(f.first, [call]), irFunction(f.second)] },
      terminalUnitIds: new Set([f.first.id, f.second.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });

    expect(report.components).toHaveLength(1);
    expect(report.components[0]!.status).toBe("blocked");
    expect(new Set(report.components[0]!.terminalUnitIds)).toEqual(new Set([f.first.id, f.second.id]));
    expect(report.components[0]!.failures).toEqual([
      expect.objectContaining({
        code: "unplanned-abi-binding",
        bindingId: irUnitCallableBindingId(f.second.id),
      }),
    ]);
  });

  it("records a source module-global ABI identity and blocks its unowned storage edge", () => {
    const f = fixture();
    const globalRef = irModuleGlobalRef(f.sourceId, 0, "state");
    const globalGet: IrInstr = {
      kind: "global.get",
      result: asValueId(0),
      resultType: irVal({ kind: "f64" }),
      target: globalRef,
    };
    const globalEntry: PreparedComponentAbiEntry = {
      id: globalRef.binding.bindingId,
      structuralReferenceKey: irGlobalBindingKey(globalRef.binding),
      slotPolicy: "required",
      intent: {
        kind: "global",
        origin: "source",
        valueType: '{"kind":"f64"}',
        mutable: true,
        sourceId: f.sourceId,
        unitId: f.moduleInit.id,
      },
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [irFunction(f.first, [globalGet])] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), globalEntry]),
    });
    const component = report.components[0]!;

    expect(component.abiDependencies).toEqual([
      expect.objectContaining({
        kind: "source-global",
        bindingId: globalRef.binding.bindingId,
        terminalOwnerUnitId: f.moduleInit.id,
      }),
    ]);
    expect(component.status).toBe("blocked");
    expect(component.failures).toContainEqual(
      expect.objectContaining({
        code: "source-global-outside-component",
        referencedUnitId: f.moduleInit.id,
      }),
    );
  });

  it("maps a nested class layout exactly and blocks a class member without a symbolic callable", () => {
    const f = fixture();
    const shape: IrClassShape = {
      classId: f.nestedClassId,
      className: "LocalBox",
      fields: [],
      methods: [{ name: "run", params: [], returnType: null }],
      constructorParams: [],
    };
    const call: IrInstr = {
      kind: "class.call",
      result: null,
      resultType: null,
      receiver: asValueId(0),
      memberKind: "method",
      methodName: "run",
      args: [],
    };
    const typeRef = irClassTypeRef(shape.classId, shape.className);
    const classEntry: PreparedComponentAbiEntry = {
      id: typeRef.binding.bindingId,
      structuralReferenceKey: irTypeBindingKey(typeRef.binding),
      slotPolicy: "required",
      intent: { kind: "class", classId: shape.classId, layoutKey: "LocalBox{}" },
    };
    const report = derivePreparedComponentDependencies({
      module: {
        functions: [
          {
            ...irFunction(f.first, [call]),
            params: [{ value: asValueId(0), name: "box", type: { kind: "class", shape } }],
            valueCount: 1,
          },
        ],
      },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), classEntry]),
    });
    const component = report.components[0]!;

    expect(component.abiDependencies).toEqual([
      expect.objectContaining({
        kind: "class-layout",
        bindingId: typeRef.binding.bindingId,
        terminalOwnerUnitId: f.first.id,
      }),
    ]);
    expect(component.status).toBe("blocked");
    expect(component.failures).toEqual([
      expect.objectContaining({
        code: "class-member-callable-unavailable",
        referencedClassId: shape.classId,
      }),
    ]);
  });

  it("closes a class member through its exact symbolic callable target", () => {
    const f = fixture();
    const target = irUnitFuncRef({ unitId: f.nestedMethod.id, name: "LocalBox_run" });
    const shape: IrClassShape = {
      classId: f.nestedClassId,
      className: "LocalBox",
      fields: [],
      methods: [{ name: "run", params: [], returnType: null, target }],
      constructorParams: [],
    };
    const call: IrInstr = {
      kind: "class.call",
      result: null,
      resultType: null,
      receiver: asValueId(0),
      memberKind: "method",
      methodName: "run",
      target,
      args: [],
    };
    const typeRef = irClassTypeRef(shape.classId, shape.className);
    const classEntry: PreparedComponentAbiEntry = {
      id: typeRef.binding.bindingId,
      structuralReferenceKey: irTypeBindingKey(typeRef.binding),
      slotPolicy: "required",
      intent: { kind: "class", classId: shape.classId, layoutKey: "LocalBox{}" },
    };
    const report = derivePreparedComponentDependencies({
      module: {
        functions: [
          {
            ...irFunction(f.first, [call]),
            params: [{ value: asValueId(0), name: "box", type: { kind: "class", shape } }],
            valueCount: 1,
          },
          irFunction(f.nestedMethod),
        ],
      },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), sourceCallableEntry(f.nestedMethod.id), classEntry]),
    });
    const component = report.components[0]!;

    expect(component.status).toBe("complete");
    expect(component.unitDependencies).toEqual([
      expect.objectContaining({
        referencedUnitId: f.nestedMethod.id,
        terminalOwnerUnitId: f.first.id,
      }),
    ]);
    expect(component.failures).toEqual([]);
  });

  it("accepts a planned compiler-support callable as an external component dependency", () => {
    const f = fixture();
    const support = irSupportFuncRef(f.sourceId, "prepared-helper", "__prepared_helper");
    if (support.binding.kind !== "support") throw new Error("invalid support fixture");
    const call: IrInstr = {
      kind: "call",
      result: null,
      resultType: null,
      target: support,
      args: [],
    };
    const supportEntry: PreparedComponentAbiEntry = {
      id: support.binding.bindingId,
      structuralReferenceKey: irCallableBindingKey(support.binding),
      slotPolicy: "required",
      intent: {
        kind: "callable",
        origin: "support",
        signature: VOID_SIGNATURE,
        sourceId: f.sourceId,
      },
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [irFunction(f.first, [call])] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), supportEntry]),
    });

    expect(report.components[0]!.status).toBe("complete");
    expect(report.components[0]!.abiDependencies).toEqual([
      expect.objectContaining({
        kind: "support",
        bindingId: support.binding.bindingId,
        terminalOwnerUnitId: null,
      }),
    ]);
  });

  it("pins a constructor init's own AST-free new wrapper in its prepared component", () => {
    const source = ts.createSourceFile(
      "/repo/prepared-constructor.ts",
      `class Box { value: number; constructor(value: number) { this.value = value; } }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([source], { entrySource: source });
    const classRecord = inventory.classes.find((record) => record.displayName === "Box");
    const constructorUnit = inventory.terminalUnits.find(
      (unit) => unit.kind === "class-constructor" && unit.lexicalOwnerId === classRecord?.id,
    );
    if (!classRecord || !constructorUnit) throw new Error("invalid constructor dependency fixture");

    const newTarget = irSupportFuncRef(classRecord.id, "class-constructor-new", "Box_new");
    const initTarget = irUnitFuncRef({ unitId: constructorUnit.id, name: "Box_init" });
    const shape: IrClassShape = {
      classId: classRecord.id,
      className: "Box",
      fields: [{ name: "value", type: irVal({ kind: "f64" }) }],
      methods: [],
      constructorParams: [irVal({ kind: "f64" })],
      constructorTarget: newTarget,
      constructorInitTarget: initTarget,
    };
    const classType: IrType = { kind: "class", shape };
    const constructorFn: IrFunction = {
      ...irFunction(constructorUnit),
      params: [
        { value: asValueId(0), name: "value", type: irVal({ kind: "f64" }) },
        { value: asValueId(1), name: "__self", type: classType },
      ],
      resultTypes: [classType],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [],
          terminator: { kind: "return", values: [asValueId(1)] },
        },
      ],
      valueCount: 2,
    };
    const classRef = irClassTypeRef(classRecord.id, "Box");
    const classEntry: PreparedComponentAbiEntry = {
      id: classRef.binding.bindingId,
      structuralReferenceKey: irTypeBindingKey(classRef.binding),
      slotPolicy: "required",
      intent: { kind: "class", classId: classRecord.id, layoutKey: "Box{value:f64}" },
    };
    const newEntry = supportCallableEntry(newTarget, classRecord.id);
    const dependencies = (entries: readonly PreparedComponentAbiEntry[]) =>
      derivePreparedComponentDependencies({
        module: { functions: [constructorFn] },
        terminalUnitIds: new Set([constructorUnit.id]),
        inventory,
        abi: abiLookup(entries),
      }).components[0]!;

    const component = dependencies([sourceCallableEntry(constructorUnit.id), classEntry, newEntry]);
    expect(component.status).toBe("complete");
    expect(component.failures).toEqual([]);
    expect(component.abiDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "class-layout",
          bindingId: classRef.binding.bindingId,
        }),
        expect.objectContaining({
          kind: "support",
          bindingId: newTarget.binding.bindingId,
        }),
      ]),
    );

    const missingNew = dependencies([sourceCallableEntry(constructorUnit.id), classEntry]);
    expect(missingNew.status).toBe("blocked");
    expect(missingNew.failures).toContainEqual(
      expect.objectContaining({
        code: "unplanned-abi-binding",
        bindingId: newTarget.binding.bindingId,
      }),
    );
  });

  it("turns a prepared string carrier into an exact support-type dependency", () => {
    const f = fixture();
    const unbound: IrFunction = {
      ...irFunction(f.first),
      params: [{ value: asValueId(0), name: "value", type: { kind: "string" } }],
      valueCount: 1,
    };
    const blocked = derivePreparedComponentDependencies({
      module: { functions: [unbound] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });
    expect(blocked.components[0]!.status).toBe("blocked");
    expect(blocked.components[0]!.failures).toEqual([
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("symbolic Program ABI type ref"),
      }),
    ]);

    const carrierRef = irSupportTypeRef(f.sourceId, "string-carrier", "__string_carrier");
    const attachment = attachIrStringCarrier(unbound, carrierRef);
    expect(attachment.usesString).toBe(true);
    expect(attachment.function.params[0]!.type).toMatchObject({
      kind: "string",
      carrierRef,
    });
    expect(attachIrStringCarrier(attachment.function, carrierRef).function).toBe(attachment.function);
    const carrierEntry: PreparedComponentAbiEntry = {
      id: carrierRef.binding.bindingId,
      structuralReferenceKey: irTypeBindingKey(carrierRef.binding),
      slotPolicy: "none",
      intent: { kind: "type", shapeKey: '{"kind":"externref"}' },
    };
    const prepared = derivePreparedComponentDependencies({
      module: { functions: [attachment.function] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), carrierEntry]),
    });

    expect(prepared.components[0]!.status).toBe("complete");
    expect(prepared.components[0]!.abiDependencies).toEqual([
      expect.objectContaining({
        kind: "support",
        bindingId: carrierRef.binding.bindingId,
        structuralReferenceKey: irTypeBindingKey(carrierRef.binding),
        terminalOwnerUnitId: null,
      }),
    ]);

    const classShape: IrClassShape = {
      classId: f.nestedClassId,
      className: "LocalBox",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    const classType = { kind: "class", shape: classShape } as const;
    const mixed = attachIrStringCarrier({ ...unbound, resultTypes: [classType] }, carrierRef).function;
    expect(mixed.resultTypes[0]).toBe(classType);
    expect(mixed.resultTypes[0]).toMatchObject({ kind: "class", shape: classShape });
  });

  it("fails closed for logical vectors without a layout and transitional raw reference types", () => {
    const f = fixture();
    const logical: IrFunction = {
      ...irFunction(f.first),
      params: [{ value: asValueId(0), name: "values", type: irVec(irVal({ kind: "f64" })) }],
      valueCount: 1,
    };
    const logicalReport = derivePreparedComponentDependencies({
      module: { functions: [logical] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });
    expect(logicalReport.components[0]!.status).toBe("blocked");
    expect(logicalReport.components[0]!.failures).toEqual([
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("symbolic Program ABI layout"),
      }),
    ]);

    const raw: IrFunction = {
      ...logical,
      params: [{ value: asValueId(0), name: "values", type: irVal({ kind: "ref", typeIdx: 17 }) }],
    };
    const rawReport = derivePreparedComponentDependencies({
      module: { functions: [raw] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });
    expect(rawReport.components[0]!.status).toBe("blocked");
    expect(rawReport.components[0]!.failures).toEqual([
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("raw IR reference type ref:17"),
      }),
    ]);
  });

  it("records the exact carrier and backing-array dependencies for a prepared logical vector", () => {
    const f = fixture();
    const carrierRef = irSupportTypeRef(f.sourceId, "vector-carrier:vec<f64>", "__ir_vec_carrier_f64");
    const dataRef = irSupportTypeRef(f.sourceId, "vector-data:vec<f64>", "__ir_vec_data_f64");
    const layout = Object.freeze({
      carrierType: carrierRef,
      dataType: dataRef,
      lengthFieldIndex: 0,
      dataFieldIndex: 1,
    });
    const logical: IrFunction = {
      ...irFunction(f.first),
      params: [{ value: asValueId(0), name: "values", type: irVec(irVal({ kind: "f64" })) }],
      valueCount: 1,
    };
    const attached = attachIrVecLayouts(logical, () => layout);
    expect(attached.usesVec).toBe(true);
    expect(attached.function.params[0]!.type).toMatchObject({ kind: "vec", layout });
    expect(attachIrVecLayouts(attached.function, () => layout).function).toBe(attached.function);

    const supportTypeEntry = (ref: typeof carrierRef, shapeKey: string): PreparedComponentAbiEntry => ({
      id: ref.binding.bindingId,
      structuralReferenceKey: irTypeBindingKey(ref.binding),
      slotPolicy: "required",
      intent: { kind: "type", shapeKey },
    });
    const carrierEntry = supportTypeEntry(carrierRef, "vector-carrier-f64");
    const dataEntry = supportTypeEntry(dataRef, "vector-data-f64");
    const prepared = derivePreparedComponentDependencies({
      module: { functions: [attached.function] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), carrierEntry, dataEntry]),
    });

    expect(prepared.components[0]!.status).toBe("complete");
    expect(prepared.components[0]!.failures).toEqual([]);
    expect(prepared.components[0]!.abiDependencies.map((dependency) => dependency.bindingId)).toEqual([
      carrierRef.binding.bindingId,
      dataRef.binding.bindingId,
    ]);
    expect(prepared.components[0]!.abiDependencies).toEqual([
      expect.objectContaining({
        kind: "support",
        bindingId: carrierRef.binding.bindingId,
        structuralReferenceKey: irTypeBindingKey(carrierRef.binding),
        terminalOwnerUnitId: null,
      }),
      expect.objectContaining({
        kind: "support",
        bindingId: dataRef.binding.bindingId,
        structuralReferenceKey: irTypeBindingKey(dataRef.binding),
        terminalOwnerUnitId: null,
      }),
    ]);

    const missingData = derivePreparedComponentDependencies({
      module: { functions: [attached.function] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), carrierEntry]),
    });
    expect(missingData.components[0]!.status).toBe("blocked");
    expect(missingData.components[0]!.failures).toContainEqual(
      expect.objectContaining({
        code: "unplanned-abi-binding",
        bindingId: dataRef.binding.bindingId,
      }),
    );
  });

  it("normalizes only a certified physical vector carrier to its logical prepared type", () => {
    const f = fixture();
    const carrierRef = irSupportTypeRef(f.sourceId, "vector-carrier:vec<f64>", "__ir_vec_carrier_f64");
    const dataRef = irSupportTypeRef(f.sourceId, "vector-data:vec<f64>", "__ir_vec_data_f64");
    const layout = Object.freeze({
      carrierType: carrierRef,
      dataType: dataRef,
      lengthFieldIndex: 0,
      dataFieldIndex: 1,
    });
    const raw: IrFunction = {
      ...irFunction(f.first),
      params: [
        { value: asValueId(0), name: "values", type: irVal({ kind: "ref", typeIdx: 17 }) },
        { value: asValueId(1), name: "lookalike", type: irVal({ kind: "ref", typeIdx: 18 }) },
      ],
      valueCount: 2,
    };

    const attached = attachIrVecLayouts(
      raw,
      () => layout,
      (type) =>
        type.val.kind === "ref" && type.val.typeIdx === 17
          ? { kind: "vec", elementType: irVal({ kind: "f64" }), nullable: false }
          : null,
    );
    expect(attached.usesVec).toBe(true);
    expect(attached.function.params[0]!.type).toMatchObject({
      kind: "vec",
      elementType: irVal({ kind: "f64" }),
      nullable: false,
      layout,
    });
    expect(attached.function.params[1]!.type).toEqual(irVal({ kind: "ref", typeIdx: 18 }));
  });

  it("keeps logical vector helper identities independent of physical type indices", () => {
    const f64 = irVal({ kind: "f64" });
    const i32 = irVal({ kind: "i32" });
    expect(irVecElemSetSymbol(f64)).toBe("__ir_vec_elem_set_f64");
    expect(irVecNewSizedSymbol(f64)).toBe("__ir_vec_new_sized_f64");
    expect(irVecElemSetSymbol(i32)).toBe("__ir_vec_elem_set_i32");
    expect(parseIrVectorRuntimeElement("__ir_vec_elem_set_f64", IR_VEC_ELEM_SET_PREFIX)).toEqual({ kind: "f64" });
    expect(parseIrVectorRuntimeElement("__ir_vec_new_sized_i32", IR_VEC_NEW_SIZED_PREFIX)).toEqual({ kind: "i32" });
    expect(parseIrVectorRuntimeElement("__ir_vec_elem_set_17", IR_VEC_ELEM_SET_PREFIX)).toBeNull();
  });

  it("rejects invalid or drifting prepared vector layouts", () => {
    const f = fixture();
    const carrierRef = irSupportTypeRef(f.sourceId, "vector-carrier:vec<f64>", "__ir_vec_carrier_f64");
    const dataRef = irSupportTypeRef(f.sourceId, "vector-data:vec<f64>", "__ir_vec_data_f64");
    const logical: IrFunction = {
      ...irFunction(f.first),
      params: [{ value: asValueId(0), name: "values", type: irVec(irVal({ kind: "f64" })) }],
      valueCount: 1,
    };
    const invalid = attachIrVecLayouts(logical, () => ({
      carrierType: carrierRef,
      dataType: dataRef,
      lengthFieldIndex: 0,
      dataFieldIndex: 0,
    }));
    const report = derivePreparedComponentDependencies({
      module: { functions: [invalid.function] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });
    expect(report.components[0]!.status).toBe("blocked");
    expect(report.components[0]!.failures).toEqual([
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("invalid prepared field layout"),
      }),
    ]);

    const attached = attachIrVecLayouts(logical, () => ({
      carrierType: carrierRef,
      dataType: dataRef,
      lengthFieldIndex: 0,
      dataFieldIndex: 1,
    }));
    expect(() =>
      attachIrVecLayouts(attached.function, () => ({
        carrierType: carrierRef,
        dataType: dataRef,
        lengthFieldIndex: 1,
        dataFieldIndex: 0,
      })),
    ).toThrow(/different prepared layout/);
  });

  it("turns literal storage and string length into exact prepared dependencies", () => {
    const f = fixture();
    const carrierRef = irSupportTypeRef(f.sourceId, "string-carrier", "__string_carrier");
    const storage = irImportGlobalRef(f.sourceId, "string_constants", "abc", "__str_0", 0);
    const lengthTarget = irImportFuncRef("wasm:js-string", "length");
    const literal: IrInstr = {
      kind: "string.const",
      result: asValueId(0),
      resultType: { kind: "string" },
      value: "abc",
    };
    const length: IrInstr = {
      kind: "string.len",
      result: asValueId(1),
      resultType: irVal({ kind: "f64" }),
      value: asValueId(0),
    };
    const unprepared = irFunction(f.first, [literal, length]);
    const withCarrier = attachIrStringCarrier(unprepared, carrierRef).function;
    const prepared = attachIrStringSupport(withCarrier, {
      storageForConst: () => storage,
      providerForLength: () => ({ kind: "callable", target: lengthTarget }),
    });
    expect(
      attachIrStringSupport(prepared, {
        storageForConst: () => storage,
        providerForLength: () => ({ kind: "callable", target: lengthTarget }),
      }),
    ).toBe(prepared);

    const callableBindingId = createIrBindingId({
      ownerId: f.sourceId,
      domain: "callable",
      role: "imported-function",
      ordinal: 0,
    });
    const entries: PreparedComponentAbiEntry[] = [
      sourceCallableEntry(f.first.id),
      {
        id: carrierRef.binding.bindingId,
        structuralReferenceKey: irTypeBindingKey(carrierRef.binding),
        slotPolicy: "none",
        intent: { kind: "type", shapeKey: '{"kind":"externref"}' },
      },
      {
        id: storage.binding.bindingId,
        structuralReferenceKey: irGlobalBindingKey(storage.binding),
        slotPolicy: "required",
        intent: {
          kind: "global",
          origin: "import",
          valueType: '{"kind":"externref"}',
          mutable: false,
        },
      },
      {
        id: callableBindingId,
        structuralReferenceKey: irCallableBindingKey(lengthTarget.binding),
        slotPolicy: "required",
        intent: {
          kind: "callable",
          origin: "import",
          signature: { params: ['{"kind":"externref"}'], results: ['{"kind":"i32"}'] },
        },
      },
    ];
    const report = derivePreparedComponentDependencies({
      module: { functions: [prepared] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup(entries),
    });

    expect(report.components[0]!.status).toBe("complete");
    expect(new Set(report.components[0]!.abiDependencies.map((dependency) => dependency.bindingId))).toEqual(
      new Set([carrierRef.binding.bindingId, storage.binding.bindingId, callableBindingId]),
    );
  });

  it("turns oversized literal materialization into an exact callable dependency", () => {
    const f = fixture();
    const carrierRef = irSupportTypeRef(f.sourceId, "string-carrier", "__string_carrier");
    const materializer = irIntrinsicFuncRef(`${IR_STRING_LITERAL_MATERIALIZE_FN}:0`);
    const literal: IrInstr = {
      kind: "string.const",
      result: asValueId(0),
      resultType: { kind: "string" },
      value: "x".repeat(10_001),
    };
    const withCarrier = attachIrStringCarrier(irFunction(f.first, [literal]), carrierRef).function;
    const prepared = attachIrStringSupport(withCarrier, {
      storageForConst: () => undefined,
      materializerForConst: () => materializer,
      providerForLength: () => undefined,
    });
    const providerBindingId = createIrBindingId({
      ownerId: f.sourceId,
      domain: "callable",
      role: "string-literal-materializer",
    });
    const report = derivePreparedComponentDependencies({
      module: { functions: [prepared] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([
        sourceCallableEntry(f.first.id),
        {
          id: carrierRef.binding.bindingId,
          structuralReferenceKey: irTypeBindingKey(carrierRef.binding),
          slotPolicy: "required",
          intent: { kind: "type", shapeKey: '{"kind":"struct","name":"AnyString"}' },
        },
        {
          id: providerBindingId,
          structuralReferenceKey: irCallableBindingKey(materializer.binding),
          slotPolicy: "required",
          intent: { kind: "callable", origin: "intrinsic" },
        },
      ]),
    });

    expect(prepared.blocks[0]!.instrs[0]).toMatchObject({
      kind: "string.const",
      materializer: { binding: materializer.binding },
    });
    expect(report.components[0]!.status).toBe("complete");
    expect(report.components[0]!.abiDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bindingId: carrierRef.binding.bindingId, kind: "support" }),
        expect.objectContaining({ bindingId: providerBindingId, kind: "external-callable" }),
      ]),
    );
  });

  it("turns final string operations into exact callable dependencies without collapsing owned append", () => {
    const f = fixture();
    const carrierRef = irSupportTypeRef(f.sourceId, "string-carrier", "__string_carrier");
    const operations: readonly IrInstr[] = [
      {
        kind: "string.concat",
        result: asValueId(0),
        resultType: { kind: "string" },
        lhs: asValueId(20),
        rhs: asValueId(21),
        encodingEvidence: "ascii",
        concatMode: "immutable",
      },
      {
        kind: "string.concat",
        result: asValueId(1),
        resultType: { kind: "string" },
        lhs: asValueId(22),
        rhs: asValueId(23),
        encodingEvidence: "ascii",
        concatMode: "owned-append",
      },
      {
        kind: "string.eq",
        result: asValueId(2),
        resultType: irVal({ kind: "bool" }),
        lhs: asValueId(24),
        rhs: asValueId(25),
        negate: false,
      },
      {
        kind: "string.char_at",
        result: asValueId(3),
        resultType: { kind: "string" },
        value: asValueId(26),
        index: asValueId(27),
        inputEncoding: "wtf16",
        encodingEvidence: "wtf16",
      },
      {
        kind: "string.char_code_at",
        result: asValueId(4),
        resultType: irVal({ kind: "f64" }),
        value: asValueId(28),
        index: asValueId(29),
        inputEncoding: "wtf16",
      },
    ];
    const withCarrier = attachIrStringCarrier(irFunction(f.first, operations), carrierRef).function;
    const prepared = attachIrStringSupport(withCarrier, {
      storageForConst: () => undefined,
      providerForLength: () => undefined,
    });
    expect(
      attachIrStringSupport(prepared, {
        storageForConst: () => undefined,
        providerForLength: () => undefined,
      }),
    ).toBe(prepared);

    const symbols = [
      IR_STRING_CONCAT_FN,
      IR_STRING_CONCAT_OWNED_FN,
      IR_STRING_EQUALS_FN,
      IR_STRING_CHAR_AT_FN,
      IR_STRING_CHAR_CODE_AT_FN,
    ];
    expect(prepared.blocks[0]!.instrs).toEqual(
      symbols.map((symbol, index) =>
        expect.objectContaining({
          kind: operations[index]!.kind,
          provider: expect.objectContaining({ binding: { kind: "intrinsic", symbol } }),
        }),
      ),
    );

    const providerRefs = symbols.map((symbol) => irIntrinsicFuncRef(symbol));
    const providerIds = providerRefs.map((_ref, ordinal) =>
      createIrBindingId({
        ownerId: f.sourceId,
        domain: "callable",
        role: "string-provider",
        ordinal,
      }),
    );
    const report = derivePreparedComponentDependencies({
      module: { functions: [prepared] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([
        sourceCallableEntry(f.first.id),
        {
          id: carrierRef.binding.bindingId,
          structuralReferenceKey: irTypeBindingKey(carrierRef.binding),
          slotPolicy: "none",
          intent: { kind: "type", shapeKey: '{"kind":"externref"}' },
        },
        ...providerRefs.map(
          (ref, index): PreparedComponentAbiEntry => ({
            id: providerIds[index]!,
            structuralReferenceKey: irCallableBindingKey(ref.binding),
            slotPolicy: "required",
            intent: { kind: "callable", origin: "intrinsic" },
          }),
        ),
      ]),
    });

    expect(report.components[0]!.status).toBe("complete");
    expect(new Set(report.components[0]!.externalCallables.map((entry) => entry.structuralReferenceKey))).toEqual(
      new Set(providerRefs.map((ref) => irCallableBindingKey(ref.binding))),
    );
    expect(new Set(report.components[0]!.abiDependencies.map((dependency) => dependency.bindingId))).toEqual(
      new Set([carrierRef.binding.bindingId, ...providerIds]),
    );
  });

  it("turns native string iteration into an exact code-point provider dependency", () => {
    const f = fixture();
    const carrierRef = irSupportTypeRef(f.sourceId, "string-carrier", "__string_carrier");
    const loop: IrInstr = {
      kind: "forof.string",
      str: asValueId(0),
      counterSlot: 0,
      lengthSlot: 1,
      strSlot: 2,
      elementSlot: 3,
      body: [],
      result: null,
      resultType: null,
    };
    const unbound: IrFunction = {
      ...irFunction(f.first, [loop]),
      params: [{ value: asValueId(0), name: "value", type: { kind: "string" } }],
      valueCount: 1,
    };
    const withCarrier = attachIrStringCarrier(unbound, carrierRef).function;
    const prepared = attachIrStringSupport(withCarrier, {
      storageForConst: () => undefined,
      providerForLength: () => undefined,
    });
    const provider = irIntrinsicFuncRef(IR_STRING_ITERATOR_CHAR_AT_FN);
    const providerBindingId = createIrBindingId({
      ownerId: f.sourceId,
      domain: "callable",
      role: "string-iterator-provider",
    });
    const report = derivePreparedComponentDependencies({
      module: { functions: [prepared] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([
        sourceCallableEntry(f.first.id),
        {
          id: carrierRef.binding.bindingId,
          structuralReferenceKey: irTypeBindingKey(carrierRef.binding),
          slotPolicy: "none",
          intent: { kind: "type", shapeKey: '{"kind":"externref"}' },
        },
        {
          id: providerBindingId,
          structuralReferenceKey: irCallableBindingKey(provider.binding),
          slotPolicy: "required",
          intent: { kind: "callable", origin: "intrinsic" },
        },
      ]),
    });

    expect(prepared.blocks[0]!.instrs[0]).toMatchObject({
      kind: "forof.string",
      provider: { binding: provider.binding },
    });
    expect(report.components[0]!.status).toBe("complete");
    expect(report.components[0]!.abiDependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bindingId: carrierRef.binding.bindingId, kind: "support" }),
        expect.objectContaining({ bindingId: providerBindingId, kind: "external-callable" }),
      ]),
    );
  });

  it("requires a reverse Program ABI identity for import/runtime/intrinsic callables", () => {
    const f = fixture();
    const imported = irImportFuncRef("env", "clock");
    const call: IrInstr = {
      kind: "call",
      result: null,
      resultType: null,
      target: imported,
      args: [],
    };
    const unplanned = derivePreparedComponentDependencies({
      module: { functions: [irFunction(f.first, [call])] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });
    expect(unplanned.components[0]!.status).toBe("blocked");
    expect(unplanned.components[0]!.failures).toEqual([
      expect.objectContaining({
        code: "unplanned-abi-binding",
        detail: expect.stringContaining(irCallableBindingKey(imported.binding)),
      }),
    ]);

    const importBindingId = createIrBindingId({
      ownerId: f.sourceId,
      domain: "callable",
      role: "import:env:clock",
    });
    const importEntry: PreparedComponentAbiEntry = {
      id: importBindingId,
      structuralReferenceKey: irCallableBindingKey(imported.binding),
      slotPolicy: "required",
      intent: {
        kind: "callable",
        origin: "import",
        signature: VOID_SIGNATURE,
      },
    };
    const planned = derivePreparedComponentDependencies({
      module: { functions: [irFunction(f.first, [call])] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), importEntry]),
    });
    expect(planned.components[0]!.status).toBe("complete");
    expect(planned.components[0]!.externalCallables).toEqual([
      expect.objectContaining({
        structuralReferenceKey: irCallableBindingKey(imported.binding),
        programAbiBindingId: importBindingId,
      }),
    ]);
  });

  it("blocks lowering-time implicit runtime dependencies that have no symbolic IR ref", () => {
    const f = fixture();
    const iterNew: IrInstr = {
      kind: "iter.new",
      result: asValueId(0),
      resultType: irVal({ kind: "externref" }),
      iterable: asValueId(1),
      async: false,
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [irFunction(f.first, [iterNew])] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });

    expect(report.components[0]!.status).toBe("blocked");
    expect(report.components[0]!.failures).toEqual([
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("iterator runtime callables"),
      }),
    ]);
  });

  it.each([
    ["i32", irVal({ kind: "i32" })],
    ["f64", irVal({ kind: "f64" })],
  ] as const)("accepts js bitwise operands with concrete %s carriers", (_name, numericType) => {
    const f = fixture();
    const bitwise: IrInstr = {
      kind: "binary",
      op: "js.bitxor",
      lhs: asValueId(0),
      rhs: asValueId(1),
      result: asValueId(2),
      resultType: numericType,
    };
    const fn: IrFunction = {
      ...irFunction(f.first, [bitwise]),
      params: [
        { value: asValueId(0), name: "lhs", type: numericType },
        { value: asValueId(1), name: "rhs", type: numericType },
      ],
      valueCount: 3,
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [fn] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });

    expect(report.components[0]!.status).toBe("complete");
    expect(report.components[0]!.failures).toEqual([]);
  });

  it("keeps js bitwise operands fail-closed when either carrier is not concrete numeric", () => {
    const f = fixture();
    const numericType = irVal({ kind: "f64" });
    const bitwise: IrInstr = {
      kind: "binary",
      op: "js.bitand",
      lhs: asValueId(0),
      rhs: asValueId(1),
      result: asValueId(2),
      resultType: numericType,
    };
    const fn: IrFunction = {
      ...irFunction(f.first, [bitwise]),
      params: [
        { value: asValueId(0), name: "lhs", type: numericType },
        { value: asValueId(1), name: "rhs", type: { kind: "extern" } },
      ],
      valueCount: 3,
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [fn] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });

    expect(report.components[0]!.status).toBe("blocked");
    expect(report.components[0]!.failures).toEqual([
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("js.bitand may resolve __unbox_number"),
      }),
    ]);
  });

  it("requires prepared exception support for try and nested throw instructions", () => {
    const f = fixture();
    const thrownType: IrType = { kind: "extern" };
    const nestedThrow: IrInstr = {
      kind: "throw",
      value: asValueId(0),
      result: null,
      resultType: null,
    };
    const tryInstr: IrInstr = {
      kind: "try",
      body: [nestedThrow],
      catchClause: { payloadSlot: -1, body: [] },
      result: null,
      resultType: null,
    };
    const fn: IrFunction = {
      ...irFunction(f.first, [tryInstr]),
      params: [{ value: asValueId(0), name: "value", type: thrownType }],
      valueCount: 1,
    };
    const dependencies = (exceptionSupportPrepared: boolean) =>
      derivePreparedComponentDependencies({
        module: { functions: [fn] },
        terminalUnitIds: new Set([f.first.id]),
        inventory: f.inventory,
        exceptionSupportPrepared,
        abi: abiLookup([sourceCallableEntry(f.first.id)]),
      }).components[0]!;

    const unprepared = dependencies(false);
    expect(unprepared.status).toBe("blocked");
    expect(unprepared.failures).toHaveLength(2);
    expect(unprepared.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "implicit-support-reference-unavailable",
          detail: expect.stringContaining("try resolves exception tag/support"),
        }),
        expect.objectContaining({
          code: "implicit-support-reference-unavailable",
          detail: expect.stringContaining("throw resolves exception tag/support"),
        }),
      ]),
    );

    const prepared = dependencies(true);
    expect(prepared.status).toBe("complete");
    expect(prepared.failures).toEqual([]);
  });

  it.each(["empty", "unrelated"] as const)(
    "does not accept %s closure evidence for a different final IR object",
    (evidenceKind) => {
      const f = fixture();
      const signature: IrClosureSignature = { params: [], returnType: null };
      const closureType: IrType = { kind: "closure", signature };
      const supportRef = irSupportTypeRef(f.first.id, "test-closure-wrapper", "__test_closure_wrapper");
      const closureNew: IrInstr = {
        kind: "closure.new",
        liftedFunc: irUnitFuncRef({ unitId: f.second.id, name: "second" }),
        signature,
        captureFieldTypes: [],
        captures: [],
        result: asValueId(0),
        resultType: closureType,
      };
      const unrelatedClosureNew: IrInstr = { ...closureNew };
      const refs = evidenceKind === "empty" ? [] : [supportRef];
      const report = derivePreparedComponentDependencies({
        module: { functions: [irFunction(f.first, [closureNew]), irFunction(f.second)] },
        terminalUnitIds: new Set([f.first.id, f.second.id]),
        inventory: f.inventory,
        closureSupport: {
          typeRefs: new Map([[closureType, refs]]),
          instructionRefs: new Map([[evidenceKind === "empty" ? closureNew : unrelatedClosureNew, refs]]),
          functionRefs: new Map(),
        },
        abi: abiLookup([
          sourceCallableEntry(f.first.id),
          sourceCallableEntry(f.second.id),
          supportTypeEntry(supportRef),
        ]),
      });

      expect(report.components[0]!.status).toBe("blocked");
      expect(report.components[0]!.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "implicit-support-reference-unavailable",
            detail: expect.stringContaining("closure.new resolves closure wrapper/type support"),
          }),
        ]),
      );
    },
  );

  it("distinguishes an explicit empty callable-carrier proof from absent preparation", () => {
    const f = fixture();
    const signature: IrClosureSignature = { params: [], returnType: null };
    const callableType: IrType = { kind: "callable", signature };
    const fn: IrFunction = {
      ...irFunction(f.first),
      params: [{ value: asValueId(0), name: "callback", type: callableType }],
      valueCount: 1,
    };
    const dependencies = (typeRefs: ReadonlyMap<IrType, readonly IrTypeRef[]>) =>
      derivePreparedComponentDependencies({
        module: { functions: [fn] },
        terminalUnitIds: new Set([f.first.id]),
        inventory: f.inventory,
        closureSupport: {
          typeRefs,
          instructionRefs: new Map(),
          functionRefs: new Map(),
        },
        abi: abiLookup([sourceCallableEntry(f.first.id)]),
      }).components[0]!;

    const absent = dependencies(new Map());
    expect(absent.status).toBe("blocked");
    expect(absent.failures).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("IR callable signature resolves backend callable/type support"),
      }),
    );

    const prepared = dependencies(new Map([[callableType, Object.freeze([])]]));
    expect(prepared.status).toBe("complete");
    expect(prepared.failures).toEqual([]);
    expect(prepared.abiDependencies).toEqual([]);
  });

  it.each([
    {
      label: "closure",
      type: {
        kind: "closure",
        signature: { params: [], returnType: null },
      } satisfies IrType,
      detail: "IR closure signature resolves backend callable/type support",
    },
    {
      label: "boxed",
      type: {
        kind: "boxed",
        inner: irVal({ kind: "f64" }),
      } satisfies IrType,
      detail: "IR boxed/ref-cell type resolves a backend type",
    },
    {
      label: "object",
      type: {
        kind: "object",
        shape: { fields: [{ name: "value", type: irVal({ kind: "f64" }) }] },
      } satisfies IrType,
      detail: "IR object shape resolves a backend type",
    },
  ])("does not accept explicit empty support evidence for a bare $label type", ({ type, detail }) => {
    const f = fixture();
    const fn: IrFunction = {
      ...irFunction(f.first),
      params: [{ value: asValueId(0), name: "value", type }],
      valueCount: 1,
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [fn] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      closureSupport: {
        typeRefs: new Map([[type, Object.freeze([])]]),
        instructionRefs: new Map(),
        functionRefs: new Map(),
      },
      abi: abiLookup([sourceCallableEntry(f.first.id)]),
    });

    expect(report.components[0]!.status).toBe("blocked");
    expect(report.components[0]!.failures).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining(detail),
      }),
    );
  });

  it("keeps nested closure-signature support dependencies fail-closed", () => {
    const f = fixture();
    const signature: IrClosureSignature = { params: [{ kind: "string" }], returnType: null };
    const closureType: IrType = { kind: "callable", signature };
    const supportRef = irSupportTypeRef(f.first.id, "test-callable-wrapper", "__test_callable_wrapper");
    const fn: IrFunction = {
      ...irFunction(f.first),
      params: [{ value: asValueId(0), name: "callback", type: closureType }],
      valueCount: 1,
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [fn] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      closureSupport: {
        typeRefs: new Map([[closureType, [supportRef]]]),
        instructionRefs: new Map(),
        functionRefs: new Map(),
      },
      abi: abiLookup([sourceCallableEntry(f.first.id), supportTypeEntry(supportRef)]),
    });

    expect(report.components[0]!.status).toBe("blocked");
    expect(report.components[0]!.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "implicit-support-reference-unavailable",
          detail: expect.stringContaining("IR string type resolves through backend support"),
        }),
      ]),
    );
  });

  it("requires exact Program ABI evidence for boxed mutable captures and each ref-cell operation", () => {
    const f = fixture();
    const boxedType: IrType = { kind: "boxed", inner: irVal({ kind: "f64" }) };
    const supportRef = irSupportTypeRef(f.first.id, "test-ref-cell-f64", "__test_ref_cell_f64");
    const refCellSet: IrInstr = {
      kind: "refcell.set",
      cell: asValueId(0),
      value: asValueId(1),
      result: null,
      resultType: null,
    };
    const fn: IrFunction = {
      ...irFunction(f.first, [refCellSet]),
      params: [
        { value: asValueId(0), name: "cell", type: boxedType },
        { value: asValueId(1), name: "value", type: irVal({ kind: "f64" }) },
      ],
      valueCount: 2,
    };
    const dependencies = (instruction: IrInstr, refs: readonly IrTypeRef[]) =>
      derivePreparedComponentDependencies({
        module: { functions: [fn] },
        terminalUnitIds: new Set([f.first.id]),
        inventory: f.inventory,
        closureSupport: {
          typeRefs: new Map([[boxedType, refs]]),
          instructionRefs: new Map([[instruction, refs]]),
          functionRefs: new Map(),
        },
        abi: abiLookup([sourceCallableEntry(f.first.id), supportTypeEntry(supportRef)]),
      }).components[0]!;

    expect(dependencies(refCellSet, [])).toMatchObject({ status: "blocked" });
    const unrelated = dependencies({ ...refCellSet }, [supportRef]);
    expect(unrelated.status).toBe("blocked");
    expect(unrelated.failures).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("refcell.set resolves ref-cell type support"),
      }),
    );

    const prepared = dependencies(refCellSet, [supportRef]);
    expect(prepared.status).toBe("complete");
    expect(prepared.failures).toEqual([]);
    expect(prepared.abiDependencies).toContainEqual(
      expect.objectContaining({ kind: "support", bindingId: supportRef.binding.bindingId }),
    );
  });

  it("requires identity-exact Program ABI evidence for each closed object operation", () => {
    const f = fixture();
    const objectType: IrType = {
      kind: "object",
      shape: { fields: [{ name: "value", type: irVal({ kind: "f64" }) }] },
    };
    const supportRef = irSupportTypeRef(f.first.id, "test-object-layout", "__test_object_layout");
    const objectNew: IrInstr = {
      kind: "object.new",
      shape: objectType.kind === "object" ? objectType.shape : { fields: [] },
      values: [asValueId(0)],
      result: asValueId(1),
      resultType: objectType,
    };
    const fn: IrFunction = {
      ...irFunction(f.first, [objectNew]),
      params: [{ value: asValueId(0), name: "value", type: irVal({ kind: "f64" }) }],
      valueCount: 2,
    };
    const dependencies = (type: IrType, refs: readonly IrTypeRef[]) =>
      derivePreparedComponentDependencies({
        module: { functions: [fn] },
        terminalUnitIds: new Set([f.first.id]),
        inventory: f.inventory,
        closureSupport: {
          typeRefs: new Map([[type, refs]]),
          instructionRefs: new Map(),
          functionRefs: new Map(),
        },
        abi: abiLookup([sourceCallableEntry(f.first.id), supportTypeEntry(supportRef)]),
      }).components[0]!;

    expect(dependencies(objectType, [])).toMatchObject({ status: "blocked" });
    const structurallyEqualType: IrType =
      objectType.kind === "object" ? { kind: "object", shape: objectType.shape } : objectType;
    expect(dependencies(structurallyEqualType, [supportRef])).toMatchObject({ status: "blocked" });

    const prepared = dependencies(objectType, [supportRef]);
    expect(prepared.status).toBe("complete");
    expect(prepared.failures).toEqual([]);
    expect(prepared.abiDependencies).toContainEqual(
      expect.objectContaining({ kind: "support", bindingId: supportRef.binding.bindingId }),
    );
  });

  it("fails closed for an unresolved exact unit ref and for a foreign terminal owner", () => {
    const f = fixture();
    const unknownUnitId = createDerivedIrUnitId({
      parentId: f.first.id,
      role: "lifted-closure",
      ordinal: 99,
    });
    const unknownCall: IrInstr = {
      kind: "call",
      result: null,
      resultType: null,
      target: irUnitFuncRef({ unitId: unknownUnitId, name: "missing" }),
      args: [],
    };
    const foreignCall: IrInstr = {
      kind: "call",
      result: null,
      resultType: null,
      target: irUnitFuncRef({ unitId: f.second.id, name: "second" }),
      args: [],
    };
    const report = derivePreparedComponentDependencies({
      module: { functions: [irFunction(f.first, [unknownCall, foreignCall]), irFunction(f.second)] },
      terminalUnitIds: new Set([f.first.id]),
      inventory: f.inventory,
      abi: abiLookup([sourceCallableEntry(f.first.id), sourceCallableEntry(f.second.id)]),
    });

    expect(report.components[0]!.status).toBe("blocked");
    expect(new Set(report.components[0]!.failures.map((failure) => failure.code))).toEqual(
      new Set(["unknown-source-unit", "foreign-source-unit"]),
    );
  });
});
