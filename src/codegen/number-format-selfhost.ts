// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted number-format emission (#3305 — parse/format family).
 *
 * Wasm-facing plumbing for the TS sources in `src/stdlib/number-format.ts`
 * (the timsort/#3159 split): tiny f64-ABI micro-kernels over the scratch
 * i16 buffer, the self-hosted body compiled through the compiler's own IR
 * pipeline, and a legacy-ABI thunk under the original funcMap name.
 *
 * Micro-kernels (`__nfd_*`, all f64-ABI — from-ast call args require exact
 * IrType match, and stdlib index arithmetic is f64):
 *   - `__nfd_new(cap) -> (ref null $__str_data)` — scratch buffer alloc.
 *   - `__nfd_get(buf, i) -> f64` / `__nfd_set(buf, i, v)` — code-unit access
 *     (trunc internally; get widens via `f64.convert_i32_u`).
 *   - `__nfd_fin(buf, len) -> (ref $AnyString)` — copies `buf[0..len)` into a
 *     tight `$NativeString`, exactly like the retained `__num_fmt_finalize`
 *     (which keeps serving the hand-written Ryu/toFixed/… siblings) but
 *     returning the struct ref so the self-hosted body can type it as
 *     `string`; the legacy thunk adds the `extern.convert_any`.
 *   - `__num_fmt_trap()` — `unreachable`; preserves the hand body's
 *     MAX_SAFE_INTEGER trap parity (#1335 Phase 2 pending).
 *
 * Emitted from `emitNativeNumberFormat` (native/standalone only), inside the
 * same append-only stable-regime window as the hand siblings — all functions
 * mint via `mintDefinedFunc`, so late-import shifts skip them identically.
 */
import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { irVal, type IrType } from "../ir/nodes.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { emitSelfHostedFunc } from "./stdlib-selfhost.js";
import { numToStringRadixDef } from "../stdlib/number-format.js";

import {
  buildNumberFormatNewBody,
  buildNumberFormatGetBody,
  buildNumberFormatSetBody,
  buildNumberFormatFinBody,
  buildNumberFormatTrapBody,
  buildNumberFormatRadixThunkBody,
} from "../runtime/wasmgc/values/number-format-radix-bodies.js";
import { numberFormatSignatures } from "../runtime/wasmgc/values/number-format-bodies.js";

function emitFunc(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: LocalDef[],
  body: Instr[],
): number {
  const typeIdx = addFuncType(ctx, params, results, `${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/** Materialize the `__nfd_*` buffer micro-kernels (idempotent via funcMap). */
function ensureNumFmtBufKernels(ctx: CodegenContext): void {
  if (ctx.funcMap.get("__nfd_new") !== undefined) return;
  const types = {
    dataTypeIdx: ctx.nativeStrDataTypeIdx,
    nativeStringTypeIdx: ctx.nativeStrTypeIdx,
    anyStringTypeIdx: ctx.anyStrTypeIdx,
  };
  const signatures = numberFormatSignatures<ValType>({
    data: { kind: "ref", typeIdx: types.dataTypeIdx },
    nullableData: { kind: "ref_null", typeIdx: types.dataTypeIdx },
    anyString: { kind: "ref", typeIdx: types.anyStringTypeIdx },
  });
  const emit = (
    name: string,
    signature: { params: ValType[]; results: ValType[] },
    built: { locals: LocalDef[]; body: Instr[] },
  ): void => {
    emitFunc(ctx, name, signature.params, signature.results, built.locals, built.body);
  };
  // __nfd_new(cap) -> fresh zero-filled scratch buffer
  emit("__nfd_new", signatures.new, buildNumberFormatNewBody(types));
  // __nfd_get(buf, i) -> f64 code unit
  emit("__nfd_get", signatures.get, buildNumberFormatGetBody(types));
  // __nfd_set(buf, i, v)
  emit("__nfd_set", signatures.set, buildNumberFormatSetBody(types));
  // __num_fmt_trap() — unreachable (hand-parity for the unsafe-integer arm)
  emit("__num_fmt_trap", signatures.trap, buildNumberFormatTrapBody());

  // __nfd_fin(buf, len) -> (ref $AnyString): copy buf[0..len) into a tight
  // $NativeString — the same copy loop as __num_fmt_finalize, f64-ABI, struct
  // result (the legacy thunk widens to externref).
  emit("__nfd_fin", signatures.fin, buildNumberFormatFinBody(types));
}

/**
 * Emit the self-hosted `number_toString_radix` — TS body + legacy
 * `(f64, f64) -> externref` thunk under the original funcMap name.
 * Precondition (matches the hand emitter it replaces): native-string types
 * registered (`emitNativeNumberFormat` runs `ensureNativeStringHelpers`
 * first).
 */
export function emitSelfHostedToStringRadix(ctx: CodegenContext): void {
  ensureNumFmtBufKernels(ctx);
  const bufRef: IrType = irVal({ kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx });
  const shIdx = emitSelfHostedFunc(ctx, numToStringRadixDef(bufRef));

  const signature = numberFormatSignatures<ValType>({
    data: { kind: "ref", typeIdx: ctx.nativeStrDataTypeIdx },
    nullableData: { kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx },
    anyString: { kind: "ref", typeIdx: ctx.anyStrTypeIdx },
  }).radixThunk;
  const built = buildNumberFormatRadixThunkBody(shIdx);
  emitFunc(ctx, "number_toString_radix", signature.params, signature.results, built.locals, built.body);
}
