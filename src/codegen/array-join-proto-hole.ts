// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-4 lane J) `Array.prototype.join` over a HOLE whose index lives on
 * `Array.prototype`.
 *
 * §23.1.3.18 step 4.b renders an absent index as the empty string — but "absent"
 * is `Get(O, ToString(k))`, a full [[Get]] with the prototype walk, not "this
 * array's backing has no slot there". The #3224 bounds guard in
 * `compileArrayJoinNative` conflated the two: any index past the physical
 * backing joined as `""`, unconditionally. Measured standalone on `da724268b0`:
 *
 * ```js
 * Array.prototype[1] = 1;
 * var x = [0]; x.length = 2;   // index 1 is a hole in x's backing
 * x[1];                        // 1        — the READ path already walks the chain
 * x.join();                    // "0,"     — expected "0,1"
 * x.toString();                // "0,"     — toString IS join
 * ```
 *
 * The read and the join disagreed about the same index, which is the shape this
 * module removes: the fallback re-asks `__extern_get_idx`, the SAME
 * prototype-aware indexed [[Get]] the #4159 routed element read uses, so the
 * two cannot answer differently. test262
 * `built-ins/Array/prototype/toString/S15.4.4.2_A3_T1`.
 *
 * ## Scope
 *
 * Gated on `ctx.protoIndexDirty` — the #4160 pre-scan flag, set only by a
 * module that writes an INDEX onto `Array.prototype` / `Object.prototype` (and
 * unconditionally by `dynamicCodeDirty`). With the flag clear, a hole cannot
 * inherit anything, `""` is exactly right, and the emitted fold is
 * byte-identical to before. The fallback also only replaces the `else` arm of a
 * guard that already existed, so a DENSE array never reaches it at all.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/**
 * Arm the fallback for this join: register the three natives it calls, flush the
 * resulting index shifts, and allocate its scratch local. Returns that local, or
 * `-1` when the module cannot observe an inherited hole — the gate is
 * `ctx.protoIndexDirty`, the #4160 pre-scan flag set only by a module that
 * writes an INDEX onto `Array.prototype` / `Object.prototype`.
 *
 * MUST run before the caller captures any other funcIdx, since registering an
 * import shifts every defined-function index at or above it (#2043).
 */
export function ensureJoinProtoHoleLocal(ctx: CodegenContext, fctx: FunctionContext): number {
  if (ctx.standalone !== true || ctx.protoIndexDirty !== true) return -1;
  const externref: ValType = { kind: "externref" };
  ensureLateImport(ctx, "__extern_get_idx", [externref, { kind: "f64" }], [externref]);
  ensureLateImport(ctx, "__extern_toString", [externref], [externref]);
  ensureLateImport(ctx, "__extern_is_undefined", [externref], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  return allocLocal(fctx, `__njoin_protohole_${fctx.locals.length}`, externref);
}

/**
 * The replacement `else` arm: `Get(recv, i)`, rendered as `""` when the walk
 * still finds nothing. Leaves a `(ref $AnyString)` on the stack, matching the
 * arm it replaces.
 *
 * Every funcIdx is resolved by NAME here rather than captured at ensure time —
 * the join fold registers its own late imports in between, which shifts defined
 * function indices (the #2043 late-shift class).
 *
 * Returns `undefined` when the fallback is not armed (`holeValueLocal < 0`) or a
 * required native is unavailable, so the caller keeps the unchanged `""` arm.
 */
export function joinProtoHoleFallbackInstrs(
  ctx: CodegenContext,
  vecLocal: number,
  iLocal: number,
  holeValueLocal: number,
  anyStrTypeIdx: number,
): Instr[] | undefined {
  if (holeValueLocal < 0) return undefined;
  const getIdx = ctx.funcMap.get("__extern_get_idx");
  const toStrIdx = ctx.funcMap.get("__extern_toString");
  const isUndefIdx = ctx.funcMap.get("__extern_is_undefined");
  if (getIdx === undefined || toStrIdx === undefined || isUndefIdx === undefined) return undefined;
  const anyStrRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  return [
    { op: "local.get", index: vecLocal },
    { op: "extern.convert_any" },
    { op: "local.get", index: iLocal },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: getIdx },
    { op: "local.tee", index: holeValueLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: holeValueLocal },
        { op: "call", funcIdx: isUndefIdx },
      ],
    },
    {
      op: "if",
      blockType: { kind: "val", type: anyStrRef },
      then: [...nativeStringLiteralInstrs(ctx, ""), { op: "ref.cast", typeIdx: anyStrTypeIdx }],
      else: [
        { op: "local.get", index: holeValueLocal },
        { op: "call", funcIdx: toStrIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
      ],
    },
  ];
}
