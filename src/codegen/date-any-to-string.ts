// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 T4) §21.4.4.41 `Date.prototype.toString` for a Date reached
 * DYNAMICALLY — `String(d)`, `"" + d`, `d + d`, a template substitution —
 * rather than through the statically-resolved `d.toString()` call.
 *
 * ## The defect
 *
 * A standalone `Date` is the nominal `__Date` struct (one i64 `[[DateValue]]`
 * field). It is not a `$Object`, not a `$__vec_base`, and it carries no
 * `__call_toString` dispatcher arm, so it falls through every arm of
 * `__any_to_string` to the canonical `"[object Object]"` terminal. Measured on
 * `new Date(0)` in standalone:
 *
 * ```js
 * d.toString();   // "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)"  ✓
 * String(d);      // "[object Object]"   ✗
 * "" + d;         // "[object Object]"   ✗
 * d + d;          // "[object Object][object Object]"   ✗   (S11.6.1_A2.2_T2)
 * ```
 *
 * The static call is right because `builtins.ts` resolves it at compile time
 * against `__date_format_string`. Every dynamic spelling reaches a different
 * terminal that has never heard of Dates — one value, two renderings, and the
 * one that disagrees with the spec is the one that is easy to miss, because the
 * spelling people reach for when checking (`d.toString()`) is the correct one.
 *
 * ## Shape
 *
 * The same shape as `__error_to_string`'s arm in the same terminal: a `ref.test`
 * on the nominal struct, and a helper that reads its one field. `mode 2` is the
 * `__date_format_string` selector for §21.4.4.41's format (the identical call
 * `d.toString()` compiles to), so the two spellings cannot drift — they are one
 * formatter.
 *
 * The Invalid-Date sentinel (i64 MIN, the `[[DateValue]]` NaN encoding) renders
 * as the literal `"Invalid Date"`, which is §21.4.4.41.4 ToDateString step 3 and
 * what the static path already answers.
 *
 * ## Demand gate
 *
 * `ctx.structMap.get("__Date") === undefined` ⇒ the module never constructed a
 * Date ⇒ nothing is minted and the terminal is untouched. That gate is exact,
 * not heuristic: the struct type is registered by `ensureDateStruct`, which only
 * a real Date construction (or a Date method call) reaches. Native strings are
 * likewise required — the formatter builds a `$NativeString`.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureDateFormatStringHelper } from "./expressions/builtins.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
// Imported from the leaf module, not the `native-strings.js` re-export: this
// helper is called FROM `native-strings.ts`, and taking the re-export would add
// a needless cycle edge back into its own module graph.
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { addFuncType } from "./registry/types.js";

/** §21.4.1.15 — the `[[DateValue]]` encoding of an Invalid Date. */
const INVALID_DATE_SENTINEL = -9223372036854775808n;
/** `__date_format_string` mode selector for §21.4.4.41 `toString`. */
const DATE_FORMAT_MODE_TO_STRING = 2;

/**
 * Mint (idempotently) `__date_any_to_string(anyref) -> ref $AnyString`, or
 * return `undefined` when this module has no Date struct / no native strings.
 *
 * The caller must have already established that the argument IS a `__Date` —
 * the body casts unconditionally, exactly like `__error_to_string`'s contract
 * with its own `ref.test` guard.
 */
export function ensureDateAnyToStringHelper(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get("__date_any_to_string");
  if (existing !== undefined) return existing;
  const dateTypeIdx = ctx.structMap.get("__Date");
  if (dateTypeIdx === undefined) return undefined;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return undefined;

  const fmtIdx = ensureDateFormatStringHelper(ctx);
  if (fmtIdx === undefined) return undefined;

  const strRef: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  const L_TS = 1;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: dateTypeIdx },
    { op: "struct.get", typeIdx: dateTypeIdx, fieldIdx: 0 },
    { op: "local.tee", index: L_TS },
    { op: "i64.const", value: INVALID_DATE_SENTINEL },
    { op: "i64.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: nativeStringLiteralInstrs(ctx, "Invalid Date"),
      else: [
        { op: "local.get", index: L_TS },
        { op: "i32.const", value: DATE_FORMAT_MODE_TO_STRING },
        { op: "call", funcIdx: fmtIdx },
      ],
    },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "anyref" }], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__date_any_to_string",
    typeIdx,
    locals: [{ name: "ts", type: { kind: "i64" } }],
    body,
    exported: false,
  });
  ctx.funcMap.set("__date_any_to_string", funcIdx);
  return funcIdx;
}
