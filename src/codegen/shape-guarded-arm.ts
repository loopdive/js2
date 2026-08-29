// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// One arm of a dynamic member-dispatch chain (#4645).
//
// Every `__get_member_*` / `__set_member_*` / `__sget_*` dispatcher is a chain
// of arms, each of which asks "is the receiver this struct type (and, for a
// collision-stamped struct, this logical shape)?" and otherwise defers to the
// rest of the chain. Five independent builders grew the same arm by hand, and
// all five wrote the shape-stamped form as TWO nested `if`s that each name the
// SAME `next` array:
//
//     local.get $any; ref.test $T
//     if                              ;; type matched
//       local.get $any; ref.cast $T; struct.get $shape; i32.const K; i32.eq
//       if  then <hit>  else <next>   ;; ← next, once
//     else <next>                     ;; ← next, AGAIN — same array object
//
// That makes the instruction graph a DAG in which the tail of the chain has two
// parents, so the number of root-to-node PATHS doubles at every stamped arm.
// Nothing in the compiler dedupes: each whole-module walk (stack-balance,
// ir-inline, the fixups, and the binary encoder itself) re-traverses the shared
// tail once per path, and the encoder emits it once per path too. On the
// `@js-temporal/polyfill` bundle a 12-arm chain reached 4,947x amplification —
// 266 distinct instructions walked 1,315,939 times — and the emitted binary
// went from 447 KB to 29.4 MB for a 31 % source increase. That is the whole of
// the "compile time goes superlinear past ~100 KB" cliff.
//
// The fix is to compute the guard as an i32 and branch on it ONCE, so `next`
// has exactly one parent and the chain is a list again:
//
//     local.get $any; ref.test $T
//     if (result i32)
//       local.get $any; ref.cast $T; struct.get $shape; i32.const K; i32.eq
//     else i32.const 0 end
//     if  then <hit>  else <next>     ;; ← next, exactly once
//
// This is behaviourally identical to the nested form — same tests, same order,
// short-circuited the same way. In particular the `ref.cast` still executes
// only on the `ref.test`-true path, so a non-matching receiver cannot trap.
// (Folding the two conditions with `i32.and` would be shorter but WRONG: both
// operands are evaluated eagerly, so the cast would run on a receiver that
// failed `ref.test`.)

import type { BlockType, Instr } from "../ir/types.js";

/** The shape-stamp identity of a collision-canonicalized struct, when it has one. */
export interface ShapeStamp {
  readonly shapeId?: number;
  readonly shapeFieldIdx?: number;
}

/**
 * Build `ref.test $T && shape == K ? hit : next` as a flat, single-`next` arm.
 *
 * @param anyLocal  local index holding the receiver as `anyref`
 * @param typeIdx   struct type this arm dispatches on
 * @param stamp     the struct's collision shape stamp (both fields, or neither)
 * @param blockType result type of the arm — `empty` for setters, a value type
 *                  for getters
 * @param hit       instructions to run when this arm claims the receiver
 * @param next      the rest of the chain; referenced EXACTLY ONCE
 */
export function buildShapeGuardedArm(
  anyLocal: number,
  typeIdx: number,
  stamp: ShapeStamp,
  blockType: BlockType,
  hit: Instr[],
  next: Instr[],
): Instr[] {
  const typeTest: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx },
  ];
  const guard: Instr[] =
    stamp.shapeId !== undefined && stamp.shapeFieldIdx !== undefined
      ? [
          ...typeTest,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx },
              { op: "struct.get", typeIdx, fieldIdx: stamp.shapeFieldIdx },
              { op: "i32.const", value: stamp.shapeId },
              { op: "i32.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ]
      : typeTest;
  return [...guard, { op: "if", blockType, then: hit, else: next }];
}
