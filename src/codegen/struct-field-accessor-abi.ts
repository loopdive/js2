// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// struct-field-accessor-abi.ts — #3520 C34.
//
// The per-field host accessor family (`__sget_<f>`, `__sset_<f>`, `__shas_<f>`,
// `__sbool_<f>`) was the last large population of defined functions with no
// semantic Program ABI owner. Without an owner each accessor fell through to the
// generic `retained-module-function` role, whose derived ordinal is the
// function's FINAL INDEX — a value that moves whenever any unrelated import or
// function is added or eliminated. That is a positional label, not an identity,
// and it is exactly what R1 exists to remove.
//
// This module gives the family one canonical entry-source-owned role. Identity
// is `(entry source, "struct-field-accessor", ordinal)` where the ordinal is
// derived from the accessor KIND plus the field name's position in the
// module's canonically SORTED accessor field-name list. Two consequences follow
// and are both covered by tests:
//
//   * the ordinal does not depend on emission order, so reversing the order in
//     which the emitters visit fields cannot change an identity; and
//   * the ordinal does not depend on the function's index, so a late import or
//     a dead-slot compaction cannot move it.
//
// The display name (`__sget_value`) stays a label. It never participates in the
// binding key, so a user function spelled the same way cannot occupy the role.

import type { WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncHandleOf } from "./func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-planning.js";
import type { ProgramAbiEntrySourceSupportObservation } from "./program-abi-callable-planning.js";

export const STRUCT_FIELD_ACCESSOR_ROLE = "struct-field-accessor";

/**
 * Accessor kinds in one closed table.
 *
 * The value is the low component of the derived ordinal, so it must stay stable
 * and must never exceed {@link STRUCT_FIELD_ACCESSOR_KIND_STRIDE}.
 */
export const STRUCT_FIELD_ACCESSOR_KIND = Object.freeze({
  get: 0,
  set: 1,
  has: 2,
  bool: 3,
} as const);

export type StructFieldAccessorKind = keyof typeof STRUCT_FIELD_ACCESSOR_KIND;

/** Ordinal stride reserved per field name. Must exceed every kind value. */
export const STRUCT_FIELD_ACCESSOR_KIND_STRIDE = 4;

interface RecordedStructFieldAccessor {
  readonly kind: StructFieldAccessorKind;
  readonly fieldName: string;
  readonly func: WasmFunction;
}

const recordedStructFieldAccessors = new WeakMap<CodegenContext, RecordedStructFieldAccessor[]>();
const observedStructFieldAccessorContexts = new WeakSet<CodegenContext>();

/**
 * Record one emitted accessor by its EXACT allocator object.
 *
 * Recording is deliberately separate from planning: the getter and setter
 * emitters are wrapped in a non-fatal `try`/`catch`, so a Program ABI invariant
 * raised inside them would be swallowed and the compile would silently return a
 * module whose accessor family had no owner. Recording cannot throw; the
 * observation pass that can runs outside those guards.
 */
export function recordStructFieldAccessor(
  ctx: CodegenContext,
  kind: StructFieldAccessorKind,
  fieldName: string,
  func: WasmFunction,
): void {
  if (fieldName.length === 0) return;
  let recorded = recordedStructFieldAccessors.get(ctx);
  if (!recorded) {
    recorded = [];
    recordedStructFieldAccessors.set(ctx, recorded);
  }
  recorded.push({ kind, fieldName, func });
}

/**
 * Canonical field-name order for the accessor family.
 *
 * Sorted by UTF-16 code unit, which is total over the recorded names and
 * independent of the order the emitters happened to visit them in.
 */
export function structFieldAccessorFieldOrder(fieldNames: Iterable<string>): readonly string[] {
  return [...new Set(fieldNames)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Derived ordinal for one accessor within the canonical field order. */
export function structFieldAccessorDerivedOrdinal(
  fieldOrder: readonly string[],
  kind: StructFieldAccessorKind,
  fieldName: string,
): number | undefined {
  const position = fieldOrder.indexOf(fieldName);
  if (position < 0) return undefined;
  return position * STRUCT_FIELD_ACCESSOR_KIND_STRIDE + STRUCT_FIELD_ACCESSOR_KIND[kind];
}

/**
 * Hand the recorded family to the retained-callable registry as one batch.
 *
 * Runs after dead-import/function elimination has settled the final layout, so
 * an accessor the module no longer contains is simply absent rather than
 * claimed as an owner of a slot that is gone. Duplicate (kind, field) records
 * for the same exact function are collapsed; a duplicate carrying a DIFFERENT
 * function object is left to the registry's contradictory-ownership invariant.
 *
 * The canonical field order is computed over the PRE-ELISION record, following
 * the R1a rule that a retained support node keeps the ID it was assigned before
 * a dead-binding pass ran. Deriving it from the surviving subset instead would
 * make a survivor's ordinal depend on whether some unrelated accessor was
 * eliminated — reintroducing, in a smaller form, exactly the positional
 * coupling this role exists to remove. Eliminated accessors are simply absent.
 */
export function observeStructFieldAccessorAbi(ctx: CodegenContext): void {
  if (observedStructFieldAccessorContexts.has(ctx)) return;
  const registry = ctx.programAbiCallables;
  if (!registry) return;
  const recorded = recordedStructFieldAccessors.get(ctx);
  if (!recorded || recorded.length === 0) return;
  observedStructFieldAccessorContexts.add(ctx);

  const fieldOrder = structFieldAccessorFieldOrder(recorded.map((entry) => entry.fieldName));
  const live = recorded.filter((entry) => definedFuncHandleOf(ctx, entry.func) !== undefined);
  if (live.length === 0) return;
  const observations: ProgramAbiEntrySourceSupportObservation[] = [];
  const claimed = new Map<number, WasmFunction>();
  for (const entry of live) {
    const derivedOrdinal = structFieldAccessorDerivedOrdinal(fieldOrder, entry.kind, entry.fieldName);
    if (derivedOrdinal === undefined) continue;
    // An identical re-record of the same exact object is inert. A SECOND object
    // claiming one (kind, field) slot is a real ownership contradiction, so it
    // is forwarded and the registry's duplicate-slot invariant rejects it.
    if (claimed.get(derivedOrdinal) === entry.func) continue;
    claimed.set(derivedOrdinal, entry.func);
    const funcIdx = definedFuncHandleOf(ctx, entry.func);
    if (funcIdx === undefined) continue;
    observations.push({
      role: STRUCT_FIELD_ACCESSOR_ROLE,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.structFieldAccessor,
      derivedOrdinal,
      displayName: entry.func.name,
      funcIdx,
    });
  }
  if (observations.length === 0) return;
  registry.observeEntrySourceSupports(observations);
}
