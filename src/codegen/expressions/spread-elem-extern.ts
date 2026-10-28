// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Project one element of a spread source (`f(...src)`) to the externref that
 * `__extras_argv` — and therefore the callee's `arguments` object — stores.
 *
 * Numbers are boxed, externrefs pass through, and GC refs are converted with
 * `extern.convert_any`. The exception is `$AnyValue` (#6736): in an untyped
 * standalone program `[0, 'a']` is a vec of tagged unions, and a union struct is
 * not a JS value. Converting it directly put the struct itself into `arguments`,
 * so `arguments[0] === 0` was false and `typeof arguments[0]` answered
 * "object". It is projected through the coercion engine instead, which unboxes
 * the union to the value it carries. Standalone-gated: the JS-host lane keeps
 * its existing lowering byte for byte.
 */
import type { Instr, ValType } from "../../ir/types.js";

/**
 * `anyToExtern` answers the `$AnyValue` projection (or `undefined` for any other
 * type). The caller supplies it because the coercion engine lives inside the
 * codegen import cycle, and this module stays outside it.
 */
export function spreadElemToExternInstrs(
  elemType: ValType,
  boxIdx: number | undefined,
  anyToExtern: (elemType: ValType) => Instr[] | undefined,
): Instr[] {
  const kind = elemType.kind;
  if (kind === "f64") {
    return boxIdx !== undefined ? [{ op: "call", funcIdx: boxIdx }] : [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (kind === "i32" || kind === "i8" || kind === "i16") {
    return boxIdx !== undefined
      ? [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx }]
      : [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  if (kind === "ref" || kind === "ref_null") {
    return anyToExtern(elemType) ?? [{ op: "extern.convert_any" }];
  }
  // externref element — already correct.
  return [];
}

/** Locals {@link holeFreeVecCopyInstrs} works in, allocated by the caller. */
export interface HoleFreeCopyLocals {
  readonly src: number;
  readonly len: number;
  readonly cap: number;
  readonly i: number;
  readonly dst: number;
}

/**
 * (#7164) `[vec] → [vec']`: a fresh vec with the same `length` whose elements
 * are the source's with every hole read as `undefined` (`holeMap`, the
 * caller's `holeToUndefinedInstrs`). A rest parameter receives this instead of
 * the caller's vec — §10.4.4 CreateArrayFromList over the iterated values, so
 * a hole is a present `undefined`. Slots past the backing stay past it (the
 * #4491 length/capacity split reads them as absent → `undefined`). A null
 * source passes through.
 */
export function holeFreeVecCopyInstrs(
  vecTypeIdx: number,
  arrTypeIdx: number,
  l: HoleFreeCopyLocals,
  holeMap: Instr[],
): Instr[] {
  const vec: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  return [
    { op: "local.tee", index: l.src },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: vec },
      then: [{ op: "ref.null", typeIdx: vecTypeIdx }],
      else: [
        { op: "local.get", index: l.src },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.tee", index: l.len },
        // cap = min(len, array.len(data))
        { op: "local.get", index: l.src },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "array.len" },
        { op: "local.tee", index: l.cap },
        { op: "local.get", index: l.len },
        { op: "local.get", index: l.cap },
        { op: "i32.lt_u" },
        { op: "select" },
        { op: "local.tee", index: l.cap },
        { op: "array.new_default", typeIdx: arrTypeIdx },
        { op: "local.set", index: l.dst },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: l.i },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: l.i },
                { op: "local.get", index: l.cap },
                { op: "i32.ge_u" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: l.dst },
                { op: "local.get", index: l.i },
                { op: "local.get", index: l.src },
                { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
                { op: "local.get", index: l.i },
                { op: "array.get", typeIdx: arrTypeIdx },
                ...holeMap,
                { op: "array.set", typeIdx: arrTypeIdx },
                { op: "local.get", index: l.i },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: l.i },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: l.len },
        { op: "local.get", index: l.dst },
        { op: "ref.as_non_null" },
        { op: "struct.new", typeIdx: vecTypeIdx },
      ],
    },
  ];
}
