// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4489) Every module-scope `var` reads as `undefined` before its declaration.
 *
 * ## The defect
 *
 * §9.1.1.4.18 CreateGlobalVarBinding (and §10.2.11 for the hoist itself)
 * instantiates every module-scope `var` with the value `undefined` BEFORE the
 * first top-level statement runs, so a read that precedes the declaration — or
 * any assignment — must answer `undefined`.
 *
 * A module global can only be given a CONSTANT initializer (see
 * `registerModuleGlobal`), and the only constant externref is
 * `ref.null.extern`. Under the #2106 S1 regime that is `null`: a genuinely
 * DIFFERENT value from the tag-1 `$undefined` singleton, not a spelling of it.
 * Measured on the compiled module before this seed existed, for a plain
 * `var x;` read at module scope:
 *
 * ```
 * x === undefined   false   (spec: true)
 * x === null        true    (spec: false)
 * x()               did not throw   (spec + `undefined()`: TypeError)
 * ```
 *
 * The nullish-intent consumers (`x == null`, `String(x)`, `x + ""`,
 * `typeof x`, `"s".concat(x)`) already answered as if `undefined`, because the
 * #2106 S1 sweep widened them to `is_null ∨ is-singleton`. That widening is
 * what kept the defect narrow — and also what kept it hidden.
 *
 * ## Why it was worth a corpus-wide change
 *
 * `ref.null.extern` is ALSO the reflective-closure ABI's "argument not passed"
 * pad (`string-proto-concat.ts`, §22.1.3.5 step 3). A genuine trailing
 * `undefined` sourced from such a slot is therefore indistinguishable from an
 * absent argument, and gets DROPPED rather than stringified — #4465's R1
 * residual, the largest single group of its 27 remaining rows.
 *
 * ## Scope, and the two things this deliberately does NOT do
 *
 * - **Only `var`.** `let`/`const` are not seeded: their correct pre-init state
 *   is the TDZ, enforced by the separate `__tdz_<name>` flag (or elided
 *   entirely by `computeElidableTopLevelTdzNames`, which only elides when no
 *   read can observe the pre-init value). Seeding them `undefined` would be
 *   dead at best and a wrong answer at worst.
 * - **Only externref slots.** A slot the type inference narrowed to a primitive
 *   (`var n = 42` ⇒ `(mut f64)`, `var s = "a"` ⇒ a native-string ref) cannot
 *   physically hold the singleton and keeps its wasm zero-init. That is the
 *   module-scope twin of #684 (which the function-local hoister answers by
 *   seeding `f64.const NaN`) and of #4264 point 2 (which answers it by WIDENING
 *   the slot to externref for `with`-body vars). Both remedies are slot-type
 *   changes with their own blast radius; recorded as this issue's residual.
 *
 * This SUBSUMES the #4264 `with`-body seed rather than sitting beside it:
 * `scriptVarBindingNames` walks the same region (top-level code, never a
 * function or class body) over the same declaration kinds (`var`, binding
 * patterns included), so `withBodyHoistedModuleVarNames` is a strict subset of
 * it. That module is still consulted for its other, independent job — the slot
 * widening above.
 *
 * Host/gc mode is excluded on #4264's grounds: there `undefined` IS the null
 * extern, and the singleton would surface to host helpers as an object.
 */
import type { ts } from "../../ts-api.js";
import { emitUndefinedExtern } from "../any-helpers.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { localGlobalIdx } from "../registry/imports.js";
import { scriptVarBindingNames } from "../source-scan-predicates.js";

/**
 * Emit `global.set $__mod_<name> (undefined)` for every externref module global
 * backed by a module-scope `var`, into the `__module_init` PROLOGUE.
 *
 * The caller must invoke this BEFORE the function-binding seeds (#2931 live
 * bindings, #4394 script global functions, #4182 Annex B block functions):
 * §9.1.1.4.18 creates a `var` binding with `undefined` only when the name is
 * not already present, and GlobalDeclarationInstantiation initialises the
 * function bindings afterwards — so a name that is both a `var` and a function
 * declaration must end up holding the FUNCTION, not this seed.
 */
export function emitModuleVarUndefinedSeeds(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  initFctx: FunctionContext,
): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  const seeded = new Set<number>();
  for (const varName of scriptVarBindingNames(sourceFile)) {
    const globalIdx = ctx.moduleGlobals.get(varName);
    if (globalIdx === undefined || seeded.has(globalIdx)) continue;
    if (ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type.kind !== "externref") continue;
    if (!emitUndefinedExtern(ctx, initFctx)) continue;
    initFctx.body.push({ op: "global.set", index: globalIdx });
    seeded.add(globalIdx);
  }
}
