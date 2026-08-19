// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Which local slot a variable declaration REUSES rather than allocating fresh.
 *
 * Two distinct reasons a declaration finds its name already bound:
 *
 *  1. The var-hoist / let-const pre-pass allocated the slot at function entry.
 *     Those slots live at or above `params.length`; reusing one is what makes
 *     hoisting observable (`x = 1; var x;` keeps the 1).
 *
 *  2. (#4555) The name is a FORMAL PARAMETER. §10.5 step 8
 *     (FunctionDeclarationInstantiation) says the binding already exists, so a
 *     bare `var x;` neither recreates it nor re-initializes it to `undefined`.
 *     Only reason (1) was modelled, so a param-named redeclaration allocated a
 *     fresh local and repointed `localMap` at it — `function f(x) { var x;
 *     return x; }` returned the slot type's zero instead of the argument.
 *
 * The parameter case is restricted to the NO-INITIALIZER form on purpose:
 * `var x = e;` keeps the ordinary store path, whose value need not fit the
 * parameter's own (possibly native f64/i32) slot type.
 */
import { ts } from "../../ts-api.js";
import type { FunctionContext } from "../context/types.js";

export function reusedVarSlotIndex(
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
  isVar: boolean,
  isHoistedLetConst: boolean,
  existingIdx: number | undefined,
): number | undefined {
  if (existingIdx === undefined) return undefined;
  if (declarationShadowsArgumentsObject(fctx, decl, existingIdx)) return undefined;
  if ((isVar || isHoistedLetConst) && existingIdx >= fctx.params.length) return existingIdx;
  if (isVar && decl.initializer === undefined && existingIdx < fctx.params.length) return existingIdx;
  return undefined;
}

/**
 * (#4555) `var arguments = <expr>;` REBINDS the name in this scope — it must
 * not write through the compiler-materialized arguments object.
 *
 * That object lives in a local literally named `arguments` whose type is a
 * non-nullable `(ref $__vec_externref)`. Reusing the slot made the store coerce
 * the declared value into that ref, and `var arguments = undefined;` therefore
 * emitted a `ref.as_non_null` on a null — an unconditional trap
 * ("dereferencing a null pointer") on a line that should simply have shadowed
 * the binding. Allocate a fresh slot of the declaration's own type instead;
 * a nested function still materializes its OWN arguments object, so only this
 * scope's name is rebound, exactly as §10.5 orders the two steps.
 */
function declarationShadowsArgumentsObject(
  fctx: FunctionContext,
  decl: ts.VariableDeclaration,
  existingIdx: number,
): boolean {
  if (decl.initializer === undefined) return false;
  if (!ts.isIdentifier(decl.name) || decl.name.text !== "arguments") return false;
  if (existingIdx < fctx.params.length) return false;
  return fctx.locals[existingIdx - fctx.params.length]?.type.kind === "ref";
}
