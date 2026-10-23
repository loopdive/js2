// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { closureInvocationKind, closureMethodArity } from "../core/closure-invocation-callables.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";

const EXTERNAL: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const VECTOR: IrType = Object.freeze({ kind: "vec", elementType: EXTERNAL, nullable: false });

/**
 * Semantic signatures only. A matching spelling is not physical permission:
 * the consumer requires the complete current source allocation/slot join.
 */
export function irClosureInvocationCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  if (ref.binding.kind !== "intrinsic") return undefined;
  const { symbol } = ref.binding;
  const arity = closureMethodArity(symbol);
  const kind = closureInvocationKind(symbol);
  if (!kind) return undefined;
  return Object.freeze({
    feature: kind === "construct" ? "js.construct" : (`js.closure.${kind}` as const),
    ref: irIntrinsicFuncRef(symbol),
    params: Object.freeze(
      kind === "method"
        ? Array.from({ length: arity! + 2 }, () => EXTERNAL)
        : kind === "apply-vector" || kind === "construct"
          ? [EXTERNAL, EXTERNAL, VECTOR]
          : [],
    ),
    results: Object.freeze([EXTERNAL]),
  });
}

/** Internal [[Construct]] code receives explicit newTarget/argv, never hidden user arguments. */
export const CLASS_CONSTRUCT_SIGNATURE = Object.freeze({
  params: Object.freeze([EXTERNAL, VECTOR]),
  returnType: EXTERNAL,
});
