// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4232) §10.4.3.5 StringGetOwnProperty for a STATICALLY-known string or
 * String-wrapper receiver: `s[i]` is the 1-char substring when `i` is a
 * canonical integer index in `[0, len)`, and **`undefined`** otherwise.
 *
 * ## What was wrong
 *
 * The #1910-R4 / #3304 arm in `compileElementAccessBody` lowered this read to
 * `__str_charAt`, whose §22.1.3.1 semantics answer the empty string out of
 * range. So `new String("hello world")[-1]` read `""`, `[11]` read `""`, and
 * `[NaN]` read `"h"` (the trunc of NaN is 0). That is not a comparison bug that
 * could be fixed in place: the arm's result type was `ref $NativeString`, which
 * cannot represent `undefined` at all.
 *
 * #3973 already solved exactly this for a receiver whose static type is
 * `any`/`unknown` (string-element-read.ts). The static arm was the last member
 * of the `.length` / `.charAt()` / `[i]` family still on charAt bounds, so this
 * module is deliberately its mirror image — same integral round-trip, same
 * single unsigned compare, same `externref` result — and the two should be
 * changed together if the spec reading ever moves.
 *
 * ## The two tests, and why they are two
 *
 *   * **Canonical integer index.** `f64(i32(idx)) === idx` rejects `1.5`,
 *     `NaN`, `±Infinity` and anything outside i32 range in one round-trip.
 *     `NaN` matters on its own: `i32.trunc_sat_f64_s(NaN)` is `0`, so without
 *     this test `s[NaN]` would read `s[0]` — which is precisely what
 *     `15.5.5.5.2-3-3` catches.
 *   * **Range.** ONE `i32.lt_u` then rejects negatives and `>= len` together,
 *     because a negative index reinterpreted as unsigned is enormous.
 *
 * ## Cost of the wider result type
 *
 * The old fast path returned a `ref $NativeString` directly. This returns
 * `externref`, so a consumer that wants a native string pays an
 * `any.convert_extern` + `ref.cast`. Both are WasmGC no-ops at runtime (no
 * allocation, no copy) — the representation is the same reference, only the
 * static type differs — so the price of spec-correctness here is compile-time
 * typing, not runtime work.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { coerceType } from "./type-coercion.js";
import { compileExpression } from "./shared.js";

/**
 * Emit `recv[idx]` with String-exotic own-property semantics, for a receiver
 * whose STATIC type is a primitive string or a `String` wrapper.
 *
 * Returns `externref` (so out-of-range can be `undefined`), or `null` when a
 * prerequisite native is unavailable — in which case the caller must fall
 * through to its previous lowering, having emitted nothing.
 */
export function emitStringExoticIndexGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
  indexExpr: ts.Expression,
): ValType | null {
  ensureObjectRuntime(ctx);
  ensureNativeStringHelpers(ctx);
  const toPrimIdx = ctx.funcMap.get("__to_primitive");
  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (toPrimIdx === undefined || charAtIdx === undefined || flattenIdx === undefined) return null;
  if (ctx.anyStrTypeIdx < 0) return null;
  const anyStr = ctx.anyStrTypeIdx;

  // [[StringData]] ← __to_primitive(recv, "string"). For a primitive-string
  // receiver this is identity (§7.1.1 step 1), so the same emission serves
  // both receiver shapes — that dual role is inherited from #3304 and is why
  // the arm has one gate rather than two.
  const strLocal = allocLocal(fctx, `__sxi_s_${fctx.locals.length}`, { kind: "ref_null", typeIdx: anyStr });
  compileExpression(ctx, fctx, recvExpr, { kind: "externref" });
  addStringConstantGlobal(ctx, "string");
  fctx.body.push(...stringConstantExternrefInstrs(ctx, "string"));
  fctx.body.push({ op: "call", funcIdx: toPrimIdx });
  coerceType(ctx, fctx, { kind: "externref" }, { kind: "ref_null", typeIdx: anyStr });
  fctx.body.push({ op: "local.set", index: strLocal });

  // Index ONCE into an f64 local: it is read three times below (round-trip
  // test, range test, char read), and re-evaluating a side-effecting index
  // expression would be observable.
  const idxF64 = allocLocal(fctx, `__sxi_idx_${fctx.locals.length}`, { kind: "f64" });
  compileExpression(ctx, fctx, indexExpr, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: idxF64 });

  const idxI32 = allocLocal(fctx, `__sxi_i_${fctx.locals.length}`, { kind: "i32" });
  const resultLocal = allocLocal(fctx, `__sxi_res_${fctx.locals.length}`, { kind: "externref" });

  const inRange: Instr[] = [
    { op: "local.get", index: strLocal },
    { op: "ref.as_non_null" },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.get", index: idxI32 },
    { op: "call", funcIdx: charAtIdx },
    { op: "extern.convert_any" },
    { op: "local.set", index: resultLocal },
  ];
  const outOfRange: Instr[] = [
    ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr]),
    { op: "local.set", index: resultLocal },
  ];

  fctx.body.push(
    { op: "local.get", index: idxF64 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: idxI32 },
    // canonical integer index? f64(i32(idx)) === idx
    { op: "local.get", index: idxI32 },
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: idxF64 },
    { op: "f64.eq" },
    // in range? (unsigned) i < len — length is field 0 of $AnyString, valid for
    // both the flat and the cons shape, so no flatten is needed to ask.
    { op: "local.get", index: idxI32 },
    { op: "local.get", index: strLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyStr, fieldIdx: 0 },
    { op: "i32.lt_u" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: inRange, else: outOfRange },
    { op: "local.get", index: resultLocal },
  );
  return { kind: "externref" };
}
