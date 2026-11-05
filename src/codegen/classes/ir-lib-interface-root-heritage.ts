// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7241) `class X extends Iterator {}` — a heritage identifier with no value
 * binding in the program: the lib declares `Iterator` as an interface only
 * (TS reports "Cannot extend an interface"). The direct backend has no compiled
 * relationship to such a parent and lays `X` out as an ordinary ROOT struct
 * with self-receiver method slots, exactly like an `implements`-only class.
 *
 * This reads that legacy layout decision back from the state
 * `collectClassDeclaration` recorded; it never re-derives it. The class
 * qualifies only when legacy recorded the spelled parent name, gave the
 * class's struct no supertype, and put it in none of the builtin-parent /
 * externref-backed / linked-dynamic-parent representations — and the parent
 * is not a host-constructible builtin (those always take the externref arm).
 */

import { ts } from "../../ts-api.js";
import { isHostConstructibleBuiltin } from "../builtin-tags.js";
import type { CodegenContext } from "../context/types.js";
import type { StructTypeDef } from "../../ir/types.js";

export function irClassExtendsLibInterfaceAsRoot(
  ctx: CodegenContext,
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  className: string,
): boolean {
  const clause = declaration.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
  const expression = clause?.types[0]?.expression;
  if (!expression || !ts.isIdentifier(expression) || clause!.types.length !== 1) return false;
  const parentName = expression.text;
  if (ctx.classParentMap.get(className) !== parentName || ctx.classSet.has(parentName)) return false;
  if (
    ctx.classBuiltinParentMap.has(className) ||
    ctx.classExternrefBackedSet.has(className) ||
    ctx.classLinkedDynamicParentExpr.has(className) ||
    isHostConstructibleBuiltin(parentName)
  ) {
    return false;
  }
  const structIdx = ctx.structMap.get(className);
  const struct = structIdx === undefined ? undefined : (ctx.mod.types[structIdx] as StructTypeDef | undefined);
  if (struct?.kind !== "struct" || struct.superTypeIdx !== undefined) return false;
  // The heritage identifier has no value binding at all: the lib declares
  // `Iterator` as an interface only, so the value-side lookup finds nothing
  // (a parameter, a local `var`, an import or a class all resolve).
  return ctx.oracle.isUnresolvableIdentifier(expression);
}
