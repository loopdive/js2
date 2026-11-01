// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — the one walker every destructuring declaration and parameter lowers
// through, following the plan the selector admitted (`binding-pattern-plan.ts`).
// The source is a strategy of the host: a typed IR value answers `read` (one
// `object.get` / `class.get` / `vec.get` per leaf), a fresh literal answers
// nothing (its plan carries evaluations instead, and no reads).
//
// The for-of head pattern stays separate (`lowerForOfVec` in from-ast): its
// leaves are slots declared once, outside the body, and written per iteration
// from a bounds-checked element read, which this single-pass walker does not
// model. It shares the leaf enumeration (`planElementReads`).

import type { ts } from "../ts-api.js";
import type { BindingLeaf, PatternLeafValue, PatternPlan } from "./binding-pattern-plan.js";
import type { IrFunctionBuilder } from "./builder.js";
import { irVal, type IrValueId } from "./nodes.js";
import { emitThrowTypeErrorIf } from "./throw-type-error.js";

export interface PatternLoweringHost<Read> {
  readonly builder: IrFunctionBuilder;
  /** Lower an evaluation or a default to its value. */
  lowerValue(expression: ts.Expression): IrValueId;
  /** Read the source value: a typed source's key or index. */
  read(read: Read): IrValueId;
  /** Bind one leaf the way its declaration binds a name. */
  bind(leaf: BindingLeaf, value: IrValueId): void;
}

/** A literal plan reads no source: its `Read` is `never`. */
export function readsNoSource(read: never): never {
  return read;
}

/** Every evaluation in source order, then each step in pattern order. */
export function lowerPatternPlan<Read>(plan: PatternPlan<Read>, host: PatternLoweringHost<Read>): void {
  const values = plan.evaluations.map((expression) => host.lowerValue(expression));
  for (const step of plan.steps) {
    if (step.kind === "nested") lowerPatternPlan(step.plan, host);
    else if (step.kind === "throw-type-error") throwTypeError(host.builder);
    else if (step.kind === "default") host.bind(step.leaf, host.lowerValue(step.initializer));
    else host.bind(step.leaf, lowerLeafValue(step.value, values, host));
  }
}

/**
 * Thrown behind a constant-true branch rather than as a terminator: the leaves
 * after it still bind, so the code the selector admitted after the
 * declaration stays well-formed.
 */
function throwTypeError(builder: IrFunctionBuilder): void {
  const always = builder.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32" }));
  emitThrowTypeErrorIf(builder, always, "Cannot destructure 'null' or 'undefined'");
}

function lowerLeafValue<Read>(
  value: PatternLeafValue<Read>,
  values: readonly IrValueId[],
  host: PatternLoweringHost<Read>,
): IrValueId {
  switch (value.kind) {
    case "evaluated":
      return values[value.index]!;
    case "length":
      return host.builder.emitConst({ kind: "f64", value: value.value }, irVal({ kind: "f64" }));
    case "undefined":
      return host.builder.emitDynUndefined();
    case "read":
      return host.read(value.read);
  }
}
