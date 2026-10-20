// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { prepareGetterProgram } from "./native-getter-invocation-fixture.js";
import {
  fillRealmLayoutFixture,
  reserveRealmAnchorControls,
  STATE_SOURCE,
  ext,
  f64,
  as,
  get,
} from "./native-realm-object-layouts.js";
import { deriveNativeRealmRequirements } from "../../src/ir/program/native-realm-requirements.js";
import { deriveNativeVectorResourcePlan } from "../../src/ir/program/native-vector-resources.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import { planNativeRealmLiterals } from "../../src/backend/wasmgc/program/native-realm-literals.js";
import { reserveNativeVectorTypes } from "../../src/backend/wasmgc/resources/native-vectors.js";
import {
  reserveNativeStringLiteralResources,
  nativeStringLiteralReservationInventory,
  fillNativeStringLiteralResources,
} from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  declareNativeInvocationSubstrateResources,
  reserveNativeInvocationSubstrateResources,
  fillNativeInvocationSubstrateResources,
} from "../../src/backend/wasmgc/resources/native-invocation-substrate.js";
import { declareNativePublicBuiltinFunctionRequests } from "../../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import {
  declareNativeClosureResources,
  instantiateNativeClosureRequirements,
  reserveNativeClosureResources,
} from "../../src/backend/wasmgc/resources/native-closures.js";
import {
  beginNativeSourceClosureEmission,
  bindNativeSourceClosureUnits,
  nativeRealmSourceClosureCallableBindings,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
  fillNativeRealmSourceCodeIdentities,
  requireCompletedNativeRealmSourceCodeIdentities,
  reserveNativeRealmSourceCodeIdentities,
} from "../../src/ir/program-native-invocation.js";
import { irUnitCallableBindingId } from "../../src/ir/core/callable-bindings.js";
import type { IrUnitId } from "../../src/shared/contracts/ir-identity.js";
import type { Instr } from "../../src/wasm/model/instructions.js";
import type { PhysicalFunctionSignature, FunctionReservation } from "../../src/wasm/physical/module-reservations.js";
import type { IrLowerResolver } from "../../src/ir/backend/lower-contracts.js";
import { emitBinary } from "../../src/emit/binary.js";
import { createEmptyModule } from "../../src/ir/types.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-object-layouts.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import {
  reserveNativeObjectRealmException,
  reserveNativeObjectRealmDeclarations,
} from "../../src/backend/wasmgc/resources/native-object-realm.js";

export const NO_SOURCE_REALM = `export function run(): number { const value = Object.create(null); return 7; }`;
export function publicRealmFoundation(
  displaced = false,
  decoded = false,
  noSource = false,
  shared = false,
  sourceText = STATE_SOURCE,
) {
  const program = prepareGetterProgram(noSource ? NO_SOURCE_REALM : sourceText, decoded);
  const projection = program.runtime[0]!;
  const realm = deriveNativeRealmRequirements(program, projection);
  if (
    !realm ||
    (noSource
      ? realm.description.sourceUnits.length !== 0
      : sourceText === STATE_SOURCE
        ? realm.description.sourceUnits.length !== 2
        : realm.description.sourceUnits.length < 2)
  )
    throw Error("missing genuine realm/source control population");
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const exceptionSelection = { required: true as const, shared };
  const exception = reserveNativeObjectRealmException(tx, realm, exceptionSelection);
  const prefix = displaced
    ? {
        type: tx.reserveType("control:prefix:type", {
          kind: "rec",
          types: [
            { kind: "struct", name: "PrefixA", fields: [] },
            { kind: "struct", name: "PrefixB", fields: [] },
          ],
        }),
        global: tx.reserveGlobal("control:prefix:global", "prefix", { kind: "i32" }, false),
        function: tx.reserveFunction("control:prefix:function", "prefix", { params: [], results: [] }),
      }
    : undefined;
  const requirements = { key: "objects", extensible: true as const },
    objectPlan = declareNativeObjectLayouts(requirements);
  const objects = reserveNativeObjectLayouts(tx, requirements, objectPlan),
    dependencies = { objects, objectPlan };
  const plan = declareNativeRealmObjectLayouts("realm-layout", objects.object.key, objects.propMap.key);
  const pack = reserveNativeRealmObjectLayouts(tx, "realm-layout", dependencies, plan);
  const f = { module, tx, prefix, requirements, objects, objectPlan, dependencies, plan, pack };
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: deriveNativeValueResourcePlan(program, projection, "native-string").anchor,
    functions: program.ir.functions,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: "wasmgc",
    target: "standalone",
  });
  const vectors = reserveNativeVectorTypes(f.tx, vectorPlan);
  const literalPlan = planNativeRealmLiterals(realm, displaced);
  const strings = reserveNativeStringLiteralResources(f.tx, {
    key: "public-realm:strings",
    utf8Storage: displaced,
    literals: literalPlan.literals,
  });
  const stringTypes = nativeStringLiteralReservationInventory(f.tx, strings).typePack;
  const substrateRequirements = { key: "public-realm:substrate" };
  const substrateDependencies = { vectors, vectorPlan, strings };
  const substratePlan = declareNativeInvocationSubstrateResources(
    substrateRequirements,
    vectors.base ? { vectorBaseKey: vectors.base.key } : {},
  );
  const substrate = reserveNativeInvocationSubstrateResources(
    f.tx,
    substrateRequirements,
    substrateDependencies,
    substratePlan,
  );
  const requestDependencies = { arguments: substrate.arguments, argumentPlan: substrate.argumentPlan, strings };
  const requests = declareNativePublicBuiltinFunctionRequests(f.tx, realm, requestDependencies);
  return {
    ...f,
    program,
    projection,
    realm,
    vectorPlan,
    vectors,
    literalPlan,
    strings,
    stringTypes,
    substrate,
    substrateDependencies,
    requestDependencies,
    requests,
    exception,
    exceptionSelection,
  };
}
export function publicRealmDeclarations(f: ReturnType<typeof publicRealmFoundation>, c = publicRealmClosures(f)) {
  const dependencies = {
    requests: f.requests,
    closures: c.closures,
    closurePlan: c.closurePlan,
    layouts: f.pack,
    substrate: f.substrate,
    vectors: f.vectors,
    vectorPlan: f.vectorPlan,
    exception: f.exception,
    ...(c.source ? { source: c.source.types } : {}),
  };
  const declarations = reserveNativeObjectRealmDeclarations(f.tx, f.realm, dependencies);
  return { ...c, dependencies, declarations };
}
export function publicRealmClosures(
  f: ReturnType<typeof publicRealmFoundation>,
  state = true,
  includeCodeIdentities = false,
) {
  if (f.realm.source?.units.length) {
    if (includeCodeIdentities && !state) throw Error("code identity fixture requires actual realm state");
    const codes = includeCodeIdentities ? reserveNativeRealmSourceCodeIdentities(f.tx, f.realm, f.pack) : undefined;
    const carriers = {
      vectors: f.vectors,
      vectorPlan: f.vectorPlan,
      strings: { types: f.stringTypes, key: f.stringTypes.key, utf8Storage: f.stringTypes.utf8Storage },
      ...(state ? { realmState: f.pack } : {}),
      ...(codes ? { codeIdentities: codes } : {}),
    };
    const source = beginNativeSourceClosureEmission(f.tx, f.realm.source, carriers, f.requests);
    return { source, carriers, closures: source.types.closures, closurePlan: source.types.closurePlan };
  }
  const closurePlan = declareNativeClosureResources({
    key: f.realm.description.key + ":public-closures",
    startingClosureCounter: 0,
    requests: f.requests.requests,
    referenceTypeKeys: f.requests.referenceTypes.map((row) => row.key),
  });
  const closures = reserveNativeClosureResources(
    f.tx,
    instantiateNativeClosureRequirements(
      f.tx,
      closurePlan,
      new Map(f.requests.referenceTypes.map((row) => [row.key, row])),
    ),
    closurePlan,
  );
  return { closures, closurePlan, source: undefined, carriers: undefined };
}
export function publicRealmSourceSlots(
  f: ReturnType<typeof publicRealmFoundation>,
  c: ReturnType<typeof publicRealmClosures>,
) {
  if (!c.source) throw Error("source control requires real lifted units");
  const slots = new Map<IrUnitId, FunctionReservation>(),
    signatures = new Map<IrUnitId, PhysicalFunctionSignature>();
  for (const unit of c.source.requirements.units) {
    const shape = c.source.requirements.shapes.find((row) => row.id === unit.shapeId)!;
    const binding = c.closures.signatures.find((row) => row.id === shape.signatureId)!.binding;
    const signature = {
      params: [{ kind: "ref" as const, typeIdx: binding.liftedSelfTypeIndex }, ...binding.info.paramTypes],
      results: binding.info.returnType ? [binding.info.returnType] : [],
    };
    const fn = f.projection.prepared.functions.find((row) => row.unitId === unit.unitId)!;
    slots.set(unit.unitId, f.tx.reserveFunction(irUnitCallableBindingId(unit.unitId), fn.name, signature));
    signatures.set(unit.unitId, signature);
  }
  const factories = ["makeCaptured", "makeEmpty"].map((name) => {
    const fn = f.projection.prepared.functions.find((row) => row.name === name)!;
    const signature = { params: name === "makeCaptured" ? [f64] : [], results: [ext] };
    const slot = f.tx.reserveFunction(irUnitCallableBindingId(fn.unitId), fn.name, signature);
    slots.set(fn.unitId, slot);
    signatures.set(fn.unitId, signature);
    return { fn, slot, name };
  });
  return { slots, signatures, factories };
}
/** Real source bodies plus full catalog *types*, with no dummy builtin body or public population installed. */
export function publicRealmSourceRuntime(
  displaced = false,
  decoded = false,
  includeCodeIdentities = false,
  sourceText = STATE_SOURCE,
) {
  const f = publicRealmFoundation(displaced, decoded, false, false, sourceText),
    c = publicRealmClosures(f, true, includeCodeIdentities),
    s = publicRealmSourceSlots(f, c);
  const controls = reserveRealmAnchorControls(f);
  const call = f.tx.reserveFunction("control:call", "controlCall", { params: [ext, f64], results: [f64] });
  const codeCall = includeCodeIdentities
    ? f.tx.reserveFunction("control:code-call", "controlCodeCall", { params: [ext, f64], results: [f64] })
    : undefined;
  const codeOf = includeCodeIdentities
    ? f.tx.reserveFunction("control:code-of", "controlCodeOf", { params: [ext], results: [ext] })
    : undefined;
  f.tx.freezeReservations();
  bindNativeSourceClosureUnits(f.tx, c.source!, s.slots);
  const callables = nativeRealmSourceClosureCallableBindings(f.tx, c.source!, f.realm);
  fillRealmLayoutFixture(f);
  controls.fill();
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeInvocationSubstrateResources(f.tx, f.substrate);
  const resolver: IrLowerResolver = {
    ...nativeSourceClosureResolver(f.tx, c.source!),
    resolveFunc(ref) {
      const slot = ref.binding.kind === "unit" && s.slots.get(ref.binding.unitId);
      if (slot) return slot.handle;
      throw Error("unexpected source callable");
    },
    resolveGlobal() {
      throw Error("unexpected source global");
    },
    resolveType() {
      throw Error("unexpected source type");
    },
    internFuncType(sig) {
      return f.tx.internFunctionType(sig.params, sig.results);
    },
  };
  for (const [id, slot] of s.slots)
    fillPreparedPrimaryUnit(
      f.tx,
      f.projection.prepared.functions.find((row) => row.unitId === id)!,
      slot,
      s.signatures.get(id)!,
      resolver,
      "wasmgc",
      c.source,
    );
  const binding = callables.entries[0]!.signature;
  f.tx.fillFunction(call, {
    locals: [],
    body: [
      ...as(0, c.closures.root.typeIndex),
      get(1),
      ...as(0, c.closures.root.typeIndex),
      { op: "struct.get", typeIdx: c.closures.root.typeIndex, fieldIdx: 0 },
      { op: "ref.cast", typeIdx: binding.liftedFuncTypeIndex },
      { op: "call_ref", typeIdx: binding.liftedFuncTypeIndex },
    ],
  });
  const codes = includeCodeIdentities ? c.carriers!.codeIdentities! : undefined;
  if (codes && codeCall && codeOf) {
    fillNativeRealmSourceCodeIdentities(f.tx, c.source!, f.realm);
    requireCompletedNativeRealmSourceCodeIdentities(f.tx, c.source!, f.realm);
    f.tx.fillFunction(codeCall, {
      locals: [{ name: "matched", type: { kind: "i32" } }],
      body: [
        get(0),
        { op: "call", funcIdx: codes.match.handle },
        { op: "local.set", index: 2 },
        ...callables.entries.flatMap((entry, index): Instr[] => [
          get(2),
          { op: "i32.const", value: index + 1 },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...as(0, c.closures.root.typeIndex),
              get(1),
              { op: "global.get", index: f.tx.physicalIndex(codes.entries[index]!.identity) },
              { op: "struct.get", typeIdx: codes.type.typeIndex, fieldIdx: 0 },
              { op: "ref.cast", typeIdx: entry.signature.liftedFuncTypeIndex },
              { op: "call_ref", typeIdx: entry.signature.liftedFuncTypeIndex },
              { op: "return" },
            ],
          },
        ]),
        { op: "unreachable" },
      ],
    });
    f.tx.defineExport("control:code-match-export", "matchCode", codes.match);
    f.tx.defineExport("control:code-call-export", "callCode", codeCall);
    f.tx.fillFunction(codeOf, {
      locals: [],
      body: [
        ...callables.entries.flatMap((entry): Instr[] => [
          get(0),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: entry.shape.type.typeIndex },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...as(0, entry.shape.type.typeIndex),
              {
                op: "struct.get",
                typeIdx: entry.shape.type.typeIndex,
                fieldIdx: 4 + entry.source.closureSubtype!.captureFieldTypes.length,
              },
              { op: "extern.convert_any" },
              { op: "return" },
            ],
          },
        ]),
        { op: "unreachable" },
      ],
    });
    f.tx.defineExport("control:code-of-export", "sourceCode", codeOf);
    for (const [index, entry] of codes.entries.entries())
      f.tx.defineExport("control:code-export:" + index, "code" + index, entry.identity);
  }
  for (const { slot, name } of s.factories) f.tx.defineExport("control:export:" + name, name, slot);
  f.tx.defineExport("control:export:call", "call", call);
  requireCompletedNativeSourceClosures(f.tx, c.source!);
  f.tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  return {
    f,
    c,
    callables,
    wasm,
    instance: () => new WebAssembly.Instance(wasm).exports as Record<string, (...args: any[]) => any>,
  };
}
