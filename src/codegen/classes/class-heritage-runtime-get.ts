// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6772 S11) §15.7.14 ClassDefinitionEvaluation step 5.g–h for a standalone
 * class whose heritage the compiler cannot resolve: read
 * `Get(superclass, "prototype")` ONCE at definition, and throw the step 5.h
 * TypeError when the answer is a primitive.
 *
 * Without this nothing evaluated the heritage at runtime on this lane (the
 * #5195 r3-5 check in class-heritage-check.ts fires only for heritages it can
 * PROVE invalid), so a `prototype` ACCESSOR on the superclass — a bound
 * function given one with `Object.defineProperty`, test262
 * `class/definition/prototype-getter.js` — was never called and its `42`
 * never threw.
 *
 * Scope (each decline keeps the class's previous bytes):
 *  - standalone only; the class is in `classDynamicUnresolvedHeritageSet`, is
 *    not a linked-provider subclass (#6640, which evaluates its heritage
 *    itself) and has no builtin parent;
 *  - the heritage is not one the r3-5 check already throws for (the value is
 *    evaluated exactly once either way);
 *  - an identifier bound to a local function or class DECLARATION declines:
 *    its `prototype` is a non-configurable data property, so the read has no
 *    observable effect (a reassignment to a primitive is the recorded
 *    residual).
 * The throw is deliberately one-sided: an `undefined` superclass or
 * `prototype` answer is NOT treated as invalid, because on this lane an
 * unmodelled carrier also answers `undefined`; IsConstructor (step 5.f) is not
 * re-checked here for the same reason. Both are recorded residuals.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import { withSpeculativeCompile } from "../context/speculative.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
// (#6797) core helpers through the late-bound delegates, so this leaf stays out of the codegen SCC.
import {
  buildThrowJsErrorInstrs,
  ensureObjectRuntime,
  heritageExpressionNeedingRuntimeCheck,
  stringConstantExternrefInstrs,
} from "../helpers/core-delegates.js";
import { coerceType, compileExpression, ensureLateImport, flushLateImportShifts } from "../shared.js";
import { standaloneCommaHeritage } from "./class-heritage-comma.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const INVALID_PROTOTYPE_MESSAGE = "Class extends value does not have valid prototype property";

function stripParens(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function classNameOf(ctx: CodegenContext, decl: ts.ClassLikeDeclaration): string | undefined {
  return ctx.anonClassExprNames.get(decl) ?? decl.name?.text;
}

/** The superclass VALUE expression to read `prototype` from, or `undefined` to decline. */
export function heritagePrototypeGetTarget(
  ctx: CodegenContext,
  decl: ts.ClassLikeDeclaration,
): ts.Expression | undefined {
  if (!ctx.standalone) return undefined;
  const className = classNameOf(ctx, decl);
  if (className === undefined || !ctx.classDynamicUnresolvedHeritageSet.has(className)) return undefined;
  if (ctx.classLinkedDynamicParentExpr.has(className) || ctx.classBuiltinParentMap.has(className)) return undefined;
  if (heritageExpressionNeedingRuntimeCheck(ctx, decl as ts.ClassDeclaration | ts.ClassExpression) !== undefined) {
    return undefined;
  }
  const clause = decl.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword && c.types.length > 0);
  if (clause === undefined) return undefined;
  // A comma heritage's leading operands run in emitStandaloneCommaHeritageEffects (S6).
  const target = standaloneCommaHeritage(ctx, decl)?.value ?? stripParens(clause.types[0]!.expression);
  if (target.kind === ts.SyntaxKind.NullKeyword) return undefined;
  if (ts.isIdentifier(target)) {
    const declaration = ctx.oracle.valueDeclarationOf(target);
    if (declaration !== undefined && (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration))) {
      return undefined;
    }
  }
  return target;
}

/** Inline, stack-neutral: `$p = Get(superclass, "prototype")`; a primitive `$p` throws. */
export function emitStandaloneHeritagePrototypeGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.ClassLikeDeclaration,
): void {
  const target = heritagePrototypeGetTarget(ctx, decl);
  if (target === undefined) return;
  withSpeculativeCompile(ctx, fctx, () => {
    ensureObjectRuntime(ctx);
    const produced = compileExpression(ctx, fctx, target, EXTERNREF);
    if (produced === null || produced === undefined || typeof produced !== "object") {
      return { commit: false, value: undefined };
    }
    if (produced.kind !== "externref") coerceType(ctx, fctx, produced, EXTERNREF);
    const value = allocLocal(fctx, `__heritage_v_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "local.set", index: value });
    const getIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
    const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
    const objIdx = ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
    const fnIdx = ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
    flushLateImportShifts(ctx, fctx);
    if (getIdx === undefined || isUndefIdx === undefined || objIdx === undefined || fnIdx === undefined) {
      return { commit: false, value: undefined };
    }
    const proto = allocLocal(fctx, `__heritage_p_${fctx.locals.length}`, EXTERNREF);
    const absent = (local: number): Instr[] => [
      { op: "local.get", index: local },
      { op: "ref.is_null" },
      { op: "local.get", index: local },
      { op: "call", funcIdx: isUndefIdx },
      { op: "i32.or" },
    ];
    const throwArm = buildThrowJsErrorInstrs(ctx, "TypeError", INVALID_PROTOTYPE_MESSAGE, { flush: fctx });
    const check: Instr[] = [
      { op: "local.get", index: value },
      ...stringConstantExternrefInstrs(ctx, "prototype"),
      { op: "call", funcIdx: getIdx },
      { op: "local.set", index: proto },
      ...absent(proto),
      { op: "local.get", index: proto },
      { op: "call", funcIdx: objIdx },
      { op: "i32.or" },
      { op: "local.get", index: proto },
      { op: "call", funcIdx: fnIdx },
      { op: "i32.or" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: throwArm },
    ];
    fctx.body.push(...absent(value), { op: "i32.eqz" }, { op: "if", blockType: { kind: "empty" }, then: check });
    return { commit: true, value: undefined };
  });
}
