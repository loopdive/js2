// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#5195 Step 1) Class elements whose ComputedPropertyName does not fold.
 *
 * `class C { [x || 1]() {} }` has a key that is only known at
 * ClassDefinitionEvaluation. `class-bodies.ts::resolveClassMemberName` folds
 * what it can (`['a']`, `[1]`, `[Symbol.iterator]`) and answers `undefined`
 * otherwise — and every collection/emit loop then SKIPPED the member outright:
 * the body was never compiled, the key expression was never evaluated (so
 * `[x = 1]` left `x` at 0), and the property never existed.
 *
 * The fix keeps every one of those loops shaped as it is by giving the member a
 * name after all: a synthetic `__cmdyn$<ordinal>` that no source identifier can
 * spell (`$` is not legal in the `${className}_${member}` join the funcMap keys
 * are built from, and the ordinal makes it unique within the class). The member
 * then registers, compiles and dispatches exactly like a named one. Only the
 * two places that publish a SPEC-VISIBLE key differ: the prototype `$Object`
 * install reads the runtime key out of a per-member module global instead of
 * emitting a string constant, and every own-key surface that folds at compile
 * time must decline the synthetic name (it is not the property's key).
 *
 * This is the same shape as the `__priv_` mangling for `#private` elements —
 * an internal name carried through the machinery, filtered at the spec-visible
 * boundary — and the same shape as the object-literal runtime-key lane (#2126).
 *
 * Standalone only: the host lane installs class members through
 * `__register_class_static_method` / the host prototype mirror, which has its
 * own (host-side) key handling, so minting synthetic names there would change
 * behaviour with no install lane to read them.
 */

import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { resolveComputedKeyExpression } from "./shared.js";
import { computedKeyPerformsWrite } from "./ast-modifiers.js";

/**
 * The prefix that marks a member registered under a synthetic name because its
 * computed key is only known at runtime. Deliberately un-spellable in source.
 */
export const DYNAMIC_MEMBER_NAME_PREFIX = "__cmdyn$";

/** The synthetic member name for the class element at `ordinal`. */
export function dynamicClassMemberName(ordinal: number): string {
  return `${DYNAMIC_MEMBER_NAME_PREFIX}${ordinal}`;
}

/**
 * True for a name minted by {@link dynamicClassMemberName}. Every compile-time
 * own-key fold must consult this: the synthetic name is bookkeeping, never a
 * property key, so publishing it would be a WRONG answer rather than a missing
 * one.
 */
export function isDynamicClassMemberName(name: string): boolean {
  return name.startsWith(DYNAMIC_MEMBER_NAME_PREFIX);
}

/** The `ordinal` encoded in a synthetic member name, or `undefined`. */
export function dynamicClassMemberOrdinal(name: string): number | undefined {
  if (!isDynamicClassMemberName(name)) return undefined;
  const ordinal = Number(name.slice(DYNAMIC_MEMBER_NAME_PREFIX.length));
  return Number.isInteger(ordinal) ? ordinal : undefined;
}

/** Map key for a class member's runtime-key global. */
export function dynamicClassKeyGlobalKey(className: string, ordinal: number): string {
  return `${className}:${ordinal}`;
}

/**
 * True when `decl` has at least one method / getter / setter whose
 * ComputedPropertyName does not fold to a compile-time key.
 *
 * The class then has ClassDefinitionEvaluation work — evaluate the key
 * expression once, in source order, in the frame that owns the declaration —
 * which the top-level collector must route through `__module_init` for it to
 * happen at all. Pure predicate; the answer is the same before and after
 * collection.
 */
export function classHasUnresolvedComputedMemberName(ctx: CodegenContext, decl: ts.ClassLikeDeclaration): boolean {
  return decl.members.some((member) => classMemberComputedKeyIsRuntime(ctx, member));
}

/**
 * (#5195 r3-3) True when this METHOD/ACCESSOR carries a ComputedPropertyName the
 * install lane must evaluate at runtime. Single source of truth for
 * {@link classHasUnresolvedComputedMemberName} (which decides whether the class
 * reaches `__module_init` at all) and
 * `class-bodies.ts::resolveInstallableClassMemberName` (which mints the
 * synthetic `__cmdyn$<n>` name). The two MUST agree: a key the name resolver
 * declines but the collector folds is never evaluated, and a key the collector
 * routes but the resolver folds installs under a stale name.
 *
 * Two ways to be runtime-keyed: the key does not fold at all, or it folds only
 * because {@link resolveConstantExpression} drops an assignment's WRITE
 * (`[x = 1]`) — the second is standalone-only, because that is where the
 * runtime-key install lane exists.
 */
export function classMemberComputedKeyIsRuntime(ctx: CodegenContext, member: ts.ClassElement): boolean {
  if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) {
    return false;
  }
  if (member.name === undefined || !ts.isComputedPropertyName(member.name)) return false;
  if (resolveComputedKeyExpression(ctx, member.name.expression) === undefined) return true;
  return ctx.standalone === true && computedKeyPerformsWrite(member.name.expression);
}

/**
 * (#5195 F1) True when `className` or any ancestor declares a member whose
 * computed key is only known at runtime.
 *
 * A subclass of such a class has no funcMap alias for the inherited member (the
 * synthetic `__cmdyn$<ordinal>` name is the parent's and carries no spec key,
 * so aliasing it makes the program-ABI planner reject the module). The member
 * is reached through the prototype chain instead, and that walk starts at the
 * SUBCLASS's own prototype `$Object` — which therefore has to exist, and to be
 * built at ClassDefinitionEvaluation like its parent's.
 */
export function classHierarchyHasDynamicMember(ctx: CodegenContext, className: string): boolean {
  let depth = 0;
  for (
    let current: string | undefined = className;
    current !== undefined && depth < 64;
    current = ctx.classParentMap.get(current), depth++
  ) {
    if ((ctx.classDynamicMembers.get(current)?.length ?? 0) > 0) return true;
  }
  return false;
}
