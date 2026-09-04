// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5249) Candidate set for an OPEN-receiver `this.m(…)` call.
 *
 * "Open receiver" = the method is not declared on the receiver's own class or
 * any ancestor, so the only implementations live BELOW it — the shape
 * `class Base { run(x) { return this.n(x); } }` with `n` declared on
 * `class A extends Base` and friends. `emitVirtualMethodDispatchByTag`
 * (`virtual-dispatch.ts`) turns >1 implementation into a `__tag` cascade whose
 * terminal `else` is `unreachable`, so the candidate set IS the set of
 * receivers that do not trap.
 *
 * The set used to be "DIRECT children of the receiver class that DECLARE the
 * method", which under-approximates it twice:
 *
 *   1. a **grandchild that declares** an override (`D extends B extends Base`)
 *      is not a direct child, so it got no arm;
 *   2. a **descendant that inherits** an implementation (`C extends A`, `C`
 *      declares nothing) has no `C_n` of its own, so it got no arm either —
 *      even though `C.n` resolves perfectly well to `A_n`.
 *
 * Both trap at run time on a module `compile()` reports clean. Measured on
 * `@js-temporal/polyfill@0.5.1`: `HelperBase.adjustCalendarDate` calls
 * `this.monthsInYear(…)`, `HelperBase` does not declare it, and exactly the
 * SEVEN direct children that do declare it got arms — while the 19 further
 * descendants (`GregoryHelper`, `RocHelper`, `JapaneseHelper`, the five
 * `Islamic*` helpers, …) all reach `unreachable`. That is the whole of the
 * 123-row `unreachable in HelperBase_adjustCalendarDate()` test262 family.
 *
 * This module answers the same question over the FULL descendant set, with
 * each descendant resolved to its nearest declaring ancestor — i.e. exactly
 * JS prototype lookup, restricted to the closed set of classes in the module.
 *
 * Order is load-bearing: the declared-direct-children come first, in the same
 * `classParentMap` iteration order as before, so `candidates[0]` — which the
 * caller uses for the static fallback name and which the emitter uses as its
 * result-type schema — is unchanged wherever the old code produced one.
 *
 * Statics are deliberately excluded from the widening: a `__tag` cascade reads
 * an INSTANCE field, and static methods are not reached through an instance
 * tag, so the static path keeps its historical direct-children-only set.
 */
import type { CodegenContext } from "../context/types.js";
import { classMemberFuncKey } from "../class-member-keys.js";

/** One arm of a tag cascade: which class, which body, which `__tag` value. */
export interface VirtualCandidate {
  className: string;
  funcIdx: number;
  classTag: number;
}

export interface OpenReceiverCandidateSet {
  /** Declared-first, then inheriting descendants. Never empty. */
  candidates: VirtualCandidate[];
  /** Class whose body `candidates[0]` actually calls (may differ from its own). */
  implClassName: string;
  /** How many entries came from the historical direct-children-declare walk. */
  declaredCount: number;
}

/**
 * Resolve `<cls>.<methodName>` to the function index of the body declared on
 * `cls` itself, or `undefined` when `cls` does not declare it.
 */
function ownMemberFuncIdx(
  ctx: CodegenContext,
  cls: string,
  methodName: string,
  receiverIsClassObject: boolean,
  receiverMemberKind: "instance" | "static",
): number | undefined {
  const fullName = `${cls}_${methodName}`;
  const declares = receiverIsClassObject ? ctx.staticMethodSet.has(fullName) : ctx.classMethodSet.has(fullName);
  return declares ? ctx.funcMap.get(classMemberFuncKey(ctx, fullName, receiverMemberKind)) : undefined; // (#1983)
}

/** True when `name` has `ancestor` somewhere up its `extends` chain. */
function descendsFrom(ctx: CodegenContext, name: string, ancestor: string | undefined): boolean {
  if (ancestor === undefined) return false;
  const seen = new Set<string>();
  let cur = ctx.classParentMap.get(name);
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = ctx.classParentMap.get(cur);
  }
  return false;
}

/**
 * Build the open-receiver candidate set for `receiverClassName.methodName`.
 *
 * @param baseClass the class named by the caller's current `fullName` guess —
 *   an abstract base the receiver was typed as, which may differ from
 *   `receiverClassName`. Descendants of EITHER count, matching the historical
 *   `parentClass === receiverClassName || parentClass === baseClass` test.
 * @returns the set, or `undefined` when no implementation is reachable at all
 *   (the caller then continues to its callable-field / getter / host fallbacks).
 */
export function collectOpenReceiverCandidates(
  ctx: CodegenContext,
  receiverClassName: string,
  baseClass: string | undefined,
  methodName: string,
  receiverIsClassObject: boolean,
  receiverMemberKind: "instance" | "static",
): OpenReceiverCandidateSet | undefined {
  const candidates: VirtualCandidate[] = [];
  const implOf = new Map<string, string>();
  const add = (className: string, implClass: string, funcIdx: number): void => {
    const classTag = ctx.classTagMap.get(className);
    if (classTag === undefined) return;
    if (implOf.has(className)) return;
    implOf.set(className, implClass);
    candidates.push({ className, funcIdx, classTag });
  };

  // Historical walk, byte-identical in both membership and order.
  for (const [childClass, parentClass] of ctx.classParentMap) {
    if (parentClass !== receiverClassName && parentClass !== baseClass) continue;
    const idx = ownMemberFuncIdx(ctx, childClass, methodName, receiverIsClassObject, receiverMemberKind);
    if (idx !== undefined) add(childClass, childClass, idx);
  }
  const declaredCount = candidates.length;

  // (#5249) Every remaining descendant, resolved by prototype lookup.
  if (!receiverIsClassObject) {
    for (const childClass of ctx.classParentMap.keys()) {
      if (implOf.has(childClass)) continue;
      if (!descendsFrom(ctx, childClass, receiverClassName) && !descendsFrom(ctx, childClass, baseClass)) continue;
      const seen = new Set<string>();
      let owner: string | undefined = childClass;
      while (owner !== undefined && !seen.has(owner)) {
        seen.add(owner);
        const idx = ownMemberFuncIdx(ctx, owner, methodName, receiverIsClassObject, receiverMemberKind);
        if (idx !== undefined) {
          add(childClass, owner, idx);
          break;
        }
        owner = ctx.classParentMap.get(owner);
      }
    }
  }

  if (candidates.length === 0) return undefined;
  const first = candidates[0]!;
  return { candidates, implClassName: implOf.get(first.className) ?? first.className, declaredCount };
}
