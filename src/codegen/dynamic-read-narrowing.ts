// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// dynamic-read-narrowing.ts — which scalar kinds a DYNAMIC member read may be
// narrowed to (#5345).
//
// `finalizeStructAndDynamicMemberGet`'s Phase-3 vote (#1269) collapses a
// dynamically typed read to a scalar when every struct that carries the
// property name agrees on one field kind. This module owns the one question
// that vote must ask first: is that kind able to REPRESENT the answer the read
// can actually produce?

import type { ValType } from "../ir/types.js";

/**
 * True when the Phase-3 vote's agreed field kind may be used as the dynamic
 * read's result type.
 *
 * The vote is a bet that the receiver will be one of the voting structs. The
 * dispatcher TERMINAL exists precisely because it may not be: a host plain
 * object (`{...options}` lowers to `__new_plain_object`), a sidecar property,
 * an expando bag. That terminal legitimately answers `undefined`, and a
 * narrowing coerces the answer back down through `__unbox_number` — so the
 * narrowed kind has to have somewhere to put "absent".
 *
 * - **`f64` is admissible.** It is the hot numeric case, and it has a NaN /
 *   sNaN-sentinel encoding that the surrounding machinery already tunes (the
 *   #2979/#2864 generator-sentinel carve-out at the call site, the #866/#4616
 *   spread sentinels).
 * - **`i32` is NOT.** `i32.trunc_sat_f64_s` saturates NaN to `0`, which is
 *   bit-identical to `false`, and i32 has no spare value to mean `undefined`.
 *   For a boolean-valued property the two-value domain is fully consumed, so
 *   the read does not merely lose precision — it reports a definite, wrong
 *   answer, with no trap and no diagnostic.
 *
 * Measured on marked@18.0.2 (`test/unit/Hooks.test.js`). Its parse guard is
 * `this.defaults.async === true && origOpt.async === false`, where
 * `origOpt = {...options}` and `options` is undefined. Exactly one struct in
 * the module carries `async` (the defaults literal `{async:false, …}`), so the
 * lone-`i32` vote fired and the absent read answered a real `false`: marked
 * threw "The async option was set to true by an extension" on 11 of its 30
 * tests. Both `x === false` and `x === undefined` were true for the same read —
 * the comparisons take different lowerings and only the scalar one is wrong —
 * so which answer a program observes depends on the order it asks.
 *
 * #3927 recorded the identical symptom from the other direction: a hot/cold
 * split hid the last `externref` carrier of `generator`, leaving a
 * boolean-branded `i32` as the only visible voter, and all 32,506 of acorn's
 * AST nodes read a constant `false`. That fix contributed `externref` from the
 * invisible carrier so the vote de-narrowed. Removing `i32` as a target is the
 * general form: it also covers the case where no struct carrier is hidden at
 * all because the receiver simply is not a struct.
 *
 * Cost of excluding it: an `i32` consumer re-narrows through its own coercion,
 * paying one box/unbox on a dynamically typed read of an `i32`-only property.
 * The #2938 boolean BRAND that the old `i32` arm went out of its way to
 * preserve through `commonScalarFieldType` is preserved for free on this path —
 * the finalize-filled `__get_member_<name>` dispatcher boxes a branded slot
 * through `__box_boolean` itself, so `g.next().done === true` still holds.
 */
export function isAdmissibleDynamicReadNarrowing(kind: ValType["kind"]): boolean {
  return kind === "f64";
}
