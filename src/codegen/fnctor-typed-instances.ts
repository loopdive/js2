// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4155 Phase 1) Resolve an approved-standalone fnctor's INSTANCE type to its
 * reserved `$__fnctor_<Name>` struct instead of `externref`.
 *
 * `src/codegen/index.ts` (#1712) resolves every function-style-constructor
 * instance type to `externref`, because the checker's instance shape (data
 * fields PLUS prototype-assigned methods) has no subtype relation to the
 * runtime struct (`compileFnctorNew`, data fields only) — so a value typed with
 * the checker's shape guard-casts to null and the first `struct.get` traps.
 *
 * The move this module makes is NOT "synthesize a struct from the checker
 * shape" — that is the version the #1712 note records as already regressed. It
 * maps the instance type onto the struct that ALREADY EXISTS at runtime, the
 * one `reserveFnctorStructTypes` (#2773 S1) reserved up-front. Methods stay on
 * the per-fnctor prototype `$Object` (#2660 S2) and are unaffected: a
 * struct-typed receiver must keep taking the dynamic path for member CALLS,
 * which is Phase 2's job and the reason this is flag-gated until then.
 *
 * Three properties make the reserved struct the right target:
 *  - it is reserved before ANY body compiles, so resolution never races the
 *    first `new F()` (the lazy `funcConstructorMap` could not offer that);
 *  - its index is pass-invariant across hoist and emit (the whole point of
 *    #2773 S1), so a baked `ref.test` matches the emit-pass `struct.new`;
 *  - it is the same type `compileFnctorNew` allocates, so no cast is
 *    introduced that did not already exist.
 *
 * `ref_null`, never `ref`: an instance type reaches positions that must be
 * default-initialisable (uninitialised locals, `null`-seeded fields, a
 * `struct.new` default), and a non-null ref cannot be.
 *
 * STANDALONE ONLY. The JS-host lane keeps externref: there a fnctor instance
 * must retain `$Object` identity for the host MOP, and `__extern_get` /
 * host-bridge member access is the coherent representation.
 *
 * ON by default; set `JS2WASM_FNCTOR_TYPED_INSTANCES=0` to restore the
 * pre-#4155 externref resolution. See {@link fnctorTypedInstancesEnabled} for
 * the measurements behind the default and why the opt-out has to stay.
 */
import ts from "typescript";
import type { CodegenContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import { definedFuncAt } from "./func-space.js";

/**
 * ON by default since 2026-08-04. `JS2WASM_FNCTOR_TYPED_INSTANCES=0` restores
 * the pre-#4155 externref resolution.
 *
 * The default is justified by the real corpus, not by fixtures. Standalone
 * acorn: 943,140 → 866,627 bytes (−8.1%), zero function imports, all four
 * runtime canaries unchanged (2,3,4,5); the provenance census's `discarded`
 * bucket 4 → 1, recovering `Parser.type` (141 reads), `Node.loc` and
 * `Token.loc`. The survivor, `Parser.options`, is boxed by the #2937
 * object-hash-consumer path rather than by #1712, so it is out of reach here
 * and this lever is exhausted at the slot level. Also green with the flag on:
 * 54 tests across the four #2660 fnctor suites plus the #4155 Phase 0 suite,
 * and 140/140 across 26 object/struct/class/prototype equivalence files.
 *
 * The opt-out is NOT decoration. Standalone **test262** only runs in the
 * `merge_group` re-validation and therefore could not gate this pre-merge, so a
 * one-variable revert must stay available without a code change. If the queue
 * parks this, set the variable rather than reverting the commit.
 */
export function fnctorTypedInstancesEnabled(): boolean {
  return process.env.JS2WASM_FNCTOR_TYPED_INSTANCES !== "0";
}

/**
 * The reserved struct type for an approved standalone fnctor instance, or null
 * to fall through to the existing `externref` resolution.
 *
 * Returns null — deliberately, not an error — when the name has no reserved
 * index. A fnctor the escape gate did not approve, or one whose declaration is
 * body-less, never gets a reservation, and those keep their existing lowering.
 */
export function resolveFnctorInstanceType(ctx: CodegenContext, symName: string | undefined): ValType | null {
  if (!fnctorTypedInstancesEnabled()) return null;
  if (!ctx.standalone || symName === undefined) return null;
  if (ctx.fnctorEscapeGate?.approvedNames.has(symName) !== true) return null;
  const typeIdx = ctx.fnctorReservedTypeIdx.get(symName);
  if (typeIdx === undefined) return null;
  return { kind: "ref_null", typeIdx };
}

/**
 * (#4612) Does the ALREADY-REGISTERED legacy signature for this position carry
 * a reserved `$__fnctor_<Name>` struct?
 *
 * ## Why the IR selector needs to ask
 *
 * The #2949 slice-3b contract for an UNANNOTATED position the IR calls
 * `dynamic` is that its carrier equals "what legacy gives the same
 * declaration" — `resolvePositionType`'s dynamic arm states it explicitly.
 * Flipping {@link fnctorTypedInstancesEnabled} on by default broke that
 * equality for exactly one family: legacy resolves an unannotated position
 * whose CHECKER type is an approved-standalone fnctor instance through
 * {@link resolveFnctorInstanceType} to `(ref null $__fnctor_<Name>)`, while
 * the IR — which reads the propagated lattice, not the checker — still sees
 * `dynamic` and lowers to the dynamic carrier.
 *
 * Measured on the #2949 runtime-dynamic acorn driver: `tokenizer`
 * (`function tokenizer(input, options) { return Parser.tokenizer(input, options) }`)
 * was claimed and then WITHDRAWN at the `abi-signature-parity` guard —
 * IR `(externref, externref) -> externref` against legacy
 * `(externref, externref) -> (ref null $__fnctor_Parser)`. A post-claim
 * withdrawal is strictly worse than a pre-claim decline: the work is done,
 * the claim is retracted, and every caller the IR already compiled against
 * the withdrawn callee's signature has to cascade-withdraw too (#3551).
 *
 * So the selector consults this BEFORE claiming, and declines the position
 * instead — the same move `resolveImplicitParamType` makes for the parameter
 * side. This narrows nothing the IR could actually express: the IR return
 * lowering (`coerceReturnValue`, from-ast.ts) has no arm that converts the
 * dynamic carrier into a struct ref, so the claim could only ever end at the
 * parity guard. Teaching the IR to EXPRESS the fnctor-instance ABI is
 * #2949/#3520 territory; this keeps the two front-ends honest until then.
 *
 * Reads the legacy artifact directly (`ctx.funcMap` → `ctx.mod.types`), the
 * SAME artifact the parity guard compares against, so the pre-claim question
 * and the post-claim check can never drift. Answers `false` whenever the
 * legacy slot is not registered yet (IR-first ordering, bare selector
 * callers): unknown ⇒ no divergence ⇒ status-quo selection.
 */
export function legacyPositionCarriesFnctorInstance(
  ctx: CodegenContext,
  name: string | undefined,
  position: "return" | number,
): boolean {
  if (!fnctorTypedInstancesEnabled()) return false;
  if (!ctx.standalone || name === undefined) return false;
  if (ctx.fnctorReservedTypeIdx.size === 0) return false;
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined) return false;
  const legacyFunction = definedFuncAt(ctx, funcIdx);
  if (legacyFunction === undefined) return false;
  const signature = ctx.mod.types[legacyFunction.typeIdx];
  if (signature?.kind !== "func") return false;
  const slot = position === "return" ? signature.results[0] : signature.params[position];
  if (slot === undefined) return false;
  if (slot.kind !== "ref" && slot.kind !== "ref_null") return false;
  for (const reserved of ctx.fnctorReservedTypeIdx.values()) {
    if (reserved === slot.typeIdx) return true;
  }
  return false;
}

/**
 * (#4612) Selector-facing adapter for {@link legacyPositionCarriesFnctorInstance}:
 * takes the AST node the selector is standing on (a parameter, or the owning
 * declaration for the return position) and derives the legacy slot name +
 * ordinal itself, so `select.ts` stays checker- and context-free.
 *
 * Only top-level `FunctionDeclaration`s carry a `ctx.funcMap` slot under their
 * source name; class members and unnamed declarations answer `false` (their
 * parity is enforced by the hard `abi-type-index-mismatch` invariant, not by
 * this soft pre-claim decline).
 */
export function makeIrDynamicCarrierDivergenceProbe(ctx: CodegenContext): (position: ts.Node) => boolean {
  return (position: ts.Node): boolean => {
    if (ts.isParameter(position)) {
      const owner = position.parent;
      if (!ts.isFunctionDeclaration(owner) || owner.name === undefined) return false;
      const index = owner.parameters.indexOf(position);
      if (index < 0) return false;
      return legacyPositionCarriesFnctorInstance(ctx, owner.name.text, index);
    }
    if (ts.isFunctionDeclaration(position) && position.name !== undefined) {
      return legacyPositionCarriesFnctorInstance(ctx, position.name.text, "return");
    }
    return false;
  };
}
