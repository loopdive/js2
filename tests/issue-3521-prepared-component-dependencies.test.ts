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
import { asBlockId, asValueId, irVal, type IrClassShape, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
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
} from "../src/ir/string-runtime.js";
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
    const alloc: IrInstr = {
      kind: "class.alloc",
      result: asValueId(0),
      resultType: { kind: "class", shape },
      shape,
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
      module: { functions: [irFunction(f.first, [alloc, call])] },
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
    const alloc: IrInstr = {
      kind: "class.alloc",
      result: asValueId(0),
      resultType: { kind: "class", shape },
      shape,
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
      module: { functions: [irFunction(f.first, [alloc, call]), irFunction(f.nestedMethod)] },
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
