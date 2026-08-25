// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared per-function binding-info oracle (#2103).
 *
 * ## Why this module exists
 *
 * Historically every lowering that needed to know a binding fact about a
 * function — "what are this function's own locals?", "which outer names does
 * this body reference?", "which of them does it write to?" — answered the
 * question by re-walking the AST from scratch with its own private helper call
 * (`collectFunctionOwnLocals`, `collectReferencedIdentifiers`,
 * `collectWrittenIdentifiers`). Closure capture, accessor-global promotion,
 * IIFE analysis, callback boxing, nested-declaration hoisting, const-folding
 * and snapshot caching each re-derived the same facts independently. Because
 * the walks are independent, the same per-node sub-results were recomputed many
 * times over (the inner `collectFunctionOwnLocals` call fires once per
 * function-scope boundary encountered during *every* outer walk), and there was
 * no single place that owned the answer — so a fix to one consumer's snapshot
 * never propagated to the others (the BIND-family bug class: stale localMap
 * shadows, for-of/for-in iterating stale snapshots, isStaticNaN ignoring
 * reassignment, Map-destructuring buffers going stale, #1970).
 *
 * This module is the structural parent's first foundation stone: a single,
 * memoized per-function analysis keyed on the AST node identity. The result for
 * a given `(node)` is deterministic — the AST is immutable for the lifetime of
 * a compile (the only AST rewrites, in `array-reduce-fusion.ts`, build *fresh*
 * trees via `ts.transform` and never mutate the original nodes that this cache
 * keys on) — so memoizing is purely behavior-preserving: identical results,
 * computed once instead of once-per-consumer-walk.
 *
 * ## Scope (this PR)
 *
 * Behavior-preserving refactor only. The oracle currently exposes the
 * own-locals query (`getFunctionOwnLocals`), which is the most-recomputed
 * primitive because both `collectReferencedIdentifiers` and
 * `collectWrittenIdentifiers` invoke it per nested scope boundary on every
 * walk. The reference/write free-variable queries and the
 * assigned-after-init / declaration-order / shadowing-depth queries named in
 * #2103's fix direction are intended to land on top of this substrate in
 * sprint 64+ as their consumers are migrated off private snapshots. Keeping the
 * additions incremental is deliberate: the issue is explicitly the "structural
 * parent for sprint 64+" and prior wholesale attempts at the full oracle
 * regressed.
 *
 * The collector functions themselves still live in `closures.ts` (they are
 * exported there and re-exported widely); this module wraps the one that is
 * pure-in-the-node with a cache and hands `closures.ts` the memoized accessor
 * to call from inside the walks.
 */

import type { ts } from "../../ts-api.js";

/**
 * Computes a function node's own locals into a caller-supplied set. Injected by
 * `closures.ts` (which owns the actual collection logic) so this module does
 * not duplicate the scope-walking rules. Pure function of `funcLike`.
 */
type OwnLocalsCollector = (funcLike: ts.Node, out: Set<string>) => void;

let collectOwnLocalsImpl: OwnLocalsCollector | null = null;

/**
 * Per-compile memoization cache for own-locals sets, keyed on the function
 * node. A `WeakMap` so entries are released with the AST; sound because the
 * keyed nodes are never mutated for the lifetime of a compile (see module
 * docstring). The stored set is frozen-by-convention: callers receive it via
 * {@link getFunctionOwnLocals}, which copies into the caller's accumulator
 * rather than handing out the cached instance, so no consumer can corrupt the
 * shared entry.
 */
const ownLocalsCache = new WeakMap<ts.Node, ReadonlySet<string>>();

/**
 * Register the own-locals collector. Called once during module init from
 * `closures.ts`. Separating registration from use avoids an import cycle
 * (`closures.ts` already imports a great deal; this keeps the dependency
 * one-directional).
 */
export function registerOwnLocalsCollector(fn: OwnLocalsCollector): void {
  collectOwnLocalsImpl = fn;
}

/**
 * The memoized own-locals set for a function-like node.
 *
 * Returns the same `ReadonlySet` instance for repeated calls on the same node
 * within a compile. Returns an empty set for non-function nodes (mirroring the
 * underlying collector, which no-ops when the node is not a function-scope
 * boundary). The returned set MUST NOT be mutated by callers — use
 * {@link addFunctionOwnLocals} when you need to accumulate into your own set.
 */
export function getFunctionOwnLocals(funcLike: ts.Node): ReadonlySet<string> {
  const cached = ownLocalsCache.get(funcLike);
  if (cached) return cached;
  /* istanbul ignore next — registration is guaranteed by module init order */
  if (!collectOwnLocalsImpl) {
    throw new Error("binding-info: own-locals collector not registered");
  }
  const computed = new Set<string>();
  collectOwnLocalsImpl(funcLike, computed);
  ownLocalsCache.set(funcLike, computed);
  return computed;
}

/**
 * Add a function-like node's own locals to `out`, going through the memoized
 * cache. Behavior-identical to calling the raw collector with `out`, but the
 * per-node walk runs at most once per compile.
 */
export function addFunctionOwnLocals(funcLike: ts.Node, out: Set<string>): void {
  for (const name of getFunctionOwnLocals(funcLike)) out.add(name);
}
