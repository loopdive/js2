// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static callback facts used by the native `Array.prototype.flatMap` arm.
 *
 * Kept separate from the array-methods implementation so the large method
 * compiler remains within its tracked LOC budget.
 * The #3532 empty-array contextual-union fix remains in `compileArrayLiteral`.
 */
import type { TypeFact } from "../checker/oracle.js";
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Resolve the callback return carrier through the registry-free type oracle. */
export function flatMapCallbackReturnFact(ctx: CodegenContext, cbArg: ts.Expression): TypeFact | undefined {
  return ctx.oracle.signatureOf(cbArg)?.returns;
}

/** A concrete callback carrier is a non-array value, so depth-1 flatten is identity. */
export function flatMapReturnIsDefinitelyNonArray(ctx: CodegenContext, fact: TypeFact | undefined): boolean {
  if (!fact) return false;
  // `class SubArray extends Array {}` is represented as a class fact, but its
  // instances are still arrays at runtime. Treat direct and user-class-
  // transitive Array subclasses as potentially flattenable; the native arm
  // then takes its existing fail-loud path instead of returning the species
  // result without flattening it.
  if (fact.kind === "class" && isArraySubclass(ctx, fact.name)) return false;
  return !["array", "tuple", "union", "any", "unknown", "unresolvable"].includes(fact.kind);
}

/** Preserve a species-created result only when the callback cannot return an array. */
export function flatMapSpeciesResult(
  ctx: CodegenContext,
  mapType: ValType | null,
  cbArg: ts.Expression,
): ValType | undefined {
  // ArraySpeciesCreate widens the map result to externref. For a statically
  // concrete scalar/object callback that remains the final flatMap result;
  // dynamic, union, and array returns stay fail-loud.
  if (mapType?.kind === "externref" && flatMapReturnIsDefinitelyNonArray(ctx, flatMapCallbackReturnFact(ctx, cbArg))) {
    return mapType;
  }
  return undefined;
}

/** Recognize direct and user-class-transitive Array subclasses. */
function isArraySubclass(ctx: CodegenContext, className: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = className;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (ctx.classBuiltinParentMap.get(current) === "Array") return true;
    current = ctx.classParentMap.get(current);
  }
  return false;
}
