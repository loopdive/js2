// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import ts from "typescript";

import { irBool } from "./boolean-brand.js";
import { isUnshadowedLibBinding } from "../shared/ambient-intrinsics.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrBackendTargetCapability } from "./backend/legality.js";
import type { IrDeclaredPrimitiveExpressionFamily } from "./module-bindings.js";
import { asVal, irDynamic, irVal, type IrFuncRef, type IrType, type IrValueId } from "./nodes.js";
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

/** The lane capabilities a provider row names (both sides' capability query takes them). */
export type IrAmbientGlobalFunctionCapability = Extract<
  IrBackendTargetCapability,
  "native-global-function-call" | "native-json-codec" | "native-dynamic-member-read"
>;

/**
 * Where a row's call may be lowered (the unit the call's nearest function-like
 * ancestor names; none for top-level code):
 *   - `any`;
 *   - `es-module-top-level-function` (#7114): in an ES module, only a top-level
 *     function declaration. Every other unit there (`<module-init>`, class
 *     members, closures) lowers as a prepared component, whose Program ABI has
 *     no identity for the `__escape` / `__unescape` runtime callables nor for
 *     `dyn.string_carrier` (measured: `late-preparation-unsupported`). Scripts —
 *     every test262 body — are unaffected;
 *   - `plain-unit` (#7267): that, and in a script never a class member (also a
 *     prepared component: "has no resolvable Program ABI binding") nor a
 *     closure nested in another function (a capturing closure whose body reads
 *     the dynamic result loses its captured-struct type from the published
 *     module once the dynamic runtime is registered: "… closure-support:
 *     captured-subtype … no longer has its allocator object", a hard compile
 *     error).
 */
type UnitScope = "any" | "es-module-top-level-function" | "plain-unit";

interface AmbientGlobalFunctionPlan {
  readonly operands: readonly OperandFamily[];
  /** The lane capabilities that name the provider's host-free lanes (all must hold). */
  readonly capabilities: readonly IrAmbientGlobalFunctionCapability[];
  readonly scope: UnitScope;
  /**
   * Legacy folds a static text at compile time with the host's parser; the
   * admission refuses those calls so the fold stays legacy's (the runtime
   * codec's number scan is not exact — #7267 review).
   */
  readonly staticTextFolded?: true;
  /** What the call answers: a concrete scalar / string, or (`JSON.parse`) the dynamic carrier. */
  readonly result: "number" | "boolean" | "string" | "dynamic";
}

const GLOBAL_FUNCTION: readonly IrAmbientGlobalFunctionCapability[] = ["native-global-function-call"];

const PLANS: ReadonlyMap<IrAmbientGlobalFunctionName, AmbientGlobalFunctionPlan> = new Map([
  ["parseInt", { operands: ["string", "number"], capabilities: GLOBAL_FUNCTION, scope: "any", result: "number" }],
  ["parseFloat", { operands: ["string"], capabilities: GLOBAL_FUNCTION, scope: "any", result: "number" }],
  [
    "escape",
    { operands: ["string"], capabilities: GLOBAL_FUNCTION, scope: "es-module-top-level-function", result: "string" },
  ],
  [
    "unescape",
    { operands: ["string"], capabilities: GLOBAL_FUNCTION, scope: "es-module-top-level-function", result: "string" },
  ],
  ["isNaN", { operands: ["number"], capabilities: GLOBAL_FUNCTION, scope: "any", result: "boolean" }],
  // No reviver: a second argument keeps legacy's reviver codec. The value graph
  // is read back through the carrier's member read, which WASI's IR read does
  // not answer for it (measured: `JSON.parse('{"a":3}').a` is NaN on WASI).
  [
    "JSON.parse",
    {
      operands: ["string"],
      capabilities: ["native-json-codec", "native-dynamic-member-read"],
      scope: "plain-unit",
      staticTextFolded: true,
      result: "dynamic",
    },
  ],
]);

/** Does `scope` admit a call at `expr`? See {@link UnitScope}. */
function unitScopeAdmits(scope: UnitScope, expr: ts.CallExpression): boolean {
  if (scope === "any") return true;
  const unit = ts.findAncestor(expr.parent, ts.isFunctionLike);
  const topLevelFunction = unit !== undefined && ts.isFunctionDeclaration(unit) && ts.isSourceFile(unit.parent);
  if (ts.isExternalModule(expr.getSourceFile())) return topLevelFunction;
  if (scope === "es-module-top-level-function" || unit === undefined || topLevelFunction) return true;
  return !ts.isClassElement(unit) && ts.findAncestor(unit.parent, ts.isFunctionLike) === undefined;
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
export interface IrAmbientGlobalFunctionAdmission {
  readonly classify: ClassifyDeclared | undefined;
  readonly supportsBackendCapability: ((capability: IrAmbientGlobalFunctionCapability) => boolean) | undefined;
  /** The lib-only ("every") binding test — a script `function JSON() {}` merges with the lib's. */
  readonly isLibOnlyBinding: (node: ts.Identifier) => boolean;
  /** Legacy's own compile-time fold test for a `staticTextFolded` row's call. */
  readonly foldsAtCompileTime: (call: ts.CallExpression) => boolean;
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
  admission: IrAmbientGlobalFunctionAdmission,
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
  if (!isUnshadowedLibBinding(callee.root, admission.isLibOnlyBinding)) return null;
  if (plan.staticTextFolded && admission.foldsAtCompileTime(expr)) return null;
  return { name: callee.name as IrAmbientGlobalFunctionName, plan, root: callee.root, operands };
}

/** An admitted call as the selector sees it: a lowering, not a call edge. */
export interface IrAdmittedAmbientGlobalFunctionCall {
  readonly arguments: readonly ts.Expression[];
  readonly result: AmbientGlobalFunctionPlan["result"];
}

/** The selector's admission: the shared one, and the row's {@link UnitScope}. */
export function admitAmbientGlobalFunctionCall(
  expr: ts.CallExpression,
  admission: IrAmbientGlobalFunctionAdmission,
): IrAdmittedAmbientGlobalFunctionCall | null {
  const call = ambientGlobalFunctionCall(expr, admission);
  if (call === null || !unitScopeAdmits(call.plan.scope, expr)) return null;
  return { arguments: expr.arguments, result: call.plan.result };
}

/** What the lowering needs from from-ast (no import of the lowerer itself). */
export interface AmbientGlobalFunctionLoweringHost {
  readonly builder: IrFunctionBuilder;
  readonly admission: IrAmbientGlobalFunctionAdmission;
  /** The provider the resolver names, or null where the lane registered none. */
  readonly target: (name: Exclude<IrAmbientGlobalFunctionName, "isNaN">) => IrFuncRef | null;
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
  const target = host.target(call.name);
  if (target === null) return null;
  const [text, radix] = lowerOperands() as [IrValueId, IrValueId | undefined];
  const textRef = coerceIrValueToExternref(builder, text);
  const args =
    call.name === "parseInt" ? [textRef, radix ?? builder.emitConst({ kind: "f64", value: NaN }, F64)] : [textRef];
  const resultType = call.plan.result === "number" ? F64 : call.plan.result === "dynamic" ? ANYREF : irDynamic();
  const result = builder.emitCall(target, args, resultType);
  if (result === null) throw new Error(`ir/ambient-global-function-call: ${call.name} provider returned no value`);
  // The externref result recovers the native string carrier; the anyref value graph crosses onto the carrier.
  if (call.plan.result === "string") return builder.emitDynStringCarrier(result);
  if (call.plan.result === "dynamic") return builder.emitBox(builder.emitCoerceToExternref(result), irDynamic());
  return result;
}
