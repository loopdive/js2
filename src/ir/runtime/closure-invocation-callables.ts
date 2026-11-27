// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFuncRef } from "../core/value-references.js";
import type { IrType } from "../core/types.js";
import { irIntrinsicFuncRef } from "../core/callable-bindings.js";
import { closureInvocationKind, closureMethodArity } from "../core/closure-invocation-callables.js";
import type { IrRuntimeCallableDeclaration } from "./callable-declarations.js";

const EXTERNAL: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });
const VECTOR: IrType = Object.freeze({ kind: "vec", elementType: EXTERNAL, nullable: false });
const scalar = (kind: "f64" | "i32"): IrType => Object.freeze({ kind: "val", val: Object.freeze({ kind }) });
/** The fixed callables' signatures; a method's follows from its arity. */
const FIXED = {
  "apply-vector": { params: [EXTERNAL, EXTERNAL, VECTOR], results: [EXTERNAL] },
  undefined: { params: [], results: [EXTERNAL] },
  receiver: { params: [], results: [EXTERNAL] },
  // (#7562) The count protocol: the entry read (`arguments.length`) and a direct call's publication.
  "arguments-length": { params: [], results: [scalar("f64")] },
  "publish-argc": { params: [scalar("i32")], results: [] },
} as const;

/**
 * Semantic signatures only. A matching spelling is not physical permission:
 * the consumer requires the complete current source allocation/slot join.
 */
export function irClosureInvocationCallableDeclaration(ref: IrFuncRef): IrRuntimeCallableDeclaration | undefined {
  if (ref.binding.kind !== "intrinsic") return undefined;
  const { symbol } = ref.binding;
  const kind = closureInvocationKind(symbol);
  if (!kind) return undefined;
  const { params, results } =
    kind === "method"
      ? { params: Array.from({ length: closureMethodArity(symbol)! + 2 }, () => EXTERNAL), results: [EXTERNAL] }
      : FIXED[kind];
  return Object.freeze({
    feature: `js.closure.${kind}` as const,
    ref: irIntrinsicFuncRef(symbol),
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
  });
}
