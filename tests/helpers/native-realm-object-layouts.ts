// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import {
  PhysicalModuleReservations,
  type FunctionReservation,
  type PhysicalFunctionSignature,
} from "../../src/wasm/physical/module-reservations.js";
import type { Instr } from "../../src/wasm/model/instructions.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-object-layouts.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
  fillNativeRealmObjectLayouts,
  requireCompletedNativeRealmObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import { emitBinary } from "../../src/emit/binary.js";
import { prepareGetterProgram } from "./native-getter-invocation-fixture.js";
import { planNativeSourceClosureRequirements } from "../../src/ir/program/native-source-closure-requirements.js";
import { deriveNativeVectorResourcePlan } from "../../src/ir/program/native-vector-resources.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import { reserveNativeVectorTypes } from "../../src/backend/wasmgc/resources/native-vectors.js";
import {
  beginNativeSourceClosureEmission,
  bindNativeSourceClosureUnits,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
} from "../../src/ir/program-native-invocation.js";
import { irUnitCallableBindingId } from "../../src/ir/core/callable-bindings.js";
import type { IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import type { IrLowerResolver } from "../../src/ir/backend/lower-contracts.js";

export const ext = { kind: "externref" } as const,
  f64 = { kind: "f64" } as const,
  i32 = { kind: "i32" } as const;
export const get = (index: number): Instr => ({ op: "local.get", index });
export const as = (index: number, typeIdx: number): Instr[] => [
  get(index),
  { op: "any.convert_extern" },
  { op: "ref.cast", typeIdx },
];

export function realmLayoutFoundation(displaced = false, extensible = true) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = displaced
    ? {
        type: tx.reserveType("control:prefix:type", {
          kind: "rec",
          types: [
            { kind: "struct", name: "PrefixA", fields: [] },
            { kind: "struct", name: "PrefixB", fields: [{ name: "n", type: i32, mutable: false }] },
          ],
        }),
        global: tx.reserveGlobal("control:prefix:global", "prefix", i32, false),
        function: tx.reserveFunction("control:prefix:function", "prefix", { params: [], results: [] }),
      }
    : undefined;
  const requirements = { key: "objects", ...(extensible ? { extensible: true as const } : {}) };
  const objectPlan = declareNativeObjectLayouts(requirements);
  const objects = reserveNativeObjectLayouts(tx, requirements, objectPlan);
  const dependencies = { objects, objectPlan };
  const plan = structuredClone(
    declareNativeRealmObjectLayouts("realm-layout", objects.object.key, objects.propMap.key),
  );
  return { module, tx, prefix, requirements, objects, objectPlan, dependencies, plan };
}
export function realmLayoutFixture(displaced = false) {
  const f = realmLayoutFoundation(displaced);
  const pack = reserveNativeRealmObjectLayouts(f.tx, "realm-layout", f.dependencies, f.plan);
  return { ...f, pack };
}
export function fillRealmLayoutFixture(f: ReturnType<typeof realmLayoutFixture>) {
  if (f.prefix) {
    f.tx.fillGlobal(f.prefix.global, [{ op: "i32.const", value: 17 }]);
    f.tx.fillFunction(f.prefix.function, { locals: [], body: [] });
  }
  fillNativeRealmObjectLayouts(f.tx, f.pack);
}
/** Deliberate operand controls, never installed or certified as standard intrinsics. */
export function reserveRealmAnchorControls(f: Pick<ReturnType<typeof realmLayoutFixture>, "tx" | "pack">) {
  const { tx, pack } = f;
  const initialize = tx.reserveFunction("control:initialize-anchors", "controlInitializeAnchors", {
    params: [ext],
    results: [],
  });
  const state = tx.reserveFunction("control:state", "controlState", { params: [], results: [ext] });
  const prototype = tx.reserveFunction("control:state-prototype", "controlStatePrototype", {
    params: [ext],
    results: [ext],
  });
  const realm = tx.reserveFunction("control:state-realm", "controlStateRealm", { params: [ext], results: [ext] });
  const setPrototype = tx.reserveFunction("control:set-state-prototype", "controlSetStatePrototype", {
    params: [ext, ext],
    results: [],
  });
  return {
    initialize,
    state,
    prototype,
    realm,
    setPrototype,
    fill() {
      tx.fillFunction(initialize, {
        locals: [],
        body: [
          { op: "struct.new", typeIdx: pack.types.identity.typeIndex },
          { op: "global.set", index: tx.physicalIndex(pack.anchors.realm) },
          get(0),
          { op: "global.set", index: tx.physicalIndex(pack.anchors.functionPrototype) },
        ],
      });
      tx.fillFunction(state, {
        locals: [],
        body: [{ op: "call", funcIdx: pack.sourceInitializer.handle }, { op: "extern.convert_any" }],
      });
      for (const [fieldIdx, token] of [prototype, realm].entries())
        tx.fillFunction(token, {
          locals: [],
          body: [
            ...as(0, pack.types.state.typeIndex),
            { op: "struct.get", typeIdx: pack.types.state.typeIndex, fieldIdx },
            ...(fieldIdx === 1 ? [{ op: "extern.convert_any" } as Instr] : []),
          ],
        });
      tx.fillFunction(setPrototype, {
        locals: [],
        body: [
          ...as(0, pack.types.state.typeIndex),
          get(1),
          { op: "struct.set", typeIdx: pack.types.state.typeIndex, fieldIdx: 0 },
        ],
      });
      for (const [name, token] of Object.entries({ initialize, state, prototype, realm, setPrototype }))
        tx.defineExport("control:export:" + name, name, token);
    },
  };
}
export function realmLayoutRuntime(displaced = false) {
  const f = realmLayoutFixture(displaced),
    controls = reserveRealmAnchorControls(f);
  f.tx.freezeReservations();
  fillRealmLayoutFixture(f);
  controls.fill();
  requireCompletedNativeRealmObjectLayouts(f.tx, f.pack);
  f.tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  return { f, wasm, instance: () => new WebAssembly.Instance(wasm).exports as Record<string, (...args: any[]) => any> };
}

export const STATE_SOURCE = `export function makeCaptured(seed: number): (value: number) => number {
  return function captured(value: number): number { return seed + value; };
}
export function makeEmpty(): (value: number) => number {
  return function empty(value: number): number { return value + 7; };
}`;
export function realmSourceFixture(displaced = false, decoded = false) {
  const f = realmLayoutFixture(displaced),
    program = prepareGetterProgram(STATE_SOURCE, decoded);
  const projection = program.runtime[0]!,
    requirements = planNativeSourceClosureRequirements(program, projection);
  if (!requirements || requirements.units.length !== 2 || requirements.gaps.length)
    throw new Error("lost genuine source control population");
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: deriveNativeValueResourcePlan(program, projection, "native-string").anchor,
    functions: program.ir.functions,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: "wasmgc",
    target: "standalone",
  });
  const vectors = reserveNativeVectorTypes(f.tx, vectorPlan),
    carriers = { vectors, vectorPlan, realmState: f.pack };
  const source = beginNativeSourceClosureEmission(f.tx, requirements, carriers);
  return { ...f, program, projection, requirements, vectorPlan, vectors, carriers, source };
}
/** Both factory bodies and lifted bodies are lowered from the genuine retained source. */
export function realmSourceRuntime(displaced = false, decoded = false) {
  const f = realmSourceFixture(displaced, decoded),
    { tx, source, requirements } = f;
  const slots = new Map<IrUnitId, FunctionReservation>(),
    signatures = new Map<IrUnitId, PhysicalFunctionSignature>();
  for (const unit of requirements.units) {
    const shape = requirements.shapes.find((row) => row.id === unit.shapeId)!;
    const binding = source.types.closures.signatures.find((row) => row.id === shape.signatureId)!.binding;
    const signature = {
      params: [{ kind: "ref" as const, typeIdx: binding.liftedSelfTypeIndex }, ...binding.info.paramTypes],
      results: binding.info.returnType ? [binding.info.returnType] : [],
    };
    const fn = f.projection.prepared.functions.find((row) => row.unitId === unit.unitId)!;
    slots.set(unit.unitId, tx.reserveFunction(irUnitCallableBindingId(unit.unitId), fn.name, signature));
    signatures.set(unit.unitId, signature);
  }
  const factories = ["makeCaptured", "makeEmpty"].map((name) => {
    const fn = f.projection.prepared.functions.find((row) => row.name === name);
    if (!fn) throw new Error("missing source factory " + name);
    const signature = { params: name === "makeCaptured" ? [f64] : [], results: [ext] };
    const slot = tx.reserveFunction(irUnitCallableBindingId(fn.unitId), fn.name, signature);
    slots.set(fn.unitId, slot);
    signatures.set(fn.unitId, signature);
    return { fn, slot, name };
  });
  const controls = reserveRealmAnchorControls(f);
  const call = tx.reserveFunction("control:call", "controlCall", { params: [ext, f64], results: [f64] });
  const readers = requirements.shapes.map((shape) => {
    const actual = source.types.shapes.find((row) => row.id === shape.id)!;
    return {
      shape,
      actual,
      state: tx.reserveFunction("control:source-state:" + shape.id, "state" + shape.captures.length, {
        params: [ext],
        results: [ext],
      }),
    };
  });
  tx.freezeReservations();
  bindNativeSourceClosureUnits(tx, source, slots);
  fillRealmLayoutFixture(f);
  controls.fill();
  const resolver: IrLowerResolver = {
    ...nativeSourceClosureResolver(tx, source),
    resolveFunc(ref) {
      if (ref.binding.kind === "unit") {
        const slot = slots.get(ref.binding.unitId);
        if (slot) return slot.handle;
      }
      throw new Error("unexpected control callable " + ref.name);
    },
    resolveGlobal() {
      throw new Error("unexpected source global");
    },
    resolveType() {
      throw new Error("unexpected source nominal type");
    },
    internFuncType(sig) {
      return tx.internFunctionType(sig.params, sig.results);
    },
  };
  for (const [id, slot] of slots) {
    const fn = f.projection.prepared.functions.find((row) => row.unitId === id)!;
    fillPreparedPrimaryUnit(tx, fn, slot, signatures.get(id)!, resolver, "wasmgc", source);
  }
  const binding = source.types.closures.signatures[0]!.binding;
  tx.fillFunction(call, {
    locals: [],
    body: [
      ...as(0, source.types.closures.root.typeIndex),
      get(1),
      ...as(0, source.types.closures.root.typeIndex),
      { op: "struct.get", typeIdx: source.types.closures.root.typeIndex, fieldIdx: 0 },
      { op: "ref.cast", typeIdx: binding.liftedFuncTypeIndex },
      { op: "call_ref", typeIdx: binding.liftedFuncTypeIndex },
    ],
  });
  for (const { shape, actual, state } of readers) {
    tx.fillFunction(state, {
      locals: [],
      body: [
        ...as(0, actual.type.typeIndex),
        { op: "struct.get", typeIdx: actual.type.typeIndex, fieldIdx: 3 + shape.captures.length },
        { op: "extern.convert_any" },
      ],
    });
    tx.defineExport("control:export:state" + shape.captures.length, "state" + shape.captures.length, state);
  }
  for (const { slot, name } of factories) tx.defineExport("control:export:" + name, name, slot);
  tx.defineExport("control:export:call", "call", call);
  requireCompletedNativeSourceClosures(tx, source);
  requireCompletedNativeRealmObjectLayouts(tx, f.pack);
  tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  return { f, wasm, instance: () => new WebAssembly.Instance(wasm).exports as Record<string, (...args: any[]) => any> };
}
