// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6775 S14) `C[Symbol.species]` for `class C extends <Builtin>` in
 * `--target standalone`.
 *
 * `get <Builtin>[@@species]` (§22.2.6.2 RegExp, §23.1.2.5 Array, …) returns
 * its `this` value, and a subclass INHERITS the accessor through its
 * constructor's [[Prototype]] chain (§15.7.14 step 5.b: `C.[[Prototype]]` is the
 * parent constructor). The read on the bare builtin is lowered, but a subclass
 * value answered `undefined` (`Symbol/species/subclassing.js`). Answer the
 * class value itself when its builtin root owns `@@species` and the class body
 * declares no static member that could shadow the key. Instance behaviour of
 * `class extends <Builtin>` is #6772's lane; this is only the static read.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isSymbolSpeciesKeyExpression, SPECIES_OWNER_CTORS } from "./builtin-static-gopd.js";
import { compileExpression } from "./shared.js";

export function tryCompileClassBuiltinSpeciesRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ElementAccessExpression,
): ValType | undefined {
  if (!ctx.standalone || !ts.isIdentifier(expr.expression)) return undefined;
  if (!isSymbolSpeciesKeyExpression(fctx, expr.argumentExpression)) return undefined;
  const root = ctx.classBuiltinParentMap.get(expr.expression.text);
  if (root === undefined || !SPECIES_OWNER_CTORS.has(root)) return undefined;
  const decl = ctx.oracle.valueDeclarationOf(expr.expression);
  if (!decl || !(ts.isClassDeclaration(decl) || ts.isClassExpression(decl))) return undefined;
  // A static member with a computed key could be `[Symbol.species]`: decline.
  const shadows = decl.members.some(
    (m) =>
      m.name !== undefined &&
      ts.isComputedPropertyName(m.name) &&
      (ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Static) !== 0,
  );
  if (shadows) return undefined;
  return compileExpression(ctx, fctx, expr.expression) ?? undefined;
}
