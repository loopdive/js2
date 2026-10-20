// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeJsClassManagedGcType,
  emitNativeJsClassGcAggregateRoot,
  assertNativeJsClassManagedGcTypeCurrent,
  emitNativeJsClassGcBox,
  emitNativeJsClassGcOwnPropertySnapshot,
  emitNativeJsClassGcOwnPropertyReplacement,
  reserveNativeJsClassGcValues,
  fillNativeJsClassGcValues,
  requireCompletedNativeJsClassGcValues,
} from "../src/backend/wasmgc/resources/native-js-class.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { irDynamic, irVal } from "../src/ir/core/types.js";
import { irSupportRef } from "../src/ir/core/types.js";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planPhysicalStartup } from "../src/ir/program/physical-startup.js";
import { JS_TAG_IDS } from "../src/ir/runtime/js-tag-domain.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import {
  createNativeJsClassRepresentability,
  assertNativeJsClassLegalityCurrent,
  type NativeJsClassLegalityContext,
  type NativeJsClassLegalityUse,
} from "../src/ir/analysis/allocation-evidence/native-js-class-legality.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import type { IrFunction } from "../src/ir/core/nodes.js";
import { prepareLinearAllocationFacts } from "../src/ir/analysis/linear-memory-plan.js";
import { planLinearMemoryFromFrozenFacts } from "../src/ir/analysis/linear-memory-from-facts.js";
import { describeNativeJsClassLinearBox } from "../src/backend/linear/program/native-js-class.js";
import {
  nativeJsClassPhysicalSignatureConverter,
  nativeJsClassPhysicalFunctionPlan,
  assertNativeJsClassPhysicalFunctionPlan,
  reserveNativeJsClassPhysicalFunctions,
  requireCompletedNativeJsClassPhysicalFunctions,
  nativeJsClassPhysicalLowering,
  assertNativeJsClassPhysicalLowering,
  nativeJsClassPhysicalFunctionSlots,
  assertNativeJsClassPhysicalValuesCurrent,
  fillNativeJsClassPhysicalValues,
  emitNativeJsClassPhysicalDefinition,
  emitNativeJsClassPhysicalModuleInitialization,
  emitNativeJsClassPhysicalFrame,
  emitNativeJsClassPhysicalNormalCompletion,
  reserveNativeJsClassPhysicalValues,
  reserveNativeJsClassPhysicalRealm,
  reserveNativeJsClassPhysicalModuleBindings,
  fillNativeJsClassPhysicalModuleBindings,
  nativeJsClassPhysicalModuleBindings,
  fillNativeJsClassPhysicalRealm,
  nativeJsClassPhysicalRealmBindings,
  nativeJsClassPhysicalBootstrapCall,
  nativeJsClassPhysicalRoleType,
  nativeJsClassPhysicalValueType,
  nativeJsClassPhysicalErrorConstructor,
  type NativeJsClassPhysicalValues,
} from "../src/backend/wasmgc/program/native-realm.js";
import {
  collectNativeProgramClassRequirements,
  completeNativeProgramStringSemantics,
} from "../src/ir/program/native-program-resource-requirements.js";
import { TYPE_ERROR_DECLARATION } from "../src/ir/runtime/native-js-class-error-callables.js";
import { REFERENCE_ERROR_DECLARATION } from "../src/ir/runtime/reference-error-callable.js";
import { physicalSignatureConverter } from "../src/ir/program-body-resources.js";
import { deriveNativeVectorResourcePlan } from "../src/ir/program/native-vector-resources.js";
import {
  reserveNativeVectorTypes,
  nativeVectorPhysicalType,
  resolveNativeVector,
  resolveNativeVectorForElement,
} from "../src/backend/wasmgc/resources/native-vectors.js";
import { emitBinary } from "../src/emit/binary.js";

function occurrencesForType(
  functions: readonly IrFunction[],
): Extract<import("../src/ir/core/types.js").IrType, { kind: "dynamic" }> | undefined {
  let type: Extract<import("../src/ir/core/types.js").IrType, { kind: "dynamic" }> | undefined;
  for (const fn of functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.resultType?.kind === "dynamic") type = instruction.resultType;
        });
  return type;
}

describe("native class primitive substrate without class admission", () => {
  it("executes the real Function.prototype substrate body returning Undefined", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const values = reserveNativeJsClassGcValues(tx, "class-substrate");
    const probe = tx.reserveFunction("class-substrate:probe", "probe", {
      params: [],
      results: [{ kind: "i32" }],
    });
    expect(
      values.carrier.object.kind === "struct" && values.carrier.object.fields.every((field) => !field.mutable),
    ).toBe(true);
    tx.freezeReservations();
    fillNativeJsClassGcValues(tx, values);
    tx.fillFunction(probe, {
      locals: [],
      body: [
        { op: "call", funcIdx: tx.physicalIndex(values.functionPrototypeBody) },
        { op: "struct.get", typeIdx: values.carrier.typeIndex, fieldIdx: 0 },
      ],
    });
    tx.defineExport("class-substrate:export", "probe", probe);
    requireCompletedNativeJsClassGcValues(tx, values);
    tx.seal();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(module)).buffer), {});
    expect((instance.exports.probe as () => number)()).toBe(1);
  });
  it("refuses foreign and copied reservations", () => {
    const one = new PhysicalModuleReservations(createEmptyModule()),
      two = new PhysicalModuleReservations(createEmptyModule());
    const values = reserveNativeJsClassGcValues(one, "foreign");
    one.freezeReservations();
    two.freezeReservations();
    expect(() => fillNativeJsClassGcValues(two, values)).toThrow("foreign pack");
    expect(() => fillNativeJsClassGcValues(one, { ...values })).toThrow("foreign pack");
  });
  it("refuses unfilled and revoked attempts", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule()),
      values = reserveNativeJsClassGcValues(tx, "unfilled");
    tx.freezeReservations();
    expect(() => requireCompletedNativeJsClassGcValues(tx, values)).toThrow("unfilled");
    fillNativeJsClassGcValues(tx, values);
    requireCompletedNativeJsClassGcValues(tx, values);
    tx.seal();
    expect(() => requireCompletedNativeJsClassGcValues(tx, values)).toThrow("inactive attempt");
  });
  it.each([0, 1, -3])("materializes an actual builder-issued Boolean box for %s", (input) => {
    const registry = new AllocSiteRegistry(),
      identities = createTestIrFunctionIdentityFactory("class-box");
    const type = irDynamic(JS_TAG_IDS.Boolean),
      builder = new IrFunctionBuilder(identities.next("box"), [type], false, registry);
    builder.openBlock();
    const value = builder.emitConst({ kind: "i32", value: input }, irVal({ kind: "i32" }));
    const boxed = builder.emitBox(value, type);
    builder.terminate({ kind: "return", values: [boxed] });
    const fn = builder.finish(),
      instruction = fn.blocks[0]!.instrs.find((item) => item.kind === "box")!;
    if (instruction.kind !== "box") throw Error("missing original box");
    expect(instruction.alloc).toBeDefined();
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module),
      pack = reserveNativeJsClassGcValues(tx, "boolean-box");
    const probe = tx.reserveFunction("boolean-box:probe", "probe", {
      params: [],
      results: [{ kind: "i32" }],
    });
    tx.freezeReservations();
    fillNativeJsClassGcValues(tx, pack);
    const body = emitNativeJsClassGcBox(tx, pack, instruction, [{ op: "i32.const", value: input }]);
    tx.fillFunction(probe, {
      locals: [],
      body: [...body, { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx: 1 }],
    });
    tx.defineExport("boolean-box:export", "probe", probe);
    requireCompletedNativeJsClassGcValues(tx, pack);
    tx.seal();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(module)).buffer), {});
    expect((instance.exports.probe as () => number)()).toBe(Number(Boolean(input)));
  });
  it.each([NaN, -0, 2.5, Infinity])("preserves a builder-issued NumberF64 payload %s", (input) => {
    const registry = new AllocSiteRegistry(),
      identities = createTestIrFunctionIdentityFactory("class-number-box");
    const type = irDynamic(JS_TAG_IDS.NumberF64),
      builder = new IrFunctionBuilder(identities.next("box"), [type], false, registry);
    builder.openBlock();
    const value = builder.emitConst({ kind: "f64", value: input }, irVal({ kind: "f64" }));
    const boxed = builder.emitBox(value, type);
    builder.terminate({ kind: "return", values: [boxed] });
    const instruction = builder.finish().blocks[0]!.instrs.find((item) => item.kind === "box")!;
    if (instruction.kind !== "box") throw Error("missing original box");
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module),
      pack = reserveNativeJsClassGcValues(tx, "number-box");
    const probe = tx.reserveFunction("number-box:probe", "probe", {
      params: [],
      results: [{ kind: "f64" }],
    });
    tx.freezeReservations();
    fillNativeJsClassGcValues(tx, pack);
    const body = emitNativeJsClassGcBox(tx, pack, instruction, [{ op: "f64.const", value: input }]);
    tx.fillFunction(probe, {
      locals: [],
      body: [...body, { op: "struct.get", typeIdx: pack.carrier.typeIndex, fieldIdx: 2 }],
    });
    tx.defineExport("number-box:export", "probe", probe);
    requireCompletedNativeJsClassGcValues(tx, pack);
    tx.seal();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(module)).buffer), {});
    expect(Object.is((instance.exports.probe as () => number)(), input)).toBe(true);
  });
  it("rejects a context getter before observing it", () => {
    let reads = 0;
    const context = Object.create(null);
    Object.defineProperty(context, "selected", {
      enumerable: true,
      get() {
        reads++;
        return {};
      },
    });
    expect(() => createNativeJsClassRepresentability(context as NativeJsClassLegalityContext)).toThrow();
    expect(reads).toBe(0);
  });
  it("rejects a proof getter before observing it", () => {
    let reads = 0;
    const use = Object.create(null);
    Object.defineProperty(use, "proof", {
      enumerable: true,
      get() {
        reads++;
        return {};
      },
    });
    expect(() =>
      assertNativeJsClassLegalityCurrent(use as NativeJsClassLegalityUse, {} as IrFunction, "wasmgc"),
    ).toThrow();
    expect(reads).toBe(0);
  });
  it.each(["number", "boolean"] as const)(
    "joins an actual %s box to unchanged checked Linear geometry",
    (partition) => {
      const registry = new AllocSiteRegistry(),
        identities = createTestIrFunctionIdentityFactory("class-linear-box");
      const number = partition === "number",
        type = irDynamic(number ? JS_TAG_IDS.NumberF64 : JS_TAG_IDS.Boolean);
      const builder = new IrFunctionBuilder(identities.next("box"), [type], false, registry);
      builder.openBlock();
      const value = number
        ? builder.emitConst({ kind: "f64", value: NaN }, irVal({ kind: "f64" }))
        : builder.emitConst({ kind: "i32", value: 1 }, irVal({ kind: "i32" }));
      const boxed = builder.emitBox(value, type);
      builder.terminate({ kind: "return", values: [boxed] });
      const fn = builder.finish(),
        module = { functions: [fn] };
      const instruction = fn.blocks[0]!.instrs.find((item) => item.kind === "box")!;
      if (instruction.kind !== "box") throw Error("missing original box");
      const facts = prepareLinearAllocationFacts(module, registry),
        planner = planLinearMemoryFromFrozenFacts(module, facts);
      const description = describeNativeJsClassLinearBox(planner, instruction);
      expect(description.allocation.id).toBe(instruction.alloc);
      expect(description).toMatchObject({
        payload: number ? "f64" : "i32",
        offset: 8,
        bytes: 16,
      });
      expect(description.allocation.layoutId).toBe("record:box:scalar:" + description.payload);
    },
  );
  it("rejects a caller-authored physical marker without observing its getter", () => {
    let reads = 0;
    const values = Object.create(null);
    Object.defineProperty(values, "kind", {
      enumerable: true,
      get() {
        reads++;
        return "native-js-class-physical-values";
      },
    });
    expect(() => assertNativeJsClassPhysicalValuesCurrent(values as NativeJsClassPhysicalValues)).toThrow(
      "unissued or copied values",
    );
    expect(reads).toBe(0);
  });
  it("rejects a frozen lookalike physical marker", () => {
    expect(() =>
      assertNativeJsClassPhysicalValuesCurrent(Object.freeze({ kind: "native-js-class-physical-values" })),
    ).toThrow("unissued or copied values");
  });
  it("refuses a fake transaction without running its state or reservation callbacks", () => {
    let effects = 0;
    const fake = Object.create(PhysicalModuleReservations.prototype);
    Object.defineProperty(fake, "state", {
      get() {
        effects++;
        return "reserving";
      },
    });
    fake.reserveType = () => {
      effects++;
      throw Error("callback used");
    };
    expect(() => reserveNativeJsClassGcValues(fake, "fake")).toThrow("shadowed transaction member");
    expect(effects).toBe(0);
  });
  it("refuses a genuine transaction state shadow without observing it", () => {
    let effects = 0;
    const tx = new PhysicalModuleReservations(createEmptyModule());
    Object.defineProperty(tx, "state", {
      get() {
        effects++;
        return "reserving";
      },
    });
    expect(() => reserveNativeJsClassGcValues(tx, "shadow")).toThrow("shadowed transaction member");
    expect(effects).toBe(0);
  });
  it.each([
    "internFunctionType",
    "assertReservationKeysAvailable",
    "physicalIndices",
    "assertTypeReservation",
    "reserveSelfReferentialStructType",
    "reserveExtensibleSelfReferentialStructType",
  ] as const)("screens reused producer method %s before effects", (key) => {
    let effects = 0;
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    Object.defineProperty(tx, key, {
      get() {
        effects++;
        throw Error("hostile method getter");
      },
    });
    expect(() => reserveNativeJsClassGcValues(tx, "method-shadow")).toThrow("shadowed transaction member");
    expect(effects).toBe(0);
    expect(module.types).toEqual([]);
    expect(module.globals).toEqual([]);
    expect(module.functions).toEqual([]);
  });
  it("screens inherited reused producer method replacement without invoking its getter", () => {
    const prototype = PhysicalModuleReservations.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, "internFunctionType")!;
    const tx = new PhysicalModuleReservations(createEmptyModule());
    let effects = 0;
    try {
      Object.defineProperty(prototype, "internFunctionType", {
        configurable: true,
        get() {
          effects++;
          throw Error("hostile inherited method getter");
        },
      });
      expect(() => reserveNativeJsClassGcValues(tx, "method-prototype")).toThrow(
        "changed transaction method authority",
      );
      expect(effects).toBe(0);
    } finally {
      Object.defineProperty(prototype, "internFunctionType", original);
    }
  });
  it("refuses a reserved carrier getter before ledger observation", () => {
    let effects = 0;
    const tx = new PhysicalModuleReservations(createEmptyModule()),
      values = reserveNativeJsClassGcValues(tx, "getter");
    tx.freezeReservations();
    Object.defineProperty(values.carrier.object, "fields", {
      configurable: true,
      get() {
        effects++;
        return [];
      },
    });
    expect(() => fillNativeJsClassGcValues(tx, values)).toThrow();
    expect(effects).toBe(0);
  });
  it("engine-validates a genuine common managed root with inline property snapshots", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module),
      values = reserveNativeJsClassGcValues(tx, "managed");
    const graph = reserveNativeJsClassManagedGcType(tx, values, "managed:root", ["x", "prototype", "constructor"]);
    assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
    expect(graph.managed.object.kind).toBe("struct");
    if (graph.managed.object.kind !== "struct") throw Error("not an actual managed record");
    const prototype = graph.managed.object.fields.find((field) => field.name === "prototype")!;
    expect(prototype.type).toEqual({
      kind: "ref_null",
      typeIdx: graph.managed.typeIndex,
    });
    const field = graph.managed.object.fields.find((field) => field.name === "property:0:value:x")!;
    expect(field.type).toEqual({
      kind: "ref",
      typeIdx: values.carrier.typeIndex,
    });
    expect(module.types.length).toBe(3); // value, actual callable signature, managed root: no property table type.
    tx.freezeReservations();
    fillNativeJsClassGcValues(tx, values);
    requireCompletedNativeJsClassGcValues(tx, values);
    assertNativeJsClassManagedGcTypeCurrent(tx, values, graph);
    tx.seal();
    expect(WebAssembly.validate(new Uint8Array(emitBinary(module)).buffer)).toBe(true);
    expect(() => assertNativeJsClassManagedGcTypeCurrent(tx, values, graph)).toThrow("revoked graph type attempt");
  });
  it("engine-validates aggregate prototype links and actual callable coordinates without realm admission", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const values = reserveNativeJsClassGcValues(tx, "aggregate");
    const graph = reserveNativeJsClassManagedGcType(tx, values, "aggregate:managed", ["x"]);
    const typeIdx = graph.managed.typeIndex;
    const object = tx.reserveGlobal("aggregate:object", "object", { kind: "ref", typeIdx }, false);
    const method = tx.reserveGlobal("aggregate:method", "method", { kind: "ref", typeIdx }, false);
    const probe = tx.reserveFunction("aggregate:probe", "probe", { params: [], results: [{ kind: "i32" }] });
    tx.freezeReservations();
    fillNativeJsClassGcValues(tx, values);
    tx.fillGlobal(object, [...emitNativeJsClassGcAggregateRoot(tx, values, graph, 2, [{ op: "ref.null", typeIdx }])]);
    tx.fillGlobal(method, [
      ...emitNativeJsClassGcAggregateRoot(
        tx,
        values,
        graph,
        6,
        [{ op: "global.get", index: tx.physicalIndex(object) }],
        values.functionPrototypeBody,
      ),
    ]);
    expect(() => emitNativeJsClassGcAggregateRoot(tx, values, graph, 2, [], values.functionPrototypeBody)).toThrow(
      "aggregate callable/role mismatch",
    );
    tx.fillFunction(probe, {
      locals: [],
      body: [
        { op: "global.get", index: tx.physicalIndex(method) },
        { op: "struct.get", typeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 10 },
        { op: "i32.mul" },
        { op: "global.get", index: tx.physicalIndex(method) },
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx, fieldIdx: 0 },
        { op: "i32.add" },
      ],
    });
    tx.defineExport("aggregate:export", "probe", probe);
    tx.seal();
    const binary = new Uint8Array(emitBinary(module)).buffer;
    expect(WebAssembly.validate(binary)).toBe(true);
    expect((new WebAssembly.Instance(new WebAssembly.Module(binary), {}).exports.probe as () => number)()).toBe(62);
    const badTx = new PhysicalModuleReservations(createEmptyModule());
    const badValues = reserveNativeJsClassGcValues(badTx, "aggregate:bad");
    const badGraph = reserveNativeJsClassManagedGcType(badTx, badValues, "aggregate:bad:managed", []);
    badTx.freezeReservations();
    fillNativeJsClassGcValues(badTx, badValues);
    expect(() =>
      emitNativeJsClassGcAggregateRoot(badTx, badValues, badGraph, 6, [], { ...badValues.functionPrototypeBody }),
    ).toThrow();
  });
  it("rejects copied graph type and duplicate key population before new reservation", () => {
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module),
      values = reserveNativeJsClassGcValues(tx, "graph-negative");
    const before = module.types.length;
    expect(() => reserveNativeJsClassManagedGcType(tx, values, "graph-negative:bad", ["x", "x"])).toThrow(
      "invalid closed key domain",
    );
    expect(module.types.length).toBe(before);
    const graph = reserveNativeJsClassManagedGcType(tx, values, "graph-negative:root", ["x"]);
    expect(() => assertNativeJsClassManagedGcTypeCurrent(tx, values, { ...graph })).toThrow(
      "unissued or foreign graph type",
    );
  });
  it("preserves a numeric snapshot when an own tagged property is replaced", () => {
    const registry = new AllocSiteRegistry();
    const identities = createTestIrFunctionIdentityFactory("class-property-snapshot");
    const dynamic = irDynamic(JS_TAG_IDS.NumberF64);
    const builder = new IrFunctionBuilder(identities.next("boxes"), [dynamic], false, registry);
    builder.openBlock();
    const first = builder.emitBox(builder.emitConst({ kind: "f64", value: 2 }, irVal({ kind: "f64" })), dynamic);
    builder.emitBox(builder.emitConst({ kind: "f64", value: 8 }, irVal({ kind: "f64" })), dynamic);
    builder.terminate({ kind: "return", values: [first] });
    const boxes = builder.finish().blocks[0]!.instrs.filter((item) => item.kind === "box");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.alloc).not.toBe(boxes[1]!.alloc);
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const values = reserveNativeJsClassGcValues(tx, "snapshot");
    const graph = reserveNativeJsClassManagedGcType(tx, values, "snapshot:root", ["x"]);
    const probe = tx.reserveFunction("snapshot:probe", "probe", {
      params: [],
      results: [{ kind: "f64" }],
    });
    tx.freezeReservations();
    fillNativeJsClassGcValues(tx, values);
    const rootIndex = graph.managed.typeIndex;
    const read = emitNativeJsClassGcOwnPropertySnapshot(tx, values, graph, "x", [{ op: "local.get", index: 0 }]);
    const replace = emitNativeJsClassGcOwnPropertyReplacement(
      tx,
      values,
      graph,
      "x",
      [{ op: "local.get", index: 0 }],
      emitNativeJsClassGcBox(tx, values, boxes[1]!, [{ op: "f64.const", value: 8 }]),
    );
    expect(read.filter((instruction) => instruction.op === "struct.new")).toHaveLength(0);
    expect(replace.filter((instruction) => instruction.op === "struct.new")).toHaveLength(1);
    tx.fillFunction(probe, {
      locals: [
        { name: "instance", type: { kind: "ref", typeIdx: rootIndex } },
        {
          name: "snapshot",
          type: { kind: "ref", typeIdx: values.carrier.typeIndex },
        },
      ],
      body: [
        { op: "i32.const", value: 0 },
        ...Array.from({ length: 7 }, () => ({
          op: "ref.null" as const,
          typeIdx: rootIndex,
        })),
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: 1 },
        ...emitNativeJsClassGcBox(tx, values, boxes[0]!, [{ op: "f64.const", value: 2 }]),
        { op: "struct.new", typeIdx: rootIndex },
        { op: "local.set", index: 0 },
        ...read,
        { op: "local.set", index: 1 },
        ...replace,
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: values.carrier.typeIndex, fieldIdx: 2 },
      ],
    });
    tx.defineExport("snapshot:export", "probe", probe);
    tx.seal();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(module)).buffer), {});
    expect((instance.exports.probe as () => number)()).toBe(2);
    // Direct physical substrate evidence only: no source class allocation or
    // inherited-property admission is inferred from this managed-root fixture.
  });
  it("refuses unknown own property recipes and copied geometry before emission", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const values = reserveNativeJsClassGcValues(tx, "property-negative");
    const graph = reserveNativeJsClassManagedGcType(tx, values, "property-negative:root", ["x"]);
    tx.freezeReservations();
    fillNativeJsClassGcValues(tx, values);
    expect(() => emitNativeJsClassGcOwnPropertySnapshot(tx, values, graph, "toString", [])).toThrow(
      "property outside complete key census",
    );
    expect(() => emitNativeJsClassGcOwnPropertyReplacement(tx, values, { ...graph }, "x", [], [])).toThrow(
      "unissued or foreign graph type",
    );
  });
  it.each([
    ["standalone", "capsule"],
    ["wasi", "capsule"],
    ["standalone", "original-alias"],
    ["wasi", "original-alias"],
  ] as const)("reserves actual declared common managed roles on GC %s/%s", async (target, family) => {
    // Let the worker's existing task-update acknowledgement settle before the
    // complete synchronous compiler/resource proof; RPC deadlines stay intact.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const policy = { backend: "wasmgc" as const, target };
    const text =
      family === "capsule"
        ? "class C{x:number;read():number{return this.x===undefined?1:0;}}export function run():number{return new C().x===undefined?1:0;}"
        : "class C{x:number;}export function run():number{const c=new C();return c.x===undefined?1:0;}";
    const reference: { run?: () => number } = {};
    new Function(
      "exports",
      ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
        .outputText,
    )(reference);
    expect(reference.run!()).toBe(1);
    const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const typed = captureTypedIrProgramInput(source);
    const result = prepareTypedIrProgram(typed, {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: false,
        verifyDominanceNaive: false,
      },
    });
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    const program = result.program;
    const gaps: string[] = [];
    const startup = planPhysicalStartup(
      program,
      new Map(program.runtime[0]!.prepared.functions.map((fn) => [fn.unitId, fn])),
      new Set(["run"]),
      {
        add: (detail) => {
          gaps.push(detail);
        },
      },
      target,
    );
    expect(gaps).toEqual([]);
    expect(startup.onceGuard).toBe(true);
    expect(startup.units).toHaveLength(1);
    expect(startup.adapter).toBe(target === "wasi" ? "wasi-start-export" : "wasm-start");
    expect(() =>
      planPhysicalStartup(
        { ...program, allocations: { ...program.allocations, metadata: [] } },
        new Map(program.runtime[0]!.prepared.functions.map((fn) => [fn.unitId, fn])),
        new Set(["run"]),
        {
          add: (detail) => {
            gaps.push(detail);
          },
        },
        target,
      ),
    ).toThrow();
    const definition = typed.jsClassDefinitions![0]!;
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const values = reserveNativeJsClassPhysicalValues(tx, program, program.runtime[0]!)!;
    expect(values).toBeDefined();
    expect(module.globals).toHaveLength(4); // Undefined + three actual canonical error-name roots before realm acquisition.
    reserveNativeJsClassPhysicalRealm(values);
    const realmBindings = nativeJsClassPhysicalRealmBindings(values);
    expect(realmBindings).toHaveLength(4);
    expect(new Set(realmBindings.map((row) => row.bindingId))).toEqual(new Set(Object.values(definition.realm)));
    expect(() => nativeJsClassPhysicalBootstrapCall(values, startup.units)).toThrow("unfilled realm bootstrap");
    const mapped = Object.values(definition.roles).map((role) =>
      nativeJsClassPhysicalRoleType(values, irSupportRef(role, false)),
    );
    expect(mapped).toHaveLength(7);
    expect(mapped.every((type) => type?.kind === "ref")).toBe(true);
    expect(new Set(mapped.map((type) => (type && "typeIdx" in type ? type.typeIdx : undefined))).size).toBe(1);
    expect(nativeJsClassPhysicalRoleType(values, irVal({ kind: "f64" }))).toBeUndefined();
    const nullable = nativeJsClassPhysicalRoleType(values, irSupportRef(definition.roles.constructor, true));
    expect(nullable?.kind).toBe("ref_null");
    const projection = program.runtime[0]!;
    const vectorPlan = deriveNativeVectorResourcePlan({
      anchor: program.inventory.sources.find((row) => row.kind === "entry")!.id,
      functions: projection.prepared.functions,
      abiEntries: program.abi.entries,
      policy: projection.prepared.manifest.policy,
      providers: projection.prepared.manifest.providers,
      backend: projection.backend,
      target: projection.target,
    });
    expect(vectorPlan.layouts).toEqual([]);
    const vectorTypes = reserveNativeVectorTypes(tx, vectorPlan);
    const baseSignature = physicalSignatureConverter(
      {
        physicalType: nativeVectorPhysicalType,
        resolve: resolveNativeVector,
        resolveElement: resolveNativeVectorForElement,
      },
      vectorTypes,
      undefined,
      undefined,
      tx,
      undefined,
    );
    const signature = nativeJsClassPhysicalSignatureConverter(values, baseSignature);
    expect(
      signature({ params: Object.values(definition.roles).map((role) => irSupportRef(role, false)), results: [] })
        .params,
    ).toEqual(mapped);
    expect(signature({ params: [{ kind: "f64" }], results: [{ kind: "i32" }] })).toEqual({
      params: [{ kind: "f64" }],
      results: [{ kind: "i32" }],
    });
    const tagged = occurrencesForType(projection.prepared.functions);
    expect(tagged).toBeDefined();
    expect(signature({ params: [tagged!], results: [tagged!] }).results).toEqual([
      nativeJsClassPhysicalValueType(values, tagged!),
    ]);
    let typeReads = 0;
    const hostileType = Object.create(null);
    Object.defineProperty(hostileType, "kind", {
      enumerable: true,
      get() {
        typeReads++;
        return "dynamic";
      },
    });
    expect(() => nativeJsClassPhysicalValueType(values, hostileType)).toThrow();
    expect(typeReads).toBe(0);
    const fake = { ...values };
    expect(() => nativeJsClassPhysicalRoleType(fake, irSupportRef(definition.roles.object, false))).toThrow(
      "unissued or copied",
    );
    expect(module.globals).toHaveLength(12); // Prior four + four actual realm bindings + four declared Error ancestor/prototype children.
    const occurrences: { fn: IrFunction; instruction: IrInstr }[] = [];
    for (const fn of program.runtime[0]!.prepared.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs) forEachInstrDeep(root, (instruction) => occurrences.push({ fn, instruction }));
    const frame = occurrences.find((row) => row.instruction.kind === "js.class.frame.new")!;
    const read = occurrences.find(
      (row) => row.instruction.kind === "js.class.frame.get" && row.instruction.access.kind === "this",
    )!;
    if (frame.instruction.kind !== "js.class.frame.new") throw Error("missing genuine original activation allocation");
    if (family === "capsule" && read?.instruction.kind !== "js.class.frame.get")
      throw Error("missing genuine original activation read");
    const completion = occurrences.find(
      (row) => row.instruction.kind === "js.class.constructor.complete" && row.instruction.completion.kind === "normal",
    )!;
    if (completion.instruction.kind !== "js.class.constructor.complete")
      throw Error("missing actual normal constructor completion");
    const completionInstruction = completion.instruction;
    const frameInstruction = frame.instruction;
    expect(frameInstruction.alloc).toBeDefined();
    const physical = mapped[0]!;
    if (physical.kind !== "ref") throw Error("missing issued managed coordinate");
    const typeIdx = physical.typeIdx;
    const managed = module.types[typeIdx]!;
    if (managed.kind !== "struct") throw Error("missing actual managed struct");
    const propertyCount = (managed.fields.length - 10) / 2;
    const log = tx.reserveGlobal("frame:log", "frame_log", { kind: "i32" }, true);
    const tick = tx.reserveFunction("frame:tick", "frame_tick", {
      params: [{ kind: "i32" }],
      results: [physical],
    });
    const probe = tx.reserveFunction("frame:probe", "frame_probe", {
      params: [],
      results: [{ kind: "i32" }],
    });
    const realmProbe = tx.reserveFunction("frame:realm-probe", "realm_probe", {
      params: [],
      results: [{ kind: "i32" }],
    });
    const errorProbes = [TYPE_ERROR_DECLARATION, REFERENCE_ERROR_DECLARATION].map((declaration, index) => ({
      declaration,
      token: tx.reserveFunction("frame:error-probe:" + index, "error_probe_" + index, {
        params: [],
        results: [{ kind: "i32" }],
      }),
    }));
    const ancestryProbe = tx.reserveFunction("frame:ancestry-probe", "ancestry_probe", {
      params: [],
      results: [{ kind: "i32" }],
    });
    tx.freezeReservations();
    fillNativeJsClassPhysicalValues(values);
    fillNativeJsClassPhysicalRealm(values);
    const bootstrap = nativeJsClassPhysicalBootstrapCall(values, startup.units);
    const nonStartup = program.runtime[0]!.prepared.functions.find((fn) => !startup.units.includes(fn.unitId))!.unitId;
    expect(() => nativeJsClassPhysicalBootstrapCall(values, [nonStartup])).toThrow(
      "foreign or reordered startup sequence",
    );
    expect(() => nativeJsClassPhysicalBootstrapCall({ ...values }, startup.units)).toThrow("unissued or copied values");
    const realmRoot = (id: string): Instr[] => [
      { op: "global.get", index: tx.physicalIndex(realmBindings.find((row) => row.bindingId === id)!.reservation) },
    ];
    tx.fillFunction(realmProbe, {
      locals: [],
      body: [
        ...bootstrap,
        ...realmRoot(definition.realm.typeError),
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        ...realmRoot(definition.realm.functionPrototype),
        { op: "ref.eq" },
        ...realmRoot(definition.realm.typeError),
        { op: "struct.get", typeIdx, fieldIdx: 6 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        ...realmRoot(definition.realm.objectPrototype),
        { op: "ref.eq" },
        { op: "i32.add" },
        ...realmRoot(definition.realm.typeError),
        ...realmRoot(definition.realm.referenceError),
        { op: "ref.eq" },
        { op: "i32.eqz" },
        { op: "i32.add" },
      ],
    });
    tx.defineExport("frame:realm-export", "realm_probe", realmProbe);
    tx.fillFunction(ancestryProbe, {
      locals: [],
      body: [
        ...realmRoot(definition.realm.typeError),
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        ...realmRoot(definition.realm.functionPrototype),
        { op: "ref.eq" },
        ...realmRoot(definition.realm.typeError),
        { op: "struct.get", typeIdx, fieldIdx: 6 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        ...realmRoot(definition.realm.objectPrototype),
        { op: "ref.eq" },
        { op: "i32.add" },
        ...realmRoot(definition.realm.typeError),
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        ...realmRoot(definition.realm.referenceError),
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        { op: "ref.eq" },
        { op: "i32.add" },
      ],
    });
    tx.defineExport("frame:ancestry-export", "ancestry_probe", ancestryProbe);

    for (const { declaration, token } of errorProbes) {
      const index = nativeJsClassPhysicalErrorConstructor(values, declaration.ref)!;
      expect(Number.isInteger(index)).toBe(true);
      const helper = module.functions[index]!;
      const construction = helper.body.find((item) => item.op === "struct.new");
      if (!construction || construction.op !== "struct.new")
        throw Error("missing actual canonical Error struct construction");
      tx.fillFunction(token, {
        locals: [],
        body: [
          { op: "ref.null.extern" },
          { op: "call", funcIdx: index },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: construction.typeIdx },
          { op: "struct.get", typeIdx: construction.typeIdx, fieldIdx: 0 },
        ],
      });
      tx.defineExport("frame:error-export:" + declaration.feature, declaration.feature, token);
    }
    expect(() => nativeJsClassPhysicalErrorConstructor({ ...values }, TYPE_ERROR_DECLARATION.ref)).toThrow(
      "unissued or copied",
    );
    tx.fillGlobal(log, [{ op: "i32.const", value: 0 }]);
    tx.fillFunction(tick, {
      locals: [],
      body: [
        { op: "global.get", index: tx.physicalIndex(log) },
        { op: "i32.const", value: 10 },
        { op: "i32.mul" },
        { op: "local.get", index: 0 },
        { op: "i32.add" },
        { op: "global.set", index: tx.physicalIndex(log) },
        { op: "local.get", index: 0 },
        ...Array.from({ length: 7 }, () => ({
          op: "ref.null" as const,
          typeIdx,
        })),
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: -1 },
        ...Array.from({ length: propertyCount }, () => [
          { op: "i32.const" as const, value: 0 },
          { op: "global.get" as const, index: 0 },
        ]).flat(),
        { op: "struct.new", typeIdx },
      ],
    });
    const locals: { name: string; type: ValType }[] = [];
    const creation = emitNativeJsClassPhysicalFrame(
      values,
      frame.fn,
      frameInstruction,
      [3, 0, 2, 1].map((value): readonly Instr[] => [
        { op: "i32.const", value },
        { op: "call", funcIdx: tx.physicalIndex(tick) },
      ]),
      (type) => {
        expect(type).toEqual({ kind: "ref_null", typeIdx: physical.typeIdx });
        const index = locals.length;
        locals.push({ name: "operand" + index, type });
        return index;
      },
    );
    expect(creation.filter((item) => item.op === "struct.new")).toHaveLength(1);
    expect(creation.filter((item) => item.op === "call")).toHaveLength(4);
    const frameRead: readonly Instr[] =
      read?.instruction.kind === "js.class.frame.get"
        ? emitNativeJsClassPhysicalFrame(values, read.fn, read.instruction, [creation], () => {
            throw Error("read must not allocate scratch");
          })
        : [...creation, { op: "struct.get", typeIdx, fieldIdx: 5 }, { op: "ref.as_non_null" }];
    // A source without a frame.get receives no invented logical read; the direct
    // physical observation above tests only its actual frame.new recipe.
    expect(() => emitNativeJsClassPhysicalFrame({ ...values }, frame.fn, frameInstruction, [], () => 0)).toThrow(
      "unissued or copied",
    );
    expect(() => emitNativeJsClassPhysicalFrame(values, frame.fn, { ...frameInstruction }, [], () => 0)).toThrow(
      "unissued activation occurrence",
    );
    const completed = emitNativeJsClassPhysicalNormalCompletion(
      values,
      completion.fn,
      completionInstruction,
      frameRead,
    );
    expect(completed).toEqual(frameRead);
    expect(() =>
      emitNativeJsClassPhysicalNormalCompletion(values, completion.fn, { ...completionInstruction }, frameRead),
    ).toThrow("unissued constructor completion occurrence");
    tx.fillFunction(probe, {
      locals,
      body: [
        ...completed,
        { op: "struct.get", typeIdx, fieldIdx: 0 },
        { op: "global.get", index: tx.physicalIndex(log) },
        { op: "i32.add" },
      ],
    });
    tx.defineExport("frame:export", "probe", probe);
    tx.seal();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(module)).buffer), {});
    expect((instance.exports.probe as () => number)()).toBe(3021);
    const realmReference =
      Number(Object.getPrototypeOf(TypeError) === Function.prototype) +
      Number(Object.getPrototypeOf(TypeError.prototype) === Object.prototype) +
      Number(TypeError !== ReferenceError);
    expect((instance.exports.realm_probe as () => number)()).toBe(realmReference);
    const ancestryReference =
      Number(Object.getPrototypeOf(Object.getPrototypeOf(TypeError)) === Function.prototype) +
      Number(Object.getPrototypeOf(Object.getPrototypeOf(TypeError.prototype)) === Object.prototype) +
      Number(Object.getPrototypeOf(TypeError) === Object.getPrototypeOf(ReferenceError));
    expect(ancestryReference).toBe(3);
    expect((instance.exports.ancestry_probe as () => number)()).toBe(ancestryReference);
    expect((instance.exports["error.type.construct"] as () => number)()).toBe(-11);
    expect((instance.exports["error.reference.construct"] as () => number)()).toBe(-16);
    // Actual original frame occurrence/site plus engine recipe evidence only;
    // Four actual realm root/prototype/provider resources are observed here;
    // no complete builtin property catalogue, class graph or source execution credit.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it("materializes only the genuine class constructor/TDZ module pair", async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const policy = { backend: "wasmgc" as const, target: "standalone" as const };
    const ast = analyzeMultiSource({ "./entry.ts": "class C{}export function run():number{return 1;}" }, "./entry.ts");
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const typed = captureTypedIrProgramInput(source);
    const result = prepareTypedIrProgram(typed, {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: false,
        verifyDominanceNaive: false,
      },
    });
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    const program = result.program,
      module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const values = reserveNativeJsClassPhysicalValues(tx, program, program.runtime[0]!)!;
    reserveNativeJsClassPhysicalModuleBindings(values);
    const rows = nativeJsClassPhysicalModuleBindings(values);
    expect(rows).toHaveLength(2);
    const definition = typed.jsClassDefinitions![0]!;
    expect(new Set(rows.map((row) => row.bindingId))).toEqual(
      new Set([
        definition.outerBinding!.valueGlobal!.binding.bindingId,
        definition.outerBinding!.tdzGlobal!.binding.bindingId,
      ]),
    );
    expect(rows.every((row) => row.reservation.object.mutable)).toBe(true);
    const probe = tx.reserveFunction("module-pair:probe", "probe", { params: [], results: [{ kind: "i32" }] });
    tx.freezeReservations();
    fillNativeJsClassPhysicalValues(values);
    fillNativeJsClassPhysicalModuleBindings(values);
    const constructorStorage = rows.find((row) => row.reservation.object.type.kind === "ref_null")!.reservation;
    const tdz = rows.find((row) => row.reservation.object.type.kind === "i32")!.reservation;
    tx.fillFunction(probe, {
      locals: [],
      body: [
        { op: "global.get", index: tx.physicalIndex(constructorStorage) },
        { op: "ref.is_null" },
        { op: "global.get", index: tx.physicalIndex(tdz) },
        { op: "i32.eqz" },
        { op: "i32.add" },
      ],
    });
    tx.defineExport("module-pair:export", "probe", probe);
    tx.seal();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(module)).buffer), {});
    expect((instance.exports.probe as () => number)()).toBe(2);
    // Actual pre-initialization storage only, not execution of the source class or TDZ read recipe.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it("retains ordinary native scalar startup without a class once guard", () => {
    const policy = {
      backend: "wasmgc" as const,
      target: "standalone" as const,
    };
    const ast = analyzeMultiSource({ "./entry.ts": "export function run():number{return 42;}" }, "./entry.ts");
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const result = prepareTypedIrProgram(captureTypedIrProgramInput(source), {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: false,
        verifyDominanceNaive: false,
      },
    });
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    const program = result.program,
      gaps: string[] = [];
    const startup = planPhysicalStartup(
      program,
      new Map(program.runtime[0]!.prepared.functions.map((fn) => [fn.unitId, fn])),
      new Set(["run"]),
      {
        add: (detail) => {
          gaps.push(detail);
        },
      },
      policy.target,
    );
    expect(gaps).toEqual([]);
    expect(startup.onceGuard).toBeUndefined();
    expect(startup.units).toEqual([]);
  });
  it("reserves actual original unit slots without caller-authored callable associations", async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const policy = { backend: "wasmgc" as const, target: "standalone" as const };
    const ast = analyzeMultiSource({ "./entry.ts": "class C{}export function run():number{return 1;}" }, "./entry.ts");
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const typedInput = captureTypedIrProgramInput(source);
    const actualDefinition = typedInput.jsClassDefinitions![0]!;
    const prepared = prepareTypedIrProgram(typedInput, {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: false,
        verifyDominanceNaive: false,
      },
    });
    if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const values = reserveNativeJsClassPhysicalValues(tx, prepared.program, prepared.program.runtime[0]!)!;
    const before = module.functions.length;
    const rows = reserveNativeJsClassPhysicalFunctions(values);
    expect(rows).toHaveLength(3);
    expect(module.functions).toHaveLength(before + 3);
    expect(rows.map((row) => row.fn)).toEqual(prepared.program.runtime[0]!.prepared.functions);
    expect(nativeJsClassPhysicalFunctionSlots(values)).toBe(rows);
    expect(rows.filter((row) => row.fn.params.length === 4)).toHaveLength(1);
    expect(
      rows.filter((row) => {
        const type = module.types[row.reservation.object.typeIdx]!;
        return type.kind === "func" && type.params.length === 4;
      }),
    ).toHaveLength(1);
    expect(() => reserveNativeJsClassPhysicalFunctions(values)).toThrow("invalid class unit reservation phase");
    expect(module.functions).toHaveLength(before + 3);
    expect(() => nativeJsClassPhysicalFunctionSlots({ ...values })).toThrow("unissued or copied");
    const token = rows[0]!.reservation.object,
      descriptor = Object.getOwnPropertyDescriptor(token, "typeIdx")!;
    let reads = 0;
    try {
      Object.defineProperty(token, "typeIdx", {
        configurable: true,
        enumerable: true,
        get() {
          reads++;
          return [];
        },
      });
      expect(() => nativeJsClassPhysicalFunctionSlots(values)).toThrow();
      expect(reads).toBe(0);
    } finally {
      Object.defineProperty(token, "typeIdx", descriptor);
    }
    expect(nativeJsClassPhysicalFunctionSlots(values)).toBe(rows);
    reserveNativeJsClassPhysicalRealm(values);
    reserveNativeJsClassPhysicalModuleBindings(values);
    const definitionUnit = rows.find((row) =>
      row.fn.blocks.some((block) => block.instrs.some((instruction) => instruction.kind === "js.class.define")),
    )!;
    const ctor = rows.find((row) => row.fn.params.length === 4)!;
    const run = rows.find((row) => row.fn.params.length === 0 && row.fn.resultTypes.length === 1)!;
    const definition = definitionUnit.fn.blocks[0]!.instrs.find(
      (instruction) => instruction.kind === "js.class.define",
    )!;
    const initialize = definitionUnit.fn.blocks[0]!.instrs.find(
      (instruction) => instruction.kind === "js.class.binding.init",
    )!;
    const frame = ctor.fn.blocks[0]!.instrs[0]!,
      completion = ctor.fn.blocks[0]!.instrs[1]!;
    if (
      definition.kind !== "js.class.define" ||
      initialize.kind !== "js.class.binding.init" ||
      frame.kind !== "js.class.frame.new" ||
      completion.kind !== "js.class.constructor.complete"
    )
      throw Error("actual source operation mismatch");
    const type = nativeJsClassPhysicalRoleType(values, ctor.fn.params[0]!.type)!;
    if (type.kind !== "ref") throw Error("missing real managed coordinate");
    const fresh = tx.reserveFunction("definition:fresh", "definition_fresh", {
      params: [],
      results: [{ kind: "i32" }],
    });
    const initialized = tx.reserveFunction("definition:initialized", "definition_initialized", {
      params: [],
      results: [{ kind: "i32" }],
    });
    tx.freezeReservations();
    fillNativeJsClassPhysicalValues(values);
    fillNativeJsClassPhysicalRealm(values);
    fillNativeJsClassPhysicalModuleBindings(values);
    const port = nativeJsClassPhysicalLowering(values, ctor.fn);
    expect(() => assertNativeJsClassPhysicalLowering({ ...port }, ctor.fn)).toThrow("foreign or copied");
    let foreignReads = 0;
    const foreignFn = {
      get unitId() {
        foreignReads++;
        return ctor.fn.unitId;
      },
    };
    expect(() => port.assertFunction(foreignFn as typeof ctor.fn)).toThrow("foreign or copied");
    expect(foreignReads).toBe(0);
    const frameKind = Object.getOwnPropertyDescriptor(frame, "kind")!;
    expect(frameKind.configurable).toBe(false);
    expect(frameKind.writable).toBe(false);
    let kindReads = 0;
    const foreignInstruction = {
      ...frame,
      get kind() {
        kindReads++;
        return "js.class.frame.new" as const;
      },
    };
    expect(() => port.emit(foreignInstruction, [], () => 0)).toThrow("foreign class lowering occurrence");
    expect(kindReads).toBe(0);
    expect(() => port.emit({ ...frame, alloc: (frame.alloc! + 1) as typeof frame.alloc }, [], () => 0)).toThrow(
      "foreign class lowering occurrence",
    );
    expect(nativeJsClassPhysicalLowering(values, ctor.fn)).toBe(port);
    expect(() => port.assertFunction(ctor.fn)).not.toThrow();
    const definitionLocals: { name: string; type: ValType }[] = [];
    const definitionScratch = (localType: ValType) => {
      const index = definitionLocals.length;
      definitionLocals.push({ name: "definition" + index, type: localType });
      return index;
    };
    const defining = emitNativeJsClassPhysicalDefinition(values, definitionUnit.fn, definition, definitionScratch);
    expect(() => requireCompletedNativeJsClassPhysicalFunctions({ ...values })).toThrow("unissued or copied");
    const ctorLocals: { name: string; type: ValType }[] = [];
    const ctorScratch = (localType: ValType) => {
      const index = 4 + ctorLocals.length;
      ctorLocals.push({ name: "ctor" + index, type: localType });
      return index;
    };
    const param = (value: number): Instr[] => {
      const index = ctor.fn.params.findIndex((parameter) => parameter.value === value);
      if (index < 0) throw Error("not an original USER/hidden parameter");
      return [{ op: "local.get", index }];
    };
    tx.fillFunction(ctor.reservation, {
      locals: ctorLocals,
      body: [
        ...emitNativeJsClassPhysicalFrame(
          values,
          ctor.fn,
          frame,
          [param(frame.environment), param(frame.thisValue), param(frame.homeObject), param(frame.newTarget)],
          ctorScratch,
        ),
        { op: "drop" },
        ...emitNativeJsClassPhysicalNormalCompletion(values, ctor.fn, completion, param(completion.self)),
      ],
    });
    const runConstant = run.fn.blocks[0]!.instrs[0]!;
    if (runConstant.kind !== "const" || runConstant.value.kind !== "f64")
      throw Error("not the original scalar source control");
    tx.fillFunction(run.reservation, { locals: [], body: [{ op: "f64.const", value: runConstant.value.value }] });
    tx.fillFunction(definitionUnit.reservation, {
      locals: definitionLocals,
      body: [...emitNativeJsClassPhysicalModuleInitialization(values, definitionUnit.fn, initialize, defining)],
    });
    expect(() => requireCompletedNativeJsClassPhysicalFunctions(values)).not.toThrow();
    const freshLocals: { name: string; type: ValType }[] = [
      { name: "a", type },
      { name: "b", type },
    ];
    const freshScratch = (localType: ValType) => {
      const index = freshLocals.length;
      freshLocals.push({ name: "fresh" + index, type: localType });
      return index;
    };
    const first = emitNativeJsClassPhysicalDefinition(values, definitionUnit.fn, definition, freshScratch);
    const second = emitNativeJsClassPhysicalDefinition(values, definitionUnit.fn, definition, freshScratch);
    const realmRows = nativeJsClassPhysicalRealmBindings(values);
    const realmFunction = realmRows.find((row) => row.bindingId === actualDefinition.realm.functionPrototype)!,
      realmObject = realmRows.find((row) => row.bindingId === actualDefinition.realm.objectPrototype)!;
    tx.fillFunction(fresh, {
      locals: freshLocals,
      body: [
        ...first,
        { op: "local.set", index: 0 },
        ...second,
        { op: "local.set", index: 1 },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "ref.eq" },
        { op: "i32.eqz" },
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: type.typeIdx, fieldIdx: 1 },
        { op: "global.get", index: tx.physicalIndex(realmFunction.reservation) },
        { op: "ref.eq" },
        { op: "i32.add" },
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: type.typeIdx, fieldIdx: 6 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: type.typeIdx, fieldIdx: 1 },
        { op: "global.get", index: tx.physicalIndex(realmObject.reservation) },
        { op: "ref.eq" },
        { op: "i32.add" },
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: type.typeIdx, fieldIdx: 6 },
        { op: "local.get", index: 1 },
        { op: "struct.get", typeIdx: type.typeIdx, fieldIdx: 6 },
        { op: "ref.eq" },
        { op: "i32.eqz" },
        { op: "i32.add" },
      ],
    });
    const storage = nativeJsClassPhysicalModuleBindings(values),
      constructorStorage = storage.find((row) => row.reservation.object.type.kind === "ref_null")!,
      tdzStorage = storage.find((row) => row.reservation.object.type.kind === "i32")!;
    tx.fillFunction(initialized, {
      locals: [],
      body: [
        { op: "global.get", index: tx.physicalIndex(constructorStorage.reservation) },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "global.get", index: tx.physicalIndex(tdzStorage.reservation) },
        { op: "i32.add" },
      ],
    });
    tx.defineExport("definition:module-export", "source_module", definitionUnit.reservation);
    tx.defineExport("definition:run-export", "source_run", run.reservation);
    tx.defineExport("definition:fresh-export", "fresh", fresh);
    tx.defineExport("definition:initialized-export", "initialized", initialized);
    tx.seal();
    const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(emitBinary(module)).buffer), {});
    expect((instance.exports.initialized as () => number)()).toBe(0);
    (instance.exports.source_module as () => void)();
    expect((instance.exports.initialized as () => number)()).toBe(2);
    expect((instance.exports.source_run as () => number)()).toBe(1);
    const A = class {},
      B = class {};
    const freshReference =
      Number(A !== B) +
      Number(Object.getPrototypeOf(A) === Function.prototype) +
      Number(Object.getPrototypeOf(A.prototype) === Object.prototype) +
      Number(A.prototype !== B.prototype);
    expect(freshReference).toBe(4);
    expect((instance.exports.fresh as () => number)()).toBe(freshReference);
    // Original unit/site recipes and a component probe only. Public compiler,
    // ordinarySet, method/invoke and complete class admission stay unclaimed.
    // The genuine failed-completion path revokes its physical transaction;
    // keep that hostile attempt separate from the successful engine witness.
    const incompleteTx = new PhysicalModuleReservations(createEmptyModule());
    const incomplete = reserveNativeJsClassPhysicalValues(
      incompleteTx,
      prepared.program,
      prepared.program.runtime[0]!,
    )!;
    reserveNativeJsClassPhysicalFunctions(incomplete);
    reserveNativeJsClassPhysicalRealm(incomplete);
    reserveNativeJsClassPhysicalModuleBindings(incomplete);
    incompleteTx.freezeReservations();
    fillNativeJsClassPhysicalValues(incomplete);
    fillNativeJsClassPhysicalRealm(incomplete);
    fillNativeJsClassPhysicalModuleBindings(incomplete);
    const revoked = nativeJsClassPhysicalLowering(incomplete, ctor.fn);
    expect(() => requireCompletedNativeJsClassPhysicalFunctions(incomplete)).toThrow("missing function fill");
    expect(incompleteTx.state).toBe("failed");
    expect(() => revoked.assertFunction(ctor.fn)).toThrow("revoked emission attempt");
    expect(() => revoked.emit(frame, [], () => 0)).toThrow("revoked emission attempt");
    const staleModule = createEmptyModule(),
      staleTx = new PhysicalModuleReservations(staleModule);
    const stale = reserveNativeJsClassPhysicalValues(staleTx, prepared.program, prepared.program.runtime[0]!)!;
    staleTx.freezeReservations();
    fillNativeJsClassPhysicalValues(stale);
    const stalePort = nativeJsClassPhysicalLowering(stale, ctor.fn);
    const helper = staleModule.functions.find((fn) => fn.name === "__class_function_prototype")!;
    expect(helper).toBeDefined();
    helper.body.push({ op: "unreachable" });
    expect(() => stalePort.emit(frame, [], () => 0)).toThrow();
    expect(staleTx.state).toBe("failed");
    expect(() => nativeJsClassPhysicalLowering(stale, ctor.fn)).toThrow("revoked emission attempt");

    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  it("issues an actual module-init class function plan and rejects copied or foreign-function custody", async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const policy = { backend: "wasmgc" as const, target: "standalone" as const };
    const ast = analyzeMultiSource({ "./entry.ts": "class C{}export function run():number{return 1;}" }, "./entry.ts");
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const prepared = prepareTypedIrProgram(captureTypedIrProgramInput(source), {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: false,
        verifyDominanceNaive: false,
      },
    });
    if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
    const projection = prepared.program.runtime[0]!,
      tx = new PhysicalModuleReservations(createEmptyModule());
    const values = reserveNativeJsClassPhysicalValues(tx, prepared.program, projection)!;
    const fn = projection.prepared.functions.find((candidate) =>
      candidate.blocks.some((block) => block.instrs.some((instruction) => instruction.kind === "js.class.define")),
    )!;
    expect(fn).toBeDefined();
    const ordinary = projection.prepared.functions.find(
      (candidate) => candidate !== fn && candidate.params.length === 0 && candidate.resultTypes.length === 1,
    )!;
    expect(ordinary).toBeDefined();
    // These generic procedures supply no class verdict; the actual current pack
    // and independently issued neutral proof authorize the native augmentation.
    const resolver = {
      resolveType() {
        throw Error("generic type not requested");
      },
    };
    const emitter = {
      pushRaw(out: Instr[], instruction: Instr) {
        out.push(instruction);
      },
    };
    const converter = {
      backend: "wasmgc",
      convertType(): readonly ValType[] {
        return [];
      },
    };
    const plan = nativeJsClassPhysicalFunctionPlan(values, fn, resolver, emitter, converter);
    expect(plan).toBeDefined();
    expect(plan!.fn).toBe(fn);
    expect(Object.isFrozen(plan)).toBe(true);
    assertNativeJsClassPhysicalFunctionPlan(plan!, fn);
    expect(() => assertNativeJsClassPhysicalFunctionPlan({ ...plan }, fn)).toThrow(
      "copied concrete class function plan",
    );
    expect(() => assertNativeJsClassPhysicalFunctionPlan(plan!, ordinary)).toThrow("foreign or copied");
    let reads = 0;
    const foreign = Object.defineProperty({}, "unitId", {
      get() {
        reads++;
        throw Error("foreign function getter");
      },
    }) as IrFunction;
    expect(() => assertNativeJsClassPhysicalFunctionPlan(plan!, foreign)).toThrow("foreign or copied");
    const fake = Object.defineProperty({}, "fn", {
      get() {
        reads++;
        throw Error("fake plan getter");
      },
    });
    expect(() => assertNativeJsClassPhysicalFunctionPlan(fake, fn)).toThrow("foreign or copied");
    expect(reads).toBe(0);
    expect(nativeJsClassPhysicalFunctionPlan(values, ordinary, resolver, emitter, converter)).toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("screens logical acquisition DATA before a program getter can execute", () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "ir", {
      enumerable: true,
      get() {
        reads++;
        throw Error("program getter");
      },
    });
    expect(() =>
      collectNativeProgramClassRequirements(
        hostile as Parameters<typeof collectNativeProgramClassRequirements>[0],
        {} as Parameters<typeof collectNativeProgramClassRequirements>[1],
      ),
    ).toThrow();
    expect(reads).toBe(0);
  });

  it("rejects unissued string semantics before observing a demand getter", () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "demands", {
      enumerable: true,
      get() {
        reads++;
        throw Error("demand getter");
      },
    });
    expect(() =>
      completeNativeProgramStringSemantics(
        hostile as Parameters<typeof completeNativeProgramStringSemantics>[0],
        undefined,
        false,
      ),
    ).toThrow("unissued string semantic acquisition");
    expect(reads).toBe(0);
  });
});
