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
import type { Instr, WasmFunction } from "../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

/** Reserved name for the host-mode guarded charCodeAt helper. */
export const JSSTR_CHARCODEAT_FN = "__jsstr_charCodeAt";
/** Reserved name for the host-mode spec-compatible substring helper. */
export const JSSTR_SUBSTRING_FN = "__jsstr_substring";
/** Reserved name for the native-mode guarded charCodeAt helper. */
export const NATIVE_CHARCODEAT_FN = "__str_charCodeAt";

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
