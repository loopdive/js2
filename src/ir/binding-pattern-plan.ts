// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a destructuring binding pattern as a plan of steps, decided once from
// the AST. Selection and lowering read the same plan, so a pattern the selector
// admits is a pattern the builder can lower, and every source lowers through
// one walker (`binding-pattern-lowering.ts`):
//
//   - a typed IR value reads one key or index per leaf (this module);
//   - a fresh literal is decomposed without being built
//     (`literal-pattern-plan.ts`).

import { ts } from "../ts-api.js";
import { collectPatternBindingNames } from "./analysis/ast-scope.js";

/** A destructuring leaf: a binding element that binds an identifier. */
export type BindingLeaf = ts.BindingElement & { readonly name: ts.Identifier };

/**
 * What a leaf binds: an evaluation of the plan, `undefined`, an array
 * literal's length, or a `Read` of the source value (a key or an index; a
 * literal plan reads no source, so its `Read` is `never`).
 */
export type PatternLeafValue<Read> =
  | { readonly kind: "evaluated"; readonly index: number }
  | { readonly kind: "undefined" }
  | { readonly kind: "length"; readonly value: number }
  | { readonly kind: "read"; readonly read: Read };

export type PatternStep<Read> =
  | { readonly kind: "bind"; readonly leaf: BindingLeaf; readonly value: PatternLeafValue<Read> }
  | { readonly kind: "default"; readonly leaf: BindingLeaf; readonly initializer: ts.Expression }
  | { readonly kind: "nested"; readonly plan: PatternPlan<Read> }
  /** RequireObjectCoercible / GetIterator on `null` or `undefined`. */
  | { readonly kind: "throw-type-error" };

/** Expressions evaluated first, in source order; then the steps, in pattern order. */
export interface PatternPlan<Read = never> {
  readonly evaluations: readonly ts.Expression[];
  readonly steps: readonly PatternStep<Read>[];
}

/** One leaf bound to one read of the source. */
export interface SourceReadStep<Read> {
  readonly kind: "bind";
  readonly leaf: BindingLeaf;
  readonly value: { readonly kind: "read"; readonly read: Read };
}

/** A flat pattern over a typed source: nothing to evaluate, one read per leaf. */
export interface SourceReadPlan<Read> extends PatternPlan<Read> {
  readonly steps: readonly SourceReadStep<Read>[];
}

/** Slice 8a (#1169g): `{ a, b: x, "c": y }` reads each leaf's identifier or string key. */
export function planPropertyReads(pattern: ts.ObjectBindingPattern): SourceReadPlan<string> | null {
  return planFlatReads(pattern, (leaf) => {
    const key = leaf.propertyName ?? leaf.name;
    return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
  });
}

/** Slice 8a (#1169g): `[a, , c]` reads each leaf's index; elisions are skipped. */
export function planElementReads(pattern: ts.ArrayBindingPattern): SourceReadPlan<number> | null {
  return planFlatReads(pattern, (_leaf, index) => index);
}

/**
 * A flat pattern the typed readers lower as one `object.get` / `vec.get` per
 * leaf: identifier leaves (no default, rest or nesting), at least one element,
 * no leaf bound twice or already in `scope`.
 */
export function isPhase1BindingPattern(pattern: ts.BindingPattern, scope: ReadonlySet<string>): boolean {
  if (pattern.elements.length === 0) return false;
  const plan = ts.isObjectBindingPattern(pattern) ? planPropertyReads(pattern) : planElementReads(pattern);
  if (plan === null) return false;
  const names = [...collectPatternBindingNames(pattern)];
  return new Set(names).size === names.length && !names.some((name) => scope.has(name));
}

function planFlatReads<Read>(
  pattern: ts.BindingPattern,
  readOf: (leaf: BindingLeaf, index: number) => Read | null,
): SourceReadPlan<Read> | null {
  const steps: SourceReadStep<Read>[] = [];
  for (const [index, element] of pattern.elements.entries()) {
    if (ts.isOmittedExpression(element)) continue;
    if (element.dotDotDotToken || element.initializer || !ts.isIdentifier(element.name)) return null;
    const leaf = element as BindingLeaf;
    const read = readOf(leaf, index);
    if (read === null) return null;
    steps.push({ kind: "bind", leaf, value: { kind: "read", read } });
  }
  return { evaluations: [], steps };
}
