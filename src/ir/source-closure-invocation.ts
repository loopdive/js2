// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrFunction, IrClosureSignature, IrType, IrValueId } from "./core/nodes.js";
import { closureSignatureEquals, irVal, irVec } from "./core/types.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irIntrinsicFuncRef } from "./core/callable-bindings.js";
import {
  IR_CLOSURE_VECTOR_APPLY,
  IR_CLOSURE_UNDEFINED,
  irClosureMethodReference,
} from "./core/closure-invocation-callables.js";
import { IrUnsupportedError } from "./outcomes.js";
import { assertSourceClosureInvocationEffects } from "./source-closure-invocation-effects.js";
import {
  sourceClosureLiteralBinding,
  sourceClosureCallbackArguments,
  type SourceClosureCallbackArgument,
} from "./source-closure-callbacks.js";

export interface SourceClosureInvocationPlan {
  readonly expression: ts.CallExpression;
  readonly callee: ts.Identifier;
  readonly declaration: ts.VariableDeclaration;
  readonly method: "call" | "apply";
  readonly receiver: ts.Expression | undefined;
  readonly arguments: readonly ts.Expression[];
  readonly callbacks: readonly SourceClosureCallbackArgument[];
}
function unsupported(detail: string): never {
  throw new IrUnsupportedError("method-call-unsupported", "build", `native closure invocation: ${detail}`);
}

/** A source fact, never inferred from an absent rest field after transport. */
export function fixedClosureParameters(
  node:
    | ts.FunctionExpression
    | ts.ArrowFunction
    | ts.MethodDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  signature: IrClosureSignature,
): Pick<NonNullable<IrFunction["closureSubtype"]>, "parameters"> {
  if (
    node.parameters.length !== signature.params.length ||
    node.parameters.some(
      (p) => p.dotDotDotToken || p.questionToken || !ts.isIdentifier(p.name) || p.name.text === "this",
    )
  )
    return {};
  const firstDefault = node.parameters.findIndex((p) => p.initializer !== undefined);
  const publicLength = firstDefault < 0 ? node.parameters.length : firstDefault;
  if (publicLength !== (signature.defaultParamStart ?? signature.params.length)) return {};
  return { parameters: { kind: "fixed", count: node.parameters.length, publicLength } };
}

function candidate(checker: ts.TypeChecker, expression: ts.CallExpression): SourceClosureInvocationPlan | undefined {
  const access = expression.expression;
  if (
    !ts.isPropertyAccessExpression(access) ||
    !ts.isIdentifier(access.expression) ||
    (access.name.text !== "call" && access.name.text !== "apply")
  )
    return undefined;
  const declaration = sourceClosureLiteralBinding(checker, access.expression);
  if (!declaration) return undefined;
  if (expression.questionDotToken || expression.arguments.some(ts.isSpreadElement))
    unsupported("optional or spread invocation needs its actual producer");
  const method = access.name.text;
  let args: readonly ts.Expression[];
  if (method === "call") args = expression.arguments.slice(1);
  else {
    if (expression.arguments.length !== 2 || !ts.isArrayLiteralExpression(expression.arguments[1]!))
      unsupported("apply requires the certified dense array literal; generic array-like access is unresolved");
    const array = expression.arguments[1] as ts.ArrayLiteralExpression;
    if (array.elements.some((element) => ts.isOmittedExpression(element) || ts.isSpreadElement(element)))
      unsupported("sparse/spread apply list needs its actual element provider");
    args = array.elements;
  }
  return {
    expression,
    callee: access.expression,
    declaration,
    method,
    receiver: expression.arguments[0],
    arguments: args,
    callbacks: sourceClosureCallbackArguments(checker, declaration, args),
  };
}

/** Conservative whole-source effect proof: no unknown call, getter, escape or prototype/member mutation. */
export function prepareSourceClosureInvocations(
  checker: ts.TypeChecker,
  sources: readonly ts.SourceFile[],
): ReadonlyMap<ts.CallExpression, SourceClosureInvocationPlan> {
  const plans = new Map<ts.CallExpression, SourceClosureInvocationPlan>();
  const discover = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const plan = candidate(checker, node);
      if (plan) plans.set(node, plan);
    }
    ts.forEachChild(node, discover);
  };
  sources.forEach(discover);
  if (!plans.size) return plans;
  assertSourceClosureInvocationEffects(checker, sources, plans);
  return plans;
}

export interface SourceClosureInvocationHost {
  readonly builder: IrFunctionBuilder;
  lower(expression: ts.Expression): IrValueId;
  externalize(value: IrValueId, expression: ts.Expression): IrValueId;
}

/** Semantic calls and the existing vector allocation, with the source evaluation order retained. */
export function lowerSourceClosureInvocation(
  plan: SourceClosureInvocationPlan,
  host: SourceClosureInvocationHost,
): IrValueId {
  const { builder } = host;
  const callee = host.lower(plan.callee),
    type = builder.typeOf(callee);
  if (type.kind !== "closure" && type.kind !== "callable") unsupported("callee lost its actual closure signature");
  const packed = type.kind === "closure" ? builder.emitCallablePack(callee, type.signature) : callee;
  // Erase only the call ABI carrier; the defining pack still retains the exact
  // signature/allocation association authenticated by the native requirements.
  const external = builder.emitCoerceToExternref(packed);
  const extern = irVal({ kind: "externref" });
  const receiver = plan.receiver
    ? host.externalize(host.lower(plan.receiver), plan.receiver)
    : builder.emitCall(irIntrinsicFuncRef(IR_CLOSURE_UNDEFINED), [], extern)!;
  const args = plan.arguments.map((argument, index) => {
    const value = host.lower(argument);
    const expected = type.signature.params[index];
    if (expected?.kind !== "callable") return host.externalize(value, argument);
    const callback = plan.callbacks.find((row) => row.index === index);
    const actual = builder.typeOf(value);
    if (
      callback?.argument !== argument ||
      actual.kind !== "closure" ||
      !closureSignatureEquals(actual.signature, expected.signature)
    )
      unsupported("callback argument differs from its exact allocation/signature proof");
    return builder.emitCoerceToExternref(builder.emitCallablePack(value, expected.signature));
  });
  const value =
    plan.method === "call"
      ? builder.emitCall(irClosureMethodReference(args.length), [receiver, external, ...args], extern)
      : builder.emitCall(
          irIntrinsicFuncRef(IR_CLOSURE_VECTOR_APPLY),
          [external, receiver, builder.emitVecNewFixed(args, extern, irVec(extern, false))],
          extern,
        );
  if (value === null) throw new Error("native invocation semantic provider unexpectedly returned void");
  const result: IrType | null = type.signature.returnType;
  // The native invocation owner returns its canonical undefined singleton for void callees.
  if (result === null) return value;
  if (result?.kind === "val" && result.val.kind === "f64") return builder.emitIntrinsic("js.number.unbox", [value]);
  if (result?.kind === "extern" || (result?.kind === "val" && result.val.kind === "externref")) return value;
  unsupported("result needs its canonical native invocation conversion");
}
