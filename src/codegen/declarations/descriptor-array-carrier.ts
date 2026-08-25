// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4670) Keep arrays with indexed accessor descriptors on the identity-safe
 * externref vec carrier. A typed f64/AnyValue slot cannot preserve a getter's
 * heterogeneous result through Array.prototype.filter.
 */
import type { ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { getOrRegisterVecType } from "../registry/types.js";

const descriptorArrayReceivers = new WeakMap<CodegenContext, Set<string>>();

export function recordDescriptorArrayReceiver(ctx: CodegenContext, name: string): void {
  let names = descriptorArrayReceivers.get(ctx);
  if (names === undefined) {
    names = new Set();
    descriptorArrayReceivers.set(ctx, names);
  }
  names.add(name);
}

export function descriptorArrayCarrierType(ctx: CodegenContext, decl: ts.VariableDeclaration): ValType | undefined {
  if (!ctx.standalone || !ctx.vecAccessorDescriptorDirty || !ts.isIdentifier(decl.name)) return undefined;
  const receivers = descriptorArrayReceivers.get(ctx);
  if (receivers === undefined) return undefined;
  const name = decl.name.text;
  if (receivers.has(name) && isArrayLiteralInitializer(decl.initializer)) {
    return externrefVecType(ctx);
  }
  const receiver = filterReceiverIdentifier(decl.initializer);
  return receiver !== undefined && receivers.has(receiver) ? externrefVecType(ctx) : undefined;
}

function externrefVecType(ctx: CodegenContext): ValType {
  return { kind: "ref_null", typeIdx: getOrRegisterVecType(ctx, "externref", { kind: "externref" }) };
}

function isArrayLiteralInitializer(initializer: ts.Expression | undefined): boolean {
  let current = initializer;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  return current !== undefined && ts.isArrayLiteralExpression(current);
}

function filterReceiverIdentifier(initializer: ts.Expression | undefined): string | undefined {
  let current = initializer;
  while (current && ts.isParenthesizedExpression(current)) current = current.expression;
  if (!current || !ts.isCallExpression(current)) return undefined;
  const callee = current.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "filter") return undefined;
  let receiver: ts.Node = callee.expression;
  while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
  return ts.isIdentifier(receiver) ? receiver.text : undefined;
}
