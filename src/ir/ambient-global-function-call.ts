// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";

import { irBool } from "./boolean-brand.js";
import type { IrFunctionBuilder } from "./builder.js";
import { asVal, irDynamic, irVal, type IrFuncRef, type IrType, type IrValueId } from "./nodes.js";
import { coerceIrValueToExternref } from "./value-coercion.js";

const F64: IrType = irVal({ kind: "f64" });

/**
 * (#7253) Direct calls of the ES5 / Annex B global functions whose host-free
 * lowering is one call to a fixed-signature native provider (or, for `isNaN`,
 * one `f64.ne`): the shape the selector admits and from-ast lowers. Each
 * operand position names the ONE primitive family it accepts — a string for
 * the parsed / transformed text, a number for `parseInt`'s radix and `isNaN`'s
 * operand — so neither side ever performs a ToString / ToNumber of its own.
 * Any other operand keeps the legacy call (which owns those coercions).
 *
 * Syntax only: callers add the binding proof (an unshadowed ambient global),
 * the lane capability (`native-global-function-call`) and the operand types.
 */
export type IrAmbientGlobalFunctionName = "parseInt" | "parseFloat" | "escape" | "unescape" | "isNaN";

type OperandFamily = "string" | "number";

const OPERAND_FAMILIES: ReadonlyMap<IrAmbientGlobalFunctionName, readonly OperandFamily[]> = new Map([
  ["parseInt", ["string", "number"]],
  ["parseFloat", ["string"]],
  ["escape", ["string"]],
  ["unescape", ["string"]],
  ["isNaN", ["number"]],
]);

export interface IrAmbientGlobalFunctionCallShape {
  readonly name: IrAmbientGlobalFunctionName;
  readonly callee: ts.Identifier;
  /** One family per SUPPLIED argument (a missing `parseInt` radix is the provider's NaN sentinel). */
  readonly families: readonly OperandFamily[];
}

export function ambientGlobalFunctionCallShape(expr: ts.CallExpression): IrAmbientGlobalFunctionCallShape | null {
  const callee = expr.expression;
  if (!ts.isIdentifier(callee) || expr.questionDotToken || expr.typeArguments?.length) return null;
  const families = OPERAND_FAMILIES.get(callee.text as IrAmbientGlobalFunctionName);
  if (families === undefined) return null;
  if (expr.arguments.length < 1 || expr.arguments.length > families.length) return null;
  if (expr.arguments.some(ts.isSpreadElement)) return null;
  return {
    name: callee.text as IrAmbientGlobalFunctionName,
    callee,
    families: families.slice(0, expr.arguments.length),
  };
}

/** The selection facts the admission reads (a narrow view of the selector's options). */
export interface AmbientGlobalFunctionSelection {
  readonly isAmbientBinding: (node: ts.Identifier) => boolean;
  readonly options:
    | {
        readonly supportsBackendCapability?: (capability: "native-global-function-call") => boolean;
        readonly classifyDeclaredPrimitiveExpression?: (expr: ts.Expression) => string | undefined;
      }
    | null
    | undefined;
}

/**
 * The selector's admission: the shape, an unshadowed ambient binding, the
 * `native-global-function-call` lane capability and every operand
 * checker-classified as its position's family. The arguments, else null — a
 * lowering, not a call edge.
 *
 * `escape` / `unescape` stay refused in an ES module's `<module-init>`: that
 * unit lowers as a prepared component, whose Program ABI has no identity for
 * the `__escape` / `__unescape` runtime callables nor for `dyn.string_carrier`
 * (measured: `late-preparation-unsupported`). Scripts — every test262 body —
 * and ordinary functions are unaffected.
 */
export function admitAmbientGlobalFunctionCall(
  expr: ts.CallExpression,
  callerIsModuleInit: boolean,
  selection: AmbientGlobalFunctionSelection,
): readonly ts.Expression[] | null {
  const shape = ambientGlobalFunctionCallShape(expr);
  if (shape === null || !selection.isAmbientBinding(shape.callee)) return null;
  if (
    (shape.name === "escape" || shape.name === "unescape") &&
    callerIsModuleInit &&
    ts.isExternalModule(expr.getSourceFile())
  ) {
    return null;
  }
  const options = selection.options;
  if (options?.supportsBackendCapability?.("native-global-function-call") !== true) return null;
  const classify = options.classifyDeclaredPrimitiveExpression;
  if (classify === undefined) return null;
  return expr.arguments.every((argument, index) => classify(argument) === shape.families[index])
    ? expr.arguments
    : null;
}

/** What the lowering needs from from-ast (no import of the lowerer itself). */
export interface AmbientGlobalFunctionLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly resolver:
    | {
        isAmbientBinding?(node: ts.Identifier): boolean;
        supportsBackendCapability?(capability: "native-global-function-call"): boolean;
        ambientGlobalFunctionTarget?(name: Exclude<IrAmbientGlobalFunctionName, "isNaN">): IrFuncRef | null;
      }
    | undefined;
  readonly inScope: (name: string) => boolean;
  readonly lowerOperand: (argument: ts.Expression, family: OperandFamily) => IrValueId;
  /** Withdraws the unit (throws). */
  readonly refuseOperand: (name: string, index: number, type: IrType) => never;
}

/**
 * from-ast's half: each typed operand straight into legacy's own provider —
 * `parseInt(s[, r])` / `parseFloat(s)` → the native scanner (a missing radix
 * is the provider's NaN sentinel, exactly legacy's call site), `escape(s)` /
 * `unescape(s)` → `__escape` / `__unescape` (their externref result recovers
 * the native string carrier), `isNaN(n)` → `n != n`. An operand that did not
 * lower to its family withdraws the unit: no ToString / ToNumber happens here.
 * Null when the call is not this shape on this lane.
 */
export function lowerAmbientGlobalFunctionCall(
  expr: ts.CallExpression,
  host: AmbientGlobalFunctionLoweringHost,
): IrValueId | null {
  const shape = ambientGlobalFunctionCallShape(expr);
  const resolver = host.resolver;
  if (
    shape === null ||
    host.inScope(shape.name) ||
    resolver?.isAmbientBinding?.(shape.callee) !== true ||
    resolver.supportsBackendCapability?.("native-global-function-call") !== true
  ) {
    return null;
  }
  const target = shape.name === "isNaN" ? null : (resolver.ambientGlobalFunctionTarget?.(shape.name) ?? null);
  if (shape.name !== "isNaN" && target === null) return null;
  const { builder } = host;
  const operands = expr.arguments.map((argument, index) => {
    const family = shape.families[index]!;
    const value = host.lowerOperand(argument, family);
    const type = builder.typeOf(value);
    const matches = family === "string" ? type.kind === "string" : asVal(type)?.kind === "f64";
    return matches ? value : host.refuseOperand(shape.name, index, type);
  });
  if (shape.name === "isNaN") return builder.emitBinary("f64.ne", operands[0]!, operands[0]!, irBool());
  const text = coerceIrValueToExternref(builder, operands[0]!);
  if (shape.name === "parseInt" || shape.name === "parseFloat") {
    const radix = shape.name === "parseInt" ? [operands[1] ?? builder.emitConst({ kind: "f64", value: NaN }, F64)] : [];
    const parsed = builder.emitCall(target!, [text, ...radix], F64);
    if (parsed === null) throw new Error(`ir/ambient-global-function-call: ${shape.name} provider returned no value`);
    return parsed;
  }
  const transformed = builder.emitCall(target!, [text], irDynamic());
  if (transformed === null)
    throw new Error(`ir/ambient-global-function-call: ${shape.name} provider returned no value`);
  return builder.emitDynStringCarrier(transformed);
}
