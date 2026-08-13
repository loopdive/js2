/**
 * (#3973) Native-string ELEMENT reads through a dynamically-typed receiver.
 *
 * Split out of `property-access.ts` (a capped god-file, #3102) rather than
 * grown inside it: this is a native-strings subsystem concern and sits
 * alongside its siblings `emitGuardedNativeStringLength` (property-access.ts)
 * and `compileGuardedNativeStringMethodCall` (string-ops.ts), which solve the
 * same "the receiver is statically `any` but may be a native string at
 * runtime" problem for `.length` and for method calls.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { redundantFlattenCall } from "./lazy-str-flatten.js"; // (#4157)
import { ensureNativeStringHelpers } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { compileExpression, ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * (#3973) Emit a runtime-guarded native-string ELEMENT read (`recv[idx]`) for a
 * receiver whose STATIC type is `any`/`unknown` but which may hold a native
 * string at runtime, in `--target standalone` + native-strings mode.
 *
 * WHY this exists: the #1910-R4/#3304 arm above emits the fast native
 * `__str_charAt` sequence, but its gate is purely STATIC
 * (`staticJsTypeOf(recv) === "string"`). An implicitly-`any` parameter never
 * satisfies it, so the read fell through to `compileElementAccessBody`'s
 * standalone numeric arm → `__extern_get_idx`, whose receiver dispatch is
 * `$Object`-array-like / typed-`__vec_<k>` / `$ObjVec` only. A `$AnyString`
 * receiver matches NONE of those arms and lands on the miss → `undefined`.
 * Host/gc mode never saw this because there `__extern_get_idx` is a JS import
 * doing a real `obj[idx]`, so a string receiver just works — which is why this
 * reproduced ONLY host-free. `.length` and `.charAt()` on the very same `any`
 * value already work precisely because they carry this runtime `ref.test`
 * guard (`emitGuardedNativeStringLength` above,
 * `compileGuardedNativeStringMethodCall` in string-ops.ts); the element-read
 * path was the one member of that family still missing it.
 *
 * Spec shape (§10.4.3.5 StringGetOwnProperty): a String exotic object has an
 * own property for `idx` ONLY when `idx` is a canonical integer index within
 * `[0, len)`. So this deliberately does NOT reuse `__str_charAt`'s own bounds
 * behaviour — charAt answers `""` out of range, whereas `s[oob]` must be
 * `undefined`. The integral round-trip test (`f64(i32(idx)) === idx`) rejects
 * `1.5`, `NaN`, `±Infinity` and anything outside i32 range; the subsequent
 * unsigned compare rejects negatives and `>= len` in one instruction.
 *
 * Non-string receivers keep the EXACT prior lowering (`__extern_get_idx`) in
 * the else arm, so arrays / `$ObjVec` / array-like `$Object` are byte-identical
 * to before. Receiver and index are each compiled ONCE into locals, so a
 * side-effecting receiver or index expression is not re-evaluated.
 */
export function emitGuardedNativeStringElementGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  recvExpr: ts.Expression,
  indexExpr: ts.Expression,
): ValType | null {
  ensureObjectRuntime(ctx);
  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
  if (flattenIdx === undefined || charAtIdx === undefined) return null;

  // Receiver ONCE → externref local.
  const recvLocal = allocLocal(fctx, `__strix_recv_${fctx.locals.length}`, { kind: "externref" });
  compileExpression(ctx, fctx, recvExpr, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: recvLocal });

  // Index ONCE → f64 local (shared by the string arm and the fallback call).
  const idxF64 = allocLocal(fctx, `__strix_idx_${fctx.locals.length}`, { kind: "f64" });
  compileExpression(ctx, fctx, indexExpr, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: idxF64 });

  // Resolve the fallback import and flush the funcIdx shift BEFORE any arm is
  // built, so every funcIdx baked below stays live (see addUnionImports).
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (getIdxFn === undefined) return null;

  const anyLocal = allocLocal(fctx, `__strix_any_${fctx.locals.length}`, { kind: "anyref" });
  const idxI32 = allocLocal(fctx, `__strix_i_${fctx.locals.length}`, { kind: "i32" });
  const resultLocal = allocLocal(fctx, `__strix_res_${fctx.locals.length}`, { kind: "externref" });

  fctx.body.push({ op: "local.get", index: recvLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: anyLocal });

  const missToResult = (): Instr[] => [
    ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr]),
    { op: "local.set", index: resultLocal },
  ];

  // THEN arm — receiver IS a native string.
  const thenArm: Instr[] = [
    { op: "local.get", index: idxF64 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: idxI32 },
    // canonical-integer test: f64(i) === idx
    { op: "local.get", index: idxI32 },
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: idxF64 },
    { op: "f64.eq" },
    // in-range test: (unsigned)i < len  (len is field 0, valid for Flat & Cons)
    { op: "local.get", index: idxI32 },
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
    { op: "i32.lt_u" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        // (#4157) `__str_charAt` flattens param 0 itself — the same argument
        // as the bounds test above, which already reads the length off
        // `$AnyString` field 0 without flattening. See `lazy-str-flatten.ts`.
        ...redundantFlattenCall(flattenIdx),
        { op: "local.get", index: idxI32 },
        { op: "call", funcIdx: charAtIdx },
        { op: "extern.convert_any" },
        { op: "local.set", index: resultLocal },
      ],
      else: missToResult(),
    },
  ];

  // ELSE arm — any other receiver keeps the EXACT existing behaviour.
  const elseArm: Instr[] = [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: idxF64 },
    { op: "call", funcIdx: getIdxFn },
    { op: "local.set", index: resultLocal },
  ];

  fctx.body.push({ op: "local.get", index: anyLocal });
  fctx.body.push({ op: "ref.test", typeIdx: ctx.anyStrTypeIdx });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenArm, else: elseArm });
  fctx.body.push({ op: "local.get", index: resultLocal });
  return { kind: "externref" };
}
