// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * `recv.length` on a statically `any` / `unknown` receiver in `--target
 * standalone` / WASI, receiver already on the stack as an `externref`.
 *
 * ## The gap (#6736)
 * This read used to answer a NUMBER for every receiver: the string arm read
 * `$AnyString.len`, a closure asked its metadata, and everything else fell to
 * `__extern_length` — the object runtime's array-like reader, which is
 * ToLength(Get(o, "length")) and so turns an ABSENT `length` into `0`. For
 * `.length` that is wrong: §7.3.2 Get of a missing property is `undefined`.
 * `{}.length`, `Object.create(p).length` and — the lodash case — a
 * constructor's `prototype` object all read `0`, so
 * `isArrayLike(LazyWrapper.prototype)` (`isLength(value.length)`) answered
 * true, `keys()` took `arrayLikeKeys`, and lodash's module init threw
 * `called value is not a function`. JS-host mode fixed the same bug in #2580
 * M2 by routing through `emitDynGet`; this is the standalone counterpart.
 *
 * ## The lowering
 * The read now produces an `externref` (a boxed number or `undefined`):
 *   1. `$AnyString`            → box(len)                  (unchanged value)
 *   2. builtin-fn metadata hit → the metadata value         (unchanged value)
 *   3. closure                 → own `length` or 0 boxed    (unchanged value)
 *   4. null / undefined        → box(`__extern_length`)     (unchanged value)
 *   5. `$__vec_base` subtype   → box(field 0)               (array/TA length)
 *   6. anything else           → `__extern_get(recv, "length")` — the real Get,
 *      prototype chain included, `undefined` when absent.
 * Arms 1–5 answer exactly what the numeric lowering did; only arm 6 changes,
 * and only for receivers whose `length` is not an own/inherited number.
 */
import type { Instr, ValType } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { getFuncRefWrapperRootTypeIdx } from "../closures/funcref-wrapper-types.js";
import { getOrRegisterVecBaseType } from "../registry/types.js";
import { ensureLateImport, flushLateImportShifts } from "../shared.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

function ifExtern(cond: Instr[], then: Instr[], otherwise: Instr[]): Instr[] {
  return [...cond, { op: "if", blockType: { kind: "val", type: EXTERNREF }, then, else: otherwise }];
}

/**
 * Helpers that live inside the codegen import cycle. The caller passes them in,
 * so this module stays outside the cycle (the `check:import-cycles` ratchet).
 */
export interface AnyLengthDeps {
  coercionInstrs(ctx: CodegenContext, from: ValType, to: ValType, fctx?: FunctionContext): Instr[];
  addStringConstantGlobal(ctx: CodegenContext, value: string): void;
  stringConstantExternrefInstrs(ctx: CodegenContext, value: string): Instr[];
}

/** Stack `[externref recv] → [externref]`; see the file header. */
export function emitStandaloneAnyLengthGet(ctx: CodegenContext, fctx: FunctionContext, deps: AnyLengthDeps): ValType {
  const { coercionInstrs, addStringConstantGlobal, stringConstantExternrefInstrs } = deps;
  const closureRootIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  ensureLateImport(ctx, "__extern_length", [EXTERNREF], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  // (#2175 S3b-3) The metadata consult also answers `$__ta_ctor` (3), so it is
  // asked for ANY receiver whenever either carrier family can exist.
  const taCtorRegistered = ctx.taCtorTypeIdx !== undefined && ctx.taCtorTypeIdx >= 0;
  const wantMeta = closureRootIdx !== undefined || taCtorRegistered;
  if (wantMeta) ensureLateImport(ctx, "__builtinfn_get_meta", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  addStringConstantGlobal(ctx, "length");
  // A fresh copy per use: the late-import shift rewrites `call` operands in
  // place, so one Instr object spliced into two arms would be shifted twice.
  const boxTemplate = coercionInstrs(ctx, I32, EXTERNREF, fctx);
  const boxI32 = (): Instr[] => structuredClone(boxTemplate);
  flushLateImportShifts(ctx, fctx);

  const lenFn = ctx.funcMap.get("__extern_length");
  const externGetFn = ctx.funcMap.get("__extern_get");
  const isUndefinedFn = ctx.funcMap.get("__extern_is_undefined");
  const bfnGetMetaFn = wantMeta ? ctx.funcMap.get("__builtinfn_get_meta") : undefined;
  const recv = allocLocal(fctx, `__alen_recv_${fctx.locals.length}`, EXTERNREF);
  const get = (): Instr[] => [{ op: "local.get", index: recv }];
  const key = (): Instr[] => stringConstantExternrefInstrs(ctx, "length");
  const boxedZero = (): Instr[] => [{ op: "i32.const", value: 0 }, ...boxI32()];

  // Arms 4–6: the non-closure fallback.
  const legacyLength = (): Instr[] =>
    lenFn !== undefined
      ? [...get(), { op: "call", funcIdx: lenFn }, { op: "i32.trunc_sat_f64_s" }, ...boxI32()]
      : boxedZero();
  const nullish: Instr[] = [...get(), { op: "ref.is_null" }];
  if (isUndefinedFn !== undefined) nullish.push(...get(), { op: "call", funcIdx: isUndefinedFn }, { op: "i32.or" });
  const plainGet: Instr[] =
    externGetFn !== undefined ? [...get(), ...key(), { op: "call", funcIdx: externGetFn }] : legacyLength();
  const vecOrGet = ifExtern(
    [...get(), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: vecBaseIdx }],
    [
      ...get(),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: vecBaseIdx },
      { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
      ...boxI32(),
    ],
    plainGet,
  );
  let chain = ifExtern(nullish, legacyLength(), vecOrGet);

  // Arm 3: a closure without metadata — its own (possibly redefined) `length`
  // from the closure bag, else Function.prototype.length (0).
  if (closureRootIdx !== undefined) {
    const own = allocLocal(fctx, `__alen_own_${fctx.locals.length}`, EXTERNREF);
    const ownOrZero: Instr[] =
      externGetFn !== undefined && isUndefinedFn !== undefined
        ? ifExtern(
            [
              ...get(),
              ...key(),
              { op: "call", funcIdx: externGetFn },
              { op: "local.tee", index: own },
              { op: "call", funcIdx: isUndefinedFn },
            ],
            boxedZero(),
            [{ op: "local.get", index: own }],
          )
        : boxedZero();
    chain = ifExtern(
      [...get(), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: closureRootIdx }],
      ownOrZero,
      chain,
    );
  }
  // Arm 2: builtin-function / `$__ta_ctor` metadata, asked first for any receiver.
  if (bfnGetMetaFn !== undefined) {
    const meta = allocLocal(fctx, `__alen_meta_${fctx.locals.length}`, EXTERNREF);
    chain = ifExtern(
      [
        ...get(),
        ...key(),
        { op: "call", funcIdx: bfnGetMetaFn },
        { op: "local.tee", index: meta },
        { op: "ref.is_null" },
      ],
      chain,
      [{ op: "local.get", index: meta }],
    );
  }
  // Arm 1: a native string.
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    chain = ifExtern(
      [...get(), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: ctx.anyStrTypeIdx }],
      [
        ...get(),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
        ...boxI32(),
      ],
      chain,
    );
  }
  fctx.body.push({ op: "local.set", index: recv }, ...chain);
  return EXTERNREF;
}
