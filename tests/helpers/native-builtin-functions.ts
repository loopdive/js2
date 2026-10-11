// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import { emitBinary } from "../../src/emit/binary.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { deriveNativeObjectAccessRequirements } from "../../src/ir/program/native-object-access-requirements.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../../src/backend/wasmgc/resources/native-values.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../../src/backend/wasmgc/resources/native-booleans.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../../src/backend/wasmgc/resources/native-bigint.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringEqualityResources,
  fillNativeStringEqualityResources,
} from "../../src/backend/wasmgc/resources/native-string-equality.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
} from "../../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
} from "../../src/backend/wasmgc/resources/native-symbol-carrier.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-object-layouts.js";
import { declareNativeObjectLookupResources } from "../../src/backend/wasmgc/resources/native-object-access-declarations.js";
import {
  reserveNativeObjectLookupResources,
  fillNativeObjectLookupResources,
} from "../../src/backend/wasmgc/resources/native-object-access.js";
import {
  declareNativeObjectStorageResources,
  reserveNativeObjectStorageResources,
  fillNativeObjectStorageResources,
} from "../../src/backend/wasmgc/resources/native-object-storage.js";
import {
  declareNativeObjectSameValueResources,
  reserveNativeObjectSameValueResources,
  fillNativeObjectSameValueResources,
} from "../../src/backend/wasmgc/resources/native-object-same-value.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
} from "../../src/backend/wasmgc/resources/native-errors.js";
import { buildBuiltinClosureValueInstrs } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import {
  NATIVE_OBJECT_DESCRIPTOR_LITERALS,
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  fillNativeObjectDescriptorResources,
} from "../../src/backend/wasmgc/resources/native-object-descriptors.js";

import { descriptorSource } from "./native-descriptor-fixture.js";
import { deriveNativeVectorResourcePlan } from "../../src/ir/program/native-vector-resources.js";
import { reserveNativeVectorTypes } from "../../src/backend/wasmgc/resources/native-vectors.js";
import { createVectorBaseType } from "../../src/runtime/wasmgc/values/vector-grow-store.js";
import {
  declareNativeArgumentVectorResources,
  reserveNativeArgumentVectorResources,
  fillNativeArgumentVectorResources,
} from "../../src/backend/wasmgc/resources/native-argument-vectors.js";
import {
  declareNativeBuiltinFunctionResources,
  reserveNativeBuiltinFunctionResources,
  fillNativeBuiltinFunctionResources,
  requireCompletedNativeBuiltinFunctionKernel,
} from "../../src/backend/wasmgc/resources/native-builtin-functions.js";
import {
  NATIVE_BUILTIN_FUNCTION_LITERALS,
  type NativeBuiltinFunctionRequirements,
} from "../../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import { planNativeSourceClosureRequirements } from "../../src/ir/program/native-source-closure-requirements.js";
import {
  beginNativeSourceClosureEmission,
  bindNativeSourceClosureUnits,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
} from "../../src/ir/program-native-invocation.js";
import { irUnitCallableBindingId } from "../../src/ir/core/callable-bindings.js";
import type { IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import type { FunctionReservation, PhysicalFunctionSignature } from "../../src/wasm/physical/module-reservations.js";
import type { IrLowerResolver } from "../../src/ir/backend/lower-contracts.js";
import {
  reserveBuiltinTransportControls,
  fillBuiltinTransportControls,
} from "./native-builtin-function-transport-controls.js";
import { reserveBuiltinStringControl, fillBuiltinStringControl } from "./native-builtin-function-string-control.js";
const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
export const BUILTIN_TEST_KEYS = [
  "x",
  "prototype",
  "length",
  "name",
  "00",
  "0",
  "2",
  "2147483648",
  "4294967294",
  "4294967295",
  ...Array.from({ length: 24 }, (_, i) => "added" + i),
];
export function builtinRequirements(): NativeBuiltinFunctionRequirements {
  return {
    key: "builtins",
    intrinsics: [
      {
        id: "function-prototype",
        behavior: "function-prototype",
        signatureId: "builtin:function-signature",
        metadataId: "builtin:function-metadata",
        initialName: "",
        initialLength: 0,
        userFormalCount: 0,
        prototype: "object-prototype",
        constructible: false,
        aliases: ["%Function.prototype%", "functionPrototype"],
      },
      {
        id: "throw-type-error",
        behavior: "throw-type-error",
        signatureId: "builtin:throw-signature",
        metadataId: "builtin:throw-metadata",
        initialName: "",
        initialLength: 0,
        userFormalCount: 0,
        prototype: "function-prototype",
        constructible: false,
        aliases: ["%ThrowTypeError%"],
      },
    ],
  };
}
export function builtinFunctionFixture(
  offset = false,
  reserveKernel = true,
  selectedSource = descriptorSource(),
  extensibleOrdinary = false,
) {
  const { program, projection } = selectedSource;
  const access = deriveNativeObjectAccessRequirements(program, projection);
  const valuePlan = deriveNativeValueResourcePlan(program, projection, "native-string");
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (offset) {
    tx.reserveType("prefix:rec", {
      kind: "rec",
      types: [
        { kind: "struct", name: "Prefix0", fields: [] },
        { kind: "struct", name: "Prefix1", fields: [{ name: "n", type: i32, mutable: false }] },
      ],
    });
    tx.internFunctionType([i32], [i32], "prefix:signature");
    tx.reserveTag("prefix:tag", { params: [i32], results: [] }, { kind: "defined", name: "prefix" });
    const prefix = tx.reserveFunction("prefix:function", "prefix", { params: [], results: [] });
    const global = tx.reserveGlobal("prefix:global", "prefix", i32, false);
    // Filled only after the shared freeze; no external imports or providers.
    prefixTokens.set(tx, { prefix, global });
  }
  const texts = [
    ...new Set([
      "",
      "TypeError",
      "value",
      "other",
      "missing",
      ...NATIVE_OBJECT_DESCRIPTOR_LITERALS,
      ...NATIVE_BUILTIN_FUNCTION_LITERALS,
      ...BUILTIN_TEST_KEYS,
    ]),
  ];
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: [
      ...texts.map((value) => ({ value, encoding: offset ? ("utf8-guaranteed" as const) : ("wtf16" as const) })),
      // Flattening owns a distinct UTF16 empty-result sentinel. Builtin literals
      // above remain first and use actual UTF8 carriers in the displaced fixture.
      ...(offset ? [{ value: "", encoding: "wtf16" as const }] : []),
    ],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings);
  const equality = reserveNativeStringEqualityResources(tx, "equality", flatten, true);
  const scanner = reserveNativeStringNumberResources(tx, valuePlan, flatten);
  const valueDependencies = { strings: { kind: "native-string" as const, stringPack: strings, scanner } };
  const values = reserveNativeValueResources(tx, valuePlan, valueDependencies);
  const booleans = reserveNativeBooleanResources(tx, "booleans", values, valuePlan, valueDependencies);
  const bigintPlan = declareNativeBigIntResources("bigints");
  const bigints = reserveNativeBigIntResources(tx, "bigints", bigintPlan);
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const layoutRequirements = { key: "objects", ...(extensibleOrdinary ? { extensible: true as const } : {}) },
    layoutPlan = declareNativeObjectLayouts(layoutRequirements);
  const layouts = reserveNativeObjectLayouts(tx, layoutRequirements, layoutPlan);
  const lookupDependencies = { layouts, layoutPlan, strings, flatten, equality, symbols };
  const lookupPlan = declareNativeObjectLookupResources("lookup", {
    object: layouts.object.key,
    propEntry: layouts.propEntry.key,
    nativeString: "strings:flat",
  });
  const lookup = reserveNativeObjectLookupResources(tx, "lookup", lookupDependencies, lookupPlan);
  const storageDependencies = { lookup, lookupDependencies };
  const storagePlan = declareNativeObjectStorageResources("storage", layouts.object.key);
  const storage = reserveNativeObjectStorageResources(tx, "storage", storageDependencies, storagePlan);
  const sameValueDependencies = {
    values,
    valuePlan,
    valueDependencies,
    booleans,
    bigints,
    bigintPlan,
    strings,
    flatten,
    equality,
  };
  const sameValuePlan = declareNativeObjectSameValueResources("same-value");
  const sameValue = reserveNativeObjectSameValueResources(tx, "same-value", sameValueDependencies, sameValuePlan);
  const errorRequirements = { key: "errors" },
    errorDependencies = { strings, typeErrorTag: -11 };
  const errors = reserveNativeErrorResources(tx, errorRequirements, errorDependencies);
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: valuePlan.anchor,
    functions: projection.prepared.functions,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: "wasmgc",
    target: "standalone",
  });
  const vectors = reserveNativeVectorTypes(tx, vectorPlan);
  const vectorBase = vectors.base ?? tx.reserveType("arguments:base", createVectorBaseType());
  const argumentPlan = declareNativeArgumentVectorResources({ key: "arguments" }, { vectorBaseKey: vectorBase.key });
  const argumentsPack = reserveNativeArgumentVectorResources(tx, { key: "arguments" }, { vectorBase }, argumentPlan);
  const requirements = builtinRequirements();
  const requestDependencies = { arguments: argumentsPack, argumentPlan, strings };
  const requests = declareNativeBuiltinFunctionResources(tx, requirements, requestDependencies);
  const sourceRequirements = planNativeSourceClosureRequirements(program, projection);
  if (!sourceRequirements) throw Error("genuine getter fixture has no source closure population");
  const carriers = { vectors, vectorPlan };
  const source = beginNativeSourceClosureEmission(tx, sourceRequirements, carriers, requests);
  const { closures, closurePlan } = source.types;
  const sourceSlots = new Map<IrUnitId, FunctionReservation>();
  const sourceSignatures = new Map<IrUnitId, PhysicalFunctionSignature>();
  for (const unit of sourceRequirements.units) {
    const shape = sourceRequirements.shapes.find((row) => row.id === unit.shapeId)!;
    const binding = closures.signatures.find((row) => row.id === shape.signatureId)!.binding;
    const signature = {
      params: [{ kind: "ref" as const, typeIdx: closures.root.typeIndex }, ...binding.info.paramTypes],
      results: binding.info.returnType ? [binding.info.returnType] : [],
    };
    const fn = projection.prepared.functions.find((row) => row.unitId === unit.unitId)!;
    sourceSlots.set(unit.unitId, tx.reserveFunction(irUnitCallableBindingId(unit.unitId), fn.name, signature));
    sourceSignatures.set(unit.unitId, signature);
  }
  const dependencies = {
    access,
    storage,
    storageDependencies,
    sameValue,
    sameValueDependencies,
    errors,
    errorRequirements,
    errorDependencies,
    closures,
  };
  const plan = declareNativeObjectDescriptorResources("descriptors");
  const pack = reserveNativeObjectDescriptorResources(tx, "descriptors", dependencies, plan);
  const kernelDependencies = {
    requests,
    closures,
    closurePlan,
    descriptors: pack,
    descriptorDependencies: dependencies,
  };
  const kernel = reserveKernel ? reserveNativeBuiltinFunctionResources(tx, kernelDependencies) : undefined;
  return {
    module,
    tx,
    program,
    projection,
    access,
    valuePlan,
    strings,
    flatten,
    equality,
    scanner,
    valueDependencies,
    values,
    booleans,
    bigintPlan,
    bigints,
    symbols,
    layouts,
    lookup,
    lookupDependencies,
    storage,
    storageDependencies,
    sameValue,
    sameValueDependencies,
    sameValuePlan,
    errors,
    errorRequirements,
    errorDependencies,
    closures,
    dependencies,
    plan,
    pack,
    kernel,
    kernelDependencies,
    requirements,
    requests,
    requestDependencies,
    argumentsPack,
    argumentPlan,
    source,
    sourceRequirements,
    carriers,
    sourceSlots,
    sourceSignatures,
    closurePlan,
  };
}
const prefixTokens = new WeakMap<
  PhysicalModuleReservations,
  {
    prefix: ReturnType<PhysicalModuleReservations["reserveFunction"]>;
    global: ReturnType<PhysicalModuleReservations["reserveGlobal"]>;
  }
>();
export function fillDescriptorDependencies(f: ReturnType<typeof builtinFunctionFixture>) {
  const prefix = prefixTokens.get(f.tx);
  if (prefix) {
    f.tx.fillFunction(prefix.prefix, { locals: [], body: [] });
    f.tx.fillGlobal(prefix.global, [{ op: "i32.const", value: 123 }]);
  }
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeStringFlattenResources(f.tx, f.flatten);
  fillNativeStringEqualityResources(f.tx, f.equality);
  fillNativeStringNumberResources(f.tx, f.scanner);
  fillNativeValueResources(f.tx, f.values, f.valueDependencies);
  fillNativeBooleanResources(f.tx, f.booleans);
  fillNativeBigIntResources(f.tx, f.bigints);
  fillNativeSymbolCarrierResources(f.tx, f.symbols);
  fillNativeObjectLookupResources(f.tx, f.lookup);
  fillNativeObjectStorageResources(f.tx, f.storage);
  fillNativeObjectSameValueResources(f.tx, f.sameValue);
  fillNativeErrorResources(f.tx, f.errors);
}

export function completeBuiltinFunctionFixture(f: ReturnType<typeof builtinFunctionFixture>) {
  if (!f.kernel) throw Error("fixture kernel not reserved");
  f.tx.freezeReservations();
  bindNativeSourceClosureUnits(f.tx, f.source, f.sourceSlots);
  fillDescriptorDependencies(f);
  fillNativeArgumentVectorResources(f.tx, f.argumentsPack);
  fillNativeObjectDescriptorResources(f.tx, f.pack, f.kernel.exception);
  const resolver: IrLowerResolver = {
    ...nativeSourceClosureResolver(f.tx, f.source),
    resolveFunc(reference) {
      const slot = reference.binding.kind === "unit" ? f.sourceSlots.get(reference.binding.unitId) : undefined;
      if (!slot) throw Error("unowned source callable " + reference.name);
      return slot.handle;
    },
    resolveGlobal() {
      throw Error("unexpected source global");
    },
    resolveType() {
      throw Error("unexpected source nominal type");
    },
    internFuncType(signature) {
      return f.tx.internFunctionType(signature.params, signature.results);
    },
  };
  for (const [id, slot] of f.sourceSlots) {
    const fn = f.projection.prepared.functions.find((row) => row.unitId === id)!;
    fillPreparedPrimaryUnit(f.tx, fn, slot, f.sourceSignatures.get(id)!, resolver, "wasmgc", f.source);
  }
  requireCompletedNativeSourceClosures(f.tx, f.source);
  fillNativeBuiltinFunctionResources(f.tx, f.kernel);
  requireCompletedNativeBuiltinFunctionKernel(f.tx, f.kernel, f.kernelDependencies);
}

export interface BuiltinFunctionRuntime {
  functionPrototype(): object;
  throwTypeError(): object;
  objectPrototype(): object;
  realmIdentity(): object;
  bag(fn: unknown): object;
  getPrototypeOf(fn: unknown): object | null;
  setPrototypeOf(fn: unknown, proto: unknown): number;
  initialName(fn: unknown): object;
  arity(fn: unknown): number;
  match(value: unknown): number;
  key(index: number): object;
  undefinedValue(): object;
  isUtf8String(value: unknown): number;
  boxNumber(value: number): unknown;
  unboxNumber(value: unknown): number;
  newVector(): object;
  push(vector: object, value: unknown): void;
  vectorLength(vector: object): number;
  vectorAt(vector: object, index: number): unknown;
  call(fn: unknown, receiver: unknown, vector: object): unknown;
  directEntry(fn: unknown, receiver: unknown, vector: object): unknown;
  method0(fn: unknown, receiver: unknown): unknown;
  method1(fn: unknown, receiver: unknown, a: unknown): unknown;
  method3(fn: unknown, receiver: unknown, a: unknown, b: unknown, c: unknown): unknown;
  construct(fn: unknown, receiver: unknown, vector: object): unknown;
  getOwn(fn: unknown, key: unknown, receiver: unknown): [number, unknown];
  get(fn: unknown, key: unknown, receiver: unknown): [number, unknown];
  hasOwn(fn: unknown, key: unknown): number;
  has(fn: unknown, key: unknown): number;
  ownDescriptor(fn: unknown, key: unknown): [number, number, unknown, unknown, unknown];
  defineData(fn: unknown, key: unknown, value: unknown, flags: number): unknown;
  defineAccessor(fn: unknown, key: unknown, getter: unknown, setter: unknown, flags: number): unknown;
  defineAttributes(fn: unknown, key: unknown, flags: number): unknown;
  deleteOwn(fn: unknown, key: unknown): number;
  ownKeys(fn: unknown): object;
  writeOwn(fn: unknown, key: unknown, value: unknown): number;
  writeOwnStrict(fn: unknown, key: unknown, value: unknown): number;
  isExtensible(fn: unknown): number;
  preventExtensions(fn: unknown): number;
  objectProto(object: unknown): unknown;
  objectFlags(object: unknown): number;
  clone(fn: unknown): object;
  forge(fn: unknown, mode: number): object;
  bareMetadata(): object;
  header(fn: unknown): [number, number];
  sourceValue(): object;
  sourceCall(fn: object): number;
  createNull(): object;
  createDefault(): object;
  symbol(id: number): object;
  ordinaryDefineData(fn: unknown, key: unknown, value: unknown, flags: number): void;
  catchRethrow(fn: unknown, receiver: unknown, vector: object): unknown;
  thrown: WebAssembly.Global;
  state: WebAssembly.Global;
  realmReady: WebAssembly.Global;
  exception: WebAssembly.Tag;
  controlValue(): object;
  controlBag(): object;
  controlLength(): unknown;
  controlCall(fn: unknown, receiver: unknown, vector: object): unknown;
  controlMethod0(fn: unknown, receiver: unknown): unknown;
  controlMethod3(fn: unknown, receiver: unknown, a: unknown, b: unknown, c: unknown): unknown;
  controlGet(fn: unknown, key: unknown, receiver: unknown): [number, unknown];
  controlCatch(fn: unknown, receiver: unknown, vector: object): unknown;
  controlMode: WebAssembly.Global;
  controlEntered: WebAssembly.Global;
  controlThrown: WebAssembly.Global;
  controlReceiver: WebAssembly.Global;
  controlVector: WebAssembly.Global;
  stringMake(prototype: unknown, value: unknown): object;
  stringOwnHas(object: unknown, key: unknown): number;
  stringStoredHas(object: unknown, key: unknown): number;
  stringOwnValue(object: unknown, key: unknown): unknown;
  stringSameValue(a: unknown, b: unknown): number;
}
/** Observer exports are test-only; no observer is installed in the intrinsic catalog. */
export function builtinFunctionRuntime(offset = false, withTransportControls = false, withStringControl = false) {
  const f = builtinFunctionFixture(offset),
    { tx } = f,
    kernel = f.kernel!;
  const control = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction("test-control:" + name, name, { params, results });
  const keys = ["", "value", "other", "missing", ...BUILTIN_TEST_KEYS];
  const keySlots = keys.map((_, index) => control("key" + index, [], [ext]));
  const observers = {
    undefinedValue: control("undefinedValue", [], [ext]),
    isUtf8String: control("isUtf8String", [ext], [i32]),
    vectorLength: control("vectorLength", [ext], [i32]),
    vectorAt: control("vectorAt", [ext, i32], [ext]),
    call: control("call", [ext, ext, ext], [ext]),
    directEntry: control("directEntry", [ext, ext, ext], [ext]),
    objectProto: control("objectProto", [ext], [ext]),
    objectFlags: control("objectFlags", [ext], [i32]),
    clone: control("clone", [ext], [ext]),
    forge: control("forge", [ext, i32], [ext]),
    bareMetadata: control("bareMetadata", [], [ext]),
    header: control("header", [ext], [i32, i32]),
    sourceValue: control("sourceValue", [], [ext]),
    sourceCall: control("sourceCall", [ext], [f64]),
    catchRethrow: control("catchRethrow", [ext, ext, ext], [ext]),
  };
  const thrown = tx.reserveGlobal("test-control:thrown", "thrown", ext, true);
  const controls = withTransportControls ? reserveBuiltinTransportControls(f) : undefined;
  const stringControl = withStringControl ? reserveBuiltinStringControl(f) : undefined;
  completeBuiltinFunctionFixture(f);
  if (controls) fillBuiltinTransportControls(f, controls);
  if (stringControl) fillBuiltinStringControl(f, stringControl);
  tx.fillGlobal(thrown, [{ op: "ref.null.extern" }]);
  const fill = (name: keyof typeof observers, body: Instr[]) => tx.fillFunction(observers[name], { locals: [], body });
  const cast = (local: number, typeIdx: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
  ];
  keys.forEach((text, index) => {
    const binding = requireNativeStringLiteral(tx, f.strings, text);
    tx.fillFunction(keySlots[index]!, {
      locals: [],
      body: [
        binding.kind === "global"
          ? { op: "global.get", index: tx.physicalIndex(binding.global) }
          : { op: "call", funcIdx: binding.function.handle },
        { op: "extern.convert_any" },
      ],
    });
  });
  fill("undefinedValue", [
    { op: "global.get", index: tx.physicalIndex(f.values.globals.undefined) },
    { op: "extern.convert_any" },
  ]);
  fill(
    "isUtf8String",
    offset
      ? [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: f.strings.layout.utf8StrTypeIdx! },
        ]
      : [{ op: "i32.const", value: 0 }],
  );
  fill("vectorLength", [
    ...cast(0, f.argumentsPack.carrier.typeIndex),
    { op: "struct.get", typeIdx: f.argumentsPack.carrier.typeIndex, fieldIdx: 0 },
  ]);
  fill("vectorAt", [
    ...cast(0, f.argumentsPack.carrier.typeIndex),
    { op: "struct.get", typeIdx: f.argumentsPack.carrier.typeIndex, fieldIdx: 1 },
    { op: "local.get", index: 1 },
    { op: "array.get", typeIdx: f.argumentsPack.array.typeIndex },
  ]);
  const callBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    ...cast(2, f.argumentsPack.carrier.typeIndex),
    { op: "call", funcIdx: kernel.functions.callVector.handle },
  ];
  fill("call", callBody);
  fill("directEntry", [
    ...cast(0, f.closures.root.typeIndex),
    { op: "local.get", index: 1 },
    ...cast(2, f.argumentsPack.carrier.typeIndex),
    { op: "call", funcIdx: kernel.entries[0]!.lifted.handle },
  ]);
  fill("objectProto", [
    ...cast(0, f.layouts.object.typeIndex),
    { op: "struct.get", typeIdx: f.layouts.object.typeIndex, fieldIdx: 0 },
    { op: "extern.convert_any" },
  ]);
  fill("objectFlags", [
    ...cast(0, f.layouts.object.typeIndex),
    { op: "struct.get", typeIdx: f.layouts.object.typeIndex, fieldIdx: 4 },
  ]);
  const entry = kernel.entries[0]!;
  fill("clone", [
    ...Array.from({ length: 8 }, (_, fieldIdx): Instr[] => [
      ...cast(0, entry.type.typeIndex),
      { op: "struct.get", typeIdx: entry.type.typeIndex, fieldIdx },
    ]).flat(),
    { op: "struct.new", typeIdx: entry.type.typeIndex },
    { op: "extern.convert_any" },
  ]);
  fill(
    "header",
    [1, 4].flatMap((fieldIdx): Instr[] => [
      ...cast(0, entry.type.typeIndex),
      { op: "struct.get", typeIdx: entry.type.typeIndex, fieldIdx },
    ]),
  );
  const sourceUnit = f.sourceRequirements.units.find(
    (unit) => f.sourceSignatures.get(unit.unitId)!.results[0]?.kind === "f64",
  )!;
  const sourceShape = f.source.types.shapes.find((shape) => shape.id === sourceUnit.shapeId)!;
  const sourceSlot = f.sourceSlots.get(sourceUnit.unitId)!;
  // Forged carriers deliberately reuse issued types but have no singleton authority.
  fill("forge", [
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "funcref" } },
      then: [{ op: "ref.func", funcIdx: kernel.entries[1]!.lifted.handle }],
      else: [
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 3 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "funcref" } },
          then: [{ op: "ref.func", funcIdx: sourceSlot.handle }],
          else: [...cast(0, entry.type.typeIndex), { op: "struct.get", typeIdx: entry.type.typeIndex, fieldIdx: 0 }],
        },
      ],
    },
    ...Array.from({ length: 7 }, (_, index): Instr[] => {
      const fieldIdx = index + 1;
      const original: Instr[] = [
        ...cast(0, entry.type.typeIndex),
        { op: "struct.get", typeIdx: entry.type.typeIndex, fieldIdx },
      ];
      return fieldIdx === 4
        ? [
            { op: "local.get", index: 1 },
            { op: "i32.const", value: 1 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: i32 },
              then: [{ op: "i32.const", value: entry.type.typeIndex }],
              else: original,
            },
          ]
        : original;
    }).flat(),
    { op: "struct.new", typeIdx: entry.type.typeIndex },
    { op: "extern.convert_any" },
  ]);
  fill("bareMetadata", [
    ...buildBuiltinClosureValueInstrs(entry.metadata.type.typeIndex, entry.lifted.handle, 0, true),
    { op: "extern.convert_any" },
  ]);
  fill("sourceValue", [
    ...buildBuiltinClosureValueInstrs(sourceShape.type.typeIndex, sourceSlot.handle, 0, false),
    { op: "extern.convert_any" },
  ]);
  fill("sourceCall", [...cast(0, f.closures.root.typeIndex), { op: "call", funcIdx: sourceSlot.handle }]);
  fill("catchRethrow", [
    {
      op: "try",
      blockType: { kind: "val", type: ext },
      body: structuredClone(callBody),
      catches: [
        {
          tagIdx: tx.physicalIndex(kernel.exception),
          body: [
            { op: "global.set", index: tx.physicalIndex(thrown) },
            { op: "rethrow", depth: 0 },
          ],
        },
      ],
    },
  ]);
  const exports = {
    ...kernel.functions,
    ...observers,
    ...Object.fromEntries(keySlots.map((token, index) => ["key" + index, token])),
    functionPrototype: kernel.entries[0]!.getter,
    throwTypeError: kernel.entries[1]!.getter,
    boxNumber: f.values.functions.boxNumber,
    unboxNumber: f.values.functions.unboxNumber,
    newVector: f.argumentsPack.newVector,
    push: f.argumentsPack.push,
    createNull: f.storage.createNull,
    createDefault: f.storage.createDefault,
    symbol: f.symbols.functions.box,
    ordinaryDefineData: f.pack.defineData,
    state: kernel.globals.state,
    realmReady: kernel.globals.realmReady,
    thrown,
    exception: kernel.exception,
  };
  for (const [name, token] of Object.entries(exports)) tx.defineExport("export:" + name, name, token);
  if (controls)
    for (const [name, token] of Object.entries({
      controlValue: controls.functions.value,
      controlBag: controls.functions.bag,
      controlLength: controls.functions.length,
      controlCall: controls.functions.call,
      controlMethod0: controls.functions.method0,
      controlMethod3: controls.functions.method3,
      controlGet: controls.functions.get,
      controlCatch: controls.functions.catch,
      controlMode: controls.globals.mode,
      controlEntered: controls.globals.entered,
      controlThrown: controls.globals.thrown,
      controlReceiver: controls.globals.receiver,
      controlVector: controls.globals.vector,
    }))
      tx.defineExport("export:" + name, name, token);
  tx.seal();
  const compiled = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  if (WebAssembly.Module.imports(compiled).length !== 0)
    throw Error("native builtin kernel unexpectedly imports host providers");
  const instantiate = () => {
    const exports = new WebAssembly.Instance(compiled).exports;
    return {
      ...exports,
      key(index: number) {
        return (exports["key" + index] as () => object)();
      },
    } as unknown as BuiltinFunctionRuntime;
  };
  return { fixture: f, compiled, runtime: instantiate(), instantiate, keyTexts: keys };
}
