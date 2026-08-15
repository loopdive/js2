// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#1983) Collision-free funcMap key for class-member synthetic names.
 *
 * Leaf module (depends only on the CodegenContext type) so every codegen file
 * — producers in `class-bodies.ts` / `new-super.ts` / `literals.ts` /
 * `object-ops.ts` and consumers in `expressions/calls.ts` / `closures.ts` /
 * `index.ts` — can import it without risking an import cycle.
 */
import type { CodegenContext } from "./context/types.js";

/**
 * Class members register in `ctx.funcMap` under `${className}_${member}` keys
 * (`A_m` for `A.m`, `A_new` for the ctor, `A_get_v` for a getter, …). A
 * top-level user `function A_m() {}` would claim the same flat string key, and
 * `ensureSiblingFunctionsRegistered` then *silently skips* registering the user
 * function because `funcMap.has("A_m")` is already true — so `A_m()` call sites
 * resolve to the class member's funcIdx (wrong signature → validation trap).
 *
 * The fix keeps the funcMap key **byte-identical** (`A_m`) in the overwhelming
 * common case (no user function of that name), and only when a real collision
 * exists relocates the *class member's* funcMap key to a form a user identifier
 * cannot produce (`__cm$A_m`). The user function keeps the bare `A_m` key (it
 * is no longer skipped, because the class member vacated `A_m`), so its many
 * bare-call / export / ref.func consumers are untouched.
 *
 * IMPORTANT: this relocates ONLY the `funcMap` funcIdx key. The parallel
 * membership sets (`classMethodSet`, `staticMethodSet`, `classAccessorSet`,
 * `staticProps`, …) and the per-name metadata maps (`funcOptionalParams`,
 * `funcRestParams`, `funcUsesArguments`, …) keep the legacy
 * `${className}_${member}` string — the sets answer "is this name a class
 * member?" (collision-free), and the method-dispatch consumer reads the
 * metadata by the same legacy `fullName`, so producer and consumer agree.
 * Producers and consumers of the funcMap **funcIdx** must both route the legacy
 * name through this helper so they agree on the relocated key.
 *
 * Known residual (out of scope, does NOT trap): if a program declares BOTH a
 * class member `A.m` *and* a user `function A_m()` *and both* carry optional /
 * rest params, the two share the legacy `funcOptionalParams[A_m]` slot. This
 * affects only optional-arg backfill for that pathological name clash; the
 * funcIdx (the trap cause) is correctly separated.
 */
export type ClassMemberKind = "static" | "instance";

export function classMemberFuncKey(ctx: CodegenContext, fullName: string, kind?: ClassMemberKind): string {
  let key = fullName;
  // Only relocate when the legacy key would actually collide with a top-level
  // user function. Keeps output identical for every non-colliding program.
  if (ctx.topLevelFunctionNames.has(fullName)) {
    // Relocate to a prefixed key. The `__cm$` prefix never appears in a
    // `${className}_${member}` join, so it cannot collide with another class
    // member's legacy key. Guard the pathological case where a user also wrote
    // `function __cm$A_m() {}` by appending disambiguators until free.
    key = `__cm$${fullName}`;
  }
  // A class may legally define both `static m()` and `m()`. They have
  // different Wasm ABIs (the static form has no hidden receiver), so sharing
  // the legacy key makes the second body overwrite or reuse the first
  // function. The collection pass pre-populates `classMethodSet`, making this
  // choice independent of source order. Instance members retain the legacy
  // key; only the colliding static member is disambiguated.
  if (kind === "static" && ctx.classMethodSet.has(fullName)) {
    key = `__cm$static$${key}`;
  }
  let n = 0;
  while (ctx.topLevelFunctionNames.has(key)) key = `__cm$${fullName}$${n++}`;
  return key;
}

/**
 * (#1394 / #2963) Walk the class-parent chain to the TOPMOST class that owns
 * the same method funcIdx. When `class D extends C { }` inherits `m` from C,
 * the codegen registers `D_m` with the SAME funcIdx as `C_m`
 * (class-bodies.ts) — two distinct cache-key names would mint two closures
 * with different identity. Spec'd behaviour: method identity follows the
 * OWNING class (`(new D()).m === C.prototype.m`), so canonicalise the cache
 * key to the topmost inheriting owner. Stops at an OVERRIDE (parent has a
 * DIFFERENT funcIdx for the same member name).
 *
 * Extracted from the typed method-value read (`compileInstanceMember`'s
 * inline `ownerNameForChain`) so the member-get dispatcher (#2963 dynamic
 * `any`-receiver method reads) resolves the IDENTICAL owner → identical
 * cache global → `c.m === C.prototype.m` holds across both read paths.
 */
/**
 * (#3123) Resolve the top-level PLAIN-FUNCTION ("fnctor") ancestor of a class,
 * if any. `class C extends F` where `F` is a top-level `function F() {}` (the
 * test262 harness `Iterator` shim shape) inherits through F's LIVE
 * `.prototype` object — assigned at RUNTIME (module init), invisible to the
 * static class-method dispatch. Three consumers key off this predicate:
 *   - the ctor fill (class-bodies.ts) registers each instance with the host
 *     (`__register_fnctor_instance`) so `_fnctorProtoLookup` walks F's live
 *     prototype chain for inherited member reads;
 *   - the method-call ladder (expressions/calls.ts) routes method MISSES on
 *     such classes through the dynamic `__extern_method_call` host ladder
 *     instead of the graceful-null tail;
 *   - the any-receiver class-INFERENCE scan (expressions/calls.ts) skips such
 *     classes, because an any-typed receiver may hold a HOST object (e.g. an
 *     Iterator-helper wrapper) that the static tag-dispatch would mis-bind.
 *
 * Walks the classParentMap chain: the nearest ancestor that is NOT a compiled
 * class must be a top-level function name of THIS module to qualify. Builtins
 * (`Error`, `Object`, …) are not in `topLevelFunctionNames`, so builtin-parent
 * chains return undefined — unless the user genuinely shadowed the builtin
 * with a top-level function, in which case fnctor semantics are correct.
 */
export function fnctorAncestorOfClass(ctx: CodegenContext, className: string): string | undefined {
  let cur: string | undefined = className;
  const seen = new Set<string>();
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const parent: string | undefined = ctx.classParentMap.get(cur);
    if (parent === undefined) return undefined;
    if (!ctx.classSet.has(parent)) {
      return ctx.topLevelFunctionNames.has(parent) && ctx.funcMap.has(parent) ? parent : undefined;
    }
    cur = parent;
  }
  return undefined;
}

/**
 * (#3123) True when ANY class in the module has a fnctor ancestor — the gate
 * for emitting the member-kind / getter dispatch exports so modules without
 * the pattern stay byte-identical.
 */
export function moduleHasFnctorSubclass(ctx: CodegenContext): boolean {
  for (const className of ctx.classParentMap.keys()) {
    if (fnctorAncestorOfClass(ctx, className) !== undefined) return true;
  }
  return false;
}

export function resolveMethodOwnerClass(ctx: CodegenContext, start: string, propName: string): string {
  const startFull = `${start}_${propName}`;
  const startIdx = ctx.funcMap.get(classMemberFuncKey(ctx, startFull));
  if (startIdx === undefined) return start; // not a method we know
  let bestOwner = start;
  let cls: string | undefined = ctx.classParentMap.get(start);
  const seen = new Set<string>([start]);
  while (cls && !seen.has(cls)) {
    seen.add(cls);
    const full = `${cls}_${propName}`;
    const parentIdx = ctx.funcMap.get(classMemberFuncKey(ctx, full));
    if (parentIdx === undefined) break; // parent doesn't have this method
    if (parentIdx === startIdx) {
      // Inherited (same funcIdx) — keep walking up.
      bestOwner = cls;
      cls = ctx.classParentMap.get(cls);
      continue;
    }
    // Parent has a DIFFERENT funcIdx → start overrides the method.
    // Identity must use start's cache, not the parent's.
    break;
  }
  return bestOwner;
}
