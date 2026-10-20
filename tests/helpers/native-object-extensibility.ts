// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mixedOwnerFixture, reserveMixedOwner, fillMixedDependencies } from "./native-mixed-object-access.js";
import { reserveBigIntOperands, fillBigIntOperands } from "./native-bigint-carrier-fixture.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../../src/backend/wasmgc/resources/native-bigint.js";
import {
  reserveNativeBooleanBoxResources,
  fillNativeBooleanBoxResources,
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../../src/backend/wasmgc/resources/native-booleans.js";
import {
  declareNativeNumberPrimitiveClassifierResources,
  reserveNativeNumberPrimitiveClassifierResources,
  fillNativeNumberPrimitiveClassifierResources,
} from "../../src/backend/wasmgc/resources/native-number-primitive-classifier.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
} from "../../src/backend/wasmgc/resources/native-errors.js";
import { fillNativeObjectRealmDeclarations } from "../../src/backend/wasmgc/resources/native-object-realm.js";
import { fillNativeMixedObjectAccessStructure } from "../../src/backend/wasmgc/resources/native-mixed-object-access.js";
import {
  reserveNativeObjectExtensibilityAlgorithms,
  fillNativeObjectExtensibilityAlgorithms,
  requireCompletedNativeObjectExtensibilityAlgorithms,
  reserveNativeObjectSetPrototypeAlgorithm,
  fillNativeObjectSetPrototypeAlgorithm,
  requireCompletedNativeObjectSetPrototypeAlgorithm,
  reserveNativeObjectPrototypeSetterAlgorithm,
  fillNativeObjectPrototypeSetterAlgorithm,
  requireCompletedNativeObjectPrototypeSetterAlgorithm,
} from "../../src/backend/wasmgc/resources/native-object-structural-algorithms.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { buildUndefinedInitializer } from "../../src/runtime/wasmgc/values/primitive-layouts.js";
import {
  reachableFunctionPositions,
  stubUnreachableFunctions,
  stubsReachedAfterFinalize,
} from "../../src/codegen/function-reachability-sweep.js";
import { emitBinary } from "../../src/emit/binary.js";
import { as, get, ext, i32 } from "./native-realm-object-layouts.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { setImmediate } from "node:timers/promises";

export function objectExtensibilityFixture(
  displaced = false,
  decoded = false,
  mode: "interned" | "allocating" = "interned",
  includeSetPrototype = false,
  includePrototypeSetter = false,
) {
  const r = mixedOwnerFixture(displaced, decoded),
    { tx } = r;
  const mixed = reserveMixedOwner(r);
  const bigintPlan = declareNativeBigIntResources("extensibility:bigint");
  const bigints = reserveNativeBigIntResources(tx, "extensibility:bigint", bigintPlan);
  const booleans = reserveNativeBooleanResources(
    tx,
    "extensibility:booleans",
    r.values,
    r.valuePlan,
    r.valueDependencies,
  );
  const primitiveDependencies = {
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
    booleans,
    bigints,
    bigintPlan,
    strings: r.f.strings,
    symbols: r.symbols,
  };
  const primitivePlan = declareNativeNumberPrimitiveClassifierResources("extensibility:primitives");
  const primitives = reserveNativeNumberPrimitiveClassifierResources(
    tx,
    "extensibility:primitives",
    primitivePlan,
    primitiveDependencies,
  );
  const booleanBoxes = reserveNativeBooleanBoxResources(
    tx,
    "extensibility:boolean",
    r.values,
    r.valuePlan,
    r.valueDependencies,
    mode,
  );
  const errorRequirements = { key: "extensibility:errors" },
    errorDependencies = { strings: r.f.strings, typeErrorTag: -11 };
  const errors = reserveNativeErrorResources(tx, errorRequirements, errorDependencies);
  const algorithmDependencies = {
    mixed,
    mixedDependencies: r.dependencies,
    primitives,
    primitivePlan,
    primitiveDependencies,
    booleanBoxes,
    errors,
    errorRequirements,
    errorDependencies,
  };
  const algorithms = reserveNativeObjectExtensibilityAlgorithms(tx, algorithmDependencies);
  const prototypeAlgorithm = includeSetPrototype
    ? reserveNativeObjectSetPrototypeAlgorithm(tx, algorithmDependencies)
    : undefined;
  if (includePrototypeSetter && !includeSetPrototype) throw Error("setter fixture requires the structural controls");
  const prototypeSetter = includePrototypeSetter
    ? reserveNativeObjectPrototypeSetterAlgorithm(tx, algorithmDependencies)
    : undefined;
  return {
    ...r,
    mixed,
    bigints,
    bigintPlan,
    booleans,
    primitives,
    primitivePlan,
    primitiveDependencies,
    booleanBoxes,
    errors,
    errorRequirements,
    errorDependencies,
    algorithmDependencies,
    algorithms,
    prototypeAlgorithm,
    prototypeSetter,
  };
}
export function fillObjectExtensibilityDependencies(r: ReturnType<typeof objectExtensibilityFixture>) {
  if (r.tx.state === "reserving") r.tx.freezeReservations();
  fillMixedDependencies(r);
  fillNativeObjectRealmDeclarations(r.tx, r.realm.declarations);
  fillNativeMixedObjectAccessStructure(r.tx, r.mixed);
  fillNativeBigIntResources(r.tx, r.bigints);
  fillNativeBooleanResources(r.tx, r.booleans);
  fillNativeNumberPrimitiveClassifierResources(r.tx, r.primitives);
  fillNativeBooleanBoxResources(r.tx, r.booleanBoxes);
  fillNativeErrorResources(r.tx, r.errors);
}
const n = (value: number): Instr => ({ op: "i32.const", value });
const global = (index: number): Instr => ({ op: "global.get", index });
/** Execute the ACTUAL producer's slots. A cloned, reachability-checked component
 * snapshot omits dead catalog bodies using the existing compiler sweep. The real
 * ledger remains unsealed/incomplete, and no missing production slot is filled.
 */
export function objectExtensibilityRuntime(
  displaced = false,
  decoded = false,
  mode: "interned" | "allocating" = "interned",
  includeSetPrototype = false,
  includePrototypeSetter = false,
) {
  const steps = objectExtensibilityRuntimeSteps(displaced, decoded, mode, includeSetPrototype, includePrototypeSetter);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Same real checks/emission as the synchronous API. Service runner IPC between
 * expensive phases without changing hook/case/RPC deadlines or skipping work.
 */
export async function objectExtensibilityRuntimeAsync(
  displaced = false,
  decoded = false,
  mode: "interned" | "allocating" = "interned",
  includeSetPrototype = false,
  includePrototypeSetter = false,
) {
  const steps = objectExtensibilityRuntimeSteps(displaced, decoded, mode, includeSetPrototype, includePrototypeSetter);
  const synchronousPhaseMs: number[] = [];
  for (;;) {
    const start = performance.now(),
      step = steps.next();
    synchronousPhaseMs.push(performance.now() - start);
    if (step.done) {
      console.info(
        "component scheduling",
        JSON.stringify({ displaced, decoded, mode, includePrototypeSetter, synchronousPhaseMs }),
      );
      return step.value;
    }
    await setImmediate();
  }
}

function* objectExtensibilityRuntimeSteps(
  displaced = false,
  decoded = false,
  mode: "interned" | "allocating" = "interned",
  includeSetPrototype = false,
  includePrototypeSetter = false,
) {
  const r = objectExtensibilityFixture(displaced, decoded, mode, includeSetPrototype, includePrototypeSetter),
    { tx, f } = r;
  const selectedEntries = [
    ...r.algorithms.entries,
    ...(r.prototypeAlgorithm?.entries ?? []),
    ...(r.prototypeSetter?.entries ?? []),
  ];
  const bigintOperands = reserveBigIntOperands(tx);
  const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
    initialize: { params: [], results: [] },
    ordinary: { params: [i32], results: [ext] },
    flags: { params: [ext], results: [i32] },
    setFlags: { params: [ext, i32], results: [] },
    clearRealm: { params: [], results: [] },
    undefinedCopy: { params: [], results: [ext] },
    native: { params: [i32, i32], results: [ext] },
    clearBag: { params: [ext], results: [] },
    text: { params: [], results: [ext] },
    undefinedValue: { params: [], results: [ext] },
    readBoolean: { params: [ext], results: [i32] },
    errorTag: { params: [ext], results: [i32] },
    preventionFalseControl: {
      params: [ext, { kind: "ref", typeIdx: f.substrate.arguments.carrier.typeIndex }],
      results: [ext],
    },
    stored0: { params: [ext, ext, { kind: "ref", typeIdx: f.substrate.arguments.carrier.typeIndex }], results: [ext] },
    stored1: { params: [ext, ext, { kind: "ref", typeIdx: f.substrate.arguments.carrier.typeIndex }], results: [ext] },
    ...(includeSetPrototype
      ? {
          stored2: {
            params: [ext, ext, { kind: "ref" as const, typeIdx: f.substrate.arguments.carrier.typeIndex }],
            results: [ext],
          },
          corruptParent: { params: [ext, ext], results: [] },
          fakePrefix: { params: [ext, ext], results: [] },
          native2: { params: [i32, i32], results: [ext] },
        }
      : {}),
    ...(includePrototypeSetter
      ? {
          stored3: {
            params: [ext, ext, { kind: "ref" as const, typeIdx: f.substrate.arguments.carrier.typeIndex }],
            results: [ext],
          },
          native3: { params: [i32, i32], results: [ext] },
        }
      : {}),
  };
  const controls = Object.fromEntries(
    Object.entries(signatures).map(([name, signature]) => [
      name,
      tx.reserveFunction("extensibility:control:" + name, name, signature),
    ]),
  );
  const sourceShape = r.c.source!.types.shapes[0]!;
  const sourceControl = tx.reserveFunction("extensibility:source", "unreadySource", { params: [], results: [ext] });
  const sourceReq = r.c.source!.requirements.shapes.find((row) => row.id === sourceShape.id)!;
  const sourceBinding = r.c.source!.types.closures.signatures.find((row) => row.id === sourceReq.signatureId)!.binding;
  const sourceLifted = tx.reserveFunction("extensibility:source-lifted", "unreadySourceLifted", {
    params: [{ kind: "ref", typeIdx: sourceBinding.liftedSelfTypeIndex }, ...sourceBinding.info.paramTypes],
    results: sourceBinding.info.returnType ? [sourceBinding.info.returnType] : [],
  });
  const completed = new Set<object>(),
    fill = tx.fillFunction.bind(tx);
  tx.fillFunction = (token, definition) => {
    fill(token, definition);
    completed.add(token.object);
  };
  yield;
  fillObjectExtensibilityDependencies(r);
  yield;
  fillNativeObjectExtensibilityAlgorithms(tx, r.algorithms);
  requireCompletedNativeObjectExtensibilityAlgorithms(tx, r.algorithms);
  yield;
  if (r.prototypeAlgorithm) {
    fillNativeObjectSetPrototypeAlgorithm(tx, r.prototypeAlgorithm);
    requireCompletedNativeObjectSetPrototypeAlgorithm(tx, r.prototypeAlgorithm);
  }
  yield;
  if (r.prototypeSetter) {
    fillNativeObjectPrototypeSetterAlgorithm(tx, r.prototypeSetter);
    requireCompletedNativeObjectPrototypeSetterAlgorithm(tx, r.prototypeSetter);
  }
  yield;
  // Exercise the real prevention algorithm's false branch with the genuine
  // IsExtensible result of a non-extensible object. This derivative is a named
  // test control, never filled into a catalog slot or accepted by its owner.
  const falseDefinition = structuredClone({
    locals: r.algorithms.entries[1]!.algorithm.object.locals,
    body: r.algorithms.entries[1]!.algorithm.object.body,
  });
  let replaced = 0;
  for (const instruction of falseDefinition.body)
    if (instruction.op === "call" && instruction.funcIdx === r.mixed.preventExtensions.handle) {
      instruction.funcIdx = r.mixed.isExtensible.handle;
      replaced++;
    }
  if (replaced !== 1) throw Error("lost actual prevention status branch control");
  tx.fillFunction(controls.preventionFalseControl!, falseDefinition);
  fillBigIntOperands(tx, r.bigints, bigintOperands);
  const call = (handle: number): Instr => ({ op: "call", funcIdx: handle });
  const realm = tx.physicalIndex(f.pack.anchors.realm);
  const prefix = (): Instr[] => [
    { op: "ref.null", typeIdx: f.objects.object.typeIndex },
    n(8),
    { op: "array.new_default", typeIdx: f.objects.propMap.typeIndex },
    n(0),
    n(0),
    n(128),
    n(0),
  ];
  const state = (foreign = false): Instr[] => [
    { op: "ref.null.extern" },
    ...(foreign
      ? [{ op: "struct.new", typeIdx: f.pack.types.identity.typeIndex } as Instr]
      : [global(realm), { op: "ref.as_non_null" } as Instr]),
    { op: "struct.new", typeIdx: f.pack.types.state.typeIndex },
  ];
  const text = (value: string, external = true): Instr[] => {
    const literal = requireNativeStringLiteral(tx, f.strings, value);
    return [
      literal.kind === "global" ? global(tx.physicalIndex(literal.global)) : call(literal.function.handle),
      ...(external ? [{ op: "extern.convert_any" } as Instr] : []),
    ];
  };
  tx.fillFunction(controls.initialize!, {
    locals: [],
    body: [
      { op: "struct.new", typeIdx: f.pack.types.identity.typeIndex },
      { op: "global.set", index: realm },
      ...prefix(),
      { op: "struct.new", typeIdx: f.pack.types.objectPrototype.typeIndex },
      { op: "global.set", index: tx.physicalIndex(r.realm.declarations.objectPrototype.singleton) },
      ...selectedEntries.flatMap((entry): Instr[] => [
        { op: "ref.func", funcIdx: entry.lifted.handle },
        n(entry.request.intrinsic.callable.length),
        call(r.storage.createNull.handle),
        n(0),
        n(entry.metadata.metadata.id),
        { op: "ref.null.extern" },
        global(realm),
        { op: "ref.as_non_null" },
        ...text(entry.request.intrinsic.callable.initialName, false),
        { op: "struct.new", typeIdx: entry.type.typeIndex },
        { op: "global.set", index: tx.physicalIndex(entry.singleton) },
      ]),
    ],
  });
  if (includeSetPrototype) {
    tx.fillFunction(controls.corruptParent!, {
      locals: [],
      body: [
        ...as(0, f.pack.types.ordinary.typeIndex),
        { op: "struct.get", typeIdx: f.pack.types.ordinary.typeIndex, fieldIdx: 6 },
        get(1),
        { op: "struct.set", typeIdx: f.pack.types.state.typeIndex, fieldIdx: 0 },
      ],
    });
    tx.fillFunction(controls.fakePrefix!, {
      locals: [],
      body: [
        ...as(0, f.objects.object.typeIndex),
        get(1),
        { op: "any.convert_extern" },
        { op: "ref.cast_null", typeIdx: f.objects.object.typeIndex },
        { op: "struct.set", typeIdx: f.objects.object.typeIndex, fieldIdx: 0 },
      ],
    });
  }
  tx.fillFunction(controls.ordinary!, {
    locals: [],
    body: [
      ...prefix(),
      get(0),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "ref", typeIdx: f.pack.types.state.typeIndex } },
        then: state(true),
        else: state(),
      },
      { op: "struct.new", typeIdx: f.pack.types.ordinary.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(controls.flags!, {
    locals: [],
    body: [
      ...as(0, f.objects.object.typeIndex),
      { op: "struct.get", typeIdx: f.objects.object.typeIndex, fieldIdx: 4 },
    ],
  });
  tx.fillFunction(controls.setFlags!, {
    locals: [],
    body: [
      ...as(0, f.objects.object.typeIndex),
      get(1),
      { op: "struct.set", typeIdx: f.objects.object.typeIndex, fieldIdx: 4 },
    ],
  });
  tx.fillFunction(controls.clearRealm!, {
    locals: [],
    body: [
      { op: "ref.null", typeIdx: f.pack.types.identity.typeIndex },
      { op: "global.set", index: realm },
    ],
  });
  tx.fillFunction(controls.undefinedCopy!, {
    locals: [],
    body: [...buildUndefinedInitializer(r.values.types.anyValue.typeIndex), { op: "extern.convert_any" }],
  });
  tx.fillFunction(controls.undefinedValue!, {
    locals: [],
    body: [global(tx.physicalIndex(r.values.globals.undefined)), { op: "extern.convert_any" }],
  });
  tx.fillFunction(controls.text!, { locals: [], body: text("name") });
  tx.fillFunction(controls.readBoolean!, {
    locals: [],
    body: [
      ...as(0, r.values.types.boxedBoolean.typeIndex),
      { op: "struct.get", typeIdx: r.values.types.boxedBoolean.typeIndex, fieldIdx: 0 },
    ],
  });
  const entry = r.algorithms.entries[0]!;
  tx.fillFunction(controls.native!, {
    locals: [],
    body: [
      { op: "ref.func", funcIdx: entry.lifted.handle },
      n(1),
      call(r.storage.createNull.handle),
      n(0),
      get(0),
      { op: "ref.null.extern" },
      global(realm),
      { op: "ref.as_non_null" },
      ...text("name", false),
      { op: "struct.new", typeIdx: entry.type.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  for (const [entry, control] of [
    ...(r.prototypeAlgorithm ? [[r.prototypeAlgorithm.entries[0]!, controls.native2!] as const] : []),
    ...(r.prototypeSetter ? [[r.prototypeSetter.entries[0]!, controls.native3!] as const] : []),
  ]) {
    tx.fillFunction(control, {
      locals: [],
      body: [
        { op: "ref.func", funcIdx: entry.lifted.handle },
        n(entry.request.intrinsic.callable.length),
        call(r.storage.createNull.handle),
        n(0),
        get(0),
        { op: "ref.null.extern" },
        get(1),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref", typeIdx: f.pack.types.identity.typeIndex } },
          then: [{ op: "struct.new", typeIdx: f.pack.types.identity.typeIndex }],
          else: [global(realm), { op: "ref.as_non_null" }],
        },
        ...text("name", false),
        { op: "struct.new", typeIdx: entry.type.typeIndex },
        { op: "extern.convert_any" },
      ],
    });
  }
  tx.fillFunction(controls.clearBag!, {
    locals: [],
    body: [
      ...as(0, entry.type.typeIndex),
      { op: "ref.null.extern" },
      { op: "struct.set", typeIdx: entry.type.typeIndex, fieldIdx: 2 },
    ],
  });
  // A real typed source carrier deliberately remains unadmitted by the mixed owner.
  tx.fillFunction(sourceLifted, { locals: [], body: [{ op: "unreachable" }] });
  tx.declareFunctionReference(sourceLifted);
  const captured: Instr[] = sourceReq.captures.map(() => ({ op: "f64.const", value: 0 }));
  tx.fillFunction(sourceControl, {
    locals: [],
    body: [
      { op: "ref.func", funcIdx: sourceLifted.handle },
      n(1),
      { op: "ref.null.extern" },
      ...captured,
      ...state(),
      { op: "struct.new", typeIdx: sourceShape.type.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(controls.errorTag!, {
    locals: [],
    body: [...as(0, r.errors.type.typeIndex), { op: "struct.get", typeIdx: r.errors.type.typeIndex, fieldIdx: 0 }],
  });
  for (const [index, key] of (includePrototypeSetter
    ? ["stored0", "stored1", "stored2", "stored3"]
    : includeSetPrototype
      ? ["stored0", "stored1", "stored2"]
      : ["stored0", "stored1"]
  ).entries())
    tx.fillFunction(controls[key]!, {
      locals: [],
      body: [
        ...as(0, r.c.closures.root.typeIndex),
        get(1),
        get(2),
        ...as(0, r.c.closures.root.typeIndex),
        { op: "struct.get", typeIdx: r.c.closures.root.typeIndex, fieldIdx: 0 },
        { op: "ref.cast", typeIdx: selectedEntries[index]!.metadata.signature.liftedFuncTypeIndex },
        { op: "call_ref", typeIdx: selectedEntries[index]!.metadata.signature.liftedFuncTypeIndex },
      ],
    });
  tx.defineExport("extensibility:export:exception", "exception", r.realm.declarations.exception.tag);
  const storedCalls = selectedEntries.map((entry, index) => {
    // Existing signature must have been interned before freeze; this is a direct
    // exported genuine lifted entry, with self supplied by the test observer.
    tx.defineExport("extensibility:export:lifted:" + index, "lifted" + index, entry.lifted);
    tx.defineExport("extensibility:export:singleton:" + index, "singleton" + index, entry.singleton);
    tx.defineExport("extensibility:export:algorithm:" + index, "algorithm" + index, entry.algorithm);
    return entry;
  });
  for (const [name, token] of Object.entries({
    ...controls,
    source: sourceControl,
    ...bigintOperands,
    boxNumber: r.values.functions.boxNumber,
    isPrimitive: r.primitives.isPrimitive,
    boxBoolean: r.booleanBoxes.boxBoolean,
    symbol: r.symbols.functions.box,
    newVector: f.substrate.arguments.newVector,
    push: f.substrate.arguments.push,
    newBoolean: r.wrappers.allocation.Boolean,
    newNumber: r.wrappers.allocation.Number,
    newSymbol: r.wrappers.allocation.Symbol,
    newBigInt: r.wrappers.allocation.BigInt,
    newString: r.stringCreate.create,
    objectPrototype: r.realm.declarations.objectPrototype.singleton,
    ...(includeSetPrototype
      ? { getPrototypeOf: r.mixed.getPrototypeOf, internalSetPrototypeOf: r.mixed.setPrototypeOf }
      : {}),
  }))
    tx.defineExport("extensibility:export:" + name, name, token);
  yield;
  const live = reachableFunctionPositions(f.module),
    liveNames = f.module.functions.filter((_, i) => live[i]).map((fn) => fn.name);
  const unfilledReachable = f.module.functions.filter((fn, i) => live[i] && !completed.has(fn));
  if (unfilledReachable.length)
    throw Error("unfilled component dependency: " + unfilledReachable.map((fn) => fn.name).join(", "));
  if (
    liveNames.length < 20 ||
    !storedCalls.every(
      (entry) => liveNames.includes(entry.algorithm.object.name) && liveNames.includes(entry.lifted.object.name),
    )
  )
    throw Error("component reachability floor lost");
  // Sweep ONLY a clone; never fill dead production obligations or certify sealing.
  const snapshot = structuredClone(f.module),
    stubbed = stubUnreachableFunctions(snapshot, live);
  if (!stubbed || stubsReachedAfterFinalize(snapshot).length) throw Error("invalid component sweep");
  yield;
  const bytes = emitBinary(snapshot),
    wasm = new WebAssembly.Module(bytes as BufferSource);
  const api = new WebAssembly.Instance(wasm).exports as Record<string, any>;
  const vector = (values: readonly unknown[]) => {
    const v = api.newVector();
    for (const value of values) api.push(v, value);
    return v;
  };
  return { r, wasm, bytes, api, vector, liveNames, stubbed, wholeRealmCompleted: false as const };
}
