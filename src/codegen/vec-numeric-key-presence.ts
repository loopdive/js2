// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6485) `__extern_has`'s NUMERIC-key arm for a `$__vec_base` receiver —
// the §13.10.1 half of `key in arrayLike`.
//
// Sibling of `vec-overlay-presence.ts` / `vec-f64-hole-presence.ts` /
// `holey-array-presence.ts`: they teach `__extern_has_idx` which indices are
// present; this one is about REACHING that helper at all.

import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Where the arm reads its operands inside `__extern_has`. */
export interface VecNumericKeyHasArmParams {
  /** Param index of the receiver (`externref obj`). */
  objParam: number;
  /** Param index of the property key (`externref key`). */
  keyParam: number;
  /** A scratch f64 local the caller has already appended. */
  numLocal: number;
  /** `__extern_has_idx`'s function index. */
  hasIdxIdx: number;
}

/**
 * Build the arm that answers `<number> in <vec-like>` by delegating to
 * `__extern_has_idx`, or `[]` when the classifier helpers are absent.
 *
 * ## Why it exists
 *
 * §13.10.1 step 6 is `HasProperty(rval, ? ToPropertyKey(lval))`, and the CALL
 * SITE does not perform that coercion: `binary-ops-in.ts` boxes the key with
 * `coerceType(…, externref)`, so `0 in arr` hands `__extern_has` a boxed
 * **Number**, not the string `"0"`. Every index delegation in that helper sits
 * behind `ref.test $AnyString`, so the key skipped it, fell through to the
 * named-key tail, and the answer came back ABSENT for a present index.
 *
 * A vec-TYPED receiver never showed this: that site folds to an inline
 * `idx < length` compare and never calls the helper. Only a receiver whose slot
 * is externref reaches here — which is why the #4655 dynamic concat carrier is
 * where it surfaced. Measured on the base tree, standalone, no #6485 flag set:
 *
 * ```js
 * var m = [1].concat([2], [3]);   // >1 arg ⇒ the dynamic carrier
 * 0 in m;   // false — spec says true; m[0] read 1 the whole time
 * ```
 *
 * ## The two guards, both load-bearing
 *
 *  - **`__typeof_number`, not a bare `__unbox_number`.** ToNumber would turn
 *    `true in arr` into `1 in arr`, while ToPropertyKey(true) is the string
 *    `"true"` and must stay absent.
 *  - **A canonical-array-index test**, `n === trunc(n) && n >= 0`.
 *    `__extern_has_idx` truncates, so without it `1.5 in [0, 1]` would answer
 *    the question for index 1 and report PRESENT, where ToPropertyKey(1.5) is
 *    `"1.5"` and is absent. `NaN` and `-Infinity` fail the same test; `-0`
 *    passes it and is correct, since ToPropertyKey(-0) is `"0"`.
 *
 * A number that is not an index falls through to the caller's pre-existing
 * tail, unchanged. Either helper missing ⇒ no arm at all, likewise unchanged.
 */
export function buildVecNumericKeyHasArm(ctx: CodegenContext, params: VecNumericKeyHasArmParams): Instr[] {
  const { objParam, keyParam, numLocal, hasIdxIdx } = params;
  return buildVecNumericKeyArm(ctx, keyParam, numLocal, [
    { op: "local.get", index: objParam },
    { op: "local.get", index: numLocal },
    { op: "call", funcIdx: hasIdxIdx },
    { op: "return" },
  ]);
}

/**
 * (#6651 H3) The GET twin of {@link buildVecNumericKeyHasArm}.
 *
 * `__extern_has` grew the numeric-key arm in #6485; `__extern_get` never did,
 * and the two must agree or `in` reports a property the read cannot fetch.
 *
 * The read site that hands this helper a boxed **Number** is the one where
 * neither the receiver nor the key is statically an array/number — e.g. a
 * `@ts-check`'d `obj[name]` whose `name` param is declared `string|symbol`
 * (test262's `propertyHelper.js` `verifyProperty`, which is why four
 * `target-array-with-non-writable-property.js` rows failed on a value the
 * descriptor itself reported correctly). `isNumericIndexExpression` declines a
 * non-numeric key type, so the call site keeps `__extern_get`, and every index
 * delegation inside it sat behind `ref.test $AnyString`. Measured standalone on
 * the base tree: `readIt([10,20], 0)` answered `undefined` through such a
 * param while `readIt([10,20], "0")` answered `10`.
 *
 * Delegating a canonical non-negative integral key to `__extern_get_idx` makes
 * the Number spelling byte-for-byte the String spelling — that helper is
 * exactly what the existing `__str_to_number` string arm calls, so overlays,
 * deletes, accessors, holes and the OOB→`undefined` miss all keep their single
 * reader. A non-index Number still falls through to the named-property tail.
 */
export function buildVecNumericKeyGetArm(
  ctx: CodegenContext,
  params: { objParam: number; keyParam: number; numLocal: number; getIdxIdx: number },
): Instr[] {
  const { objParam, keyParam, numLocal, getIdxIdx } = params;
  return buildVecNumericKeyArm(ctx, keyParam, numLocal, [
    { op: "local.get", index: objParam },
    { op: "local.get", index: numLocal },
    { op: "call", funcIdx: getIdxIdx },
    { op: "return" },
  ]);
}

/**
 * The shared classifier both arms sit behind: "the key is a Number whose
 * ToPropertyKey result is a canonical array index". See the two-guards note
 * above for why `__typeof_number` (not a bare ToNumber) and the integral /
 * non-negative test are each load-bearing.
 */
function buildVecNumericKeyArm(ctx: CodegenContext, keyParam: number, numLocal: number, hit: Instr[]): Instr[] {
  const typeofNumberIdx = ctx.funcMap.get("__typeof_number");
  const unboxNumberIdx = ctx.funcMap.get("__unbox_number");
  if (typeofNumberIdx === undefined || unboxNumberIdx === undefined) return [];
  return [
    { op: "local.get", index: keyParam },
    { op: "call", funcIdx: typeofNumberIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: keyParam },
        { op: "call", funcIdx: unboxNumberIdx },
        { op: "local.tee", index: numLocal },
        { op: "local.get", index: numLocal },
        { op: "f64.trunc" },
        { op: "f64.eq" }, // integral — rejects 1.5 and NaN
        { op: "local.get", index: numLocal },
        { op: "f64.const", value: 0 },
        { op: "f64.ge" }, // non-negative — rejects -1 and -Infinity
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: hit,
        },
      ],
    },
  ];
}
