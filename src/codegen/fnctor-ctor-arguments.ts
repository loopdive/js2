// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The `arguments` object inside a **[[Construct]]** body — `new F(…)` where `F`
 * is a function DECLARATION.
 *
 * ## The defect
 *
 * `compileNewFunctionDeclaration` (new-super.ts) does not reuse the ordinary
 * function-body lowering. It synthesizes a fresh `__fnctor_<F>_new` and compiles
 * `F`'s statements into it — and that synthesized body never ran the
 * `needsImplicitArgumentsObject` block that `function-body.ts` runs for every
 * ordinary call. So inside a constructor `arguments` resolved to nothing and
 * read back as `null`. Measured on this branch's base with the real
 * `runTest262File` (`--target standalone`), one probe, three shapes:
 *
 * | shape                                        | base                | spec           |
 * | -------------------------------------------- | ------------------- | -------------- |
 * | `function F(){…arguments…}; F("",1,2)`       | `object`, `len 3`   | `object`, 3    |
 * | `function F(){…arguments…}; new F("",1,2)`   | **`null`**          | `object`, 3    |
 * | `function F(){this.z=1; …arguments…}; new F(…)` | **`null`**       | `object`, 3    |
 *
 * The `null` is not a missing property — it is the binding itself, so the very
 * next `arguments.length` traps with "cannot read property 'length' of null"
 * (`built-ins/Function/prototype/call/S15.3.4.4_A6_T5/T6/T9`), and a body that
 * only spreads it into a callee silently passes ZERO arguments, which surfaces
 * one step later as `NaN` (`…/apply/S15.3.4.3_A7_T5/T6/T9`).
 *
 * ## The second half — the call site
 *
 * Materializing the vec inside the ctor is not enough. `new F("", 1, 2)` on a
 * ZERO-formal `F` has three arguments and no parameter slot to put them in, and
 * §10.2.1.3 passes them to [[Call]] where only `arguments` can observe them.
 * `emitFnctorConstructorArguments` (fnctor-constructor-identity.ts) compiles each
 * over-supplied argument for its side effects and **drops** it — correct for
 * arity, but it means the values are gone before the callee could see them.
 *
 * The ordinary call path already has the protocol for exactly this: the extras
 * ride `__extras_argv` with `__argc` recording how many formals were really
 * filled (#1053/#1511), and `emitArgumentsVecBody` concatenates formals[0..argc)
 * with that vector. So the call site saves the over-supplied values into
 * externref locals instead of dropping them and publishes them through the SAME
 * two globals. Nothing new is invented; the constructor call simply starts
 * speaking the protocol its callee reads.
 *
 * `maybeSetArgcForKnownCall` cannot do that job here: it keys on
 * `ctx.funcUsesArguments`, which holds the SOURCE name (`F`), while the fnctor
 * call site passes the synthesized `__fnctor_F_new`. It therefore returns early
 * for every constructor, which is why `__argc` was never set either.
 *
 * ## Why this cannot change a module that does not construct
 *
 * Both halves are gated on `needsImplicitArgumentsObject(funcDecl)` — the same
 * predicate `function-body.ts` uses — so a constructor whose body never mentions
 * `arguments` emits byte-identical code, call site included. The gate is
 * evaluated once, at the fnctor ctor's compile, and handed to the call site as a
 * boolean, so the two halves cannot disagree about whether the protocol is live.
 *
 * ## Mapped arguments
 *
 * §10.4.4 mapping (writes to `arguments[i]` flowing back into the named
 * parameter) is installed on the SAME terms as the ordinary path — simple
 * parameter list, non-strict — with `paramOffset` pointing past the fnctor's
 * capture/TDZ parameters rather than at slot 0. The one deliberate difference is
 * that this does NOT publish into `ctx.mappedArgsInfoByFunc`: that map is keyed
 * by declaration node and is read by the `delete args[i]` alias resolver, and a
 * function declaration that is BOTH called and constructed would have its two
 * activations overwrite each other's entry there. A missing alias entry costs a
 * `delete` refinement; a wrong one would cost the wrong frame's parameter.
 */
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildArgcExtrasSetupFromLocals } from "./expressions/argc-extras.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { needsImplicitArgumentsObject } from "./helpers/body-uses-arguments.js";
import { shouldRegisterArgumentsWithHost } from "./helpers/arguments-registration.js";
import { isSimpleParameterList, isStrictFunction } from "./helpers/is-strict-function.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { emitArgumentsVecBody } from "./statements/nested-declarations.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Does this `new F(…)` need the `arguments` protocol? One question, asked once,
 * so the ctor body and its call site cannot disagree.
 */
export function fnctorCtorNeedsArguments(funcDecl: ts.FunctionDeclaration): boolean {
  return funcDecl.body !== undefined && needsImplicitArgumentsObject(funcDecl);
}

/**
 * Materialize `arguments` inside a synthesized `__fnctor_<F>_new` body.
 *
 * `userParamOffset` is the index of the constructor's FIRST user-declared
 * parameter (past the capture and TDZ-flag parameters); `userParamTypes` are the
 * declared formals' wasm types, in order. Emits into `ctorFctx.body`, which must
 * already be the live body of the constructor being compiled.
 */
export function emitFnctorCtorArgumentsObject(
  ctx: CodegenContext,
  ctorFctx: FunctionContext,
  funcDecl: ts.FunctionDeclaration,
  userParamOffset: number,
  userParamTypes: readonly ValType[],
): void {
  if (!funcDecl.body) return;

  // Reserve the box/unbox pair BEFORE any `call` below bakes an index: adding a
  // late import shifts defined-function indices, and the flush can only patch
  // instructions it can reach.
  const hasNumericParam = userParamTypes.some((t) => t.kind === "f64" || t.kind === "i32");
  if (hasNumericParam) {
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [EXTERNREF]);
    ensureLateImport(ctx, "__unbox_number", [EXTERNREF], [{ kind: "f64" }]);
    flushLateImportShifts(ctx, ctorFctx);
  }

  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  const argsLocal = allocLocal(ctorFctx, "arguments", { kind: "ref", typeIdx: vecTypeIdx });
  const arrTmp = allocLocal(ctorFctx, "__args_arr_tmp", { kind: "ref", typeIdx: arrTypeIdx });

  // §10.4.4: mapped only for a simple parameter list in non-strict code. See the
  // module header for why `ctx.mappedArgsInfoByFunc` is deliberately not written.
  const mappedAllowed =
    isSimpleParameterList(funcDecl.parameters) && !isStrictFunction(funcDecl, ctx.inferModuleStrictArguments);
  if (mappedAllowed && userParamTypes.length > 0) {
    ctorFctx.mappedArgsInfo = {
      argsLocalIdx: argsLocal,
      arrTypeIdx,
      vecTypeIdx,
      paramCount: userParamTypes.length,
      paramOffset: userParamOffset,
      paramTypes: [...userParamTypes],
    };
  }

  emitArgumentsVecBody(
    ctx,
    ctorFctx,
    [...userParamTypes],
    userParamOffset,
    { vecTypeIdx, arrTypeIdx, argsLocalIdx: argsLocal, arrTmpIdx: arrTmp },
    shouldRegisterArgumentsWithHost(ctx, funcDecl.body, ctorFctx.directEvalBindingNames !== undefined),
  );
}

/**
 * Publish a constructor call site's over-supplied arguments through
 * `__extras_argv` / `__argc`, so the ctor body's `arguments` vec sees them.
 *
 * `extrasLocals` are externref locals already holding the values beyond the
 * declared formals, in source order. Stack-neutral: safe to emit while the
 * formals are still on the wasm stack awaiting the `call`.
 */
export function emitFnctorCtorCallSiteArgc(
  ctx: CodegenContext,
  fctx: FunctionContext,
  declaredCount: number,
  extrasLocals: readonly number[],
  actualArgCount: number,
): void {
  fctx.body.push(...buildArgcExtrasSetupFromLocals(ctx, fctx, declaredCount, [...extrasLocals], actualArgCount));
}
