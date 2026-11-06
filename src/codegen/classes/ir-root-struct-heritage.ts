// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * `class X extends P` whose heritage the direct backend has NO compiled
 * struct relationship to, so it lays `X` out as an ordinary ROOT struct with
 * self-receiver method slots, exactly like an `implements`-only class. Two
 * heritage kinds qualify:
 *
 *  - (#7241) `P` has no value binding in the program: the lib declares
 *    `Iterator` as an interface only (TS reports "Cannot extend an interface").
 *  - (#7244) `P` is a compiled top-level `function P() {}` — the "fnctor"
 *    parent of #3123, which is exactly the test262 harness `Iterator` shim
 *    (`scripts/test262-iterator-binding.mjs`). Legacy records it through
 *    `fnctorAncestorOfClass`, on every lane; inherited members resolve at the
 *    call site (standalone) or through the host's live-prototype lookup (gc),
 *    never through the class struct.
 *
 * This reads that legacy layout decision back from the state
 * `collectClassDeclaration` recorded; it never re-derives it. The class
 * qualifies only when legacy recorded the spelled parent name, gave the
 * class's struct no supertype, and put it in none of the builtin-parent /
 * externref-backed / linked-dynamic-parent representations — and the parent
 * is not a host-constructible builtin (those always take the externref arm).
 * The selector then admits only the class's own `super`-free instance
 * methods; its constructor (which calls `super()` into the parent) and
 * accessors stay legacy.
 */

import { ts } from "../../ts-api.js";
import { isHostConstructibleBuiltin } from "../builtin-tags.js";
import { fnctorAncestorOfClass } from "../class-member-keys.js";
import type { CodegenContext } from "../context/types.js";
import type { StructTypeDef } from "../../ir/types.js";

export function irClassHeritageIsRootStruct(
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
  // (#7244) A compiled top-level function constructor parent — what legacy
  // itself keys the fnctor arm on.
  if (fnctorAncestorOfClass(ctx, className) === parentName) return true;
  // (#7241) The heritage identifier has no value binding at all: the lib
  // declares `Iterator` as an interface only, so the value-side lookup finds
  // nothing (a parameter, a local `var`, an import or a class all resolve).
  return ctx.oracle.isUnresolvableIdentifier(expression);
}
