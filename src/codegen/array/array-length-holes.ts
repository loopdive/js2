// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771 S3) `Array(n)` / `new Array(n)` holes are holes, `--target standalone`.
 *
 * §23.1.1.1 step 4 builds an array of `n` HOLES — ArrayCreate(len) sets only
 * `length`. The length-form builders (`literals.ts::compileArrayConstructorCall`,
 * `expressions/new-indexed.ts`) allocated the externref backing with
 * `array.new_default`, so every slot held `ref.null.extern` — JS `null`:
 * `new Array(5)[2] === null`, `2 in new Array(5)` was true, and
 * `compareArray(new Array(4000), […])` compared `null`s against `undefined`s
 * (`concat/Array.prototype.concat_{spreadable-sparse-object,large-typed-array,
 * small-typed-array}.js`).
 *
 * The tree already owns the representation for an absent externref slot: the
 * `$Hole` marker the elision literal `[1, , 3]` stores (array-holes.ts, #2001),
 * whose reads map it to `undefined` wherever `ctx.usesArrayHoles` arms them.
 * So: the pre-scan arms `usesArrayHoles` for a module containing the length
 * form (standalone only — the host lane keeps its bytes), the builders fill the
 * backing with the marker, and the static `k in arr` fold learns the marker.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocTempLocal } from "../context/locals.js";
import { holeSentinelInstrs, holeTestInstrs } from "../helpers/core-delegates.js"; // (#6797) late-bound core
import { getArrTypeIdxFromVec } from "../registry/types.js";

/** `Array(x)` / `new Array(x)` with ONE non-spread argument — the length form. */
export function isArrayLengthConstructor(node: ts.Node): boolean {
  if (!ts.isNewExpression(node) && !ts.isCallExpression(node)) return false;
  const callee = node.expression;
  const args = node.arguments;
  return (
    ts.isIdentifier(callee) &&
    callee.text === "Array" &&
    args !== undefined &&
    args.length === 1 &&
    !ts.isSpreadElement(args[0]!)
  );
}

/** Does the vec at `vecTypeIdx` (or the array at `arrTypeIdx`) store externref elements? */
function arrayHoldsExternref(ctx: CodegenContext, arrTypeIdx: number): boolean {
  const arrDef = ctx.mod.types[arrTypeIdx];
  return arrDef?.kind === "array" && (arrDef.element as ValType).kind === "externref";
}

/**
 * The backing allocation of the length form. Expects `(…, size:i32)` on the
 * stack, like `array.new_default`, which it returns unchanged for every lane /
 * element kind that has no marker.
 */
export function holeFilledArrayNewInstrs(ctx: CodegenContext, fctx: FunctionContext, arrTypeIdx: number): Instr[] {
  if (!ctx.standalone || !ctx.usesArrayHoles || !arrayHoldsExternref(ctx, arrTypeIdx)) {
    return [{ op: "array.new_default", typeIdx: arrTypeIdx }];
  }
  const size = allocTempLocal(fctx, { kind: "i32" });
  return [
    { op: "local.set", index: size },
    ...holeSentinelInstrs(ctx),
    { op: "local.get", index: size },
    { op: "array.new", typeIdx: arrTypeIdx },
  ];
}

/**
 * `idx in arr` for a statically-typed externref vec and a literal index, when
 * the slot can hold the marker: in range of `length` AND of the physical backing
 * (the #4491 length/capacity split leaves slots past the backing absent) AND not
 * `$Hole`. Expects the vec ref on the stack, leaves i32. `undefined` when the
 * dense `idx < length` compare is still the answer (the caller keeps it).
 */
export function vecStaticIndexPresenceInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecTypeIdx: number,
  idx: number,
): Instr[] | undefined {
  if (!ctx.standalone || !ctx.usesArrayHoles || idx > 0x7fffffff) return undefined;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0 || !arrayHoldsExternref(ctx, arrTypeIdx)) return undefined;
  const vec = allocTempLocal(fctx, { kind: "ref_null", typeIdx: vecTypeIdx });
  const data = allocTempLocal(fctx, { kind: "ref_null", typeIdx: arrTypeIdx });
  return [
    { op: "local.tee", index: vec },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: idx },
    { op: "i32.gt_s" }, // idx < length
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: vec },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.tee", index: data },
        { op: "array.len" },
        { op: "i32.const", value: idx },
        { op: "i32.gt_u" }, // idx < capacity
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: data },
            { op: "i32.const", value: idx },
            { op: "array.get", typeIdx: arrTypeIdx },
            ...holeTestInstrs(ctx),
            { op: "i32.eqz" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * Does an `indexOf` / `lastIndexOf` scan over an externref vec read a `$Hole`
 * as `undefined`? §23.1.3.17/20 test HasProperty first, so a hole is SKIPPED —
 * which the #2001 S1 map (`$Hole → undefined`) contradicts on purpose, for the
 * test262 shape that pairs a hole with an index INHERITED from
 * `Array.prototype` / `Object.prototype` (the flat vec cannot see it; the map
 * answers `undefined`, which is what that inherited getter-less accessor
 * yields). Standalone keeps the map only where such a write exists
 * (`protoIndexDirty`); elsewhere nothing can be inherited, the hole is absent,
 * and the raw marker never strict-equals a search value — so
 * `new Array(3).indexOf(undefined)` stays `-1` now that the length form stores
 * holes (S3) instead of `null`. The host lane keeps its bytes.
 */
export function holeSearchReadsUndefined(ctx: CodegenContext): boolean {
  return !ctx.standalone || ctx.protoIndexDirty;
}
