// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { StructTypeDef, TypeDef, ValType, WasmModule } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { reportErrorNoNode } from "./context/errors.js";

// Declaration collection can temporarily detach/rebuild explicit edges while
// later source files resolve inherited field types. Sealing is therefore a
// monotonic declaration fact, not something body codegen may infer solely from
// the current `superTypeIdx` graph.
const sealedNominalStructParents = new WeakMap<CodegenContext, Set<number>>();

/** Wasm-level equality for mutable struct fields (source-only carrier brands are erased). */
export function samePhysicalValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "ref" || left.kind === "ref_null") {
    return left.typeIdx === (right as typeof left).typeIdx;
  }
  return true;
}

/**
 * Every field of a WasmGC supertype must remain an exact physical prefix of a
 * subtype when, as in compiler-owned interface layouts, those fields are
 * mutable. Names are included because generated struct.get indices also rely
 * on the source property occupying the same slot throughout the hierarchy.
 */
export function hasStructPrefix(child: StructTypeDef, parent: StructTypeDef): boolean {
  if (child.fields.length < parent.fields.length) return false;
  return parent.fields.every((parentField, index) => {
    const childField = child.fields[index];
    return (
      childField !== undefined &&
      childField.name === parentField.name &&
      childField.mutable === parentField.mutable &&
      samePhysicalValType(childField.type, parentField.type)
    );
  });
}

/** Whether a GC struct ref can flow to a declared nominal ancestor unchanged. */
export function isDeclaredStructRefSubtypeAssignable(mod: WasmModule, actual: ValType, expected: ValType): boolean {
  if (
    (actual.kind !== "ref" && actual.kind !== "ref_null") ||
    (expected.kind !== "ref" && expected.kind !== "ref_null") ||
    (actual.kind === "ref_null" && expected.kind === "ref")
  ) {
    return false;
  }

  let current: number | undefined = actual.typeIdx;
  for (let depth = 0; current !== undefined && depth <= mod.types.length; depth++) {
    if (current === expected.typeIdx) return true;
    const definition: TypeDef | undefined = mod.types[current];
    if (!definition || definition.kind !== "struct") return false;
    const parent: number | undefined = definition.superTypeIdx;
    if (parent === undefined || parent < 0) return false;
    current = parent;
  }
  return false;
}

/** Nearest nominal struct ancestor shared by two GC references, including either input itself. */
export function nearestDeclaredStructCommonAncestor(
  mod: WasmModule,
  left: ValType,
  right: ValType,
): number | undefined {
  if ((left.kind !== "ref" && left.kind !== "ref_null") || (right.kind !== "ref" && right.kind !== "ref_null")) {
    return undefined;
  }

  const leftAncestors = new Set<number>();
  let current: number | undefined = left.typeIdx;
  for (let depth = 0; current !== undefined && depth <= mod.types.length; depth++) {
    leftAncestors.add(current);
    const definition: TypeDef | undefined = mod.types[current];
    if (!definition || definition.kind !== "struct") break;
    const parent: number | undefined = definition.superTypeIdx;
    if (parent === undefined || parent < 0) break;
    current = parent;
  }

  current = right.typeIdx;
  for (let depth = 0; current !== undefined && depth <= mod.types.length; depth++) {
    if (leftAncestors.has(current)) return current;
    const definition: TypeDef | undefined = mod.types[current];
    if (!definition || definition.kind !== "struct") break;
    const parent: number | undefined = definition.superTypeIdx;
    if (parent === undefined || parent < 0) break;
    current = parent;
  }
  return undefined;
}

/** True when `typeIdx` is already the physical prefix of a declared struct subtype. */
export function isNominalStructParent(mod: WasmModule, typeIdx: number): boolean {
  return mod.types.some(
    (candidate, candidateIdx) =>
      candidateIdx !== typeIdx && candidate.kind === "struct" && candidate.superTypeIdx === typeIdx,
  );
}

/** Permanently freeze a declaration-time nominal parent for this compilation. */
export function sealNominalStructParent(ctx: CodegenContext, typeIdx: number): void {
  let sealed = sealedNominalStructParents.get(ctx);
  if (!sealed) {
    sealed = new Set<number>();
    sealedNominalStructParents.set(ctx, sealed);
  }
  sealed.add(typeIdx);
}

/**
 * Whether body-time shape discovery must not append fields to this struct.
 * The live edge scan covers non-interface hierarchy producers; the persistent
 * sidecar covers interface edges while multi-source resolution rebuilds them.
 */
export function isSealedNominalStructParent(ctx: CodegenContext, typeIdx: number): boolean {
  return sealedNominalStructParents.get(ctx)?.has(typeIdx) === true || isNominalStructParent(ctx.mod, typeIdx);
}

function wouldCreateStructCycle(mod: WasmModule, childIdx: number, parentIdx: number): boolean {
  for (let current = parentIdx, depth = 0; depth < mod.types.length; depth++) {
    if (current === childIdx) return true;
    const currentType = mod.types[current];
    if (!currentType || currentType.kind !== "struct") return false;
    const next = currentType.superTypeIdx;
    if (next === undefined || next < 0) return false;
    current = next;
  }
  return true;
}

/**
 * Give a flattened structural interface one representable declared ancestor.
 *
 * TypeScript permits merged interfaces and multiple inheritance, while WasmGC
 * permits only one nominal supertype. Declaration collection therefore leaves
 * those shapes flat by default. A later ABI may nevertheless require a real
 * upcast to one of the interface's declared ancestors (typed construction is
 * the current caller). When the child's physical layout already contains an
 * exact mutable-field prefix for such an ancestor, installing that one edge is
 * lossless: the remaining TypeScript bases continue to use the structural
 * projection machinery.
 *
 * Candidates are tried from the largest prefix to the smallest so a merged
 * `SourceFile extends Declaration, LocalsContainer` links through Declaration
 * (and transitively Node), rather than skipping useful intermediate fields and
 * linking straight to Node. Nothing is changed unless the child is currently
 * flat, the parent precedes it in the type section, and the exact WasmGC prefix
 * and acyclic-chain invariants hold.
 */
export function linkCompatibleDeclaredStructAncestor(
  ctx: CodegenContext,
  childIdx: number,
  candidateParentIdxs: readonly number[],
): number | undefined {
  const child = ctx.mod.types[childIdx];
  if (!child || child.kind !== "struct" || child.superTypeIdx !== undefined) return undefined;

  const candidates = [...new Set(candidateParentIdxs)]
    .filter((parentIdx) => parentIdx >= 0 && parentIdx < childIdx)
    .map((parentIdx) => ({ parentIdx, parent: ctx.mod.types[parentIdx] }))
    .filter(
      (entry): entry is { parentIdx: number; parent: StructTypeDef } =>
        entry.parent?.kind === "struct" && entry.parent.final !== true,
    )
    .sort((left, right) => right.parent.fields.length - left.parent.fields.length);

  for (const { parentIdx, parent } of candidates) {
    if (!hasStructPrefix(child, parent) || wouldCreateStructCycle(ctx.mod, childIdx, parentIdx)) continue;
    sealNominalStructParent(ctx, parentIdx);
    if (parent.superTypeIdx === undefined) parent.superTypeIdx = -1;
    child.superTypeIdx = parentIdx;
    return parentIdx;
  }
  return undefined;
}

function invalidHierarchyReason(mod: WasmModule, childIdx: number, child: StructTypeDef): string | undefined {
  const parentIdx = child.superTypeIdx;
  if (parentIdx === undefined || parentIdx < 0) return undefined;
  const parent = mod.types[parentIdx];
  if (!parent || parent.kind !== "struct") return `supertype #${parentIdx} is not a struct`;
  if (parent.final === true) return `supertype #${parentIdx} (${parent.name}) is final`;
  if (parent.superTypeIdx === undefined) {
    return `supertype #${parentIdx} (${parent.name}) was not emitted as an open hierarchy type`;
  }
  if (!hasStructPrefix(child, parent)) {
    return `supertype #${parentIdx} (${parent.name}) is no longer an exact mutable-field prefix`;
  }

  const seen = new Set<number>([childIdx]);
  let current = parentIdx;
  for (let depth = 0; depth <= mod.types.length; depth++) {
    if (seen.has(current)) return `supertype chain contains a cycle through #${current}`;
    seen.add(current);
    const currentType = mod.types[current];
    if (!currentType || currentType.kind !== "struct") return undefined;
    const next = currentType.superTypeIdx;
    if (next === undefined || next < 0) return undefined;
    current = next;
  }
  return "supertype chain did not terminate";
}

/**
 * Last pre-DCE safety gate for explicit GC struct hierarchies. Dynamic field
 * discovery is allowed to grow ordinary structural carriers while bodies are
 * compiled, but a nominal parent is a frozen prefix: changing it after a child
 * copied the prefix makes the type section invalid and also invalidates every
 * no-op child-to-parent upcast already emitted. Producer guards prevent that;
 * this audit makes any missed producer a hard compile diagnostic rather than
 * letting the engine discover an opaque `invalid explicit supertype` later.
 */
export function validateFinalStructHierarchies(ctx: CodegenContext): boolean {
  let valid = true;
  for (let childIdx = 0; childIdx < ctx.mod.types.length; childIdx++) {
    const child = ctx.mod.types[childIdx];
    if (!child || child.kind !== "struct" || child.superTypeIdx === undefined || child.superTypeIdx < 0) continue;
    const reason = invalidHierarchyReason(ctx.mod, childIdx, child);
    if (reason === undefined) continue;
    valid = false;
    reportErrorNoNode(
      ctx,
      `struct hierarchy layout became invalid before finalization: subtype #${childIdx} (${child.name}) ${reason}`,
    );
  }
  return valid;
}
