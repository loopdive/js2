// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";

import { irBool } from "./boolean-brand.js";
import { isUnshadowedLibGlobal } from "../shared/ambient-intrinsics.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrFromAstResolver } from "./from-ast.js";
import type { IrDeclaredPrimitiveExpressionFamily } from "./module-bindings.js";
import { asVal, irDynamic, irVal, type IrType, type IrValueId } from "./nodes.js";
import { coerceIrValueToExternref } from "./value-coercion.js";

const F64: IrType = irVal({ kind: "f64" });
const ANYREF: IrType = irVal({ kind: "anyref" });

/**
 * (#7253) Direct calls of the ES5 / Annex B global functions whose host-free
 * lowering is one call to a fixed-signature native provider (or, for `isNaN`,
 * one `f64.ne`); (#7267) and `JSON.parse(text)`, whose provider is the native
 * codec's `__json_parse_text`. Each operand position names the ONE primitive
 * family it accepts — a string for the parsed / transformed text, a number for
 * `parseInt`'s radix and `isNaN`'s operand — so the IR never performs a
 * ToString / ToNumber of its own: any other operand keeps the legacy call,
 * which owns those coercions (and the `stringToNumber` dynamic-carrier arm).
 */
export type IrAmbientGlobalFunctionName = "parseInt" | "parseFloat" | "escape" | "unescape" | "isNaN" | "JSON.parse";

type OperandFamily = "string" | "number";
type ClassifyDeclared = (expr: ts.Expression) => IrDeclaredPrimitiveExpressionFamily | undefined;

type ProviderCapability = "native-global-function-call" | "native-json-codec" | "native-dynamic-member-read";

interface AmbientGlobalFunctionPlan {
  readonly operands: readonly OperandFamily[];
  /** The lane capabilities that name the provider's host-free lanes (all must hold). */
  readonly capabilities: readonly ProviderCapability[];
  /**
   * The provider is a runtime callable, which an ES module's `<module-init>`
   * cannot name: that unit lowers as a prepared component whose Program ABI
   * has no identity for it (measured for `__escape`: `late-preparation-unsupported`).
   */
  readonly runtimeCallable: boolean;
  /** What the call answers: a concrete scalar / string, or (`JSON.parse`) the dynamic carrier. */
  readonly result: "number" | "boolean" | "string" | "dynamic";
}

const PLANS: ReadonlyMap<IrAmbientGlobalFunctionName, AmbientGlobalFunctionPlan> = new Map([
  ["parseInt", globalFunction(["string", "number"], false, "number")],
  ["parseFloat", globalFunction(["string"], false, "number")],
  ["escape", globalFunction(["string"], true, "string")],
  ["unescape", globalFunction(["string"], true, "string")],
  ["isNaN", globalFunction(["number"], false, "boolean")],
  // No reviver: a second argument keeps legacy's reviver codec. The value graph
  // is read back through the carrier's member read, which WASI's IR read does
  // not answer for it (measured: `JSON.parse('{"a":3}').a` is NaN on WASI).
  [
    "JSON.parse",
    {
      operands: ["string"],
      capabilities: ["native-json-codec", "native-dynamic-member-read"],
      runtimeCallable: true,
      result: "dynamic",
    },
  ],
]);

function globalFunction(
  operands: readonly OperandFamily[],
  runtimeCallable: boolean,
  result: AmbientGlobalFunctionPlan["result"],
): AmbientGlobalFunctionPlan {
  return { operands, capabilities: ["native-global-function-call"], runtimeCallable, result };
}

interface IrAmbientGlobalFunctionCall {
  readonly name: IrAmbientGlobalFunctionName;
  readonly plan: AmbientGlobalFunctionPlan;
  /** The global the callee resolves through: the function itself, or `JSON` of `JSON.parse`. */
  readonly root: ts.Identifier;
  /** The SUPPLIED arguments with their families (a missing `parseInt` radix is the provider's NaN sentinel). */
  readonly operands: readonly { readonly argument: ts.Expression; readonly family: OperandFamily }[];
}

/** What both sides ask of their lane and binding resolver. */
export interface AmbientGlobalFunctionAdmission {
  readonly classify: ClassifyDeclared | undefined;
  readonly supportsBackendCapability: ((capability: ProviderCapability) => boolean) | undefined;
  /** The lib-only ("every") binding test — a script `function JSON() {}` merges with the lib's. */
  readonly isLibOnlyBinding: (node: ts.Identifier) => boolean;
}

/** `parseInt` or `JSON.parse`: the callee's table name and the global it resolves through. */
function calleeOf(callee: ts.Expression): { readonly name: string; readonly root: ts.Identifier } | null {
  if (ts.isIdentifier(callee)) return { name: callee.text, root: callee };
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
  return { name: `${callee.expression.text}.${callee.name.text}`, root: callee.expression };
}

/**
 * The admission both sides read: the call shape, every operand
 * checker-classified as its position's family, the plan's lane capability and
 * the unshadowed lib global. The selector adds only the module-init rule.
 */
function ambientGlobalFunctionCall(
  expr: ts.CallExpression,
  admission: AmbientGlobalFunctionAdmission,
): IrAmbientGlobalFunctionCall | null {
  const { classify } = admission;
  if (classify === undefined || expr.questionDotToken || expr.typeArguments?.length) return null;
  const callee = calleeOf(expr.expression);
  const plan = callee === null ? undefined : PLANS.get(callee.name as IrAmbientGlobalFunctionName);
  if (callee === null || plan === undefined) return null;
  if (expr.arguments.length < 1 || expr.arguments.length > plan.operands.length) return null;
  if (!plan.capabilities.every((capability) => admission.supportsBackendCapability?.(capability) === true)) return null;
  const operands = expr.arguments.map((argument, index) => ({ argument, family: plan.operands[index]! }));
  if (!operands.every(({ argument, family }) => classify(argument) === family)) return null;
  if (!isUnshadowedLibGlobal(callee.root, admission.isLibOnlyBinding)) return null;
  return { name: callee.name as IrAmbientGlobalFunctionName, plan, root: callee.root, operands };
}

/** An admitted call as the selector sees it: a lowering, not a call edge. */
export interface IrAdmittedAmbientGlobalFunctionCall {
  readonly arguments: readonly ts.Expression[];
  readonly result: AmbientGlobalFunctionPlan["result"];
}

/**
 * The selector's admission: the shared one, refused in an ES module's
 * `<module-init>` where the provider is a runtime callable (see
 * {@link AmbientGlobalFunctionPlan.runtimeCallable}). Scripts — every test262
 * body — and ordinary functions are unaffected.
 */
export function admitAmbientGlobalFunctionCall(
  expr: ts.CallExpression,
  callerIsModuleInit: boolean,
  admission: AmbientGlobalFunctionAdmission,
): IrAdmittedAmbientGlobalFunctionCall | null {
  const call = ambientGlobalFunctionCall(expr, admission);
  if (call === null) return null;
  if (call.plan.runtimeCallable && callerIsModuleInit && ts.isExternalModule(expr.getSourceFile())) return null;
  return { arguments: expr.arguments, result: call.plan.result };
}

/** What the lowering needs from from-ast (no import of the lowerer itself). */
export interface AmbientGlobalFunctionLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly admission: AmbientGlobalFunctionAdmission;
  readonly target: Pick<IrFromAstResolver, "ambientGlobalFunctionTarget">["ambientGlobalFunctionTarget"];
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
 * string carrier), `JSON.parse(s)` → `__json_parse_text` (its anyref value
 * graph crosses onto the externref carrier with `extern.convert_any`, exactly
 * legacy's call site), `isNaN(n)` → `n != n`. Null when the call is not
 * admitted on this lane, which leaves it to the other call arms.
 */
export function lowerAmbientGlobalFunctionCall(
  expr: ts.CallExpression,
  host: AmbientGlobalFunctionLoweringHost,
): IrValueId | null {
  const { builder } = host;
  const call = ambientGlobalFunctionCall(expr, host.admission);
  if (call === null) return null;
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
  const target = host.target?.(call.name) ?? null;
  if (target === null) return null;
  const [text, radix] = lowerOperands() as [IrValueId, IrValueId | undefined];
  const textRef = coerceIrValueToExternref(builder, text);
  const parse = call.name === "parseInt" || call.name === "parseFloat";
  const args =
    call.name === "parseInt" ? [textRef, radix ?? builder.emitConst({ kind: "f64", value: NaN }, F64)] : [textRef];
  const resultType = parse ? F64 : call.name === "JSON.parse" ? ANYREF : irDynamic();
  const result = builder.emitCall(target, args, resultType);
  if (result === null) throw new Error(`ir/ambient-global-function-call: ${call.name} provider returned no value`);
  if (parse) return result;
  if (call.name === "JSON.parse") return builder.emitBox(builder.emitCoerceToExternref(result), irDynamic());
  return builder.emitDynStringCarrier(result);
}
