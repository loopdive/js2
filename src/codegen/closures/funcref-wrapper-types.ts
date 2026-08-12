// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Funcref-wrapper struct / func-type registry for js2wasm closures.
 *
 * Extracted verbatim from `closures.ts` (issue #3270) — the small, foundational
 * wrapper-struct / lifted-func-type registry that the method-trampoline and
 * funcref-as-closure subsystems both build on. Isolates the isorecursive
 * root-wrapper canonicalization logic (#2873) in one place.
 */

import type { ClosureInfo, CodegenContext } from "../context/types.js";
import type { ValType } from "../../ir/types.js";
import { funcSignatureOf } from "../func-space.js"; // (#1916 S2 read chokepoint)
import { addFuncType } from "../index.js";
import { closureArityField, closureBagField } from "./closure-header-layout.js";

export type ClosureAllocationMode = "support" | "ordinary" | "host-one-shot";

function observeAllocation(info: ClosureInfo, mode: ClosureAllocationMode): void {
  if (mode === "ordinary") info.hostOneShotOnly = false;
  else if (mode === "host-one-shot" && info.hostOneShotOnly === undefined) info.hostOneShotOnly = true;
}

/**
 * (#3673/#4241) Closure representation constants and header field factories.
 *
 * These now live in the LEAF module `closure-header-layout.ts` and are
 * re-exported here so the ~10 existing importers are unaffected. The move was
 * forced by a real failure: this module imports the codegen barrel
 * (`../index.js`), and `program-abi-type-planning.ts` — which VALIDATES the
 * header on the IR path — is reachable from that barrel, so it could not import
 * the constants without closing an initialization cycle. It therefore carried
 * its own hand-written copy of the layout (`fields.length === 2 && funcref &&
 * i32`), which the `$bag` insertion silently invalidated. A leaf that both
 * sides can import is the fix; see that module's header for the full story.
 *
 * Capture fields start at CLOSURE_CAPTURE_FIELD_BASE — every capture
 * read/write, TDZ-slot index AND header validator derives from these
 * constants, never a bare literal.
 */
export {
  CLOSURE_ARITY_FIELD_IDX,
  CLOSURE_BAG_FIELD_IDX,
  CLOSURE_CAPTURE_FIELD_BASE,
  CLOSURE_FUNC_FIELD_IDX,
  closureArityField,
  closureBagField,
  closureBagInitInstr,
  closureSubtypeFieldCount,
  hasClosureHeaderPrefix,
  isCanonicalClosureHeader,
} from "./closure-header-layout.js";

/**
 * Look up a function's parameter and result types from its index.
 */
export function getFuncSignature(
  ctx: CodegenContext,
  funcIdx: number,
): { params: ValType[]; results: ValType[] } | null {
  // #1916 S2 — funcSignatureOf is the positional-read chokepoint (func-space.ts).
  const sig = funcSignatureOf(ctx, funcIdx);
  return sig ? { params: sig.params, results: sig.results } : null;
}

/**
 * Get or create the closure struct type and lifted func type for wrapping
 * plain functions with a given signature. Struct type and func type are shared
 * across all functions with the same signature, but each function gets its own
 * trampoline.
 */
export function getOrCreateFuncRefWrapperTypes(
  ctx: CodegenContext,
  userParams: ValType[],
  resultTypes: ValType[],
  allocationMode: ClosureAllocationMode = "ordinary",
): {
  structTypeIdx: number;
  liftedFuncTypeIdx: number;
  liftedSelfTypeIdx: number;
  closureInfo: ClosureInfo;
} | null {
  // Build cache key from param types and result types
  const sigKey = `${userParams.map((p) => p.kind + ((p as any).typeIdx ?? "")).join(",")}->${resultTypes.map((r) => r.kind + ((r as any).typeIdx ?? "")).join(",")}`;

  const cached = ctx.funcRefWrapperCache.get(sigKey);
  if (cached) {
    observeAllocation(cached, allocationMode);
    return {
      structTypeIdx: cached.structTypeIdx,
      liftedFuncTypeIdx: cached.funcTypeIdx,
      liftedSelfTypeIdx: getFuncRefWrapperRootTypeIdx(ctx) ?? cached.structTypeIdx,
      closureInfo: cached,
    };
  }

  // Create the closure struct type: just (field $func funcref), no captures.
  // Mark as non-final (superTypeIdx = -1) so closures with captures can be
  // subtypes of this wrapper struct, enabling ref.cast to succeed at call sites.
  const closureName = `__fn_wrap_${ctx.closureCounter++}`;
  const structFields = [
    { name: "func", type: { kind: "funcref" as const }, mutable: false },
    closureArityField(),
    closureBagField(),
  ];
  const structTypeIdx = ctx.mod.types.length;
  const rootWrapperTypeIdx = (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx;
  ctx.mod.types.push({
    kind: "struct",
    name: `${closureName}_struct`,
    fields: structFields,
    superTypeIdx: rootWrapperTypeIdx ?? -1, // first wrapper is the root; later signatures subtype it
  });
  const liftedSelfTypeIdx = rootWrapperTypeIdx ?? structTypeIdx;
  if (rootWrapperTypeIdx === undefined) {
    (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx = structTypeIdx;
  }

  // Cross-module callable ABI: every lifted funcref takes the structurally
  // canonical ROOT as `self`, never the per-signature allocation wrapper.
  // Wrapper creation order is module-local, so embedding the latter here
  // makes identical source signatures disagree across separately compiled
  // modules. Captured bodies recover their environment with a root→subtype
  // cast; the user-visible params/results still identify the funcref exactly.
  const liftedParams: ValType[] = [{ kind: "ref", typeIdx: liftedSelfTypeIdx }, ...userParams];
  const liftedFuncTypeIdx = addFuncType(ctx, liftedParams, resultTypes, `${closureName}_type`);

  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: liftedFuncTypeIdx,
    returnType: resultTypes.length > 0 ? resultTypes[0]! : null,
    paramTypes: userParams,
  };
  observeAllocation(closureInfo, allocationMode);
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);
  ctx.funcRefWrapperCache.set(sigKey, closureInfo);

  return { structTypeIdx, liftedFuncTypeIdx, liftedSelfTypeIdx, closureInfo };
}

/**
 * #3371 — Return a nominally-distinct subtype for an ordinary function value.
 *
 * Arrow functions and method closures deliberately keep using the signature
 * wrapper above.  Ordinary function declarations/expressions add one immutable
 * marker field, making their runtime type distinguishable for IsConstructor
 * without changing field 0 or the shared lifted-call ABI.  The subtype still
 * casts to the base wrapper at every existing call site.
 */
export function getOrCreateConstructibleFuncRefWrapperTypes(
  ctx: CodegenContext,
  userParams: ValType[],
  resultTypes: ValType[],
): {
  structTypeIdx: number;
  liftedFuncTypeIdx: number;
  liftedSelfTypeIdx: number;
  closureInfo: ClosureInfo;
} | null {
  const sigKey = `${userParams.map((p) => p.kind + ((p as any).typeIdx ?? "")).join(",")}->${resultTypes.map((r) => r.kind + ((r as any).typeIdx ?? "")).join(",")}`;
  const cached = ctx.constructibleFuncRefWrapperCache.get(sigKey);
  if (cached) {
    return {
      structTypeIdx: cached.structTypeIdx,
      liftedFuncTypeIdx: cached.funcTypeIdx,
      liftedSelfTypeIdx: getFuncRefWrapperRootTypeIdx(ctx) ?? cached.structTypeIdx,
      closureInfo: cached,
    };
  }

  const base = getOrCreateFuncRefWrapperTypes(ctx, userParams, resultTypes);
  if (!base) return null;
  const structTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__constructible_fn_wrap_${ctx.closureCounter++}_struct`,
    fields: [
      { name: "func", type: { kind: "funcref" as const }, mutable: false },
      closureArityField(),
      closureBagField(),
      { name: "__constructible", type: { kind: "i32" as const }, mutable: false },
    ],
    superTypeIdx: base.structTypeIdx,
  });
  const closureInfo: ClosureInfo = {
    structTypeIdx,
    funcTypeIdx: base.liftedFuncTypeIdx,
    returnType: resultTypes.length > 0 ? resultTypes[0]! : null,
    paramTypes: userParams,
  };
  ctx.closureInfoByTypeIdx.set(structTypeIdx, closureInfo);
  ctx.constructibleFuncRefWrapperCache.set(sigKey, closureInfo);
  ctx.constructibleClosureTypeIdxs.add(structTypeIdx);
  return {
    structTypeIdx,
    liftedFuncTypeIdx: base.liftedFuncTypeIdx,
    liftedSelfTypeIdx: base.liftedSelfTypeIdx,
    closureInfo,
  };
}

/**
 * (#2873 park fix) The ROOT funcref-wrapper struct type — the FIRST wrapper
 * `getOrCreateFuncRefWrapperTypes` created in this module. Every later
 * per-signature wrapper struct is a direct subtype of it. It is also the
 * canonical lifted-function `self` type for EVERY signature, so function type
 * identity does not depend on which signature created the root locally. The
 * finalization pass explicitly keeps this root open even in a minimal module
 * with no child wrapper: WasmGC canonical identity includes finality, so an
 * opportunistically-final root would not match another module's open root.
 * The root is therefore the ONLY wrapper type a `ref.test`/`ref.cast` is
 * guaranteed to accept for a closure value of ANY shared signature wrapper.
 *
 * Why callers need it: wrapper structs are all layout-identical
 * `(struct (field funcref))`, but WasmGC isorecursive canonicalization keys on
 * (fields, supertype, finality) — a direct `$root` subtype does NOT canonicalize
 * with the root or with another sibling. A call site that casts a
 * closure value to the wrapper of its *declared* signature therefore nulls out
 * whenever the value was allocated under a different signature's wrapper
 * (e.g. an activated async closure: its wrapper is minted for the REWRITTEN
 * `... -> externref` Promise signature, while an `fn: () => void` param casts
 * to the void wrapper) — unless creation ORDER happened to make the declared
 * wrapper the root. Cast/read/pass `self` through the root instead and
 * discriminate only on the funcref's exact type (which encodes the true
 * signature).
 */
export function getFuncRefWrapperRootTypeIdx(ctx: CodegenContext): number | undefined {
  return (ctx as unknown as { __funcRefWrapperRootTypeIdx?: number }).__funcRefWrapperRootTypeIdx;
}

/**
 * Return the concrete struct type used by a closure funcref's leading `self`
 * parameter. Shared wrapper funcs return the canonical root; private/named
 * function-expression funcs return their concrete nullable struct. Dispatch
 * sites use this distinction to avoid foreign per-signature wrapper casts
 * without breaking private closure types.
 */
export function getClosureFuncSelfTypeIdx(ctx: CodegenContext, funcTypeIdx: number): number | undefined {
  const type = ctx.mod.types[funcTypeIdx];
  if (!type || type.kind !== "func") return undefined;
  const self = type.params[0];
  return self && (self.kind === "ref" || self.kind === "ref_null") ? self.typeIdx : undefined;
}
