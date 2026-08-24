// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * §13.15.3 `+` — ToPrimitive BOTH operands, THEN choose concatenation vs
 * numeric addition — for an OBJECT-typed operand under `--target standalone`.
 *
 * ## The defect
 *
 * ```js
 * var f = function () { return 1; }, o = {}, d = new Date(0);
 * o + o;   // NaN — must be "[object Object][object Object]"
 * f + f;   // NaN — must be the two source texts concatenated
 * d + d;   // NaN — must be the two date strings concatenated
 * ```
 *
 * Read off the emitted module, not inferred: all three lower to
 * `f64.add(__to_number(l), __to_number(r))`. The two `+` arms that DO reduce
 * their operands are reached only when an operand is statically a **string**
 * (`"1" + o` is right today) or statically `any`/`unknown` (#2058's
 * `emitAnyAdd`, itself excluded whenever `anyValueTypeIdx >= 0` — i.e. always,
 * in standalone). An object-TYPED operand matched neither, fell through to the
 * f64 hint, and ToNumber("[object Object]") is NaN.
 *
 * This is the same shut-gate shape #4564 found on the relational operators,
 * one operator family over: there the cascade existed and the gate excluded
 * object operands (fixed in fcc0c206); here the reduction never happens at all.
 * Fixing the carrier half of ToPrimitive (#4564, carrier-to-primitive.ts) is
 * what makes this arm worth having — with it, `d + d` reduces via
 * `Date.prototype.toString` and `f + f` via `Function.prototype.toString`.
 *
 * ## Hint DEFAULT, and why the order matters
 *
 * §13.15.3 step 5 reduces with hint **default** (NOT number — that is
 * §7.2.12's hint, and the difference is observable on a Date, where default
 * behaves as string). Only then does step 7 ask whether EITHER primitive is a
 * string. Asking the raw operands instead is the exact bug the relational
 * cascade had.
 *
 * ## Why #1374's landmine does not apply
 *
 * `binary-ops.ts` records that #1374 widened a gate to non-numeric operands and
 * caused 14 `runtime_error` regressions — by routing them to the HOST
 * operator, which throws on an opaque WasmGC struct. `admitsObjectAddition`
 * widens only where there is no JS host, and every step below is in-module
 * (`__to_primitive`, `__typeof_string`, `__any_to_string`, `__str_concat`), so
 * no host operator ever sees a struct.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addOperandCallableSourceText } from "./add-to-primitive.js";
import { isStaticallyCallableType } from "./callable-to-string.js";
import { runtimeToPrimitiveInstrs } from "./coercion-engine.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { ensureAnyToStringHelper, ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { compileExpression } from "./shared.js";
import { coerceType } from "./type-coercion.js";

/** Operand types this arm must not take — `any`/`unknown` belong to #2058, i64 has no arm. */
const EXCLUDED = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.BigInt | ts.TypeFlags.BigIntLiteral;

/**
 * Does this type contain an object alternative and otherwise only primitive
 * alternatives the externref cascade can represent? A mixed `{} | number`
 * still needs runtime ToPrimitive: its object arm may become a string while its
 * number arm stays numeric. Relationals keep their narrower all-object gate;
 * this broader rule is specific to `+`'s runtime string-vs-number decision.
 */
function hasObjectOperandType(t: ts.Type): boolean {
  const parts = t.isUnion() ? t.types : [t];
  if (parts.length === 0) return false;
  let hasObject = false;
  for (const p of parts) {
    if ((p.flags & EXCLUDED) !== 0) return false;
    if ((p.flags & ts.TypeFlags.Object) !== 0) {
      hasObject = true;
      continue;
    }
    if (
      (p.flags &
        (ts.TypeFlags.NumberLike |
          ts.TypeFlags.StringLike |
          ts.TypeFlags.BooleanLike |
          ts.TypeFlags.Null |
          ts.TypeFlags.Undefined |
          ts.TypeFlags.Void |
          ts.TypeFlags.Never)) ===
      0
    ) {
      return false;
    }
  }
  return hasObject;
}

/** A union can contain a callable constituent without exposing call signatures itself. */
function containsStaticallyCallableType(t: ts.Type): boolean {
  return (t.isUnion() ? t.types : [t]).some((part) => isStaticallyCallableType(part));
}

function identifierTargetsDeclaration(
  ctx: CodegenContext,
  identifier: ts.Identifier,
  declaration: ts.Declaration,
): boolean {
  return (
    ctx.oracle.valueDeclarationOf(identifier) === declaration ||
    ctx.oracle.declarationsOf(identifier).includes(declaration)
  );
}

function bindingNameTargetsDeclaration(
  ctx: CodegenContext,
  name: ts.BindingName,
  declaration: ts.Declaration,
): boolean {
  if (ts.isIdentifier(name)) return identifierTargetsDeclaration(ctx, name, declaration);
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingNameTargetsDeclaration(ctx, element.name, declaration),
  );
}

function assignmentTargetWritesDeclaration(
  ctx: CodegenContext,
  target: ts.Expression,
  declaration: ts.Declaration,
): boolean {
  let node = target;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  if (ts.isIdentifier(node)) return identifierTargetsDeclaration(ctx, node, declaration);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentTargetWritesDeclaration(ctx, node.left, declaration);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) => {
      if (ts.isOmittedExpression(element)) return false;
      return assignmentTargetWritesDeclaration(
        ctx,
        ts.isSpreadElement(element) ? element.expression : element,
        declaration,
      );
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some((property) => {
      if (ts.isShorthandPropertyAssignment(property)) {
        return identifierTargetsDeclaration(ctx, property.name, declaration);
      }
      if (ts.isPropertyAssignment(property)) {
        return assignmentTargetWritesDeclaration(ctx, property.initializer, declaration);
      }
      if (ts.isSpreadAssignment(property)) {
        return assignmentTargetWritesDeclaration(ctx, property.expression, declaration);
      }
      return false;
    });
  }
  // Property/element access writes mutate the value (`f.valueOf = …`), not the
  // binding. Those overrides are exactly what the runtime cascade must observe.
  return false;
}

const bindingWriteCache = new WeakMap<ts.Declaration, boolean>();

/** Whole-file proof that a closure-producing binding keeps that carrier. */
function bindingHasWrites(ctx: CodegenContext, declaration: ts.Declaration): boolean {
  const cached = bindingWriteCache.get(declaration);
  if (cached !== undefined) return cached;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // A later `var f = ...` is a runtime write even though it is represented as
    // another declaration, not a BinaryExpression. The oracle's declarations
    // set joins same-symbol `var` redeclarations without conflating shadows.
    if (
      ts.isVariableDeclaration(node) &&
      node !== declaration &&
      node.initializer !== undefined &&
      bindingNameTargetsDeclaration(ctx, node.name, declaration)
    ) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      assignmentTargetWritesDeclaration(ctx, node.left, declaration)
    ) {
      found = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      assignmentTargetWritesDeclaration(ctx, node.operand, declaration)
    ) {
      found = true;
      return;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const loopWrites = ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations.some((loopDecl) =>
            bindingNameTargetsDeclaration(ctx, loopDecl.name, declaration),
          )
        : assignmentTargetWritesDeclaration(ctx, node.initializer, declaration);
      if (loopWrites) {
        found = true;
        return;
      }
    }
    // Dynamic scope prevents the oracle from resolving an assignment target:
    // a `with` body or direct eval may rebind this mutable closure. Decline the
    // optimization for the whole file rather than treating "unresolved" as a
    // proof of no write.
    if (ts.isWithStatement(node)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration.getSourceFile(), visit);
  bindingWriteCache.set(declaration, found);
  return found;
}

/**
 * A source function whose runtime value is one of the closure carriers handled
 * by carrier-to-primitive.ts. Callable parameters/imports stay conservative:
 * their runtime carrier is not proven by the checker signature alone.
 */
function isKnownCompiledClosure(ctx: CodegenContext, expr: ts.Expression): boolean {
  let node = expr;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    node = node.expression;
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return true;
  if (!ts.isIdentifier(node)) return false;
  const declaration = ctx.oracle.valueDeclarationOf(node);
  if (declaration && ts.isFunctionDeclaration(declaration)) return !bindingHasWrites(ctx, declaration);
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  let initializer = declaration.initializer;
  while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)) {
    initializer = initializer.expression;
  }
  if (!ts.isFunctionExpression(initializer) && !ts.isArrowFunction(initializer)) return false;
  const declarationList = declaration.parent;
  const isConst = ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0;
  return isConst || !bindingHasWrites(ctx, declaration);
}

/**
 * Should a `+` with these operand types take the standalone §13.15.3 cascade?
 *
 * Function-plus-static-string used to be excluded because the dynamic ToString
 * terminal rendered a closure as `"[object Object]"`. The carrier arm now
 * reduces closures first, so keeping that exclusion would skip observable
 * custom valueOf methods (`f.valueOf = () => 7; f + "x"`). Class objects,
 * callable Proxies and reified builtin callables retain their existing lowering
 * for now: their identities are not runtime closure carriers, and routing them
 * here can reach the nominal-class driver or a builtin `$Object` path (#4265).
 */
export function admitsObjectAddition(
  ctx: CodegenContext,
  left: ts.Type,
  right: ts.Type,
  leftExpr: ts.Expression,
  rightExpr: ts.Expression,
): boolean {
  if (!ctx.standalone) return false;
  if (ctx.targetProfile.semanticProviders !== "native-first") return false;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return false;
  if ((left.flags & EXCLUDED) !== 0 || (right.flags & EXCLUDED) !== 0) return false;
  if (
    (containsStaticallyCallableType(left) && !isKnownCompiledClosure(ctx, leftExpr)) ||
    (containsStaticallyCallableType(right) && !isKnownCompiledClosure(ctx, rightExpr))
  ) {
    return false;
  }
  return hasObjectOperandType(left) || hasObjectOperandType(right);
}

/**
 * Emit §13.15.3 for the two operands of `expr`: ToPrimitive(default) both, then
 * concatenate when EITHER primitive is a string, else add as f64. Returns
 * `externref` — which of the two arms runs is a runtime property of the
 * operands, so the static result type cannot be narrower.
 *
 * Degrades to the previous ToNumber/`f64.add` lowering if any helper is
 * missing, rather than emitting a half-cascade.
 */
export function emitObjectAdd(ctx: CodegenContext, fctx: FunctionContext, expr: ts.BinaryExpression): ValType {
  // Registered before the operands compile, so its setup cannot desync funcIdxs
  // (the #2191 hazard) — same discipline as `emitAnyRelational`.
  ensureObjectRuntime(ctx);
  ensureNativeStringHelpers(ctx);

  const externref: ValType = { kind: "externref" };
  /**
   * (#4491 T4 parity, 2026-08-23) §20.2.3.5 step 1 for an operand that is a
   * top-level function: its ToPrimitive answer is its SOURCE TEXT, which is the
   * same string `f.toString()` already returns from `ctx.funcSourceText`
   * (#1463). The runtime cascade below cannot produce it — `__extern_toString`'s
   * callable terminal is step 3's `"function () { [native code] }"` placeholder
   * — so `f1 + 1 !== f1.toString() + 1` (`S11.6.1_A2.2_T3` CHECK#1).
   *
   * The fold and its guards already existed in `add-to-primitive.ts`, but on a
   * path this shape never takes: `admitsObjectAddition` above ADMITS a
   * known-compiled-closure operand, so `emitObjectAdd` claims `f1 + 1` and
   * `binary-ops.ts`'s later `admitsObjectAdd` arm — the only caller of that
   * helper — is unreachable for it. Measured: repairing the helper's own guard
   * alone moved 0 of 128 rows, because the helper was never called. Reusing it
   * HERE is what makes the spellings agree, and reuse (rather than a second
   * copy of the guards) is what stops them drifting apart again.
   *
   * A substituted operand is not evaluated, which is safe for exactly the shape
   * the helper admits: a plain identifier resolving to a function declaration
   * has no side effects, so §13.15.3's left-then-right evaluation order is
   * unobservable here. The `f.valueOf = …` / `f.toString = …` override guard
   * inside the helper is what keeps CHECKS #2-#4 of that same test on the
   * runtime cascade, where they belong.
   */
  const emitOperand = (operand: ts.Expression): ValType | null => {
    let inner = operand;
    while (
      ts.isParenthesizedExpression(inner) ||
      ts.isAsExpression(inner) ||
      ts.isNonNullExpression(inner) ||
      ts.isSatisfiesExpression(inner) ||
      ts.isTypeAssertionExpression(inner)
    ) {
      inner = inner.expression;
    }
    const source = addOperandCallableSourceText(ctx, fctx, inner);
    if (source !== undefined) {
      addStringConstantGlobal(ctx, source);
      fctx.body.push(...stringConstantExternrefInstrs(ctx, source));
      return externref;
    }
    return compileExpression(ctx, fctx, operand, externref);
  };
  const lType = emitOperand(expr.left);
  if (!lType) return { kind: "f64" };
  if (lType.kind !== "externref") coerceType(ctx, fctx, lType, externref);
  const lTmp = allocTempLocal(fctx, externref);
  fctx.body.push({ op: "local.set", index: lTmp });
  const rType = emitOperand(expr.right);
  if (!rType) {
    releaseTempLocal(fctx, lTmp);
    return { kind: "f64" };
  }
  if (rType.kind !== "externref") coerceType(ctx, fctx, rType, externref);
  const rTmp = allocTempLocal(fctx, externref);
  fctx.body.push({ op: "local.set", index: rTmp });

  const typeofStr = ctx.funcMap.get("__typeof_string");
  const strConcat = ctx.nativeStrHelpers.get("__str_concat");
  const boxNumber = ctx.funcMap.get("__box_number");
  const toPrimitive = runtimeToPrimitiveInstrs(ctx, "default");
  const anyToString = ensureAnyToStringHelper(ctx);

  const numericFallback = (): ValType => {
    fctx.body.push({ op: "local.get", index: lTmp });
    coerceType(ctx, fctx, externref, { kind: "f64" }, "number");
    fctx.body.push({ op: "local.get", index: rTmp });
    coerceType(ctx, fctx, externref, { kind: "f64" }, "number");
    fctx.body.push({ op: "f64.add" });
    releaseTempLocal(fctx, rTmp);
    releaseTempLocal(fctx, lTmp);
    return { kind: "f64" };
  };
  if (typeofStr === undefined || strConcat === undefined || boxNumber === undefined || toPrimitive === null) {
    return numericFallback();
  }

  // §13.15.3 step 5 — hint DEFAULT on both, in left-to-right order.
  for (const tmp of [lTmp, rTmp]) {
    fctx.body.push({ op: "local.get", index: tmp });
    fctx.body.push(...toPrimitive.map((i) => ({ ...i })));
    fctx.body.push({ op: "local.set", index: tmp });
  }

  // step 7 — EITHER primitive a string ⇒ concatenate ToString of both.
  const toStr = (tmp: number): Instr[] => [
    { op: "local.get", index: tmp },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: anyToString },
  ];
  const concatArm: Instr[] = [
    ...toStr(lTmp),
    ...toStr(rTmp),
    { op: "call", funcIdx: strConcat },
    { op: "extern.convert_any" },
  ];
  // step 8 — otherwise ToNumber both and add. Both primitives are boxed, so the
  // module's own ToNumber coercion applies before the box back out.
  const numericArm: Instr[] = [];
  {
    const saved = fctx.body;
    (fctx as { body: Instr[] }).body = numericArm;
    fctx.body.push({ op: "local.get", index: lTmp });
    coerceType(ctx, fctx, externref, { kind: "f64" }, "number");
    fctx.body.push({ op: "local.get", index: rTmp });
    coerceType(ctx, fctx, externref, { kind: "f64" }, "number");
    fctx.body.push({ op: "f64.add" }, { op: "call", funcIdx: boxNumber });
    (fctx as { body: Instr[] }).body = saved;
  }

  fctx.body.push(
    { op: "local.get", index: lTmp },
    { op: "call", funcIdx: typeofStr },
    { op: "local.get", index: rTmp },
    { op: "call", funcIdx: typeofStr },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "val", type: externref }, then: concatArm, else: numericArm },
  );
  releaseTempLocal(fctx, rTmp);
  releaseTempLocal(fctx, lTmp);
  return externref;
}
