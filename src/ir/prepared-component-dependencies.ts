// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  arePairedIrModuleGlobalBindingIds,
  irClassTypeRef,
  irGlobalBindingKey,
  irTypeBindingKey,
} from "./abi-bindings.js";
import { irCallableBindingKey, irUnitCallableBindingId } from "./callable-bindings.js";
import { IR_STRING_REPEAT_FN } from "./string-runtime.js";
import type { IrBindingId, IrClassId, IrTerminalUnitRecord, IrUnitId, IrUnitInventory } from "./identity.js";
import {
  forEachInstrDeep,
  type IrClassShape,
  type IrFuncRef,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrModule,
  type IrType,
  type IrTypeRef,
  type IrValueId,
  type IrVecLayoutRef,
} from "./nodes.js";
import type { ProgramAbiDerivedUnitRecord, ProgramAbiIntent, ProgramAbiPlanEntry } from "./program-abi.js";
import {
  capabilityGlobalIntentMatches,
  externalCallableIntentMatches,
  hasExactRequiredCapabilityGlobal,
} from "./capability-abi-validation.js";
import {
  buildPreparedComponentOwnershipIndex,
  type PreparedComponentOwnershipIndex as OwnershipIndex,
} from "./prepared-component-ownership.js";
import {
  preparedDynamicCarrierRef,
  preparedInstructionSupport,
  type PreparedClassAccessorWritebackEvidence,
  type PreparedComponentClosureSupportEvidence,
  type PreparedDynamicInstructionSupportEvidence,
  type PreparedInstructionSupportSidecars,
} from "./prepared-instruction-support.js";
export type {
  PreparedClassAccessorWritebackEvidence,
  PreparedComponentClosureSupportEvidence,
  PreparedDynamicInstructionSupportEvidence,
  PreparedInstructionSupportSidecars,
} from "./prepared-instruction-support.js";

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
  /** Exact, structurally certified source-owned dependency borrowed by a bounded class accessor. */
  readonly borrowing?:
    | { readonly kind: "nested-accessor-class-layout" }
    | {
        readonly kind: "class-setter-writeback-global";
        readonly dynamicCarrierBindingId: IrBindingId;
      }
    | {
        readonly kind: "class-setter-writeback-tdz-global";
        readonly valueGlobalBindingId: IrBindingId;
      };
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
  readonly closureSupport?: PreparedComponentClosureSupportEvidence;
  /** Final IR proved exception ops and the shared tag was reserved before sealing. */
  readonly exceptionSupportPrepared?: boolean;
  readonly classAccessorWritebacks?: ReadonlyMap<IrUnitId, PreparedClassAccessorWritebackEvidence>;
  readonly dynamicInstructionSupport?: ReadonlyMap<IrUnitId, PreparedDynamicInstructionSupportEvidence>;
  readonly abi: PreparedComponentAbiLookup;
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
    case "fnctor":
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
  dynamicCarrierRef?: IrTypeRef,
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
        if (!type.typeRef) {
          block(`raw IR reference type ${type.val.kind}:${type.val.typeIdx} has no symbolic Program ABI type ref`);
          return;
        }
        recordSupportTypeReference(
          evidence,
          type.typeRef,
          abi,
          ownership,
          "IR physical reference carrier must use a compiler-support Program ABI type ref",
        );
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
      recordImplicitTypeRequirement(evidence, type.elementType, seen, abi, ownership, dynamicCarrierRef);
      return;
    }
    case "object":
      block("IR object shape resolves a backend type without a symbolic Program ABI type ref");
      return;
    case "fnctor":
      block("IR fnctor type requires an exact prepared ABI resolver/layout and cannot use object/class fallback");
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
      if (!dynamicCarrierRef) {
        block("IR dynamic carrier resolves backend type/helper support without a symbolic Program ABI ref");
        return;
      }
      recordSupportTypeReference(
        evidence,
        dynamicCarrierRef,
        abi,
        ownership,
        "IR dynamic carrier must use a compiler-support Program ABI type ref",
      );
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
  for (const value of fn.asyncPlan?.values ?? []) types.set(value.value, value.type);
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

function reachableAsyncPlanVecTypes(fn: IrFunction): ReadonlySet<IrType> {
  const vectors = new Set<IrType>();
  const seen = new Set<IrType>();
  const collectType = (type: IrType): void => {
    if (seen.has(type)) return;
    seen.add(type);
    switch (type.kind) {
      case "vec":
        vectors.add(type);
        collectType(type.elementType);
        return;
      case "object":
        for (const field of type.shape.fields) collectType(field.type);
        return;
      case "closure":
      case "callable":
        for (const param of type.signature.params) collectType(param);
        if (type.signature.returnType) collectType(type.signature.returnType);
        return;
      case "union":
        for (const member of type.members) collectType(member);
        return;
      case "boxed":
        collectType(type.inner);
        return;
      case "val":
      case "string":
      case "class":
      case "extern":
      case "dynamic":
        return;
    }
  };
  const collectInstr = (instr: IrInstr): void => {
    forEachInstrDeep(instr, (nested) => {
      if (nested.resultType) collectType(nested.resultType);
      switch (nested.kind) {
        case "const":
          if (nested.value.kind === "null") collectType(nested.value.ty);
          return;
        case "box":
          collectType(nested.toType);
          return;
        case "object.new":
          for (const field of nested.shape.fields) collectType(field.type);
          return;
        case "closure.new":
          for (const param of nested.signature.params) collectType(param);
          if (nested.signature.returnType) collectType(nested.signature.returnType);
          for (const capture of nested.captureFieldTypes) collectType(capture);
          return;
        case "vec.new_fixed":
        case "forof.vec":
          collectType(nested.elementType);
          return;
        default:
          return;
      }
    });
  };
  const plan = fn.asyncPlan;
  if (!plan) return vectors;
  if (plan.abi.fulfillmentType) collectType(plan.abi.fulfillmentType);
  for (const value of plan.params) collectType(value.type);
  for (const value of plan.values) collectType(value.type);
  for (const spill of plan.spills) collectType(spill.type);
  for (const state of plan.states) {
    if (state.resume) collectType(state.resume.type);
    for (const instr of state.body) collectInstr(instr);
  }
  return vectors;
}

function samePreparedVecLayout(left: IrVecLayoutRef, right: IrVecLayoutRef): boolean {
  return (
    irTypeBindingKey(left.carrierType.binding) === irTypeBindingKey(right.carrierType.binding) &&
    irTypeBindingKey(left.dataType.binding) === irTypeBindingKey(right.dataType.binding) &&
    left.lengthFieldIndex === right.lengthFieldIndex &&
    left.dataFieldIndex === right.dataFieldIndex
  );
}

function implicitSupportRequirement(
  instr: IrInstr,
  valueTypes: ReadonlyMap<IrValueId, IrType>,
  hasPreparedSupport = false,
  exceptionSupportPrepared = false,
): string | null {
  switch (instr.kind) {
    case "binary": {
      if (!instr.op.startsWith("js.")) return null;
      const concreteNumeric = (value: IrValueId): boolean => {
        const type = valueTypes.get(value);
        if (!type || type.kind !== "val") return false;
        return type.val.kind === "f64" || type.val.kind === "i32";
      };
      return concreteNumeric(instr.lhs) && concreteNumeric(instr.rhs)
        ? null
        : `${instr.op} may resolve __unbox_number without an explicit symbolic callable ref`;
    }
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
      return hasPreparedSupport
        ? null
        : `${instr.kind} resolves dynamic carrier/helper support without an explicit symbolic ref`;
    case "string.const":
      return instr.storage || instr.materializer
        ? null
        : `${instr.kind} resolves string globals/types/helpers without an explicit symbolic ref`;
    case "string.len":
      return instr.provider
        ? null
        : `${instr.kind} resolves string globals/types/helpers without an explicit symbolic ref`;
    case "string.concat":
    case "string.repeat":
    case "string.eq":
    case "string.char_at":
    case "string.char_code_at":
      return instr.provider ? null : `${instr.kind} resolves a string callable without an explicit symbolic ref`;
    case "forof.string":
      return instr.provider ? null : `${instr.kind} resolves a string callable without an explicit symbolic ref`;
    case "object.new":
    case "object.get":
    case "object.set":
      return hasPreparedSupport
        ? null
        : `${instr.kind} resolves an object layout without an explicit symbolic type ref`;
    case "closure.new":
    case "closure.cap":
    case "closure.call":
      return hasPreparedSupport
        ? null
        : `${instr.kind} resolves closure wrapper/type support beyond its explicit callable ref`;
    case "refcell.new":
    case "refcell.get":
    case "refcell.set":
      return hasPreparedSupport
        ? null
        : `${instr.kind} resolves ref-cell type support without an explicit symbolic type ref`;
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
      return instr.provider
        ? null
        : `${instr.kind} resolves generator runtime callables without explicit symbolic refs`;
    case "gen.setReturn": {
      if (!instr.provider) {
        return `${instr.kind} resolves generator runtime callables without explicit symbolic refs`;
      }
      // The boxing helper is a second, type-dependent callable. Fail closed
      // unless the attachment agrees with the value type lowering will see.
      const val = valueTypes.get(instr.value);
      const needsBoxing = val?.kind === "val" && (val.val.kind === "f64" || val.val.kind === "i32");
      return needsBoxing === (instr.boxProvider !== undefined)
        ? null
        : `${instr.kind} boxing attachment disagrees with its stashed value type`;
    }
    case "throw":
      return exceptionSupportPrepared
        ? null
        : `${instr.kind} resolves exception tag/support without an explicit symbolic ref`;
    case "try":
      return exceptionSupportPrepared
        ? null
        : `${instr.kind} resolves exception tag/support without prepared final-IR evidence`;
    case "extern.new":
    case "extern.call":
    case "extern.prop":
    case "extern.propSet":
      return instr.provider
        ? null
        : `${instr.kind} resolves host/runtime callables or globals without explicit symbolic refs`;
    case "extern.regex":
      // Besides RegExp_new, this instruction materializes pattern and flags
      // through backend-selected string storage. Keep it fail-closed until
      // all three symbolic dependencies are attached together.
      return `${instr.kind} resolves host/runtime callables or globals without explicit symbolic refs`;
    case "await":
    case "async.return":
    case "async.throw":
      return `${instr.kind} resolves async runtime support without explicit symbolic refs`;
    case "const":
    case "call":
    case "intrinsic":
      return instr.kind === "intrinsic" && !instr.provider
        ? `${instr.kind} has no provider from the frozen runtime manifest`
        : null;
    case "global.get":
    case "global.set":
    case "unary":
    case "select":
    case "if":
    case "class.new":
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
    case "fnctor.new":
    case "fnctor.get":
      return `${instr.kind} requires an explicit fnctor ABI resolver and prepared component support`;
    default: {
      const exhaustive: never = instr;
      return `unknown IR instruction ${(exhaustive as { readonly kind?: unknown }).kind ?? "<missing>"}`;
    }
  }
}

function explicitClassShapes(instr: IrInstr, valueTypes: ReadonlyMap<IrValueId, IrType>): readonly IrClassShape[] {
  switch (instr.kind) {
    case "class.new":
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
  inventory: IrUnitInventory,
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
  const terminal = terminalInventoryUnit(inventory, evidence.terminalOwnerUnitId);
  const borrowsOwnNestedClassLayout =
    terminalOwner !== null &&
    terminal?.containingTerminalOwnerId === terminalOwner &&
    terminal.lexicalOwnerId === shape.classId &&
    (terminal.kind === "class-constructor" ||
      terminal.kind === "class-instance-method" ||
      terminal.kind === "class-instance-getter" ||
      terminal.kind === "class-static-getter" ||
      terminal.kind === "class-instance-setter" ||
      terminal.kind === "class-static-setter");
  if (terminalOwner !== null && !candidateTerminalUnitIds.has(terminalOwner) && !borrowsOwnNestedClassLayout) {
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
  if (borrowsOwnNestedClassLayout && !candidateTerminalUnitIds.has(terminalOwner)) {
    const key = `class-layout\u0000${ref.binding.bindingId}`;
    const dependency = evidence.abiDependencies.get(key);
    if (dependency) {
      evidence.abiDependencies.set(
        key,
        Object.freeze({ ...dependency, borrowing: { kind: "nested-accessor-class-layout" as const } }),
      );
    }
  }
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

/**
 * An implicit constructor is source-identifiable but has no terminal source
 * body. Preparation installs its exact `_init` support body; derived support
 * bodies additionally forward to their parent `_init`. Treat the non-terminal
 * callable as sealed support and let the caller record the parent chain.
 *
 * (#3522) This holds for a NESTED implicit constructor too. Its `terminalOwnerId`
 * names the enclosing executable rather than being null, but its `_init` is the
 * same AST-free support body — it is deliberately NOT a post-pass IR function,
 * so routing it to `recordUnitReference` would always report a spurious
 * `missing-function-body`. Preparedness is not assumed here: `addAbiDependency`
 * resolves the support binding and fails closed with `unplanned-abi-binding`
 * when this transaction did not actually prepare the unit.
 *
 * The discriminant is NON-TERMINALITY, not a null terminal owner. Since the
 * #4402 initialized-field checkpoint an implicit constructor with initialized
 * instance fields is an ORDINARY TERMINAL class-member owner carrying a real
 * source body, and it must keep flowing through `recordUnitReference` as a
 * source callable. Testing `terminalOwnerId === null` conflated the two: it
 * excluded terminal initialized-field constructors and genuine nested support
 * for the same incidental reason.
 */
function recordImplicitConstructorSupportReference(
  evidence: MutableFunctionEvidence,
  targetUnitId: IrUnitId,
  input: DerivePreparedComponentDependenciesInput,
  ownership: OwnershipIndex,
): boolean {
  const unit = input.inventory.allUnits.find(({ id }) => id === targetUnitId);
  const isTerminal = input.inventory.terminalUnits.some(({ id }) => id === targetUnitId);
  if (unit?.kind !== "class-implicit-constructor" || isTerminal) return false;
  const bindingId = irUnitCallableBindingId(targetUnitId);
  addAbiDependency(evidence, input.abi, ownership, {
    bindingId,
    kind: "support",
    structuralReferenceKey: irCallableBindingKey({ kind: "unit", unitId: targetUnitId }),
    expected: (intent) => intent.kind === "callable" && intent.origin === "source" && intent.unitId === targetUnitId,
  });
  return true;
}

function recordClassConstructorInitReference(
  evidence: MutableFunctionEvidence,
  shape: IrClassShape,
  input: DerivePreparedComponentDependenciesInput,
  ownership: OwnershipIndex,
  functionsByUnitId: ReadonlyMap<IrUnitId, IrFunction>,
  visitedClassIds: Set<IrClassId> = new Set(),
): void {
  if (visitedClassIds.has(shape.classId)) {
    addFailure(evidence, {
      code: "implicit-support-reference-unavailable",
      ownerUnitId: evidence.terminalOwnerUnitId,
      referencedClassId: shape.classId,
      detail: `implicit constructor parent chain cycles through class ${shape.classId}`,
    });
    return;
  }
  visitedClassIds.add(shape.classId);
  const initTarget = shape.constructorInitTarget;
  if (initTarget?.binding.kind !== "unit") {
    addFailure(evidence, {
      code: "class-member-callable-unavailable",
      ownerUnitId: evidence.terminalOwnerUnitId,
      referencedClassId: shape.classId,
      detail: "class.new has no exact source-owned constructor init dependency",
    });
    return;
  }
  if (recordImplicitConstructorSupportReference(evidence, initTarget.binding.unitId, input, ownership)) {
    if (shape.parent) {
      recordClassConstructorInitReference(evidence, shape.parent, input, ownership, functionsByUnitId, visitedClassIds);
    }
    return;
  }
  recordUnitReference(
    evidence,
    initTarget.binding.unitId,
    functionsByUnitId,
    input.terminalUnitIds,
    input.abi,
    ownership,
  );
}

function recordGlobalReference(
  evidence: MutableFunctionEvidence,
  ref: IrGlobalRef,
  abi: PreparedComponentAbiLookup,
  ownership: OwnershipIndex,
  terminalUnitIds: ReadonlySet<IrUnitId>,
  writeback?: PreparedClassAccessorWritebackEvidence,
): void {
  const key = irGlobalBindingKey(ref.binding);
  const expectedOrigin = ref.binding.kind;
  const expectedCapability = ref.binding.kind === "source" ? ref.binding.capability : undefined;
  const entry = addAbiDependency(evidence, abi, ownership, {
    bindingId: ref.binding.bindingId,
    kind: expectedOrigin === "source" ? "source-global" : expectedOrigin === "support" ? "support" : "external-global",
    structuralReferenceKey: key,
    expected: (intent) => capabilityGlobalIntentMatches(intent, expectedOrigin, expectedCapability),
  });
  if (entry && expectedCapability === "dom" && !hasExactRequiredCapabilityGlobal(entry, ref.binding.bindingId)) {
    evidence.abiDependencies.delete(`source-global\u0000${ref.binding.bindingId}`);
    addFailure(evidence, {
      code: "abi-binding-contract-mismatch",
      ownerUnitId: evidence.terminalOwnerUnitId,
      bindingId: ref.binding.bindingId,
      detail: `capability source global ${key} does not own its exact canonical allocator binding`,
    });
    return;
  }
  if (entry && ref.binding.kind === "source") {
    const storageTerminalOwner = terminalOwnerForIntent(entry.canonical.intent, ownership);
    if (storageTerminalOwner === null || !terminalUnitIds.has(storageTerminalOwner)) {
      const callable = canonicalAbiEntry(abi, irUnitCallableBindingId(evidence.terminalOwnerUnitId));
      const requestedGlobal = entry.requested.intent;
      const canonicalGlobal = entry.canonical.intent;
      const requestedCallable = callable.kind === "resolved" ? callable.entry.requested.intent : undefined;
      const canonicalCallable = callable.kind === "resolved" ? callable.entry.canonical.intent : undefined;
      const carrier = writeback ? canonicalAbiEntry(abi, writeback.dynamicCarrierRef.binding.bindingId) : undefined;
      const exactDynamicWriteback =
        writeback?.valueGlobalBindingId === ref.binding.bindingId &&
        requestedGlobal.kind === "global" &&
        requestedGlobal.origin === "source" &&
        requestedGlobal.mutable &&
        requestedGlobal.valueType === writeback.dynamicCarrierValueType &&
        canonicalGlobal.kind === "global" &&
        canonicalGlobal.origin === "source" &&
        canonicalGlobal.mutable &&
        canonicalGlobal.valueType === writeback.dynamicCarrierValueType &&
        requestedCallable?.kind === "callable" &&
        requestedCallable.origin === "source" &&
        requestedCallable.unitId === evidence.terminalOwnerUnitId &&
        requestedCallable.signature.params.length === 2 &&
        requestedCallable.signature.params[1] === writeback.dynamicCarrierValueType &&
        requestedCallable.signature.results.length === 0 &&
        canonicalCallable?.kind === "callable" &&
        canonicalCallable.origin === "source" &&
        canonicalCallable.unitId === evidence.terminalOwnerUnitId &&
        canonicalCallable.signature.params.length === 2 &&
        canonicalCallable.signature.params[1] === writeback.dynamicCarrierValueType &&
        canonicalCallable.signature.results.length === 0 &&
        carrier?.kind === "resolved" &&
        carrier.entry.requested.intent.kind === "type" &&
        carrier.entry.canonical.intent.kind === "type";
      if (exactDynamicWriteback) {
        const dependencyKey = `source-global\u0000${ref.binding.bindingId}`;
        const dependency = evidence.abiDependencies.get(dependencyKey);
        if (dependency) {
          evidence.abiDependencies.set(
            dependencyKey,
            Object.freeze({
              ...dependency,
              borrowing: {
                kind: "class-setter-writeback-global" as const,
                dynamicCarrierBindingId: writeback.dynamicCarrierRef.binding.bindingId,
              },
            }),
          );
          return;
        }
      }
      const requestedValueGlobal = writeback ? canonicalAbiEntry(abi, writeback.valueGlobalBindingId) : undefined;
      const requestedTdzGlobal = entry.requested.intent;
      const canonicalTdzGlobal = entry.canonical.intent;
      const valueRequestedIntent =
        requestedValueGlobal?.kind === "resolved" ? requestedValueGlobal.entry.requested.intent : undefined;
      const valueCanonicalIntent =
        requestedValueGlobal?.kind === "resolved" ? requestedValueGlobal.entry.canonical.intent : undefined;
      const exactTdzWriteback =
        writeback?.tdzGlobalBindingId === ref.binding.bindingId &&
        arePairedIrModuleGlobalBindingIds(writeback.valueGlobalBindingId, writeback.tdzGlobalBindingId) &&
        requestedTdzGlobal.kind === "global" &&
        requestedTdzGlobal.origin === "source" &&
        requestedTdzGlobal.mutable &&
        requestedTdzGlobal.valueType === JSON.stringify({ kind: "i32" }) &&
        canonicalTdzGlobal.kind === "global" &&
        canonicalTdzGlobal.origin === "source" &&
        canonicalTdzGlobal.mutable &&
        canonicalTdzGlobal.valueType === JSON.stringify({ kind: "i32" }) &&
        valueRequestedIntent?.kind === "global" &&
        valueRequestedIntent.origin === "source" &&
        requestedValueGlobal?.kind === "resolved" &&
        arePairedIrModuleGlobalBindingIds(requestedValueGlobal.entry.requested.id, entry.requested.id) &&
        valueRequestedIntent.sourceId === requestedTdzGlobal.sourceId &&
        valueRequestedIntent.unitId === requestedTdzGlobal.unitId &&
        valueCanonicalIntent?.kind === "global" &&
        valueCanonicalIntent.origin === "source" &&
        requestedValueGlobal?.kind === "resolved" &&
        arePairedIrModuleGlobalBindingIds(requestedValueGlobal.entry.canonical.id, entry.canonical.id) &&
        valueCanonicalIntent.sourceId === canonicalTdzGlobal.sourceId &&
        valueCanonicalIntent.unitId === canonicalTdzGlobal.unitId;
      if (exactTdzWriteback) {
        const dependencyKey = `source-global\u0000${ref.binding.bindingId}`;
        const dependency = evidence.abiDependencies.get(dependencyKey);
        if (dependency) {
          evidence.abiDependencies.set(
            dependencyKey,
            Object.freeze({
              ...dependency,
              borrowing: {
                kind: "class-setter-writeback-tdz-global" as const,
                valueGlobalBindingId: writeback.valueGlobalBindingId,
              },
            }),
          );
          return;
        }
      }
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
  ref: IrFuncRef,
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
      expected: (intent) =>
        externalCallableIntentMatches(intent, ref.binding) &&
        (ref.binding.kind !== "intrinsic" ||
          ref.binding.symbol !== IR_STRING_REPEAT_FN ||
          (intent.kind === "callable" &&
            intent.signature.params.length === 2 &&
            intent.signature.params[1] === '{"kind":"f64"}' &&
            intent.signature.results.length === 1 &&
            intent.signature.params[0] === intent.signature.results[0] &&
            (intent.signature.params[0] === '{"kind":"externref"}' ||
              intent.signature.params[0] === '{"kind":"i32"}' ||
              intent.signature.params[0]?.startsWith('{"kind":"ref"')))),
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

function recordConstructorNewSupportDependency(
  evidence: MutableFunctionEvidence,
  fn: IrFunction,
  terminalOwnerUnitId: IrUnitId,
  input: DerivePreparedComponentDependenciesInput,
  ownership: OwnershipIndex,
): void {
  if (terminalInventoryUnit(input.inventory, terminalOwnerUnitId)?.kind !== "class-constructor") return;
  const receiverType = fn.params.at(-1)?.type;
  const constructorTarget = receiverType?.kind === "class" ? receiverType.shape.constructorTarget : undefined;
  if (receiverType?.kind !== "class" || constructorTarget?.binding.kind !== "support") {
    addFailure(evidence, {
      code: "class-member-callable-unavailable",
      ownerUnitId: terminalOwnerUnitId,
      ...(receiverType?.kind === "class" ? { referencedClassId: receiverType.shape.classId } : {}),
      detail: "prepared constructor init has no exact class-owned _new support dependency",
    });
    return;
  }
  // The constructor IR body is `<Class>_init`, so it contains no `class.new`
  // instruction of its own. Pin the AST-free allocation wrapper explicitly
  // in the same prepared transaction.
  recordExternalCallable(evidence, constructorTarget, input.abi, ownership);
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
  const reachableAsyncVectors = reachableAsyncPlanVecTypes(fn);
  const fulfilledAsyncVectors = new Set(
    (fn.asyncPlan?.states ?? []).flatMap((state) =>
      state.resume?.source === "fulfilled" && state.resume.type.kind === "vec" ? [state.resume.type] : [],
    ),
  );
  const preparedAsyncLayouts = new Map<IrType, IrVecLayoutRef>();
  for (const entry of fn.asyncRuntime?.typeLayouts ?? []) {
    if (entry.logicalType.kind !== "vec") {
      addFailure(evidence, {
        code: "implicit-support-reference-unavailable",
        ownerUnitId: terminalOwnerUnitId,
        detail: `prepared async layout is attached to non-vector IR type ${entry.logicalType.kind}`,
      });
      continue;
    }
    if (!reachableAsyncVectors.has(entry.logicalType)) {
      addFailure(evidence, {
        code: "implicit-support-reference-unavailable",
        ownerUnitId: terminalOwnerUnitId,
        detail: "prepared async vec layout is dangling from the exact final async-plan type objects",
      });
      continue;
    }
    if (preparedAsyncLayouts.has(entry.logicalType)) {
      addFailure(evidence, {
        code: "implicit-support-reference-unavailable",
        ownerUnitId: terminalOwnerUnitId,
        detail: "prepared async vec type has duplicate backend layout sidecars",
      });
      continue;
    }
    if (entry.logicalType.layout && !samePreparedVecLayout(entry.logicalType.layout, entry.layout)) {
      addFailure(evidence, {
        code: "implicit-support-reference-unavailable",
        ownerUnitId: terminalOwnerUnitId,
        detail: "prepared async vec sidecar disagrees with the logical type's existing layout",
      });
      continue;
    }
    preparedAsyncLayouts.set(entry.logicalType, entry.layout);
    const needsFromExtern = fulfilledAsyncVectors.has(entry.logicalType);
    if (needsFromExtern !== (entry.fromExtern !== undefined)) {
      addFailure(evidence, {
        code: "implicit-support-reference-unavailable",
        ownerUnitId: terminalOwnerUnitId,
        detail: needsFromExtern
          ? "prepared fulfilled async vec type has no exact extern materializer"
          : "prepared async vec layout carries a materializer outside an exact fulfilled resume type",
      });
    } else if (entry.fromExtern) {
      recordExternalCallable(evidence, entry.fromExtern, input.abi, ownership);
    }
  }
  for (const type of reachableAsyncVectors) {
    if (preparedAsyncLayouts.has(type)) continue;
    addFailure(evidence, {
      code: "implicit-support-reference-unavailable",
      ownerUnitId: terminalOwnerUnitId,
      detail: "prepared async vec type has no exact backend layout sidecar",
    });
  }
  const recordPreparedClosureRefs = (
    refs: readonly IrTypeRef[] | undefined,
    detail: string,
    allowEmpty = false,
  ): boolean => {
    // A present empty collection is meaningful evidence: callable carriers
    // lower directly to externref and require no Wasm support type. Absence,
    // by contrast, remains a closed-world preparation failure.
    if (!refs || (!allowEmpty && refs.length === 0)) return false;
    for (const ref of refs) recordSupportTypeReference(evidence, ref, input.abi, ownership, detail);
    return true;
  };
  const collectType = (type: IrType): void => {
    collectIrTypeClasses(type, classes, seenTypes);
    const preparedAsyncLayout = preparedAsyncLayouts.get(type);
    if (preparedAsyncLayout) {
      if (type.kind !== "vec") {
        addFailure(evidence, {
          code: "implicit-support-reference-unavailable",
          ownerUnitId: terminalOwnerUnitId,
          detail: `prepared async layout is attached to non-vector IR type ${type.kind}`,
        });
        return;
      }
      if (
        !Number.isSafeInteger(preparedAsyncLayout.lengthFieldIndex) ||
        preparedAsyncLayout.lengthFieldIndex < 0 ||
        !Number.isSafeInteger(preparedAsyncLayout.dataFieldIndex) ||
        preparedAsyncLayout.dataFieldIndex < 0 ||
        preparedAsyncLayout.lengthFieldIndex === preparedAsyncLayout.dataFieldIndex
      ) {
        addFailure(evidence, {
          code: "implicit-support-reference-unavailable",
          ownerUnitId: terminalOwnerUnitId,
          detail: "prepared async vec type carries an invalid field layout",
        });
        return;
      }
      recordSupportTypeReference(
        evidence,
        preparedAsyncLayout.carrierType,
        input.abi,
        ownership,
        "prepared async vec carrier must use a compiler-support Program ABI type ref",
      );
      recordSupportTypeReference(
        evidence,
        preparedAsyncLayout.dataType,
        input.abi,
        ownership,
        "prepared async vec backing array must use a compiler-support Program ABI type ref",
      );
      collectType(type.elementType);
      return;
    }
    const preparedRefs = input.closureSupport?.typeRefs.get(type);
    if (
      (type.kind === "closure" || type.kind === "callable" || type.kind === "boxed" || type.kind === "object") &&
      recordPreparedClosureRefs(
        preparedRefs,
        `prepared IR ${type.kind} type must use Program ABI support refs`,
        type.kind === "callable",
      )
    ) {
      if (type.kind === "boxed") {
        collectType(type.inner);
      } else if (type.kind === "object") {
        for (const field of type.shape.fields) collectType(field.type);
      } else {
        for (const param of type.signature.params) collectType(param);
        if (type.signature.returnType) collectType(type.signature.returnType);
      }
      return;
    }
    recordImplicitTypeRequirement(
      evidence,
      type,
      seenImplicitTypes,
      input.abi,
      ownership,
      preparedDynamicCarrierRef(terminalOwnerUnitId, input),
    );
  };
  for (const param of fn.params) collectType(param.type);
  for (const result of fn.resultTypes) collectType(result);
  recordConstructorNewSupportDependency(evidence, fn, terminalOwnerUnitId, input, ownership);
  if (fn.asyncPlan) {
    if (fn.asyncPlan.abi.fulfillmentType) collectType(fn.asyncPlan.abi.fulfillmentType);
    for (const value of fn.asyncPlan.values) collectType(value.type);
    for (const spill of fn.asyncPlan.spills) collectType(spill.type);
  }
  if (fn.closureSubtype) {
    for (const capture of fn.closureSubtype.captureFieldTypes) collectType(capture);
  }
  const functionClosureSupport = input.closureSupport?.functionRefs.get(fn);
  recordPreparedClosureRefs(
    functionClosureSupport,
    "prepared IR lifted closure body must use Program ABI support refs",
  );

  const collectInstr = (instr: IrInstr): void => {
    const classAccessorWriteback = input.classAccessorWritebacks?.get(terminalOwnerUnitId);
    forEachInstrDeep(instr, (nested) => {
      if (nested.resultType) collectType(nested.resultType);
      for (const shape of explicitClassShapes(nested, valueTypes)) collectClassShape(shape, classes, seenTypes);
      const support = preparedInstructionSupport(
        nested,
        terminalOwnerUnitId,
        valueTypes,
        functionClosureSupport,
        input,
      );
      recordPreparedClosureRefs(support.typeRefs, `prepared IR ${nested.kind} must use Program ABI support refs`);
      for (const target of support.callableRefs) recordExternalCallable(evidence, target, input.abi, ownership);
      const exceptionTagTypeRef = nested.kind === "throw" ? classAccessorWriteback?.tdzExceptionTagTypeRef : undefined;
      if (exceptionTagTypeRef) {
        recordSupportTypeReference(
          evidence,
          exceptionTagTypeRef,
          input.abi,
          ownership,
          "prepared TDZ throw must use the singleton Program ABI exception-tag type ref",
        );
      }
      const implicitSupport = implicitSupportRequirement(
        nested,
        valueTypes,
        support.hasPreparedSupport,
        input.exceptionSupportPrepared === true || exceptionTagTypeRef !== undefined,
      );
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
      } else if (nested.kind === "intrinsic") {
        if (nested.provider?.kind === "callable") {
          recordExternalCallable(evidence, nested.provider.target, input.abi, ownership);
        }
      } else if (
        (nested.kind === "extern.new" ||
          nested.kind === "extern.call" ||
          nested.kind === "extern.prop" ||
          nested.kind === "extern.propSet") &&
        nested.provider
      ) {
        recordExternalCallable(evidence, nested.provider, input.abi, ownership);
      } else if (
        (nested.kind === "gen.push" ||
          nested.kind === "gen.epilogue" ||
          nested.kind === "gen.yieldStar" ||
          nested.kind === "gen.setReturn") &&
        nested.provider
      ) {
        // #2951 — the generator runtime callables are ordinary external
        // callables once they are symbolic. `gen.setReturn` may also pin the
        // boxing helper for a numeric stashed value.
        recordExternalCallable(evidence, nested.provider, input.abi, ownership);
        if (nested.kind === "gen.setReturn" && nested.boxProvider) {
          recordExternalCallable(evidence, nested.boxProvider, input.abi, ownership);
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
        recordGlobalReference(
          evidence,
          nested.target,
          input.abi,
          ownership,
          input.terminalUnitIds,
          classAccessorWriteback,
        );
      } else if (nested.kind === "string.const") {
        if (nested.storage) {
          recordGlobalReference(
            evidence,
            nested.storage,
            input.abi,
            ownership,
            input.terminalUnitIds,
            classAccessorWriteback,
          );
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
          nested.kind === "string.repeat" ||
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
        // `class.new` lowers through the AST-free `<Class>_new` support
        // wrapper above, but that wrapper tail-calls the exact source-owned
        // `<Class>_init`. Keep the semantic source edge explicit so sealing
        // unions a constructing caller with every constructor body it executes,
        // including the parent chain of a synthesized derived forwarder.
        if (nested.kind === "class.new") {
          if (shape) {
            recordClassConstructorInitReference(evidence, shape, input, ownership, functionsByUnitId);
          } else {
            addFailure(evidence, {
              code: "class-member-callable-unavailable",
              ownerUnitId: terminalOwnerUnitId,
              detail: "class.new has no exact class shape for constructor dependency sealing",
            });
          }
        }
      }
    });
  };
  // A prepared async source callable is lowered exclusively from its semantic
  // state plan. Its original AST-lowered block is retained as provenance for
  // diagnostics, but scanning it would invent dependencies on the discarded
  // `await`/boxing path and prevent the real state-plan component from sealing.
  if (!fn.asyncPlan) {
    for (const block of fn.blocks) {
      for (const type of block.blockArgTypes) collectType(type);
      for (const instr of block.instrs) collectInstr(instr);
    }
  }
  for (const state of fn.asyncRuntime?.states ?? fn.asyncPlan?.states ?? []) {
    if (state.resume) collectType(state.resume.type);
    for (const instr of state.body) collectInstr(instr);
  }
  for (const adapter of fn.asyncRuntime?.adapters ?? []) {
    recordExternalCallable(evidence, adapter.target, input.abi, ownership);
  }
  for (const shape of classes.values()) {
    addClassLayout(evidence, shape, input.terminalUnitIds, input.abi, ownership, input.inventory);
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
 * identity is reconciled against Program ABI evidence. Terminals sharing one
 * canonical class layout form one atomic component. Source globals remain
 * blocked until their terminal storage owner is explicit. Class call sites
 * close over exact callable targets when present; compatibility nodes without
 * one remain blocked rather than guessing from a member name.
 */
export function derivePreparedComponentDependencies(
  input: DerivePreparedComponentDependenciesInput,
): PreparedComponentDependencyReport {
  const ownership = buildPreparedComponentOwnershipIndex(input.inventory, input.derivedUnits ?? []);
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
  const classLayoutOwner = new Map<IrBindingId, IrUnitId>();
  for (const item of evidence) {
    for (const dependency of item.unitDependencies.values()) {
      union.connect(item.terminalOwnerUnitId, dependency.terminalOwnerUnitId);
    }
    for (const dependency of item.abiDependencies.values()) {
      if (dependency.kind === "class-layout") {
        const previousOwner = classLayoutOwner.get(dependency.canonicalBindingId);
        if (previousOwner === undefined) {
          classLayoutOwner.set(dependency.canonicalBindingId, item.terminalOwnerUnitId);
        } else {
          union.connect(item.terminalOwnerUnitId, previousOwner);
        }
      }
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
