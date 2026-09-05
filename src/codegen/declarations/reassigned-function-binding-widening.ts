// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-6 T12) The FunctionDeclaration half of the #4204 "the slot is
 * DYNAMIC while the checker still calls it static" rule.
 *
 * ## What the existing rule misses
 *
 * `moduleGlobalIsDynamicButStaticallyPrimitive` (#4204) exists because a
 * widened binding KEEPS its declaration-derived checker type: `var x = 2` is
 * still `number` to TypeScript after `x = this` forced the slot to `externref`,
 * so any consumer that CONST-FOLDS from the checker type answers about a
 * representation the value no longer has. `typeof` is the consumer that shows,
 * because it folds to a literal and never reads the value.
 *
 * That analysis resolves binding identity with `variableDeclarationOf`, which
 * answers only for a `ts.VariableDeclaration`. A function declaration's binding
 * is an ordinary mutable var binding with exactly the same hazard —
 * `function g() {}; g = 123;` — and it slides straight past:
 *
 * | probe (`function g(){}; g = 123`) | before | after |
 * | --- | --- | --- |
 * | `g === 123` | false (write dropped) | true |
 * | `typeof g`  | **`"function"`** | `"number"` |
 *
 * ## The fact this keys on
 *
 * `ctx.liveFuncBindingGlobals` (#2931) is already exactly the right set: a
 * function-declaration name that is REASSIGNED somewhere in the realm, and the
 * reason its `externref` module global exists at all. A name outside it keeps a
 * fixed function value, so its checker type is sound and folding stays correct
 * — which is why this cannot be phrased as "every function binding is dynamic".
 *
 * The identifier must also RESOLVE to that module-scope function declaration:
 * the set is name-keyed, and a same-named function local must not consult a
 * global (the constraint #4204's own note records).
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/** True when `node` is hoisted to module scope — no function/class-like owner. */
function isModuleScoped(node: ts.Node): boolean {
  for (let parent = node.parent; parent !== undefined && !ts.isSourceFile(parent); parent = parent.parent) {
    if (
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isArrowFunction(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isConstructorDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isModuleDeclaration(parent)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Is `id` a read of a module-scope FUNCTION-declaration binding whose value may
 * have been replaced by a reassignment, so the checker's function type no longer
 * describes what the slot holds?
 *
 * Entry point for `moduleGlobalIsDynamicButStaticallyPrimitive`; the caller has
 * already established that the backing module global is `externref`.
 */
export function reassignedFunctionBindingIsDynamic(ctx: CodegenContext, id: ts.Identifier): boolean {
  if (ctx.liveFuncBindingGlobals?.has(id.text) !== true) return false;
  const declaration = ctx.oracle.valueDeclarationOf(id);
  return (
    declaration !== undefined &&
    ts.isFunctionDeclaration(declaration) &&
    declaration.name?.text === id.text &&
    isModuleScoped(declaration)
  );
}
