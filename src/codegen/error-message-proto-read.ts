// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster C, C2) `err.message` through a STATICALLY-TYPED Error
 * receiver, when the instance has no own `message`.
 *
 * §20.5.1.1 step 3 defines `message` only for an argument that is not
 * `undefined`, so `new Err()` on `class Err extends TypeError {}` has none and
 * the read must continue down the prototype chain — `Err.prototype.message`,
 * then `Error.prototype.message`. The statically-typed arm in
 * `property-access-dispatch.ts` read `$Error_struct` field 1 unconditionally,
 * answered JS `null`, and STOPPED the walk, which made the subclass-prototype
 * edge (`error-subclass-proto-chain.ts`) reachable only through a receiver
 * whose static type had been erased.
 *
 * Measured, standalone (`.tmp/w6651C/m10.ts`):
 *
 * | receiver                                 | base        | node                  |
 * | ---------------------------------------- | ----------- | --------------------- |
 * | `err2.message` (static type `Err`)        | `undefined` | `"custom-type-error"` |
 * | `(err2 as { message }).message`           | `"custom-…"`| `"custom-type-error"` |
 *
 * The two disagreeing for the SAME program is the whole finding: it is the
 * static type, not the value, that selected the wrong read.
 *
 * `name` and `stack` deliberately keep the unconditional read. `name` is
 * always materialised by the constructor, so its field is never null; `stack`
 * is non-standard and its absence is already the answer the read should give.
 */
import type { Instr, ValType } from "../ir/types.js";
import { buildCaughtErrorPropFallback } from "./caught-error-prop-fallback.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceType } from "./type-coercion.js";

/**
 * Emit the `message` read for a statically-Error receiver whose ANYREF value is
 * already on the stack: answer the struct field when it is present, otherwise
 * fall through to the ordinary dynamic read (which walks the prototype chain).
 *
 * Leaves exactly one value of `resultType` on the stack.
 */
export function emitErrorMessageReadWithProtoFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structIdx: number,
  fieldIdx: number,
  propName: string,
  resultType: ValType,
): void {
  const tmpAny = allocTempLocal(fctx, { kind: "anyref" });
  fctx.body.push({ op: "local.set", index: tmpAny });
  fctx.body.push({ op: "local.get", index: tmpAny });
  fctx.body.push({ op: "ref.cast", typeIdx: structIdx });
  fctx.body.push({ op: "struct.get", typeIdx: structIdx, fieldIdx });
  fctx.body.push({ op: "ref.is_null" });
  // Both arms are built in a swapped buffer so `coerceType`'s appends land
  // inside the arm rather than in the enclosing body.
  const saved = fctx.body;
  fctx.body = [];
  fctx.body.push({ op: "local.get", index: tmpAny });
  fctx.body.push({ op: "ref.cast", typeIdx: structIdx });
  fctx.body.push({ op: "struct.get", typeIdx: structIdx, fieldIdx });
  if (resultType.kind !== "externref") coerceType(ctx, fctx, { kind: "externref" }, resultType);
  const presentInstrs = fctx.body;
  fctx.body = saved;
  const absentInstrs: Instr[] = buildCaughtErrorPropFallback(ctx, fctx, tmpAny, propName, resultType);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: resultType },
    then: absentInstrs,
    else: presentInstrs,
  });
  releaseTempLocal(fctx, tmpAny);
}
