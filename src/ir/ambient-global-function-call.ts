// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";

import { irBool } from "./boolean-brand.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrFromAstResolver } from "./from-ast.js";
import type { IrDeclaredPrimitiveExpressionFamily } from "./module-bindings.js";
import { asVal, irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import type { IrSelectionOptions } from "./select.js";
import { coerceIrValueToExternref } from "./value-coercion.js";

const F64: IrType = irVal({ kind: "f64" });

/**
 * (#7253) Direct calls of the ES5 / Annex B global functions whose host-free
 * lowering is one call to a fixed-signature native provider (or, for `isNaN`,
 * one `f64.ne`). Each operand position names the ONE primitive family it
 * accepts — a string for the parsed / transformed text, a number for
 * `parseInt`'s radix and `isNaN`'s operand — so the IR never performs a
 * ToString / ToNumber of its own: any other operand keeps the legacy call,
 * which owns those coercions (and the `stringToNumber` dynamic-carrier arm).
 */
export type IrAmbientGlobalFunctionName = "parseInt" | "parseFloat" | "escape" | "unescape" | "isNaN";

type OperandFamily = "string" | "number";
type ClassifyDeclared = (expr: ts.Expression) => IrDeclaredPrimitiveExpressionFamily | undefined;

const OPERAND_FAMILIES: ReadonlyMap<IrAmbientGlobalFunctionName, readonly OperandFamily[]> = new Map([
  ["parseInt", ["string", "number"]],
  ["parseFloat", ["string"]],
  ["escape", ["string"]],
  ["unescape", ["string"]],
  ["isNaN", ["number"]],
]);

interface IrAmbientGlobalFunctionCall {
  readonly name: IrAmbientGlobalFunctionName;
  readonly callee: ts.Identifier;
  /** The SUPPLIED arguments with their families (a missing `parseInt` radix is the provider's NaN sentinel). */
  readonly operands: readonly { readonly argument: ts.Expression; readonly family: OperandFamily }[];
}

/**
 * The admission both sides read: the call shape, and every operand
 * checker-classified as its position's family. Binding and lane proofs are
 * the caller's.
 */
function ambientGlobalFunctionCall(
  expr: ts.CallExpression,
  classify: ClassifyDeclared,
): IrAmbientGlobalFunctionCall | null {
  const callee = expr.expression;
  if (!ts.isIdentifier(callee) || expr.questionDotToken || expr.typeArguments?.length) return null;
  const name = callee.text as IrAmbientGlobalFunctionName;
  const families = OPERAND_FAMILIES.get(name);
  if (families === undefined || expr.arguments.length < 1 || expr.arguments.length > families.length) return null;
  const operands = expr.arguments.map((argument, index) => ({ argument, family: families[index]! }));
  return operands.every(({ argument, family }) => classify(argument) === family) ? { name, callee, operands } : null;
}

/**
 * The selector's admission: the shared one, a lib-only ambient binding and the
 * `native-global-function-call` lane capability. The arguments, else null — a
 * lowering, not a call edge.
 *
 * Lib-only, not merely "has a lib declaration": in a script a source
 * `function unescape() {}` merges with the lib's `declare function`, and the
 * call must keep binding to the source function (#7118's `function Number`).
 *
 * In an ES module `escape` / `unescape` are admitted only from a top-level
 * function declaration. Every other unit there (`<module-init>`, class
 * members, closures) lowers as a prepared component, whose Program ABI has no
 * identity for the `__escape` / `__unescape` runtime callables nor for
 * `dyn.string_carrier` (measured: `late-preparation-unsupported`). Scripts —
 * every test262 body — are unaffected.
 */
export function admitAmbientGlobalFunctionCall(
  expr: ts.CallExpression,
  isLibOnlyBinding: (node: ts.Identifier) => boolean,
  options: Pick<IrSelectionOptions, "supportsBackendCapability" | "classifyDeclaredPrimitiveExpression"> | undefined,
): readonly ts.Expression[] | null {
  const classify = options?.classifyDeclaredPrimitiveExpression;
  if (classify === undefined || options?.supportsBackendCapability?.("native-global-function-call") !== true) {
    return null;
  }
  const call = ambientGlobalFunctionCall(expr, classify);
  if (call === null || !isLibOnlyBinding(call.callee)) return null;
  const escapeFamily = call.name === "escape" || call.name === "unescape";
  if (escapeFamily && ts.isExternalModule(expr.getSourceFile()) && !inTopLevelFunctionDeclaration(expr)) return null;
  return expr.arguments;
}

function inTopLevelFunctionDeclaration(node: ts.Node): boolean {
  const unit = ts.findAncestor(node.parent, ts.isFunctionLike);
  return unit !== undefined && ts.isFunctionDeclaration(unit) && ts.isSourceFile(unit.parent);
}

/** What the lowering needs from from-ast (no import of the lowerer itself). */
export interface AmbientGlobalFunctionLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly resolver:
    | Pick<IrFromAstResolver, "isLibOnlyBinding" | "supportsBackendCapability" | "ambientGlobalFunctionTarget">
    | undefined;
  readonly classify: ClassifyDeclared;
  readonly lowerOperand: (argument: ts.Expression, family: OperandFamily) => IrValueId;
  /** Withdraws the unit (throws). */
  readonly refuseOperand: (name: string, index: number, type: IrType) => never;
}

/**
 * from-ast's half, behind the same admission as the selector: each typed
 * operand straight into legacy's own provider — `parseInt(s[, r])` /
 * `parseFloat(s)` → the native scanner (a missing radix is the provider's NaN
 * sentinel, exactly legacy's call site), `escape(s)` / `unescape(s)` →
 * `__escape` / `__unescape` (their externref result recovers the native
 * string carrier), `isNaN(n)` → `n != n`. Null when the call is not admitted
 * on this lane, which leaves it to the other call arms.
 */
export function lowerAmbientGlobalFunctionCall(
  expr: ts.CallExpression,
  host: AmbientGlobalFunctionLoweringHost,
): IrValueId | null {
  const { builder, resolver } = host;
  if (resolver?.supportsBackendCapability?.("native-global-function-call") !== true) return null;
  const call = ambientGlobalFunctionCall(expr, host.classify);
  if (call === null || resolver.isLibOnlyBinding?.(call.callee) !== true) return null;
  const lowerOperands = (): IrValueId[] =>
    call.operands.map(({ argument, family }, index) => {
      const value = host.lowerOperand(argument, family);
      const type = builder.typeOf(value);
      const matches = family === "string" ? type.kind === "string" : asVal(type)?.kind === "f64";
      return matches ? value : host.refuseOperand(call.name, index, type);
    });
  if (call.name === "isNaN") {
    const [n] = lowerOperands() as [IrValueId];
    return builder.emitBinary("f64.ne", n, n, irBool());
  }
  const target = resolver.ambientGlobalFunctionTarget?.(call.name) ?? null;
  if (target === null) return null;
  const [text, radix] = lowerOperands() as [IrValueId, IrValueId | undefined];
  const textRef = coerceIrValueToExternref(builder, text);
  const parse = call.name === "parseInt" || call.name === "parseFloat";
  const args =
    call.name === "parseInt" ? [textRef, radix ?? builder.emitConst({ kind: "f64", value: NaN }, F64)] : [textRef];
  const result = builder.emitCall(target, args, parse ? F64 : irDynamic())!; // non-void result type
  return parse ? result : builder.emitDynStringCarrier(result);
}
