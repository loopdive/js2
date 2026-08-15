// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4464) §10.2.1.3 [[Construct]] step 13 — "return the operand only when it is
 * an Object" — for construction lowerings whose result is an EXTERNREF value.
 *
 * The nominal-struct constructor arm in `statements/control-flow.ts` can settle
 * this question statically: the only override object it is able to represent is
 * an instance of its own struct, so a `ref.test` against that one type decides
 * it. A `new function(){…}` body has no such restriction — its `return` operand
 * is an arbitrary runtime value — so the classification has to happen at
 * runtime, and this module emits that probe.
 *
 * The probe is deliberately the SAME one `construct-bound.ts` uses for
 * `Reflect.construct`/bound-function construction (§10.2.2 step 13), including
 * its two non-obvious clauses:
 *
 *   - the null test runs FIRST and separately, because `__typeof_object(null)`
 *     answers 1 by design (JS `typeof null === "object"`). Folding null into the
 *     typeof probe would let `return null` yield `null` from `new`, which is the
 *     exact defect the step exists to prevent; and
 *   - a returned FUNCTION is an Object per spec, hence the `__typeof_function`
 *     arm — `S13.2.2_A8_T1/T2` return a function from the constructor body and
 *     expect it, not `this`, to be the construction result.
 *
 * DECLINES (returns false, emitting nothing) when the runtime predicates are not
 * in the module. A caller that cannot classify the operand must fall back to
 * `this`, never hand back an unclassified value.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * Consume an externref construction-body result from the stack and leave the
 * §10.2.1.3 step-13 answer: the operand when Type(operand) is Object, else the
 * receiver held in `thisLocal`.
 *
 * Returns false without emitting anything when the Type(V) predicates are
 * unavailable; the caller then owns the fallback.
 */
export function emitConstructReturnSelect(ctx: CodegenContext, fctx: FunctionContext, thisLocal: number): boolean {
  const typeofObjectIdx = ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  const typeofFunctionIdx = ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  flushLateImportShifts(ctx, fctx);
  if (typeofObjectIdx === undefined || typeofFunctionIdx === undefined) return false;

  const tmp = allocLocal(fctx, `__ctor_ret_${fctx.locals.length}`, EXTERNREF);
  const isObject: Instr[] = [
    { op: "local.get", index: tmp },
    { op: "call", funcIdx: typeofObjectIdx },
    { op: "local.get", index: tmp },
    { op: "call", funcIdx: typeofFunctionIdx },
    { op: "i32.or" },
  ];
  fctx.body.push(
    { op: "local.set", index: tmp },
    { op: "local.get", index: tmp },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      // `null` is not an Object — §10.2.1.3 discards it and yields `this`.
      then: [{ op: "local.get", index: thisLocal }],
      else: [
        ...isObject,
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: [{ op: "local.get", index: tmp }],
          else: [{ op: "local.get", index: thisLocal }],
        },
      ],
    },
  );
  return true;
}
