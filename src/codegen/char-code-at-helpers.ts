// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3156) Guarded `String.prototype.charCodeAt` helpers for the IR path.
 *
 * ECMA-262 §22.1.3.3: `charCodeAt(pos)` returns the UTF-16 code unit at
 * ToIntegerOrInfinity(pos), or `NaN` when the resolved position is outside
 * `[0, length)`. Both legacy arms inline this guard at every call site
 * (host: `src/codegen/expressions/calls.ts` `method === "charCodeAt"` arm;
 * native: `src/codegen/string-ops.ts` `compileNativeStringMethodCall`).
 * The IR instead lowers `s.charCodeAt(i)` to ONE call of a mode-specific
 * defined helper `(recv, i32 idx) -> f64` so `lowerStringMethodCall` can ride
 * the generic `STRING_METHOD_TABLE` machinery — no value-producing if/else
 * needs to be built in from-ast.
 *
 * Both helpers follow the `ensureFmod` / `ensureVecElemSet` discipline:
 * materialized on demand from the IR resolver's `resolveFunc`, append-only
 * DEFINED functions (never imports — no existing funcIdx shifts), registered
 * in `ctx.funcMap` so any later late-import shift patches the map entry and
 * the emitted `call` ops by the same delta (#329/#1899).
 *
 * ## Host mode — `__jsstr_charCodeAt (externref, i32) -> f64`
 * Wraps the `wasm:js-string` `charCodeAt` + `length` builtins (i32-indexed;
 * the raw builtin TRAPS out of range — #2003) in the legacy bounds guard:
 * `idx >= 0 && idx < len ? f64(charCodeAt(s, idx)) : NaN`. The builtin
 * funcIdxs are read from `ctx.jsStringImports` — NOT `ctx.funcMap` by bare
 * name, which a user function called `charCodeAt` shadows (#1072). Import
 * indices never shift (imports precede defined functions), so baking them
 * into the helper body is stable. Requires `addStringImports` to have run —
 * the IR integration pre-registers it (`preregisterStringSupport`) whenever
 * a lowered function calls this helper.
 *
 * ## Native mode — `__str_charCodeAt (ref $AnyString, i32) -> f64`
 * Mirrors the legacy inline arm: flatten (cons-rope → flat), then bounds
 * guard against `.len`, then `array.get_u data[off + idx]` +
 * `f64.convert_i32_u`. Requires the native-string helper family
 * (`__str_flatten`) and struct types to exist — guaranteed whenever the
 * receiver is a string in native mode (the legacy scan/codegen registers
 * them for any string usage); returns `null` otherwise so the caller can
 * demote with a clear message.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

/** Reserved name for the host-mode guarded charCodeAt helper. */
export const JSSTR_CHARCODEAT_FN = "__jsstr_charCodeAt";
/** Reserved name for the host-mode spec-compatible substring helper. */
export const JSSTR_SUBSTRING_FN = "__jsstr_substring";
/** Reserved name for the native-mode guarded charCodeAt helper. */
export const NATIVE_CHARCODEAT_FN = "__str_charCodeAt";

// --- (#3931) canonical char-read-loop hoist helpers ------------------------
//
// The IR port of #2682 (`ir/char-read-loop.ts`) proves `0 <= i < recv.length`
// at every read site in the loop body, which makes the §22.1.3.3 OOB/NaN arm
// of the helpers above DEAD CODE there. These two helpers are the unguarded
// counterparts the proof licenses; they are small enough for the module
// inliner to fold into the loop body.
//
// Both return an i32 rather than an f64 code unit: the proof is exactly what
// lets `ir/i32-pure-bitwise.ts` treat the read as an int32-range LEAF, so
// `(h * 31 + s.charCodeAt(i)) | 0` composes in native i32 instead of paying
// the f64 ToInt32 bit-decomposition per iteration.
//
// Both take the STRING CARRIER ValType (`ref null $AnyString` / `externref`),
// never a raw descriptor type. That is not cosmetic: an IR value typed with a
// raw `ref N` has no symbolic Program ABI type identity, and a prepared
// component carrying one is REFUSED (`implicit-support-reference-unavailable`
// in `ir/prepared-component-dependencies.ts`) — which demotes the whole
// function back to legacy and silently undoes the optimisation. So the
// descriptor (`.data`/`.off`) stays INSIDE the native helper; what the IR
// hoists is the flatten, which is the expensive half.

/** `(ref $AnyString) -> (ref $NativeString)` — the existing rope-flattening helper. */
export const NATIVE_FLATTEN_FN = "__str_flatten";
/** `(ref null $AnyString, i32) -> i32` — UNGUARDED read of an already-FLAT receiver. */
export const NATIVE_FLAT_CHARCODEAT_FN = "__str_flat_charCodeAt";
/** `(externref, i32) -> i32` — UNGUARDED host code-unit read (caller proved in-bounds). */
export const JSSTR_CHARCODEAT_TRUSTED_FN = "__jsstr_charCodeAt_trusted";

/**
 * Ensure a host-string substring helper backed by the engine's
 * `wasm:js-string.substring` builtin.
 *
 * The builtin is deliberately lower-level than `String.prototype.substring`:
 * its indices must already be in range and ordered. Keep the JavaScript
 * semantics in Wasm (clamp both indices to `[0, length]`, then swap when
 * `start > end`) and reserve the actual slicing operation for the engine
 * builtin. This avoids an `env.string_substring` Wasm-to-JavaScript host call
 * in every hot-loop iteration while preserving the observable contract.
 */
export function ensureHostSubstringGuarded(ctx: CodegenContext): number | null {
  const existing = ctx.funcMap.get(JSSTR_SUBSTRING_FN);
  if (existing !== undefined) return existing;

  const substringIdx = ctx.jsStringImports.get("substring");
  const lengthIdx = ctx.jsStringImports.get("length");
  if (substringIdx === undefined || lengthIdx === undefined) return null;

  const sigIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);

  const S = 0;
  const START = 1;
  const END = 2;
  const LEN = 3;
  const clampParam = (index: number): Instr[] => [
    { op: "local.get", index },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index },
      ],
    },
    { op: "local.get", index },
    { op: "local.get", index: LEN },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: LEN },
        { op: "local.set", index },
      ],
    },
  ];

  const callSubstring = (start: number, end: number): Instr[] => [
    { op: "local.get", index: S },
    { op: "local.get", index: start },
    { op: "local.get", index: end },
    { op: "call", funcIdx: substringIdx },
  ];

  const body: Instr[] = [
    { op: "local.get", index: S },
    { op: "call", funcIdx: lengthIdx },
    { op: "local.set", index: LEN },
    ...clampParam(START),
    ...clampParam(END),
    { op: "local.get", index: START },
    { op: "local.get", index: END },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: callSubstring(END, START),
      else: callSubstring(START, END),
    },
  ];

  const fn: WasmFunction = {
    name: JSSTR_SUBSTRING_FN,
    typeIdx: sigIdx,
    locals: [{ name: "$len", type: { kind: "i32" } }],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(JSSTR_SUBSTRING_FN, funcIdx);
  return funcIdx;
}

/**
 * Ensure the host-mode helper exists; returns its funcIdx, or `null` when the
 * `wasm:js-string` builtins are not registered (caller reports + demotes).
 */
export function ensureHostCharCodeAtGuarded(ctx: CodegenContext): number | null {
  const existing = ctx.funcMap.get(JSSTR_CHARCODEAT_FN);
  if (existing !== undefined) return existing;

  const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
  const lengthIdx = ctx.jsStringImports.get("length");
  if (charCodeAtIdx === undefined || lengthIdx === undefined) return null;

  const sigIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "f64" }]);
  const funcIdx = mintDefinedFunc(ctx);

  const S = 0; // externref receiver
  const IDX = 1; // i32 index (caller already applied i32.trunc_sat_f64_s)

  // (idx >= 0) & (idx < length(s)) ? f64(charCodeAt(s, idx)) : NaN
  // — byte-for-byte the guard the legacy host arm emits inline.
  const body: Instr[] = [
    { op: "local.get", index: IDX },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "local.get", index: IDX },
    { op: "local.get", index: S },
    { op: "call", funcIdx: lengthIdx },
    { op: "i32.lt_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [
        { op: "local.get", index: S },
        { op: "local.get", index: IDX },
        { op: "call", funcIdx: charCodeAtIdx },
        { op: "f64.convert_i32_u" },
      ],
      else: [{ op: "f64.const", value: Number.NaN }],
    },
  ];

  const fn: WasmFunction = {
    name: JSSTR_CHARCODEAT_FN,
    typeIdx: sigIdx,
    locals: [],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(JSSTR_CHARCODEAT_FN, funcIdx);
  return funcIdx;
}

/**
 * Ensure the native-mode helper exists; returns its funcIdx, or `null` when
 * the native-string machinery (`__str_flatten`, struct types) is missing.
 */
export function ensureNativeCharCodeAtHelper(ctx: CodegenContext): number | null {
  const existing = ctx.funcMap.get(NATIVE_CHARCODEAT_FN);
  if (existing !== undefined) return existing;

  // __str_flatten's funcMap entry is the authoritative, shift-maintained
  // index (#1618); the nativeStrHelpers map can be stale after late imports.
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (flattenIdx === undefined || anyStrTypeIdx < 0 || strTypeIdx < 0 || strDataTypeIdx < 0) return null;

  const sigIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: anyStrTypeIdx }, { kind: "i32" }], [{ kind: "f64" }]);
  const funcIdx = mintDefinedFunc(ctx);

  const S = 0; // (ref $AnyString) receiver
  const IDX = 1; // i32 index
  const FLAT = 2; // (ref null $NativeString) flattened receiver

  // Mirrors the legacy native inline arm (string-ops.ts `charCodeAt`), while
  // avoiding a helper call for the overwhelmingly common already-flat value:
  //   flat = s is FlatString ? s : __str_flatten(s)
  //   (idx < 0) | (idx >= flat.len) ? NaN : f64(flat.data[flat.off + idx])
  const body: Instr[] = [
    { op: "local.get", index: S },
    { op: "ref.test", typeIdx: strTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      then: [
        { op: "local.get", index: S },
        { op: "ref.cast", typeIdx: strTypeIdx },
      ],
      else: [
        { op: "local.get", index: S },
        { op: "call", funcIdx: flattenIdx },
      ],
    },
    { op: "local.set", index: FLAT },
    { op: "local.get", index: IDX },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    { op: "local.get", index: IDX },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // .len
    { op: "i32.ge_s" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "f64.const", value: Number.NaN }],
      else: [
        { op: "local.get", index: FLAT },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
        { op: "local.get", index: FLAT },
        { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
        { op: "local.get", index: IDX },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "f64.convert_i32_u" },
      ],
    },
  ];

  const fn: WasmFunction = {
    name: NATIVE_CHARCODEAT_FN,
    typeIdx: sigIdx,
    locals: [{ name: "$flat", type: { kind: "ref_null", typeIdx: strTypeIdx } }],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(NATIVE_CHARCODEAT_FN, funcIdx);
  return funcIdx;
}

/**
 * (#3931) Register a tiny defined helper under `name`, once. Shares the
 * `mintDefinedFunc` + `funcMap` discipline of the guarded helpers above so a
 * later late-import addition shifts this index with every other one.
 */
function ensureTinyHelper(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: WasmFunction["locals"],
  body: Instr[],
): number {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const sigIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  const fn: WasmFunction = { name, typeIdx: sigIdx, locals, body, exported: false };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * (#3931) `__str_flat_charCodeAt(flat, i) -> i32` — the UNGUARDED code-unit
 * read of an ALREADY-FLATTENED receiver, i.e. the body of legacy's
 * `emitHoistedCharCodeAtRead` (`data[off + i]`) with the flatten and the
 * `0 <= i < len` guard both removed: the caller hoisted the flatten into the
 * loop preheader and `ir/char-read-loop.ts` proved the bound.
 *
 * The parameter is the string CARRIER (`ref null $AnyString`), not
 * `ref $NativeString`, so the IR never has to name a raw descriptor type —
 * see the note by the constants above for why that matters. The hoisted value
 * is always the flatten helper's own result, so the `ref.cast` is a proven
 * downcast, not a check that can fail in practice.
 *
 * `null` when the native-string struct types are not registered (caller keeps
 * the guarded lowering).
 */
export function ensureNativeFlatCharCodeAtHelper(ctx: CodegenContext): number | null {
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (anyStrTypeIdx < 0 || strTypeIdx < 0 || strDataTypeIdx < 0) return null;

  const S = 0; // (ref null $AnyString) — the hoisted, already-flat receiver
  const IDX = 1; // i32 index, proven in [0, len)
  const FLAT = 2; // (ref null $NativeString)
  return ensureTinyHelper(
    ctx,
    NATIVE_FLAT_CHARCODEAT_FN,
    [{ kind: "ref_null", typeIdx: anyStrTypeIdx }, { kind: "i32" }],
    [{ kind: "i32" }],
    [{ name: "$flat", type: { kind: "ref_null", typeIdx: strTypeIdx } }],
    [
      { op: "local.get", index: S },
      { op: "ref.cast", typeIdx: strTypeIdx },
      { op: "local.set", index: FLAT },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
      { op: "local.get", index: IDX },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
    ],
  );
}

/**
 * (#3931) `__jsstr_charCodeAt_trusted(s, i) -> i32` — the host-mode unguarded
 * read. Host strings have no flattenable descriptor to hoist, so the whole
 * optimisation there is dropping the guard: the raw `wasm:js-string.charCodeAt`
 * builtin TRAPS out of range (#2003), which is exactly why the guarded helper
 * exists — and exactly what the in-bounds proof makes unreachable. `null` when
 * the builtins are not registered (caller keeps the guarded lowering).
 */
export function ensureHostCharCodeAtTrusted(ctx: CodegenContext): number | null {
  const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
  if (charCodeAtIdx === undefined) return null;
  return ensureTinyHelper(
    ctx,
    JSSTR_CHARCODEAT_TRUSTED_FN,
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "i32" }],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: charCodeAtIdx },
    ],
  );
}
