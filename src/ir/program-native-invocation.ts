// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { NativeInvocationRequirements } from "./program/native-invocation-requirements.js";
import {
  assertNativeRealmRequirementsCurrent,
  type NativeRealmRequirements,
} from "./program/native-realm-requirements.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import {
  planNativeSourceClosureRequirements,
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "./program/native-source-closure-requirements.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./program/prepared-contracts.js";
import type { IrFunction, IrType } from "./core/nodes.js";
import { nativeRefCellScalarInner } from "./program/native-ref-cell-requirements.js";
import type { IrUnitId } from "../shared/contracts/ir-identity.js";
import { irUnitCallableBindingId } from "./core/callable-bindings.js";
import { PreparedIrProgramInvariantError } from "./program/errors.js";
import {
  reserveNativeSourceClosureTypes,
  requireNativeSourceClosureTypes,
  requireCompletedNativeSourceClosureState,
  resolveNativeSourceClosure,
  resolveNativeSourceClosureShape,
  resolveNativeSourceRefCell,
  nativeSourceClosureCodeIdentities,
  type NativeSourceClosureTypes,
  type NativeSourceClosureCarriers,
} from "../backend/wasmgc/resources/native-source-closures.js";
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  PhysicalFunctionSignature,
} from "../wasm/physical/module-reservations.js";
import { sameValTypes } from "../wasm/physical/function-types.js";
import {
  bindNativeSourceClosureCallables,
  requireNativeSourceClosureCallables,
  type NativeSourceClosureCallables,
  bindNativeRealmSourceClosureCallables,
  requireNativeRealmSourceClosureCallables,
  type NativeRealmSourceClosureCallables,
} from "../backend/wasmgc/resources/native-source-closure-callables.js";
import type { Instr, LocalDef, ValType } from "../wasm/model/instructions.js";
import { lowerIrFunctionBody } from "./lower-generic.js";
import { wasmValueTypeConverter } from "./backend/wasm-lowering.js";
import type { IrLowerResolver } from "./backend/lower-contracts.js";
import { WasmGcEmitter } from "./backend/wasmgc-emitter.js";
import { LinearEmitter } from "./backend/linear-emitter.js";
import type { IrBackendKind } from "./backend/legality.js";
import type { NativeBuiltinFunctionRequestIssuer } from "../backend/wasmgc/resources/native-builtin-function-requests.js";
import {
  requireNativeSourceCodeIdentityReservations,
  reserveNativeSourceCodeIdentityResources,
  type NativeSourceCodeIdentityReservations,
} from "../backend/wasmgc/resources/native-source-code-identities.js";
import type { NativeRealmObjectLayoutReservations } from "../backend/wasmgc/resources/native-realm-object-layouts.js";
import {
  withNativeSourceCodeIdentity,
  buildNativeSourceCodeIdentityInitializer,
  buildNativeSourceCodeMatch,
} from "../runtime/wasmgc/values/source-code-identity-bodies.js";

export interface NativeSourceClosureEmission {
  readonly requirements: NativeSourceClosureRequirements;
  readonly types: NativeSourceClosureTypes;
}
/** Actual lifted-body custody only; never source allocation or realm population authority. */
export interface NativeRealmSourceClosureBodyCustody {
  readonly source: NativeSourceClosureEmission;
  readonly callables: NativeRealmSourceClosureCallables;
  readonly completionScope: "realm-source-body-custody";
}
interface SourceOwner {
  readonly tx: PhysicalModuleReservations;
  readonly units: Map<IrUnitId, { readonly fn: IrFunction; readonly slot: FunctionReservation }>;
  readonly completed: Map<IrUnitId, { readonly locals: LocalDef[]; readonly body: Instr[] }>;
  readonly attempted: Set<IrUnitId>;
  callables?: NativeSourceClosureCallables;
  realmCallables?: NativeRealmSourceClosureCallables;
  realmBodyCustody?: NativeRealmSourceClosureBodyCustody;
  bound: boolean;
  readonly builtins: NativeBuiltinFunctionRequestIssuer | undefined;
}
const owners = new WeakMap<NativeSourceClosureEmission, SourceOwner>();
function fail(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native source invocation: ${detail}`);
}
function requireOwner(tx: PhysicalModuleReservations, pack: NativeSourceClosureEmission): SourceOwner {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign or copied source association");
  assertPreparedIrProgram(pack.requirements.demands.program);
  assertNativeSourceClosureRequirementsCurrent(pack.requirements);
  requireNativeSourceClosureTypes(tx, pack.types, pack.requirements);
  return owner;
}

export function prepareNativeSourceClosureInput(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeSourceClosureRequirements | undefined {
  assertPreparedIrProgram(program);
  if (!program.runtime.includes(projection)) fail("unselected runtime projection");
  return planNativeSourceClosureRequirements(program, projection);
}

export function beginNativeSourceClosureEmission(
  tx: PhysicalModuleReservations,
  requirements: NativeSourceClosureRequirements,
  carriers: NativeSourceClosureCarriers,
  builtins?: NativeBuiltinFunctionRequestIssuer,
): NativeSourceClosureEmission {
  assertPreparedIrProgram(requirements.demands.program);
  assertNativeSourceClosureRequirementsCurrent(requirements);
  const types = reserveNativeSourceClosureTypes(tx, requirements, carriers, builtins);
  const pack = Object.freeze({ requirements, types });
  owners.set(pack, { tx, units: new Map(), completed: new Map(), attempted: new Set(), bound: false, builtins });
  return pack;
}

/** Bind only after the existing consumer loop has allocated and frozen all unit slots. */
export function bindNativeSourceClosureUnits(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
): void {
  const owner = requireOwner(tx, pack);
  if (owner.bound || tx.state !== "filling") fail("source slots require one frozen binding operation");
  const prepared = pack.requirements.demands.projection.prepared.functions;
  const rows = pack.requirements.units.map((unit) => {
    const fn = prepared.find((candidate) => candidate.unitId === unit.unitId);
    const slot = slots.get(unit.unitId);
    if (!fn || !slot || slot.key !== irUnitCallableBindingId(unit.unitId))
      fail("source unit has no exact original ABI slot");
    tx.physicalIndex(slot);
    if (fn.asyncPlan || fn.asyncRuntime) fail("async closure body has no native canonical frame completion owner");
    const shape = pack.types.shapes.find((candidate) => candidate.id === unit.shapeId);
    if (!shape || !fn.closureSubtype) fail("source unit has no exact capture shape");
    const resolved = resolveNativeSourceClosureShape(
      tx,
      pack.types,
      fn.closureSubtype.signature,
      fn.closureSubtype.captureFieldTypes,
    );
    if (resolved !== shape) fail("source slot capture metadata differs from its actual type owner");
    // The lifted signature already exists in the sole canonical wrapper owner.
    if (slot.object.typeIdx !== shape.lowering.funcTypeIdx) fail("source slot does not use its exact lifted signature");
    return { unitId: unit.unitId, fn, slot };
  });
  const codeIdentities = nativeSourceClosureCodeIdentities(tx, pack.types);
  const referencedSlots = [
    ...new Set([
      ...pack.requirements.allocations.map((row) => row.liftedUnitId),
      ...(codeIdentities ? pack.requirements.units.map((row) => row.unitId) : []),
    ]),
  ].map((id) => {
    const row = rows.find((candidate) => candidate.unitId === id);
    if (!row) fail("source allocation target has no authenticated lifted unit slot");
    return row.slot;
  });
  for (const slot of referencedSlots) tx.declareFunctionReference(slot);
  for (const row of rows) owner.units.set(row.unitId, { fn: row.fn, slot: row.slot });
  owner.bound = true;
}

export function nativeSourceClosureCallableBindings(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
  requirements: NativeInvocationRequirements,
): NativeSourceClosureCallables {
  const owner = requireOwner(tx, pack);
  if (!owner.bound) fail("source callables have not been bound to the consumer's slots");
  owner.callables ??= bindNativeSourceClosureCallables(
    tx,
    pack.types,
    new Map([...owner.units].map(([id, row]) => [id, row.slot])),
    requirements,
  );
  return requireNativeSourceClosureCallables(tx, owner.callables, pack.types);
}

/** Bind the genuine original unit map, without fabricating selected invocation demand. */
export function nativeRealmSourceClosureCallableBindings(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
  realm: NativeRealmRequirements,
): NativeRealmSourceClosureCallables {
  const owner = requireOwner(tx, pack);
  if (!owner.bound) fail("realm source callables have not been bound to the consumer's slots");
  owner.realmCallables ??= bindNativeRealmSourceClosureCallables(
    tx,
    pack.types,
    new Map([...owner.units].map(([id, row]) => [id, row.slot])),
    realm,
  );
  return requireNativeRealmSourceClosureCallables(tx, owner.realmCallables, pack.types, realm);
}

/** Only the genuine prepared-body producer can issue this full source-unit custody. */
export function completeNativeRealmSourceClosureBodyCustody(
  tx: PhysicalModuleReservations,
  source: NativeSourceClosureEmission,
  realm: NativeRealmRequirements,
): NativeRealmSourceClosureBodyCustody {
  const owner = requireOwner(tx, source);
  requireCompletedNativeSourceClosures(tx, source);
  const callables = nativeRealmSourceClosureCallableBindings(tx, source, realm);
  owner.realmBodyCustody ??= Object.freeze({
    source,
    callables,
    completionScope: "realm-source-body-custody" as const,
  });
  return requireNativeRealmSourceClosureBodyCustody(tx, owner.realmBodyCustody, source, realm);
}

/** Recheck real bodies and original associations on every use, not merely issuance. */
export function requireNativeRealmSourceClosureBodyCustody(
  tx: PhysicalModuleReservations,
  custody: NativeRealmSourceClosureBodyCustody,
  source: NativeSourceClosureEmission,
  realm: NativeRealmRequirements,
): NativeRealmSourceClosureBodyCustody {
  const owner = requireOwner(tx, source);
  if (owner.realmBodyCustody !== custody || custody.source !== source || custody.callables !== owner.realmCallables)
    fail("foreign, copied or substituted source-body custody");
  requireCompletedNativeSourceClosures(tx, source);
  requireNativeRealmSourceClosureCallables(tx, custody.callables, source.types, realm);
  return custody;
}

export interface NativeRealmSourceCodeIdentities {
  readonly declarations: NativeSourceCodeIdentityReservations;
  readonly bodies: NativeRealmSourceClosureBodyCustody;
  readonly completionScope: "realm-source-code-identities";
}
interface SourceCodeOwner {
  readonly source: NativeSourceClosureEmission;
  phase: "filling" | "filled" | "failed";
  completion?: NativeRealmSourceCodeIdentities;
}
const sourceCodeOwners = new WeakMap<NativeSourceCodeIdentityReservations, SourceCodeOwner>();
/** Semantic selection stays in IR; the backend receives a complete physical description only. */
export function reserveNativeRealmSourceCodeIdentities(
  tx: PhysicalModuleReservations,
  realm: NativeRealmRequirements,
  layouts: NativeRealmObjectLayoutReservations,
): NativeSourceCodeIdentityReservations {
  assertNativeRealmRequirementsCurrent(realm);
  if (!realm.source?.units.length || realm.source.gaps.length) fail("complete nonempty source requirements required");
  return reserveNativeSourceCodeIdentityResources(
    tx,
    {
      key: realm.description.key + ":source-code",
      realm,
      source: realm.source,
      units: realm.source.units.map((row) => row.unitId),
    },
    layouts,
  );
}
function sourceCodeGraph(
  tx: PhysicalModuleReservations,
  source: NativeSourceClosureEmission,
  realm: NativeRealmRequirements,
) {
  requireOwner(tx, source);
  assertNativeRealmRequirementsCurrent(realm);
  const declarations = nativeSourceClosureCodeIdentities(tx, source.types);
  if (
    !declarations ||
    declarations.realm !== realm ||
    realm.source !== source.requirements ||
    declarations.key !== realm.description.key + ":source-code"
  )
    fail("missing original source code declarations");
  requireNativeSourceCodeIdentityReservations(tx, declarations, source.requirements, declarations.layouts);
  const bodies = completeNativeRealmSourceClosureBodyCustody(tx, source, realm);
  const entries = declarations.entries.map((entry) => {
    const callable = bodies.callables.entries.find((row) => row.unitId === entry.unitId);
    if (!callable) fail("code identity lacks its actual lowered source unit");
    const shape = source.requirements.shapes.find((row) => row.id === callable.shape.id)!;
    return { entry, callable, stateField: 3 + shape.captures.length };
  });
  const match = buildNativeSourceCodeMatch({
    realmGlobal: tx.physicalIndex(declarations.layouts.anchors.realm),
    stateTypeIdx: declarations.layouts.types.state.typeIndex,
    codeTypeIdx: declarations.type.typeIndex,
    entries: entries.map((row) => ({
      sourceTypeIdx: row.callable.shape.type.typeIndex,
      stateField: row.stateField,
      codeField: row.stateField + 1,
      codeGlobal: tx.physicalIndex(row.entry.identity),
    })),
  });
  return { declarations, bodies, entries, match };
}
/** Targets come only from the genuine complete IR body-custody graph, never passed-in definitions. */
export function fillNativeRealmSourceCodeIdentities(
  tx: PhysicalModuleReservations,
  source: NativeSourceClosureEmission,
  realm: NativeRealmRequirements,
): void {
  const graph = sourceCodeGraph(tx, source, realm),
    { declarations } = graph;
  if (tx.state !== "filling" || sourceCodeOwners.has(declarations)) fail("code identity fill is duplicate or terminal");
  const owner: SourceCodeOwner = { source, phase: "filling" };
  sourceCodeOwners.set(declarations, owner);
  try {
    for (const row of graph.entries) {
      tx.fillGlobal(
        row.entry.identity,
        buildNativeSourceCodeIdentityInitializer(declarations.type.typeIndex, row.callable.slot.handle),
      );
    }
    tx.fillFunction(declarations.match, graph.match);
    owner.phase = "filled";
  } catch (error) {
    owner.phase = "failed";
    throw error;
  }
}
/** Re-derive exact code global initializers and matcher from genuine body custody on every use. */
export function requireCompletedNativeRealmSourceCodeIdentities(
  tx: PhysicalModuleReservations,
  source: NativeSourceClosureEmission,
  realm: NativeRealmRequirements,
): NativeRealmSourceCodeIdentities {
  const graph = sourceCodeGraph(tx, source, realm),
    { declarations, bodies } = graph,
    owner = sourceCodeOwners.get(declarations);
  if (!owner || owner.source !== source || owner.phase !== "filled")
    fail("source code identities are incomplete or terminal");
  for (const row of graph.entries)
    tx.assertCanonicalGlobalInitializer(
      row.entry.identity,
      buildNativeSourceCodeIdentityInitializer(declarations.type.typeIndex, row.callable.slot.handle),
    );
  tx.assertCanonicalFunctionDefinition(declarations.match, graph.match);
  owner.completion ??= Object.freeze({
    declarations,
    bodies,
    completionScope: "realm-source-code-identities" as const,
  });
  if (owner.completion.bodies !== bodies) fail("changed source-body custody");
  return owner.completion;
}
export function requireNativeRealmSourceCodeIdentities(
  tx: PhysicalModuleReservations,
  completion: NativeRealmSourceCodeIdentities,
  source: NativeSourceClosureEmission,
  realm: NativeRealmRequirements,
): NativeRealmSourceCodeIdentities {
  const actual = requireCompletedNativeRealmSourceCodeIdentities(tx, source, realm);
  if (completion !== actual) fail("foreign, copied or substituted completed code identities");
  return actual;
}

export function nativeSourceClosureValueType(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
  logical: IrType,
): ValType | undefined {
  requireOwner(tx, pack);
  if (logical.kind === "boxed") {
    const inner = nativeRefCellScalarInner(logical);
    const cell = inner && resolveNativeSourceRefCell(tx, pack.types, inner);
    if (!cell) fail("logical mutable capture has no selected ref-cell owner");
    return { kind: "ref", typeIdx: cell.typeIdx };
  }
  if (logical.kind !== "closure" && logical.kind !== "callable") return undefined;
  if (!resolveNativeSourceClosure(tx, pack.types, logical.signature))
    fail("logical signature has no selected wrapper owner");
  return logical.kind === "callable"
    ? { kind: "externref" }
    : { kind: "ref", typeIdx: pack.types.closures.root.typeIndex };
}

export function nativeSourceClosureResolver(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
): Pick<IrLowerResolver, "resolveClosure" | "resolveClosureRoot" | "resolveClosureSubtype" | "resolveRefCell"> {
  const owner = requireOwner(tx, pack);
  if (!owner.bound) fail("source resolver used before original unit binding");
  return {
    resolveRefCell: (inner, allocation) => resolveNativeSourceRefCell(tx, pack.types, inner, allocation),
    resolveClosure: (signature) => resolveNativeSourceClosure(tx, pack.types, signature),
    resolveClosureRoot: () => {
      requireOwner(tx, pack);
      return pack.types.closures.root.typeIndex;
    },
    resolveClosureSubtype: (signature, captures, hostOneShot, domAuthority, liftedHandle) => {
      requireOwner(tx, pack);
      if (hostOneShot || domAuthority) fail("certified callback authority is not an ordinary source carrier");
      const shape = resolveNativeSourceClosureShape(tx, pack.types, signature, captures);
      if (!shape) return null;
      if (liftedHandle !== undefined) {
        // resolveFunc supplies a stable FuncHandle, not the final raw index.
        const association = pack.requirements.units.find(
          (unit) => unit.shapeId === shape.id && owner.units.get(unit.unitId)?.slot.handle === liftedHandle,
        );
        if (!association) fail("closure allocation does not target its selected lifted source slot");
        tx.physicalIndex(owner.units.get(association.unitId)!.slot);
        const codes = nativeSourceClosureCodeIdentities(tx, pack.types);
        if (codes) {
          const identity = codes.entries.find((row) => row.unitId === association.unitId);
          if (!identity) fail("allocation lacks its original source code identity");
          return withNativeSourceCodeIdentity(shape.lowering, tx.physicalIndex(identity.identity));
        }
      }
      return shape.lowering;
    },
  };
}

/** The only source completion producer: actually lower the retained body into its original slot. */
export function fillPreparedPrimaryUnit(
  tx: PhysicalModuleReservations,
  fn: IrFunction,
  slot: FunctionReservation,
  signature: PhysicalFunctionSignature,
  resolver: IrLowerResolver,
  backend: IrBackendKind,
  source?: NativeSourceClosureEmission,
): void {
  const owner = source ? requireOwner(tx, source) : undefined;
  const association = owner?.units.get(fn.unitId);
  if (association && (association.fn !== fn || association.slot !== slot || owner!.attempted.has(fn.unitId)))
    fail("source canonical lowering uses a changed function/slot or repeats completion");
  if (fn.closureSubtype && source && !association) fail("unbound source closure body");
  const emitter = backend === "wasmgc" ? new WasmGcEmitter(resolver) : new LinearEmitter();
  const lowered = lowerIrFunctionBody<Instr[], ValType>(
    fn,
    resolver,
    emitter,
    wasmValueTypeConverter(backend, resolver, fn.name),
  );
  const params = lowered.params.flatMap((param) => [...param.slots]);
  const results = lowered.results.flatMap((result) => [...result]);
  if (!sameValTypes(params, signature.params) || !sameValTypes(results, signature.results))
    fail(`body ${fn.unitId} lowered to a signature different from its original ABI slot`);
  const definition = {
    locals: lowered.locals.flatMap((local) =>
      local.slots.map((type, index) => ({
        name: index === 0 ? local.name : `${local.name}$${index}`,
        type,
      })),
    ),
    body: lowered.body,
  };
  // Clone BEFORE the ledger sees the definition: its receipt may faithfully
  // describe an intercepted/substituted fill rather than the actual IR output.
  const canonical = association ? structuredClone(definition) : undefined;
  if (association) owner!.attempted.add(fn.unitId);
  tx.fillFunction(slot, definition);
  if (canonical) owner!.completed.set(fn.unitId, canonical);
}

export function requireCompletedNativeSourceClosures(
  tx: PhysicalModuleReservations,
  pack: NativeSourceClosureEmission,
): NativeSourceClosureEmission {
  const owner = requireOwner(tx, pack);
  if (!owner.bound || owner.units.size !== pack.requirements.units.length || owner.completed.size !== owner.units.size)
    fail("source canonical lowering is incomplete");
  requireCompletedNativeSourceClosureState(tx, pack.types);
  for (const [unitId, row] of owner.units) {
    const canonical = owner.completed.get(unitId);
    if (!canonical) fail("source unit did not pass canonical lowering");
    tx.assertCanonicalFunctionDefinition(row.slot, canonical);
  }
  return pack;
}
