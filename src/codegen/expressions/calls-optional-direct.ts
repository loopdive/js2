// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5346) `fn?.(…)` where the callee is a bare identifier — the short-circuit,
 * the by-name static resolution, and the value-callee fallback.
 *
 * Split out of `calls.ts` (#5346): it is one self-contained lowering and that
 * file is at its LOC ceiling. `compileCallExpression` is INJECTED rather than
 * imported so the two modules do not form an import cycle.
 */

import { ts } from "../../ts-api.js";
import { isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolveWasmType } from "../index.js";
import type { InnerResult } from "../shared.js";
import { coerceType, compileExpression, valTypesMatch, VOID_RESULT } from "../shared.js";
import { maybeSetArgcForKnownCall } from "../statements/nested-declarations.js";
import { defaultValueInstrs, pushDefaultValue, pushParamSentinel } from "../type-coercion.js";
import { getFuncParamTypes } from "./helpers.js";
import { ensureExternIsUndefinedImport, flushLateImportShifts } from "./late-imports.js";

/** `compileCallExpression`, injected to keep this module free of a cycle. */
type OrdinaryCallCompiler = (ctx: CodegenContext, fctx: FunctionContext, expr: ts.CallExpression) => InnerResult;

/**
 * (#5346) Optional direct calls whose short-circuit has already been emitted
 * and which are being re-entered for their ORDINARY call lowering.
 *
 * `compileOptionalDirectCall` resolves `fn?.(…)` through `ctx.closureMap` /
 * `ctx.funcMap`, both keyed by the callee's NAME. A callee that is a VALUE — a
 * parameter holding a callback — is in neither, and the arm below hands the
 * work back to `compileCallExpression`, which lowers exactly the same call
 * without the question-dot. It must be handed the REAL node: a
 * `ts.factory.createCallExpression` twin has no parent, so `getSourceFile()`
 * on it is `undefined` and the func-value-wrapper registration crashes with
 * "Cannot read properties of undefined (reading 'fileName')". Re-entering with
 * the real node needs this guard so the optional gate does not take it back.
 */
const optionalDirectCallLoweringDynamically = new WeakSet<ts.CallExpression>();

/** True while `expr` is being re-entered for its ordinary (non-optional) lowering. */
export function isLoweringOptionalDirectCallDynamically(expr: ts.CallExpression): boolean {
  return optionalDirectCallLoweringDynamically.has(expr);
}

export function compileOptionalDirectCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  compileOrdinaryCall: OrdinaryCallCompiler,
): InnerResult {
  const callee = expr.expression as ts.Identifier;
  const calleeType = compileExpression(ctx, fctx, callee);
  if (!calleeType) return null;

  if (calleeType.kind !== "ref" && calleeType.kind !== "ref_null" && calleeType.kind !== "externref") {
    fctx.body.push({ op: "drop" });
    return compileOrdinaryCallIgnoringQuestionDot(ctx, fctx, expr, compileOrdinaryCall);
  }

  const tmp = allocLocal(fctx, `__optdcall_${fctx.locals.length}`, calleeType);
  fctx.body.push({ op: "local.tee", index: tmp });
  fctx.body.push({ op: "ref.is_null" });
  // (#5346) An externref can carry host JavaScript `undefined` as a NON-null
  // reference, so `ref.is_null` alone does not short-circuit `fn?.()` when the
  // callee is an omitted argument. `compileOptionalCallExpression` (the
  // `obj.m?.()` form) has always tested both; this form did not need to while
  // its unresolved arm silently skipped the call. Now that the arm performs the
  // call, the missing test is the difference between short-circuiting and
  // `TypeError: undefined is not a function`.
  if (calleeType.kind === "externref") {
    const isUndefIdx = ensureExternIsUndefinedImport(ctx);
    if (isUndefIdx !== undefined) {
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_is_undefined") ?? isUndefIdx });
      fctx.body.push({ op: "i32.or" });
    }
  }

  let resultType: ValType = { kind: "externref" };
  const sig = ctx.checker.getResolvedSignature(expr);
  if (sig) {
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    if (!isVoidType(retType)) {
      const resolved = resolveWasmType(ctx, retType);
      resultType = resolved.kind === "ref" ? { kind: "ref_null", typeIdx: resolved.typeIdx } : resolved;
    }
  }

  const savedBody = pushBody(fctx);
  const funcName = callee.text;
  const closureInfo = ctx.closureMap.get(funcName);
  const funcIdx = ctx.funcMap.get(funcName);
  let resolved = false;

  if (closureInfo && (calleeType.kind === "ref" || calleeType.kind === "ref_null")) {
    fctx.body.push({ op: "local.get", index: tmp });
    if (calleeType.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" });
    const closureTmp = allocLocal(fctx, `__optdcall_cls_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: calleeType.typeIdx,
    });
    fctx.body.push({ op: "local.tee", index: closureTmp });
    fctx.body.push({ op: "local.get", index: closureTmp });
    for (const arg of expr.arguments) compileExpression(ctx, fctx, arg);
    fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
    resolved = true;
  } else if (funcIdx !== undefined) {
    const paramTypes = getFuncParamTypes(ctx, funcIdx);
    for (let i = 0; i < expr.arguments.length; i++) {
      compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
    }
    if (paramTypes) {
      const optInfo = ctx.funcOptionalParams.get(funcName);
      for (let i = expr.arguments.length; i < paramTypes.length; i++) {
        const opt = optInfo?.find((o) => o.index === i);
        if (opt) {
          pushParamSentinel(fctx, paramTypes[i]!, ctx, opt);
        } else {
          pushDefaultValue(fctx, paramTypes[i]!, ctx);
        }
      }
      maybeSetArgcForKnownCall(ctx, fctx, funcName, expr.arguments.length, paramTypes.length);
    }
    fctx.body.push({ op: "call", funcIdx });
    resolved = true;
  }

  if (!resolved) {
    // (#5346) Neither map answered, because both are keyed by the callee's NAME
    // and the callee here is a VALUE — overwhelmingly a parameter holding a
    // callback (`function walk(items, onEnter) { … onEnter?.(items) … }`).
    // Pushing the default did not "fail to optimise" that call, it SKIPPED it:
    // the callback never ran and the expression evaluated to null. Measured on
    // prettier@3.8.1 — `traverseDoc`'s `onEnter?.(doc)` never fired, so
    // `isEmptyDoc` answered `true` for every doc (`tests/unit/is-empty-doc.js`
    // 7/16, all nine failures the same `true != false`).
    //
    // Lower it as the ordinary call it is. The nullish test above has already
    // been emitted and we are inside its else arm, so `?.`'s short-circuit is
    // unchanged: neither the callee re-read nor the arguments run when the
    // callee is nullish. Re-reading a plain-identifier callee is side-effect
    // free, which is what makes the re-entry sound.
    const inner = compileOrdinaryCallIgnoringQuestionDot(ctx, fctx, expr, compileOrdinaryCall);
    if (inner === null || inner === VOID_RESULT) {
      fctx.body.push(...defaultValueInstrs(resultType));
    } else {
      // Adopt the ordinary call's OWN result representation rather than
      // coercing it into the signature-derived `resultType`. That coercion is
      // lossy exactly where it matters: a callback declared
      // `(doc) => void | boolean` resolves to an i32 boolean, so the
      // `undefined` a void-returning callback returns arrives as `0` — and
      // `onEnter?.(doc) === false` is then TRUE on every visit. In prettier
      // that made `traverseDoc` `continue` at the root and visit exactly one
      // node. `ref` widens to `ref_null` so the nullish arm can supply a null.
      resultType = inner.kind === "ref" ? { kind: "ref_null", typeIdx: inner.typeIdx } : inner;
    }
  }

  const elseInstrs = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: defaultValueInstrs(resultType),
    else: elseInstrs,
  });

  return resultType;
}

/**
 * (#5346) Lower `expr` as if it had no question-dot, from inside
 * `compileOptionalDirectCall`'s non-nullish arm.
 *
 * Passing the REAL node (not a `ts.factory` twin) keeps its parent, source
 * file, text range and checker resolution intact — a synthesized twin has no
 * parent, and the func-value-wrapper registration reads `getSourceFile()
 * .fileName` off it. The WeakSet is what stops the optional gate in
 * `compileCallExpression` from routing the node straight back here.
 */
function compileOrdinaryCallIgnoringQuestionDot(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  compileOrdinaryCall: OrdinaryCallCompiler,
): InnerResult {
  optionalDirectCallLoweringDynamically.add(expr);
  try {
    return compileOrdinaryCall(ctx, fctx, expr);
  } finally {
    optionalDirectCallLoweringDynamically.delete(expr);
  }
}
