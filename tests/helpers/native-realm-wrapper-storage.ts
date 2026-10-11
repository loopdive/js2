// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../src/wasm/model/instructions.js";
import { emitBinary } from "../../src/emit/binary.js";
import { prepareGetterProgram } from "./native-getter-invocation-fixture.js";
import { stringCreateFixture, fillStringCreateDependencies } from "./native-string-create-fixture.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
  fillNativeRealmObjectLayouts,
  requireCompletedNativeRealmObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import {
  declareNativePrimitiveWrapperLayouts,
  reserveNativePrimitiveWrapperLayouts,
} from "../../src/backend/wasmgc/resources/native-primitive-wrapper-layouts.js";
import {
  declareNativePrimitiveWrapperStorageResources,
  reserveNativePrimitiveWrapperStorageResources,
  fillNativePrimitiveWrapperStorageResources,
  requireCompletedNativePrimitiveWrapperStorage,
} from "../../src/backend/wasmgc/resources/native-primitive-wrapper-storage.js";
import {
  declareNativeStringOwnDescriptorResources,
  reserveNativeStringOwnDescriptorResources,
  fillNativeStringOwnDescriptorResources,
} from "../../src/backend/wasmgc/resources/native-string-exotic-own-descriptors.js";
import {
  declareNativeStringCreateResources,
  reserveNativeStringCreateResources,
  fillNativeStringCreateResources,
  requireCompletedNativeStringCreate,
} from "../../src/backend/wasmgc/resources/native-string-create.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { planNativeStringLiteral } from "../../src/runtime/wasmgc/values/string-literal-bodies.js";
import { PRIMITIVE_WRAPPER_KINDS as kinds } from "../../src/runtime/wasmgc/values/primitive-wrapper-layouts.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../../src/backend/wasmgc/resources/native-bigint.js";
import { reserveBigIntOperands, fillBigIntOperands } from "./native-bigint-carrier-fixture.js";
import { reserveRealmAnchorControls, ext, i32, get, as } from "./native-realm-object-layouts.js";

/** Existing genuine own-storage owners are composed; these are internal storage tests, not public ToObject. */
export function realmWrapperFixture(displaced = false) {
  const program = prepareGetterProgram("export function run(): number { return 1; }");
  const f = stringCreateFixture(displaced, displaced, 8, false, { program, additionalLiterals: [] });
  const stateDependencies = { objects: f.objects, objectPlan: f.objectPlan };
  const statePlan = declareNativeRealmObjectLayouts("stateful", f.objects.object.key, f.objects.propMap.key);
  const state = reserveNativeRealmObjectLayouts(f.tx, "stateful", stateDependencies, statePlan);
  const layoutDependencies = { ...f.layoutDependencies, realmState: state };
  const layoutPlan = declareNativePrimitiveWrapperLayouts(
    "stateful:wrappers",
    {
      object: f.objects.object.key,
      propMap: f.objects.propMap.key,
      anyString: "strings:any",
      symbol: f.symbols.types.symbol.key,
    },
    state.types.state.key,
  );
  const layouts = reserveNativePrimitiveWrapperLayouts(f.tx, "stateful:wrappers", layoutPlan, layoutDependencies);
  const wrapperDependencies = { layouts, layoutPlan, layoutDependencies };
  const wrapperPlan = declareNativePrimitiveWrapperStorageResources(
    "stateful:storage",
    { anyString: "strings:any", symbol: f.symbols.types.symbol.key },
    8,
  );
  const wrappers = reserveNativePrimitiveWrapperStorageResources(
    f.tx,
    "stateful:storage",
    wrapperPlan,
    wrapperDependencies,
  );
  const ownDependencies = { ...wrapperDependencies, lookup: f.lookup, lookupDependencies: f.lookupDependencies };
  const ownPlan = declareNativeStringOwnDescriptorResources("stateful:own", {
    object: f.objects.object.key,
    propEntry: f.objects.propEntry.key,
  });
  const own = reserveNativeStringOwnDescriptorResources(f.tx, "stateful:own", ownPlan, ownDependencies);
  const createDependencies = {
    ...f.createDependencies,
    ...wrapperDependencies,
    ownDescriptors: own,
    ownDescriptorDependencies: ownDependencies,
  };
  const createPlan = declareNativeStringCreateResources("stateful:create", "strings:any", 8);
  const create = reserveNativeStringCreateResources(f.tx, "stateful:create", createPlan, createDependencies);
  return {
    f,
    state,
    stateDependencies,
    statePlan,
    layoutDependencies,
    layoutPlan,
    layouts,
    wrappers,
    wrapperDependencies,
    wrapperPlan,
    own,
    ownDependencies,
    create,
    createDependencies,
  };
}
export function realmWrapperRuntime(displaced = false) {
  const r = realmWrapperFixture(displaced),
    { f } = r,
    { tx } = f;
  const controls = reserveRealmAnchorControls({ tx, pack: r.state });
  const bigint = reserveNativeBigIntResources(tx, "control:bigint", declareNativeBigIntResources("control:bigint"));
  const bigintOperands = reserveBigIntOperands(tx);
  const text = displaced ? "é😀" : "abc";
  const literal = planNativeStringLiteral(f.strings.layout, displaced, text, displaced ? "utf8-guaranteed" : "wtf16");
  if (literal.kind !== "global") throw new Error("control literal unexpectedly requires chunks");
  const payload = tx.reserveGlobal(
    "control:string-payload",
    "controlStringPayload",
    { kind: "ref", typeIdx: literal.refTypeIdx },
    false,
  );
  const states = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      tx.reserveFunction("control:wrapper-state:" + kind, "state" + kind, { params: [ext], results: [ext] }),
    ]),
  );
  const prefix = tx.reserveFunction("control:prefix-null", "prefixNull", { params: [ext], results: [i32] });
  const ownValue = tx.reserveFunction("control:own-value", "ownValue", { params: [ext, ext], results: [ext] });
  const ownFlags = tx.reserveFunction("control:own-flags", "ownFlags", { params: [ext, ext], results: [i32] });
  const ownSequence = tx.reserveFunction("control:own-sequence", "ownSequence", { params: [ext, ext], results: [i32] });
  const ownCount = tx.reserveFunction("control:own-count", "ownCount", { params: [ext], results: [i32] });
  const nextSequence = tx.reserveFunction("control:next-sequence", "nextSequence", { params: [ext], results: [i32] });
  const isUtf8 = tx.reserveFunction("control:is-utf8", "isUtf8", { params: [ext], results: [i32] });
  const length = tx.reserveFunction("control:string-length", "stringLength", { params: [ext], results: [i32] });
  const codeUnit = tx.reserveFunction("control:string-code-unit", "codeUnit", { params: [ext, i32], results: [i32] });
  const keys = Object.fromEntries(
    ["length", "0", "1", "2"].map((value) => [value, requireNativeStringLiteral(tx, f.strings, value)]),
  );
  tx.freezeReservations();
  fillStringCreateDependencies(f);
  fillNativeStringCreateResources(tx, f.create);
  fillNativeRealmObjectLayouts(tx, r.state);
  fillNativePrimitiveWrapperStorageResources(tx, r.wrappers);
  fillNativeStringOwnDescriptorResources(tx, r.own);
  fillNativeStringCreateResources(tx, r.create);
  fillNativeBigIntResources(tx, bigint);
  fillBigIntOperands(tx, bigint, bigintOperands);
  controls.fill();
  tx.fillGlobal(payload, literal.init);
  tx.defineExport("control:export:payload", "payload", payload);
  for (const [key, binding] of Object.entries(keys)) {
    if (binding.kind !== "global") throw new Error("small key lost literal binding");
    tx.defineExport("control:export:key:" + key, "key" + key, binding.global);
  }
  for (const kind of kinds) {
    tx.fillFunction(states[kind]!, {
      locals: [],
      body: [
        ...as(0, r.layouts.types[kind].typeIndex),
        { op: "struct.get", typeIdx: r.layouts.types[kind].typeIndex, fieldIdx: 7 },
        { op: "extern.convert_any" },
      ],
    });
    for (const [name, token] of Object.entries({
      ["new" + kind]: r.wrappers.allocation[kind],
      ["read" + kind]: r.wrappers.read[kind],
      ["state" + kind]: states[kind]!,
    }))
      tx.defineExport("control:export:" + name, name, token);
  }
  tx.fillFunction(prefix, {
    locals: [],
    body: [
      ...as(0, f.objects.object.typeIndex),
      { op: "struct.get", typeIdx: f.objects.object.typeIndex, fieldIdx: 0 },
      { op: "ref.is_null" },
    ],
  });
  for (const [fieldIdx, token] of [
    [1, ownValue],
    [2, ownFlags],
    [3, ownSequence],
  ] as const)
    tx.fillFunction(token, {
      locals: [],
      body: [
        ...as(0, f.objects.object.typeIndex),
        get(1),
        { op: "call", funcIdx: r.own.findOwn.handle },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: f.objects.propEntry.typeIndex, fieldIdx },
        ...(fieldIdx === 1 ? [{ op: "extern.convert_any" } as Instr] : []),
      ],
    });
  for (const [fieldIdx, token] of [
    [2, ownCount],
    [5, nextSequence],
  ] as const)
    tx.fillFunction(token, {
      locals: [],
      body: [...as(0, f.objects.object.typeIndex), { op: "struct.get", typeIdx: f.objects.object.typeIndex, fieldIdx }],
    });
  tx.fillFunction(isUtf8, {
    locals: [],
    body: displaced
      ? [get(0), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: f.strings.layout.utf8StrTypeIdx }]
      : [{ op: "i32.const", value: 0 }],
  });
  tx.fillFunction(length, {
    locals: [],
    body: [...as(0, f.anyString), { op: "struct.get", typeIdx: f.anyString, fieldIdx: 0 }],
  });
  tx.fillFunction(codeUnit, {
    locals: [{ name: "flat", type: { kind: "ref", typeIdx: f.flatString } }],
    body: [
      ...as(0, f.anyString),
      { op: "call", funcIdx: f.flatten.flatten.handle },
      { op: "local.set", index: 2 },
      get(2),
      { op: "struct.get", typeIdx: f.flatString, fieldIdx: 2 },
      get(2),
      { op: "struct.get", typeIdx: f.flatString, fieldIdx: 1 },
      get(1),
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: f.dataString },
    ],
  });
  for (const [name, token] of Object.entries({
    prefix,
    ownValue,
    ownFlags,
    ownSequence,
    ownCount,
    nextSequence,
    isUtf8,
    length,
    codeUnit,
    stringCreate: r.create.create,
    unbox: f.values.functions.unboxNumber,
    symbol: f.symbols.functions.box,
    wideBigInt: bigintOperands.wide96one!,
  }))
    tx.defineExport("control:export:" + name, name, token);
  requireCompletedNativeRealmObjectLayouts(tx, r.state);
  requireCompletedNativePrimitiveWrapperStorage(tx, r.wrappers, r.wrapperPlan, r.wrapperDependencies);
  requireCompletedNativeStringCreate(tx, r.create, r.createDependencies);
  tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  return { r, wasm, api: new WebAssembly.Instance(wasm).exports as Record<string, any>, text };
}
