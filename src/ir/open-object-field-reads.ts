// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7352 O1) A value computed from an open-object module binding is a dynamic
 * value. The checker types `o.a` of `var o = { a: "x" }` from the literal, as
 * legacy's closed struct stored it; on the lane where the binding is the open
 * `$Object` (`isOpenObjectBinding`) the IR reads it through the dynamic
 * carrier, and so is every value computed from it (`o.a + 1`,
 * `Array.prototype.indexOf.call(o, x)`). The checker's family is no proof of
 * what such a value holds, so the selector's checker-backed evidence (the
 * primitive classifiers, the resolver's scalar family and slot-value match)
 * answers nothing for an expression that reads such a binding, and every
 * consumer judges it as the carrier it lowers to.
 */

import { ts } from "../ts-api.js";
import type { IrSelectionOptions } from "./select.js";

type Resolver = NonNullable<IrSelectionOptions["resolveModuleBinding"]>;

/** Whether `node` reads an open-object module binding outside a nested function (false off the lane). */
export function readsOpenObject(options: IrSelectionOptions | undefined, node: ts.Node): boolean {
  const isOpenObjectBinding = options?.isOpenObjectBinding;
  const resolve = options?.resolveModuleBinding;
  if (isOpenObjectBinding === undefined || resolve === undefined) return false;
  const reads = (child: ts.Node): boolean => {
    if (!ts.isIdentifier(child)) {
      return !ts.isFunctionLike(child) && ts.forEachChild(child, (next) => reads(next) || undefined) === true;
    }
    const binding = resolve(child);
    return (
      binding?.valueKind.kind === "dynamic" &&
      ts.isVariableDeclaration(binding.declaration) &&
      isOpenObjectBinding(binding.declaration)
    );
  };
  return reads(node);
}

/** `options` with its checker-backed evidence blind to values read off an open-object binding. */
export function withOpenObjectFieldReads(options: IrSelectionOptions | undefined): IrSelectionOptions | undefined {
  const resolve = options?.resolveModuleBinding;
  if (options?.isOpenObjectBinding === undefined || resolve === undefined) return options;
  const blind =
    <R>(classify: ((expr: ts.Expression) => R | undefined) | undefined) =>
    (expr: ts.Expression): R | undefined =>
      readsOpenObject(options, expr) ? undefined : classify?.(expr);
  const call = resolve as (node: ts.Identifier, writeValue?: ts.Expression) => ReturnType<Resolver>;
  // A slot other than the carrier takes no value computed from an open object.
  const slotTakes = (node: ts.Identifier, value: ts.Expression) =>
    resolve(node)?.valueKind.kind === "dynamic" || !readsOpenObject(options, value);
  const resolveModuleBinding = Object.assign(
    (node: ts.Identifier, writeValue?: ts.Expression) =>
      writeValue === undefined || slotTakes(node, writeValue) ? call(node, writeValue) : undefined,
    resolve,
    {
      scalarExpressionFamily: blind(resolve.scalarExpressionFamily),
      bindingValueMatches: (node: ts.Identifier, value: ts.Expression) =>
        resolve.bindingValueMatches(node, value) && slotTakes(node, value),
    },
  );
  return {
    ...options,
    resolveModuleBinding,
    classifyPrimitiveExpression: options.classifyPrimitiveExpression && blind(options.classifyPrimitiveExpression),
    classifyDeclaredPrimitiveExpression:
      options.classifyDeclaredPrimitiveExpression && blind(options.classifyDeclaredPrimitiveExpression),
  };
}
