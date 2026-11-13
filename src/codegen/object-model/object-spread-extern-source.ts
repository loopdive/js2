// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7014, #4616) Does a struct-shaped object literal's spread source need the
 * RUNTIME CopyDataProperties route instead of a static struct read?
 *
 * `function f(options?: Opts) { options = { tag: "d", ...options }; }` — since
 * #4839 (778d1ee11d) an optional parameter is stored as `externref`, the
 * undefined-capable ABI, so the binding holds whatever object the CALLER built:
 * `f({ keepPrototype: true })` passes its own `__anon` struct, not `Opts`.
 * Casting that value to the checker's `Opts` struct trapped ("illegal cast") on
 * the JS host and emitted invalid Wasm in standalone. The runtime copy
 * (§13.2.5.5, a nullish source is skipped) reads whatever own properties the
 * value really has.
 *
 * Scoped to the case the runtime copy supports: the spread is the literal's
 * LAST property and no earlier source already took the runtime route, so the
 * runtime sources stay a suffix (`emitRuntimeSpreadCopy` refuses anything else).
 */
import { ts } from "../../ts-api.js";
import { getLocalType } from "../context/locals.js";
import type { FunctionContext } from "../context/types.js";

export function spreadSourceNeedsRuntimeCopy(
  fctx: FunctionContext,
  literal: ts.ObjectLiteralExpression,
  propIndex: number,
  runtimeSourcesSoFar: number,
): boolean {
  if (propIndex !== literal.properties.length - 1 || runtimeSourcesSoFar !== 0) return false;
  const prop = literal.properties[propIndex];
  if (!prop || !ts.isSpreadAssignment(prop) || !ts.isIdentifier(prop.expression)) return false;
  const index = fctx.localMap.get(prop.expression.text);
  return index !== undefined && getLocalType(fctx, index)?.kind === "externref";
}
