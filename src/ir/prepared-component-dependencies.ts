// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irClassTypeRef, irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";
import { irCallableBindingKey, irUnitCallableBindingId } from "./callable-bindings.js";
import type { IrBindingId, IrClassId, IrTerminalUnitRecord, IrUnitId, IrUnitInventory } from "./identity.js";
import {
  forEachInstrDeep,
  type IrClassShape,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrModule,
  type IrType,
  type IrTypeRef,
  type IrValueId,
} from "./nodes.js";
import type { ProgramAbiDerivedUnitRecord, ProgramAbiIntent, ProgramAbiPlanEntry } from "./program-abi.js";

export type PreparedComponentAbiEntry = Pick<
  ProgramAbiPlanEntry,
  "id" | "intent" | "slotPolicy" | "structuralReferenceKey"
> & {
  readonly aliasOf?: IrBindingId;
};

/**
 * Minimal read-only Program ABI surface needed by dependency discovery.
 *
 * `ProgramAbiMap` and a sealed prepared scope adapt directly. Planning-time
 * callers also need reverse structural-key lookup for import/runtime/intrinsic
 * refs, whose IR binding deliberately carries no `IrBindingId`; exposing that
 * lookup on `ProgramAbiSession` is the smallest remaining production adapter.
 * Omitting both reverse-lookup forms is safe but conservative: every such ref
 * blocks.
 */
export interface PreparedComponentAbiLookup {
  get(id: IrBindingId): PreparedComponentAbiEntry | undefined;
  bindingIdsForStructuralReference?(key: string): readonly IrBindingId[];
  entries?(): readonly PreparedComponentAbiEntry[];
}

export type PreparedComponentDependencyFailureCode =
  | "unknown-component-terminal"
  | "missing-function-body"
  | "unknown-source-unit"
  | "foreign-source-unit"
  | "unplanned-abi-binding"
  | "abi-binding-cycle"
  | "abi-binding-contract-mismatch"
  | "source-global-outside-component"
  | "unknown-source-class"
  | "foreign-source-class"
  | "class-member-callable-unavailable"
  | "implicit-support-reference-unavailable";

export interface PreparedComponentDependencyFailure {
  readonly code: PreparedComponentDependencyFailureCode;
  readonly ownerUnitId: IrUnitId;
  readonly detail: string;
  readonly structuralReferenceKey?: string;
  readonly referencedUnitId?: IrUnitId;
  readonly referencedClassId?: IrClassId;
  readonly bindingId?: IrBindingId;
}

export interface PreparedComponentUnitDependency {
  readonly ownerUnitId: IrUnitId;
  readonly referencedUnitId: IrUnitId;
  readonly terminalOwnerUnitId: IrUnitId;
  readonly programAbiBindingId: IrBindingId;
}

export type PreparedComponentAbiDependencyKind =
  | "source-callable"
  | "source-global"
  | "external-callable"
  | "external-global"
  | "class-layout"
  | "support";

export interface PreparedComponentAbiDependency {
  readonly ownerUnitId: IrUnitId;
  readonly kind: PreparedComponentAbiDependencyKind;
  readonly bindingId: IrBindingId;
  readonly canonicalBindingId: IrBindingId;
  readonly structuralReferenceKey: string;
  readonly terminalOwnerUnitId: IrUnitId | null;
}

export interface PreparedComponentExternalCallableDependency {
  readonly ownerUnitId: IrUnitId;
  readonly structuralReferenceKey: string;
  readonly programAbiBindingId: IrBindingId | null;
}

export interface PreparedComponentDependencyEvidence {
  readonly id: string;
  readonly status: "complete" | "blocked";
  readonly terminalUnitIds: readonly IrUnitId[];
  readonly functionUnitIds: readonly IrUnitId[];
  readonly unitDependencies: readonly PreparedComponentUnitDependency[];
  readonly abiDependencies: readonly PreparedComponentAbiDependency[];
  readonly externalCallables: readonly PreparedComponentExternalCallableDependency[];
  readonly failures: readonly PreparedComponentDependencyFailure[];
}

export interface PreparedComponentDependencyReport {
  readonly components: readonly PreparedComponentDependencyEvidence[];
  readonly componentByTerminalUnitId: ReadonlyMap<IrUnitId, PreparedComponentDependencyEvidence>;
}

export interface DerivePreparedComponentDependenciesInput {
  readonly module: IrModule;
  /** Exact R2 candidate denominator. Local calls close components within it. */
  readonly terminalUnitIds: ReadonlySet<IrUnitId>;
  readonly inventory: IrUnitInventory;
  readonly derivedUnits?: readonly ProgramAbiDerivedUnitRecord[];
  readonly abi: PreparedComponentAbiLookup;
}

interface OwnershipIndex {
  readonly unitTerminalOwner: ReadonlyMap<IrUnitId, IrUnitId | null>;
  readonly classTerminalOwner: ReadonlyMap<IrClassId, IrUnitId | null>;
}

interface MutableFunctionEvidence {
  readonly function: IrFunction;
  readonly terminalOwnerUnitId: IrUnitId;
  readonly unitDependencies: Map<string, PreparedComponentUnitDependency>;
  readonly abiDependencies: Map<string, PreparedComponentAbiDependency>;
  readonly externalCallables: Map<string, PreparedComponentExternalCallableDependency>;
  readonly failures: Map<string, PreparedComponentDependencyFailure>;
}

interface CanonicalAbiEntry {
  readonly requested: PreparedComponentAbiEntry;
  readonly canonical: PreparedComponentAbiEntry;
}

type CanonicalAbiResolution =
  | { readonly kind: "resolved"; readonly entry: CanonicalAbiEntry }
  | { readonly kind: "missing" }
  | { readonly kind: "cycle" };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new Map(entries);
}

function terminalInventoryUnit(inventory: IrUnitInventory, unitId: IrUnitId): IrTerminalUnitRecord | undefined {
  // R2 components are keyed by terminal executable ownership, not by syntax
  // family. Free functions, class members, and module init all carry the same
  // exact terminal-owner contract in the inventory.
  return inventory.terminalUnits.find((unit) => unit.id === unitId);
}

function buildOwnershipIndex(
  inventory: IrUnitInventory,
  derivedUnits: readonly ProgramAbiDerivedUnitRecord[],
): OwnershipIndex {
  const directUnitOwners = new Map<IrUnitId, IrUnitId | null>();
  for (const unit of inventory.allUnits) directUnitOwners.set(unit.id, unit.terminalOwnerId);
  for (const unit of derivedUnits) directUnitOwners.set(unit.id, unit.terminalOwnerId);

  const unitOwners = new Map<IrUnitId, IrUnitId | null>();
  const resolveUnit = (unitId: IrUnitId, visiting = new Set<IrUnitId>()): IrUnitId | null | undefined => {
    if (unitOwners.has(unitId)) return unitOwners.get(unitId)!;
    const direct = directUnitOwners.get(unitId);
    if (direct === undefined) return undefined;
    if (direct === null || direct === unitId) {
      unitOwners.set(unitId, direct);
      return direct;
    }
    if (visiting.has(unitId)) return undefined;
    const resolved = resolveUnit(direct, new Set(visiting).add(unitId));
    if (resolved === undefined) return undefined;
    unitOwners.set(unitId, resolved);
    return resolved;
  };
  for (const unitId of directUnitOwners.keys()) resolveUnit(unitId);

  const classRecords = new Map(inventory.classes.map((record) => [record.id, record] as const));
  const classOwners = new Map<IrClassId, IrUnitId | null>();
  const resolveClass = (classId: IrClassId, visiting = new Set<IrClassId>()): IrUnitId | null | undefined => {
    if (classOwners.has(classId)) return classOwners.get(classId)!;
    const record = classRecords.get(classId);
    if (!record) return undefined;
    if (record.lexicalOwnerId === null) {
      classOwners.set(classId, null);
      return null;
    }
    if (visiting.has(classId)) return undefined;
    const nextVisiting = new Set(visiting).add(classId);
    const nestedClass = classRecords.get(record.lexicalOwnerId as IrClassId);
    const resolved = nestedClass
      ? resolveClass(nestedClass.id, nextVisiting)
      : resolveUnit(record.lexicalOwnerId as IrUnitId);
    if (resolved === undefined) return undefined;
    classOwners.set(classId, resolved);
    return resolved;
  };
  for (const classId of classRecords.keys()) resolveClass(classId);
  return {
    unitTerminalOwner: readonlyMap(unitOwners),
    classTerminalOwner: readonlyMap(classOwners),
  };
}

function canonicalAbiEntry(abi: PreparedComponentAbiLookup, id: IrBindingId): CanonicalAbiResolution {
  const requested = abi.get(id);
  if (!requested) return { kind: "missing" };
  let canonical = requested;
  const visited = new Set<IrBindingId>();
  while (canonical.slotPolicy === "alias") {
    if (visited.has(canonical.id)) return { kind: "cycle" };
    visited.add(canonical.id);
    if (!canonical.aliasOf) return { kind: "missing" };
    const target = abi.get(canonical.aliasOf);
    if (!target) return { kind: "missing" };
    canonical = target;
  }
  return { kind: "resolved", entry: { requested, canonical } };
}

function terminalOwnerForIntent(intent: ProgramAbiIntent, ownership: OwnershipIndex): IrUnitId | null {
  if (intent.kind === "callable") {
    if (intent.unitId) return ownership.unitTerminalOwner.get(intent.unitId) ?? null;
    if (intent.classId) return ownership.classTerminalOwner.get(intent.classId) ?? null;
  }
  if (intent.kind === "global" && intent.unitId) {
    return ownership.unitTerminalOwner.get(intent.unitId) ?? null;
  }
  if (intent.kind === "class") return ownership.classTerminalOwner.get(intent.classId) ?? null;
  return null;
}

function failureKey(failure: PreparedComponentDependencyFailure): string {
  return [
    failure.code,
    failure.ownerUnitId,
    failure.referencedUnitId ?? "",
    failure.referencedClassId ?? "",
    failure.bindingId ?? "",
    failure.structuralReferenceKey ?? "",
    failure.detail,
  ].join("\u0000");
}

function addFailure(evidence: MutableFunctionEvidence, failure: PreparedComponentDependencyFailure): void {
  evidence.failures.set(failureKey(failure), Object.freeze(failure));
}

function addAbiDependency(
  evidence: MutableFunctionEvidence,
  abi: PreparedComponentAbiLookup,
  ownership: OwnershipIndex,
  input: {
    readonly bindingId: IrBindingId;
    readonly kind: PreparedComponentAbiDependencyKind;
    readonly structuralReferenceKey: string;
    readonly expected: (intent: ProgramAbiIntent) => boolean;
  },
): CanonicalAbiEntry | undefined {
  const resolution = canonicalAbiEntry(abi, input.bindingId);
  if (resolution.kind !== "resolved") {
    addFailure(evidence, {
      code: resolution.kind === "cycle" ? "abi-binding-cycle" : "unplanned-abi-binding",
      ownerUnitId: evidence.terminalOwnerUnitId,
      bindingId: input.bindingId,
      detail: `symbolic dependency ${input.structuralReferenceKey} has no resolvable Program ABI binding`,
    });
    return undefined;
  }
  const entry = resolution.entry;
  if (!input.expected(entry.requested.intent) || !input.expected(entry.canonical.intent)) {
    addFailure(evidence, {
      code: "abi-binding-contract-mismatch",
      ownerUnitId: evidence.terminalOwnerUnitId,
      bindingId: input.bindingId,
      detail: `symbolic dependency ${input.structuralReferenceKey} disagrees with its Program ABI intent`,
    });
    return undefined;
  }
  if (entry.requested.structuralReferenceKey !== input.structuralReferenceKey) {
    addFailure(evidence, {
      code: "abi-binding-contract-mismatch",
      ownerUnitId: evidence.terminalOwnerUnitId,
      bindingId: input.bindingId,
      detail:
        `symbolic dependency ${input.structuralReferenceKey} disagrees with Program ABI reference ` +
        `${entry.requested.structuralReferenceKey ?? "<missing>"}`,
    });
    return undefined;
  }
  const dependency = Object.freeze({
    ownerUnitId: evidence.terminalOwnerUnitId,
    kind: input.kind,
    bindingId: input.bindingId,
    canonicalBindingId: entry.canonical.id,
    structuralReferenceKey: input.structuralReferenceKey,
    terminalOwnerUnitId: terminalOwnerForIntent(entry.canonical.intent, ownership),
  });
  evidence.abiDependencies.set(`${input.kind}\u0000${input.bindingId}`, dependency);
  return entry;
}

function collectIrTypeClasses(type: IrType, classes: Map<IrClassId, IrClassShape>, seen: Set<IrType>): void {
  if (seen.has(type)) return;
  seen.add(type);
  switch (type.kind) {
    case "class":
      collectClassShape(type.shape, classes, seen);
      return;
    case "object":
      for (const field of type.shape.fields) collectIrTypeClasses(field.type, classes, seen);
      return;
    case "vec":
      collectIrTypeClasses(type.elementType, classes, seen);
      return;
    case "closure":
    case "callable":
      for (const param of type.signature.params) collectIrTypeClasses(param, classes, seen);
      if (type.signature.returnType) collectIrTypeClasses(type.signature.returnType, classes, seen);
      return;
    case "union":
      for (const member of type.members) collectIrTypeClasses(member, classes, seen);
      return;
    case "boxed":
      collectIrTypeClasses(type.inner, classes, seen);
      return;
    case "val":
    case "string":
    case "extern":
    case "dynamic":
      return;
  }
}

function recordImplicitTypeRequirement(
  evidence: MutableFunctionEvidence,
  type: IrType,
  seen: Set<IrType>,
  abi: PreparedComponentAbiLookup,
  ownership: OwnershipIndex,
): void {
  if (seen.has(type)) return;
  seen.add(type);
  const block = (detail: string): void => {
    addFailure(evidence, {
      code: "implicit-support-reference-unavailable",
      ownerUnitId: evidence.terminalOwnerUnitId,
      detail,
    });
  };
  switch (type.kind) {
    case "val":
      if (type.val.kind === "ref" || type.val.kind === "ref_null") {
        block(`raw IR reference type ${type.val.kind}:${type.val.typeIdx} has no symbolic Program ABI type ref`);
      }
      return;
    case "string": {
      const carrierRef = type.carrierRef;
      if (!carrierRef) {
        block("IR string type resolves through backend support without a symbolic Program ABI type ref");
        return;
      }
      recordSupportTypeReference(
        evidence,
        carrierRef,
        abi,
        ownership,
        "IR string carrier must use a compiler-support Program ABI type ref",
      );
      return;
    }
    case "vec": {
      if (!type.layout) {
        block("IR vec type resolves through backend support without a symbolic Program ABI layout");
        return;
      }
      if (
        !Number.isSafeInteger(type.layout.lengthFieldIndex) ||
        type.layout.lengthFieldIndex < 0 ||
        !Number.isSafeInteger(type.layout.dataFieldIndex) ||
        type.layout.dataFieldIndex < 0 ||
        type.layout.lengthFieldIndex === type.layout.dataFieldIndex
      ) {
        block("IR vec type carries an invalid prepared field layout");
        return;
      }
      recordSupportTypeReference(
        evidence,
        type.layout.carrierType,
        abi,
        ownership,
        "IR vec carrier must use a compiler-support Program ABI type ref",
      );
      recordSupportTypeReference(
        evidence,
        type.layout.dataType,
        abi,
        ownership,
        "IR vec backing array must use a compiler-support Program ABI type ref",
      );
      recordImplicitTypeRequirement(evidence, type.elementType, seen, abi, ownership);
      return;
    }
    case "object":
      block("IR object shape resolves a backend type without a symbolic Program ABI type ref");
      return;
    case "closure":
    case "callable":
      block(`IR ${type.kind} signature resolves backend callable/type support without a symbolic Program ABI ref`);
      return;
    case "union":
      block("IR union type resolves a backend type without a symbolic Program ABI type ref");
      return;
    case "boxed":
      block("IR boxed/ref-cell type resolves a backend type without a symbolic Program ABI type ref");
      return;
    case "dynamic":
      block("IR dynamic carrier resolves backend type/helper support without a symbolic Program ABI ref");
      return;
    case "class":
    case "extern":
      return;
  }
}

function recordSupportTypeReference(
  evidence: MutableFunctionEvidence,
  ref: IrTypeRef,
  abi: PreparedComponentAbiLookup,
  ownership: OwnershipIndex,
  invalidDetail: string,
): void {
  if (ref.binding.kind !== "support") {
    addFailure(evidence, {
      code: "implicit-support-reference-unavailable",
      ownerUnitId: evidence.terminalOwnerUnitId,
      detail: invalidDetail,
    });
    return;
  }
  let structuralReferenceKey: string;
  try {
    structuralReferenceKey = irTypeBindingKey(ref.binding);
  } catch {
    addFailure(evidence, {
      code: "implicit-support-reference-unavailable",
      ownerUnitId: evidence.terminalOwnerUnitId,
      detail: `${invalidDetail} (malformed binding)`,
    });
    return;
  }
  addAbiDependency(evidence, abi, ownership, {
    bindingId: ref.binding.bindingId,
    kind: "support",
    structuralReferenceKey,
    expected: (intent) => intent.kind === "type",
  });
}

function collectClassShape(shape: IrClassShape, classes: Map<IrClassId, IrClassShape>, seen: Set<IrType>): void {
  if (classes.has(shape.classId)) return;
  classes.set(shape.classId, shape);
  for (const field of shape.fields) collectIrTypeClasses(field.type, classes, seen);
  for (const method of shape.methods) {
    for (const param of method.params) collectIrTypeClasses(param, classes, seen);
    if (method.returnType) collectIrTypeClasses(method.returnType, classes, seen);
  }
  for (const param of shape.constructorParams) collectIrTypeClasses(param, classes, seen);
  if (shape.parent) collectClassShape(shape.parent, classes, seen);
}

function valueTypesOf(fn: IrFunction): Map<IrValueId, IrType> {
  const types = new Map<IrValueId, IrType>();
  for (const param of fn.params) types.set(param.value, param.type);
  for (const block of fn.blocks) {
    block.blockArgs.forEach((value, index) => {
      const type = block.blockArgTypes[index];
      if (type) types.set(value, type);
    });
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => {
        if (nested.result !== null && nested.resultType !== null) types.set(nested.result, nested.resultType);
      });
    }
  }
  return types;
}

function implicitSupportRequirement(instr: IrInstr): string | null {
  switch (instr.kind) {
    case "binary":
      return instr.op.startsWith("js.")
        ? `${instr.op} may resolve __unbox_number without an explicit symbolic callable ref`
        : null;
    case "raw.wasm":
      return "raw.wasm is opaque to symbolic dependency discovery";
    case "box":
    case "unbox":
    case "tag.test":
    case "dyn.truthy":
    case "dyn.to_number":
    case "dyn.eq":
    case "dyn.member_get":
    case "dyn.member_set":
      return `${instr.kind} resolves dynamic carrier/helper support without an explicit symbolic ref`;
    case "string.const":
      return instr.storage || instr.materializer
        ? null
        : `${instr.kind} resolves string globals/types/helpers without an explicit symbolic ref`;
    case "string.len":
      return instr.provider
        ? null
        : `${instr.kind} resolves string globals/types/helpers without an explicit symbolic ref`;
    case "string.concat":
    case "string.eq":
    case "string.char_at":
    case "string.char_code_at":
      return instr.provider ? null : `${instr.kind} resolves a string callable without an explicit symbolic ref`;
    case "forof.string":
      return instr.provider ? null : `${instr.kind} resolves a string callable without an explicit symbolic ref`;
    case "object.new":
    case "object.get":
    case "object.set":
      return `${instr.kind} resolves an object layout without an explicit symbolic type ref`;
    case "closure.new":
    case "closure.cap":
    case "closure.call":
      return `${instr.kind} resolves closure wrapper/type support beyond its explicit callable ref`;
    case "refcell.new":
    case "refcell.get":
    case "refcell.set":
      return `${instr.kind} resolves ref-cell type support without an explicit symbolic type ref`;
    case "vec.len":
    case "vec.get":
    case "vec.set":
    case "vec.set_length":
    case "vec.new_fixed":
    case "forof.vec":
      // Final vec types carry their carrier/backing-array refs. The type walk
      // above records both dependencies and fails closed for transitional raw
      // references or a missing layout.
      return null;
    case "iter.new":
    case "iter.next":
    case "iter.done":
    case "iter.value":
    case "iter.return":
    case "forof.iter":
      return `${instr.kind} resolves iterator runtime callables without explicit symbolic refs`;
    case "gen.push":
    case "gen.epilogue":
    case "gen.yieldStar":
    case "gen.setReturn":
      return `${instr.kind} resolves generator runtime callables without explicit symbolic refs`;
    case "throw":
    case "try":
      return `${instr.kind} resolves exception tag/support without an explicit symbolic ref`;
    case "extern.new":
    case "extern.call":
    case "extern.prop":
    case "extern.propSet":
    case "extern.regex":
      return `${instr.kind} resolves host/runtime callables or globals without explicit symbolic refs`;
    case "await":
    case "async.return":
    case "async.throw":
      return `${instr.kind} resolves async runtime support without explicit symbolic refs`;
    case "const":
    case "call":
    case "global.get":
    case "global.set":
    case "unary":
    case "select":
    case "if":
    case "class.new":
    case "class.alloc":
    case "class.get":
    case "class.set":
    case "class.call":
    case "class.super_init":
    case "class.super_call":
    case "class.instanceof":
    case "class.static_call":
    case "slot.read":
    case "slot.write":
    case "coerce.to_externref":
    case "early.return":
    case "while.loop":
    case "for.loop":
    case "br.label":
    case "if.stmt":
    case "labeled.block":
    case "switch":
      return null;
    default: {
      const exhaustive: never = instr;
      return `unknown IR instruction ${(exhaustive as { readonly kind?: unknown }).kind ?? "<missing>"}`;
    }
  }
}

function explicitClassShapes(instr: IrInstr, valueTypes: ReadonlyMap<IrValueId, IrType>): readonly IrClassShape[] {
  switch (instr.kind) {
    case "class.new":
    case "class.alloc":
    case "class.static_call":
      return [instr.shape];
    case "class.super_init":
    case "class.super_call":
      return [instr.parentShape];
    case "class.instanceof":
      return [instr.targetShape];
    case "class.get":
    case "class.set":
    case "class.call": {
      const receiver = valueTypes.get(instr.kind === "class.call" ? instr.receiver : instr.value);
      return receiver?.kind === "class" ? [receiver.shape] : [];
    }
    default:
      return [];
  }
}

function addClassLayout(
  evidence: MutableFunctionEvidence,
  shape: IrClassShape,
  candidateTerminalUnitIds: ReadonlySet<IrUnitId>,
  abi: PreparedComponentAbiLookup,
  ownership: OwnershipIndex,
): void {
  const terminalOwner = ownership.classTerminalOwner.get(shape.classId);
  if (terminalOwner === undefined) {
    addFailure(evidence, {
      code: "unknown-source-class",
      ownerUnitId: evidence.terminalOwnerUnitId,
      referencedClassId: shape.classId,
      detail: `class layout ${shape.classId} is absent from the source inventory`,
    });
    return;
  }
  if (terminalOwner !== null && !candidateTerminalUnitIds.has(terminalOwner)) {
    addFailure(evidence, {
      code: "foreign-source-class",
      ownerUnitId: evidence.terminalOwnerUnitId,
      referencedClassId: shape.classId,
      detail: `class layout ${shape.classId} belongs to non-candidate terminal ${terminalOwner}`,
    });
    return;
  }
  const ref = irClassTypeRef(shape.classId, shape.className);
  addAbiDependency(evidence, abi, ownership, {
    bindingId: ref.binding.bindingId,
    kind: "class-layout",
    structuralReferenceKey: irTypeBindingKey(ref.binding),
    expected: (intent) => intent.kind === "class" && intent.classId === shape.classId,
  });
}

function recordUnitReference(
  evidence: MutableFunctionEvidence,
  targetUnitId: IrUnitId,
  functionsByUnitId: ReadonlyMap<IrUnitId, IrFunction>,
  candidateTerminalUnitIds: ReadonlySet<IrUnitId>,
  abi: PreparedComponentAbiLookup,
  ownership: OwnershipIndex,
): void {
  const targetOwner = ownership.unitTerminalOwner.get(targetUnitId);
  if (targetOwner === undefined || targetOwner === null) {
    addFailure(evidence, {
      code: "unknown-source-unit",
      ownerUnitId: evidence.terminalOwnerUnitId,
      referencedUnitId: targetUnitId,
      detail: `unit-bound symbolic reference ${targetUnitId} has no terminal source owner`,
    });
    return;
  }
  if (!candidateTerminalUnitIds.has(targetOwner)) {
    addFailure(evidence, {
      code: "foreign-source-unit",
      ownerUnitId: evidence.terminalOwnerUnitId,
      referencedUnitId: targetUnitId,
      detail: `unit-bound symbolic reference ${targetUnitId} belongs to non-candidate terminal ${targetOwner}`,
    });
    return;
  }
  const bindingId = irUnitCallableBindingId(targetUnitId);
  evidence.unitDependencies.set(
    `${targetUnitId}\u0000${targetOwner}`,
    Object.freeze({
      ownerUnitId: evidence.terminalOwnerUnitId,
      referencedUnitId: targetUnitId,
      terminalOwnerUnitId: targetOwner,
      programAbiBindingId: bindingId,
    }),
  );
  if (!functionsByUnitId.has(targetUnitId)) {
    addFailure(evidence, {
      code: "missing-function-body",
      ownerUnitId: evidence.terminalOwnerUnitId,
      referencedUnitId: targetUnitId,
      detail: `unit-bound symbolic reference ${targetUnitId} has no post-pass IR function`,
    });
    return;
  }
  const entry = addAbiDependency(evidence, abi, ownership, {
    bindingId,
    kind: "source-callable",
    structuralReferenceKey: irCallableBindingKey({ kind: "unit", unitId: targetUnitId }),
    expected: (intent) => intent.kind === "callable" && intent.origin === "source" && intent.unitId === targetUnitId,
  });
  if (!entry) return;
}

function recordGlobalReference(
  evidence: MutableFunctionEvidence,
  ref: IrGlobalRef,
  abi: PreparedComponentAbiLookup,
  ownership: OwnershipIndex,
  terminalUnitIds: ReadonlySet<IrUnitId>,
): void {
  const key = irGlobalBindingKey(ref.binding);
  const expectedOrigin = ref.binding.kind;
  const entry = addAbiDependency(evidence, abi, ownership, {
    bindingId: ref.binding.bindingId,
    kind: expectedOrigin === "source" ? "source-global" : expectedOrigin === "support" ? "support" : "external-global",
    structuralReferenceKey: key,
    expected: (intent) =>
      intent.kind === "global" &&
      (expectedOrigin === "source" || expectedOrigin === "support" ? intent.origin === expectedOrigin : true),
  });
  if (entry && ref.binding.kind === "source") {
    const storageTerminalOwner = terminalOwnerForIntent(entry.canonical.intent, ownership);
    if (storageTerminalOwner === null || !terminalUnitIds.has(storageTerminalOwner)) {
      addFailure(evidence, {
        code: "source-global-outside-component",
        ownerUnitId: evidence.terminalOwnerUnitId,
        ...(storageTerminalOwner === null ? {} : { referencedUnitId: storageTerminalOwner }),
        bindingId: ref.binding.bindingId,
        detail:
          storageTerminalOwner === null
            ? `source global ${key} has no exact terminal storage owner in the Program ABI contract`
            : `source global ${key} belongs to non-candidate storage terminal ${storageTerminalOwner}`,
      });
    }
  }
}

function recordExternalCallable(
  evidence: MutableFunctionEvidence,
  ref: Extract<IrInstr, { kind: "call" }>["target"],
  abi: PreparedComponentAbiLookup,
  ownership: OwnershipIndex,
): void {
  const key = irCallableBindingKey(ref.binding);
  if (ref.binding.kind === "support") {
    addAbiDependency(evidence, abi, ownership, {
      bindingId: ref.binding.bindingId,
      kind: "support",
      structuralReferenceKey: key,
      expected: (intent) => intent.kind === "callable" && intent.origin === "support",
    });
    return;
  }
  const reverseIds = abi.bindingIdsForStructuralReference?.(key);
  const matches = reverseIds
    ? reverseIds.flatMap((id) => {
        const entry = abi.get(id);
        return entry ? [entry] : [];
      })
    : (abi.entries?.() ?? []).filter((entry) => entry.structuralReferenceKey === key);
  if (matches.length > 1) {
    addFailure(evidence, {
      code: "abi-binding-contract-mismatch",
      ownerUnitId: evidence.terminalOwnerUnitId,
      detail: `external callable ${key} maps to ${matches.length} Program ABI identities`,
    });
    return;
  }
  const match = matches[0];
  if (!match) {
    addFailure(evidence, {
      code: "unplanned-abi-binding",
      ownerUnitId: evidence.terminalOwnerUnitId,
      structuralReferenceKey: key,
      detail:
        `external callable ${key} has no Program ABI identity; planning-time discovery requires ` +
        "an exact structural-key reverse lookup",
    });
  } else {
    addAbiDependency(evidence, abi, ownership, {
      bindingId: match.id,
      kind: "external-callable",
      structuralReferenceKey: key,
      expected: (intent) => intent.kind === "callable" && intent.origin !== "source",
    });
  }
  evidence.externalCallables.set(
    key,
    Object.freeze({
      ownerUnitId: evidence.terminalOwnerUnitId,
      structuralReferenceKey: key,
      programAbiBindingId: match?.id ?? null,
    }),
  );
}

function collectFunctionEvidence(
  fn: IrFunction,
  terminalOwnerUnitId: IrUnitId,
  input: DerivePreparedComponentDependenciesInput,
  ownership: OwnershipIndex,
  functionsByUnitId: ReadonlyMap<IrUnitId, IrFunction>,
): MutableFunctionEvidence {
  const evidence: MutableFunctionEvidence = {
    function: fn,
    terminalOwnerUnitId,
    unitDependencies: new Map(),
    abiDependencies: new Map(),
    externalCallables: new Map(),
    failures: new Map(),
  };
  const valueTypes = valueTypesOf(fn);
  const classes = new Map<IrClassId, IrClassShape>();
  const seenTypes = new Set<IrType>();
  const seenImplicitTypes = new Set<IrType>();
  const collectType = (type: IrType): void => {
    collectIrTypeClasses(type, classes, seenTypes);
    recordImplicitTypeRequirement(evidence, type, seenImplicitTypes, input.abi, ownership);
  };
  for (const param of fn.params) collectType(param.type);
  for (const result of fn.resultTypes) collectType(result);
  if (fn.closureSubtype) {
    for (const capture of fn.closureSubtype.captureFieldTypes) collectType(capture);
  }

  for (const block of fn.blocks) {
    for (const type of block.blockArgTypes) collectType(type);
    for (const instr of block.instrs) {
      forEachInstrDeep(instr, (nested) => {
        if (nested.resultType) collectType(nested.resultType);
        for (const shape of explicitClassShapes(nested, valueTypes)) collectClassShape(shape, classes, seenTypes);
        const implicitSupport = implicitSupportRequirement(nested);
        if (implicitSupport) {
          addFailure(evidence, {
            code: "implicit-support-reference-unavailable",
            ownerUnitId: terminalOwnerUnitId,
            detail: implicitSupport,
          });
        }
        if (nested.kind === "call") {
          if (nested.target.binding.kind === "unit") {
            recordUnitReference(
              evidence,
              nested.target.binding.unitId,
              functionsByUnitId,
              input.terminalUnitIds,
              input.abi,
              ownership,
            );
          } else {
            recordExternalCallable(evidence, nested.target, input.abi, ownership);
          }
        } else if (nested.kind === "closure.new") {
          if (nested.liftedFunc.binding.kind === "unit") {
            recordUnitReference(
              evidence,
              nested.liftedFunc.binding.unitId,
              functionsByUnitId,
              input.terminalUnitIds,
              input.abi,
              ownership,
            );
          } else {
            recordExternalCallable(evidence, nested.liftedFunc, input.abi, ownership);
          }
        } else if (nested.kind === "global.get" || nested.kind === "global.set") {
          recordGlobalReference(evidence, nested.target, input.abi, ownership, input.terminalUnitIds);
        } else if (nested.kind === "string.const") {
          if (nested.storage) {
            recordGlobalReference(evidence, nested.storage, input.abi, ownership, input.terminalUnitIds);
          } else if (nested.materializer) {
            recordExternalCallable(evidence, nested.materializer, input.abi, ownership);
          }
        } else if (nested.kind === "string.len" && nested.provider) {
          if (nested.provider.kind === "callable") {
            recordExternalCallable(evidence, nested.provider.target, input.abi, ownership);
          } else {
            recordSupportTypeReference(
              evidence,
              nested.provider.ownerType,
              input.abi,
              ownership,
              "IR string.len struct field must use a compiler-support Program ABI type ref",
            );
          }
        } else if (
          (nested.kind === "string.concat" ||
            nested.kind === "string.eq" ||
            nested.kind === "string.char_at" ||
            nested.kind === "string.char_code_at" ||
            nested.kind === "forof.string") &&
          nested.provider
        ) {
          recordExternalCallable(evidence, nested.provider, input.abi, ownership);
        }
        if (
          nested.kind === "class.call" ||
          nested.kind === "class.super_init" ||
          nested.kind === "class.super_call" ||
          nested.kind === "class.static_call" ||
          nested.kind === "class.new"
        ) {
          const shape = explicitClassShapes(nested, valueTypes)[0];
          const target = nested.target;
          if (!target) {
            addFailure(evidence, {
              code: "class-member-callable-unavailable",
              ownerUnitId: terminalOwnerUnitId,
              ...(shape ? { referencedClassId: shape.classId } : {}),
              detail:
                `${nested.kind} carries a class/member descriptor but no exact symbolic callable reference; ` +
                "dependency ownership cannot be inferred from compatibility names",
            });
          } else if (target.binding.kind === "unit") {
            recordUnitReference(
              evidence,
              target.binding.unitId,
              functionsByUnitId,
              input.terminalUnitIds,
              input.abi,
              ownership,
            );
          } else {
            recordExternalCallable(evidence, target, input.abi, ownership);
          }
        }
      });
    }
  }
  for (const shape of classes.values()) {
    addClassLayout(evidence, shape, input.terminalUnitIds, input.abi, ownership);
  }
  return evidence;
}

class ComponentUnion {
  readonly #parent = new Map<IrUnitId, IrUnitId>();

  constructor(unitIds: Iterable<IrUnitId>) {
    for (const unitId of unitIds) this.#parent.set(unitId, unitId);
  }

  find(unitId: IrUnitId): IrUnitId {
    const parent = this.#parent.get(unitId);
    if (!parent) throw new Error(`unknown component terminal ${unitId}`);
    if (parent === unitId) return unitId;
    const root = this.find(parent);
    this.#parent.set(unitId, root);
    return root;
  }

  connect(left: IrUnitId, right: IrUnitId): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    this.#parent.set(
      compareText(leftRoot, rightRoot) <= 0 ? rightRoot : leftRoot,
      compareText(leftRoot, rightRoot) <= 0 ? leftRoot : rightRoot,
    );
  }
}

function freezeComponent(
  terminalUnitIds: readonly IrUnitId[],
  evidence: readonly MutableFunctionEvidence[],
): PreparedComponentDependencyEvidence {
  const unitDependencies = evidence.flatMap((item) => [...item.unitDependencies.values()]);
  const abiDependencies = evidence.flatMap((item) => [...item.abiDependencies.values()]);
  const externalCallables = evidence.flatMap((item) => [...item.externalCallables.values()]);
  const failures = evidence.flatMap((item) => [...item.failures.values()]);
  const functionUnitIds = evidence.map((item) => item.function.unitId).sort(compareText);
  const distinct = <T>(items: readonly T[], key: (item: T) => string): readonly T[] =>
    Object.freeze([...new Map(items.map((item) => [key(item), item] as const)).values()]);
  const exactFailures = distinct(failures, failureKey);
  return Object.freeze({
    id: `prepared-component:${terminalUnitIds.join("+")}`,
    status: exactFailures.length === 0 ? ("complete" as const) : ("blocked" as const),
    terminalUnitIds: Object.freeze([...terminalUnitIds]),
    functionUnitIds: Object.freeze(functionUnitIds),
    unitDependencies: distinct(
      unitDependencies,
      (item) => `${item.ownerUnitId}\u0000${item.referencedUnitId}\u0000${item.terminalOwnerUnitId}`,
    ),
    abiDependencies: distinct(
      abiDependencies,
      (item) => `${item.ownerUnitId}\u0000${item.kind}\u0000${item.bindingId}`,
    ),
    externalCallables: distinct(externalCallables, (item) => `${item.ownerUnitId}\u0000${item.structuralReferenceKey}`),
    failures: exactFailures,
  });
}

/**
 * Derive component-atomic dependency evidence from the final post-pass IR.
 *
 * Exact unit references close the terminal component as an undirected
 * ownership graph. Every directly encoded global/support/class-layout
 * identity is reconciled against Program ABI evidence. Source globals remain
 * blocked until their terminal storage owner is explicit. Class call sites
 * close over exact callable targets when present; compatibility nodes without
 * one remain blocked rather than guessing from a member name.
 */
export function derivePreparedComponentDependencies(
  input: DerivePreparedComponentDependenciesInput,
): PreparedComponentDependencyReport {
  const ownership = buildOwnershipIndex(input.inventory, input.derivedUnits ?? []);
  const functionsByUnitId = new Map(input.module.functions.map((fn) => [fn.unitId, fn] as const));
  const evidence: MutableFunctionEvidence[] = [];
  const globalFailures = new Map<IrUnitId, PreparedComponentDependencyFailure[]>();

  for (const terminalUnitId of input.terminalUnitIds) {
    if (!terminalInventoryUnit(input.inventory, terminalUnitId)) {
      globalFailures.set(terminalUnitId, [
        Object.freeze({
          code: "unknown-component-terminal",
          ownerUnitId: terminalUnitId,
          detail: `prepared component denominator includes unknown terminal ${terminalUnitId}`,
        }),
      ]);
    }
  }
  for (const fn of input.module.functions) {
    const terminalOwner = ownership.unitTerminalOwner.get(fn.unitId);
    if (terminalOwner === undefined || terminalOwner === null || !input.terminalUnitIds.has(terminalOwner)) continue;
    evidence.push(collectFunctionEvidence(fn, terminalOwner, input, ownership, functionsByUnitId));
  }
  for (const terminalUnitId of input.terminalUnitIds) {
    if (!evidence.some((item) => item.terminalOwnerUnitId === terminalUnitId)) {
      const failures = globalFailures.get(terminalUnitId) ?? [];
      failures.push(
        Object.freeze({
          code: "missing-function-body",
          ownerUnitId: terminalUnitId,
          detail: `prepared component terminal ${terminalUnitId} has no post-pass IR function`,
        }),
      );
      globalFailures.set(terminalUnitId, failures);
    }
  }

  const union = new ComponentUnion(input.terminalUnitIds);
  for (const item of evidence) {
    for (const dependency of item.unitDependencies.values()) {
      union.connect(item.terminalOwnerUnitId, dependency.terminalOwnerUnitId);
    }
    for (const dependency of item.abiDependencies.values()) {
      if (
        dependency.kind === "source-global" &&
        dependency.terminalOwnerUnitId !== null &&
        input.terminalUnitIds.has(dependency.terminalOwnerUnitId)
      ) {
        union.connect(item.terminalOwnerUnitId, dependency.terminalOwnerUnitId);
      }
    }
  }
  const terminalsByRoot = new Map<IrUnitId, IrUnitId[]>();
  for (const terminalUnitId of input.terminalUnitIds) {
    const root = union.find(terminalUnitId);
    const terminals = terminalsByRoot.get(root) ?? [];
    terminals.push(terminalUnitId);
    terminalsByRoot.set(root, terminals);
  }
  const components = [...terminalsByRoot.values()]
    .map((terminalUnitIds) => {
      terminalUnitIds.sort(compareText);
      const componentEvidence = evidence.filter((item) => terminalUnitIds.includes(item.terminalOwnerUnitId));
      for (const terminalUnitId of terminalUnitIds) {
        const failures = globalFailures.get(terminalUnitId);
        if (!failures) continue;
        const holder =
          componentEvidence.find((item) => item.terminalOwnerUnitId === terminalUnitId) ??
          ({
            function: { unitId: terminalUnitId } as IrFunction,
            terminalOwnerUnitId: terminalUnitId,
            unitDependencies: new Map(),
            abiDependencies: new Map(),
            externalCallables: new Map(),
            failures: new Map(),
          } satisfies MutableFunctionEvidence);
        for (const failure of failures) addFailure(holder, failure);
        if (!componentEvidence.includes(holder)) componentEvidence.push(holder);
      }
      return freezeComponent(terminalUnitIds, componentEvidence);
    })
    .sort((left, right) => compareText(left.id, right.id));
  const componentByTerminalUnitId = new Map<IrUnitId, PreparedComponentDependencyEvidence>();
  for (const component of components) {
    for (const terminalUnitId of component.terminalUnitIds) {
      componentByTerminalUnitId.set(terminalUnitId, component);
    }
  }
  return Object.freeze({
    components: Object.freeze(components),
    componentByTerminalUnitId: readonlyMap(componentByTerminalUnitId),
  });
}
