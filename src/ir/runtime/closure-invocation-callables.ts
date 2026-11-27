// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { closureInvocationKind, closureMethodArity } from "../core/closure-invocation-callables.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";

const EXTERNAL: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const VECTOR: IrType = Object.freeze({ kind: "vec", elementType: EXTERNAL, nullable: false });
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
/** Each named kind's parameters and results; a method's are its arity's carriers. */
const SIGNATURES = {
  "apply-vector": [[EXTERNAL, EXTERNAL, VECTOR], [EXTERNAL]],
  undefined: [[], [EXTERNAL]],
  receiver: [[], [EXTERNAL]],
  "install-builtin-caller": [[EXTERNAL], []],
  argument: [[EXTERNAL, F64], [EXTERNAL]],
  "argument-count": [[EXTERNAL], [F64]],
} as const satisfies Record<string, readonly [readonly IrType[], readonly IrType[]]>;

/**
 * Semantic signatures only. A matching spelling is not physical permission:
 * the consumer requires the complete current source allocation/slot join.
 */
export function irClosureInvocationCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  if (ref.binding.kind !== "intrinsic") return undefined;
  const { symbol } = ref.binding;
  const kind = closureInvocationKind(symbol);
  if (!kind) return undefined;
  const [params, results] =
    kind === "method"
      ? [Array.from({ length: closureMethodArity(symbol)! + 2 }, () => EXTERNAL), [EXTERNAL]]
      : SIGNATURES[kind];
  return Object.freeze({
    feature: `js.closure.${kind}` as const,
    ref: irIntrinsicFuncRef(symbol),
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
  });
}
