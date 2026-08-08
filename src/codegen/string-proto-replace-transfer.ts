// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4232) Native body for a reflective `String.prototype.replace` closure in
 * `--target standalone` — the arm #4224 named as its own leftover.
 *
 * #4224 made the DIRECT call path (`"abc".replace(…)`) handle function
 * replacers and non-string replacement values. What it could not reach is the
 * **transferred** form the ES5 sputnik battery uses:
 *
 * ```js
 * var __instance = new Object(true);
 * __instance.replace = String.prototype.replace;
 * __instance.replace(true, 1);   // → "1"
 * ```
 *
 * That goes through the `native-proto.ts` closure factory, whose String glue
 * (`array-object-proto.ts`) had no `replace` arm, so the member fell through to
 * `emitProtoMemberBodyRefusal`. This module supplies it, following
 * `string-proto-split.ts` (#4220) step for step — same closure ABI, same
 * "late-import adders first, then capture funcIdxs by name" discipline, same
 * decision to live in its own module so the dispatcher stays a dispatcher.
 *
 * ## §22.1.3.19 as emitted
 *
 *   1. `? RequireObjectCoercible(this)`
 *   3. `string = ? ToString(this)`
 *   4. `searchString = ? ToString(searchValue)`
 *   6. `replaceValue = ? ToString(replaceValue)`
 *   8. `position = StringIndexOf(string, searchString, 0)`
 *   9. `position = -1` ⇒ return `string` unchanged
 *  10–12. `preceding + GetSubstitution(…) + following`
 *
 * Step 11 reuses `__regex_get_substitution` (#1913) rather than concatenating
 * the replacement literally: `$$`, `$&`, `` $` `` and `$'` are live on the
 * STRING-search path too (§22.1.3.19 step 11 calls the same GetSubstitution the
 * RegExp path does). Group 0 is the whole match, so the caps array is exactly
 * `[position, position + searchLength]` and `nGroups` is 1; `$1` and above are
 * out of range and pass through literally, which is what the spec asks for.
 *
 * ## Deliberately NOT handled
 *
 * - **A callable `replaceValue`.** §22.1.3.19 step 5 would call it per match,
 *   but a reflective closure receives it as a runtime `externref` and this body
 *   has no way to marshal a dynamic call from inside a leaf native. It takes
 *   the `IsCallable` false branch unconditionally, i.e. ToString. Same shape as
 *   the RegExp-separator gap `string-proto-split.ts` records for `split`.
 * - **A RegExp `searchValue`.** §22.1.3.19 step 2 dispatches to
 *   `searchValue[@@replace]`; the standalone engine compiles patterns at
 *   COMPILE time from a statically known literal, which a runtime `externref`
 *   is not. It flows into ToString(searchValue) here — the pre-existing
 *   behaviour of every other reflective String member with a search-value
 *   argument.
 *
 * Both gaps are pre-existing (the member threw outright before), so neither is
 * a regression; they are the reason this arm is worth +2 test262 files rather
 * than the whole `replace` directory.
 */

import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureRegexGetSubstitution, regexI32ArrayType } from "./native-regex.js";
import { ensureAnyToStringHelper, ensureNativeStringHelpers, flatStringType } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { emitStringProtoToStringFlat } from "./string-proto-tostring.js";

/**
 * Native body for a reflective `String.prototype.replace(searchValue,
 * replaceValue)` closure. Closure ABI: `this` = param 1, searchValue = param 2,
 * replaceValue = param 3 (spec arity 2, so both arg slots exist).
 *
 * Returns `externref`; `null` when a prerequisite native is missing, in which
 * case the caller keeps its refusal body.
 */
export function emitStringReplaceMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  emitRequireObjectCoercible: () => void,
): ValType | null {
  ensureNativeStringHelpers(ctx);
  ensureObjectRuntime(ctx);
  if (ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0) return null;

  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf");
  const substringIdx = ctx.nativeStrHelpers.get("__str_substring");
  const concatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (
    anyToStrIdx === undefined ||
    flattenIdx === undefined ||
    indexOfIdx === undefined ||
    substringIdx === undefined ||
    concatIdx === undefined
  ) {
    return null;
  }
  // `__regex_get_substitution` throws rather than declining when its own
  // prerequisites are absent, so it is demanded only after they are proven
  // present above.
  const getSubIdx = ensureRegexGetSubstitution(ctx);
  const i32Arr = regexI32ArrayType(ctx);
  const anyStr = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStr };

  // Step 1.
  emitRequireObjectCoercible();

  // Steps 3/4/6 — all three ToStrings, in spec order, each flattened. The
  // ORDER is observable: a `searchValue` whose `toString` throws must do so
  // before the `replaceValue`'s runs.
  const sLocal = allocLocal(fctx, `__repl_s_${fctx.locals.length}`, flatStringType(ctx));
  emitStringProtoToStringFlat(ctx, fctx, 1, anyToStrIdx, flattenIdx);
  fctx.body.push({ op: "local.set", index: sLocal });

  const needleLocal = allocLocal(fctx, `__repl_n_${fctx.locals.length}`, flatStringType(ctx));
  emitStringProtoToStringFlat(ctx, fctx, 2, anyToStrIdx, flattenIdx);
  fctx.body.push({ op: "local.set", index: needleLocal });

  const replLocal = allocLocal(fctx, `__repl_r_${fctx.locals.length}`, flatStringType(ctx));
  emitStringProtoToStringFlat(ctx, fctx, 3, anyToStrIdx, flattenIdx);
  fctx.body.push({ op: "local.set", index: replLocal });

  // Step 8.
  const posLocal = allocLocal(fctx, `__repl_pos_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(
    { op: "local.get", index: sLocal },
    { op: "local.get", index: needleLocal },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: indexOfIdx },
    { op: "local.set", index: posLocal },
  );

  const endLocal = allocLocal(fctx, `__repl_end_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(
    { op: "local.get", index: posLocal },
    { op: "local.get", index: needleLocal },
    { op: "struct.get", typeIdx: anyStr, fieldIdx: 0 },
    { op: "i32.add" },
    { op: "local.set", index: endLocal },
  );

  // Steps 10–12. Group 0 spans the match, so caps = [position, position+len].
  const replaced: Instr[] = [
    // preceding = substring(string, 0, position)
    { op: "local.get", index: sLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: posLocal },
    { op: "call", funcIdx: substringIdx },
    // ++ GetSubstitution(string, len, 1, caps, replacement, «»)
    { op: "local.get", index: sLocal },
    { op: "local.get", index: sLocal },
    { op: "struct.get", typeIdx: anyStr, fieldIdx: 0 },
    { op: "i32.const", value: 1 },
    { op: "local.get", index: posLocal },
    { op: "local.get", index: endLocal },
    { op: "array.new_fixed", typeIdx: i32Arr, length: 2 },
    { op: "local.get", index: replLocal },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: i32Arr },
    { op: "call", funcIdx: getSubIdx },
    { op: "call", funcIdx: concatIdx },
    // ++ following = substring(string, position + searchLength, len)
    { op: "local.get", index: sLocal },
    { op: "local.get", index: endLocal },
    { op: "local.get", index: sLocal },
    { op: "struct.get", typeIdx: anyStr, fieldIdx: 0 },
    { op: "call", funcIdx: substringIdx },
    { op: "call", funcIdx: concatIdx },
  ];

  // Step 9 — no match returns the subject itself, NOT a copy: §22.1.3.19 says
  // "return string", and the identity matters for `s.replace(x, y) === s`.
  fctx.body.push(
    { op: "local.get", index: posLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [{ op: "local.get", index: sLocal }],
      else: replaced,
    },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" };
}
