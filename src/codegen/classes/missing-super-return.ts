// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 V4) §10.2.1.3 [[Construct]] steps 10–13 for a DERIVED constructor
 * with no lexical `super()` whose body is a single `return <operand>`:
 *
 *   - step 13.a: an Object result is returned as-is (not decided here — the
 *     missing-super lowering keeps its entry throw for that shape);
 *   - step 13.c: a result that is not undefined is a TypeError;
 *   - step 15: only an `undefined` completion reaches GetThisBinding, whose
 *     uninitialised binding is the ReferenceError.
 *
 * `return null` is the case the old checker-flags test missed: `null` has
 * typeof "object" but is not an Object, so it is a step-13.c TypeError, not
 * the uninitialised-`this` ReferenceError (`Function/internals/Construct/
 * derived-return-val.js`). The operand is statically a non-Object,
 * non-undefined value exactly when its oracle fact is a primitive or `null`.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

export function missingSuperReturnIsTypeError(
  ctx: CodegenContext,
  ctor: ts.ConstructorDeclaration | undefined,
): boolean {
  const statements = ctor?.body?.statements;
  const only = statements?.length === 1 ? statements[0] : undefined;
  if (only === undefined || !ts.isReturnStatement(only) || only.expression === undefined) return false;
  switch (ctx.oracle.typeFactOf(only.expression).kind) {
    case "number":
    case "boolean":
    case "string":
    case "bigint":
    case "symbol":
    case "null":
      return true;
    default:
      return false;
  }
}
