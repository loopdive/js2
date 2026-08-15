// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4439) Native bodies for the reflective `String.prototype.match` /
 * `String.prototype.search` closures in `--target standalone`.
 *
 * The DIRECT call path (`"abc".match(/b/)`, `"abc".search(/b/)`) has been
 * native since #1539/#4016. What was missing is the **borrowed / transferred**
 * form the ES5 sputnik battery uses almost exclusively:
 *
 * ```js
 * var o = new Object(true);
 * o.search = String.prototype.search;
 * o.search(true);                      // → 0  ("true".search(/true/))
 *
 * Number.prototype.match = String.prototype.match;
 * (10203040506070809000).match(/0./)[0];   // → "02"
 * ```
 *
 * Those reach the `native-proto.ts` closure factory, whose String glue
 * (`array-object-proto.ts`) had no `match`/`search` arm — so the member fell
 * through to `emitProtoMemberBodyRefusal` and threw
 * `String.prototype.<m> is not yet implemented in --target standalone`.
 *
 * This module supplies the missing arms. It is `string-proto-split.ts`'s
 * sibling in every structural respect (reflective closure ABI, its own module
 * so the dispatcher stays a dispatcher and the LOC/function budget gates keep
 * growth cohesive) and differs in exactly one place: **it does NOT stop at
 * `ToString(searchValue)`.**
 *
 * ## Why the RegExp lane is reachable here and was not for `split`
 *
 * `string-proto-split.ts` documents a deliberate carve-out: a reflective
 * closure receives its separator as a runtime `externref`, "so there is no
 * static pattern to compile and no runtime interpreter to fall back on."
 * That is only half true, and the other half is what this module uses:
 *
 *   1. A backend-created RegExp **is** a runtime value with a concrete WasmGC
 *      shape — the `$NativeRegExp` struct. `ref.test` recovers it from the
 *      opaque `externref` with no static provenance at all (the same recovery
 *      `recoverRegExpStructFromExternref` does for `RegExp.prototype.test.call`).
 *   2. For everything else there **is** a runtime compiler:
 *      `__regex_compile_dynamic_simple` (#2161), which is exactly what the
 *      direct-path `RegExpCreate(ToString(v), "")` arm of `string-search-value.ts`
 *      already calls.
 *
 * So the argument dispatch is a two-lane runtime branch, not a compile-time
 * decision — that is the whole design of this module:
 *
 * ```
 * ref.test $NativeRegExp(arg) ? arg                       // a real RegExp
 *                             : __regex_compile_dynamic_simple(P, "")
 *                                 where P = undefined(arg) ? "" : ToString(arg)
 * ```
 *
 * `split` keeps its ToString-only behaviour because §22.1.3.23 has no
 * RegExpCreate step; `match`/`search` have one (§22.1.3.14 step 3 /
 * §22.1.3.17 step 3), which is what makes the second lane spec-correct rather
 * than a widening.
 *
 * ## Result shapes
 *
 * `search` → the match index or `-1`, boxed as a Number (`__box_number`), via
 * the shared `__regex_search` sequence (`emitRegexSearchCall`) — the same
 * helper `.test` and the direct `search` use.
 *
 * `match` → `null` on a miss, else the `exec`-shaped `$__regexp_match_vec`
 * (element 0 + captures, with the `index`/`input`/`groups` own properties
 * `emitRegexExecArrayCall` defines on it), boxed to `externref`. The `g` flag
 * is only known at RUNTIME here, so the global all-matches walk
 * (`__regex_match_all`) is selected by a runtime test on the struct's flags
 * field rather than the static `staticRegExpFlags` the direct path uses. Both
 * arms yield `ref null $__regexp_match_vec`, so they share one block type.
 * Emitting only the exec arm would have been a SILENT WRONG ANSWER for a
 * borrowed `match` with a `/…/g` argument, which this project rates worse than
 * a refusal.
 *
 * ## Known deviations (shared with the sibling reflective bodies)
 *
 * - An explicit `null` argument is treated as an ABSENT one (empty pattern),
 *   not as `ToString(null) === "null"`. The reflective closure ABI pads an
 *   omitted trailing argument with `ref.null.extern`, and the #2106 regime's
 *   `__extern_is_undefined` answers true for both spellings, so the two are
 *   indistinguishable inside the closure. `string-proto-split.ts` carries the
 *   identical conflation.
 * - An arbitrary object carrying a custom `@@match`/`@@search` method is
 *   `ToString`'d rather than dispatched to that method (§22.1.3.14/.17 step 2).
 *   Same gap the whole reflective String family has.
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  flatStringType,
  nativeStringLiteralInstrs,
} from "./native-strings.js";
import { ensureRegexMatchAll, ensureRegexMatchVecType, regexI32ArrayType } from "./native-regex.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { RE_FLAG_G } from "./regex/bytecode.js";
import {
  RE_FIELD_CLASS_TABLE,
  RE_FIELD_FLAGS,
  RE_FIELD_LASTINDEX,
  RE_FIELD_NGROUPS,
  RE_FIELD_NSCRATCH,
  RE_FIELD_PROG,
  emitRegexExecArrayCall,
  emitRegexSearchCall,
  ensureDynamicStandaloneRegExpCompiler,
  ensureStandaloneRegExpStruct,
  usesNativeRegExpProvider,
} from "./regexp-standalone.js";
import { ensureLateImport } from "./expressions/late-imports.js";
import { flushLateImportShifts } from "./shared.js";
import { emitStringProtoToStringFlat } from "./string-proto-tostring.js";
import { ensureVecConstructorCarrier } from "./vec-constructor-carrier.js";

/**
 * Push `1` when the closure param at `paramIdx` holds `undefined`.
 *
 * Mirrors `string-proto-split.ts`'s private helper: the reflective ABI pads an
 * omitted trailing argument with `ref.null.extern`, while the #2106 standalone
 * regime represents a written `undefined` as a DISTINCT non-null sentinel
 * externref, so both spellings must be recognized or `s.match()` would compile
 * the pattern `"undefined"` instead of the empty one.
 */
function pushIsUndefined(ctx: CodegenContext, sink: Instr[], paramIdx: number): void {
  sink.push({ op: "local.get", index: paramIdx }, { op: "ref.is_null" });
  const isUndefIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefIdx !== undefined) {
    sink.push({ op: "local.get", index: paramIdx }, { op: "call", funcIdx: isUndefIdx }, { op: "i32.or" });
  }
}

/**
 * §22.1.3.14 / §22.1.3.17 step 1 — `? RequireObjectCoercible(this)`: throw a
 * *catchable* TypeError (never a `ref.cast` trap) when `this` is null or
 * undefined.
 */
function emitRequireObjectCoercible(ctx: CodegenContext, fctx: FunctionContext, member: string): void {
  const rocThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, rocThrow, `String.prototype.${member} called on null or undefined`);
  pushIsUndefined(ctx, fctx.body, 1);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rocThrow });
}

/**
 * Leave a non-null `$NativeRegExp` on the stack for the closure's argument slot
 * (param 2), choosing between the two lanes at RUNTIME — see the module header.
 *
 * Every temporary instruction buffer is registered in `fctx.savedBodies` before
 * anything is emitted into it. That is load-bearing, not tidiness: an
 * `ensureLateImport` flush occurring while `fctx.body` points at one buffer
 * walks `fctx.body` + `fctx.savedBodies`, and a buffer reachable from neither
 * would keep pre-shift `funcIdx`s and call the wrong function.
 */
function emitRegExpOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  structTypeIdx: number,
  dynCompilerIdx: number,
  anyToStrIdx: number,
  flattenIdx: number,
): void {
  const outer = fctx.body;
  fctx.savedBodies.push(outer);

  // Lane A — the argument already IS a backend-created RegExp.
  const regexpArm: Instr[] = [
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: structTypeIdx },
  ];
  fctx.savedBodies.push(regexpArm);

  // Lane B — RegExpCreate(P, "") where P is "" for an absent/undefined
  // argument (RegExpInitialize step 1) and `ToString(arg)` otherwise.
  const createArm: Instr[] = [];
  const toStringArm: Instr[] = [];
  fctx.savedBodies.push(createArm, toStringArm);

  fctx.body = toStringArm;
  emitStringProtoToStringFlat(ctx, fctx, 2, anyToStrIdx, flattenIdx);

  fctx.body = createArm;
  pushIsUndefined(ctx, fctx.body, 2);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: flatStringType(ctx) },
    then: [...nativeStringLiteralInstrs(ctx, "")],
    else: toStringArm,
  });
  for (const instr of nativeStringLiteralInstrs(ctx, "")) fctx.body.push(instr); // flags
  fctx.body.push({ op: "call", funcIdx: dynCompilerIdx });

  fctx.body = outer;
  fctx.body.push(
    { op: "local.get", index: 2 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: structTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: structTypeIdx } },
      then: regexpArm,
      else: createArm,
    },
  );
}

/**
 * Native body for a reflective `String.prototype.match(regexp)` /
 * `String.prototype.search(regexp)` closure. Closure ABI: `this` = param 1,
 * the search value = param 2 (both spec arity 1, so one arg slot).
 *
 * Spec order (observable — the receiver's `toString` runs before the
 * argument's, and the sputnik battery's boxed-primitive receivers exercise
 * exactly that):
 *
 *   1. `? RequireObjectCoercible(this)`
 *   3. `S = ? ToString(this)`
 *   4. `rx = ? RegExpCreate(searchValue, undefined)` — or the value itself
 *      when it already carries the native RegExp brand
 *   5. the `@@search` / `@@match` core
 *
 * Returns `externref` (the uniform closure result). `null` here means "no
 * native body" and the caller falls through to its refusal, exactly as for the
 * `split` / `concat` / `replace` siblings.
 */
export function emitStringMatchSearchMemberBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: "match" | "search",
): ValType | null {
  // Host lane and any build without the standalone engine keep the refusal:
  // there `String.prototype.match` is served by the host bridge.
  if (!usesNativeRegExpProvider(ctx) || !ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;

  // (1) Every late-import / type / helper registration happens FIRST and is
  // settled by ONE flush, so each funcIdx fetched BY NAME below is
  // post-shift-correct. This is the discipline every sibling reflective body
  // follows (see `emitStringSplitMemberBody`).
  ensureNativeStringHelpers(ctx);
  ensureObjectRuntime(ctx); // registers `__extern_is_undefined`
  // The result of `match` reaches the caller as an `externref`, so every
  // property read on it goes through the dynamic `__extern_get` native. Demand
  // the runtime `.constructor` carrier for the same reason `split` does.
  if (member === "match") {
    ensureVecConstructorCarrier(ctx);
    ensureRegexMatchVecType(ctx);
    ensureRegexMatchAll(ctx);
  }
  const structTypeIdx = ensureStandaloneRegExpStruct(ctx);
  const dynCompilerMinted = ensureDynamicStandaloneRegExpCompiler(ctx);
  flushLateImportShifts(ctx, fctx);

  // (2) Helper funcIdxs, after the shifts.
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const dynCompilerIdx = ctx.nativeRegexHelpers.get("__regex_compile_dynamic_simple") ?? dynCompilerMinted;
  if (flattenIdx === undefined) return null; // caller falls through to its refusal

  // Step 1.
  emitRequireObjectCoercible(ctx, fctx, member);

  // Step 3: S = ? ToString(this), flattened. Kept as the FLAT struct so the
  // global-match arm can read data/off/len directly; `emitRegexSearchCall`
  // re-flattens (a no-op on an already-flat string) through its input override.
  emitStringProtoToStringFlat(ctx, fctx, 1, anyToStrIdx, flattenIdx);
  const subjLocal = allocLocal(fctx, `__ms_subj_${fctx.locals.length}`, flatStringType(ctx));
  fctx.body.push({ op: "local.set", index: subjLocal });
  const inputOverride = (): ValType => {
    fctx.body.push({ op: "local.get", index: subjLocal });
    return flatStringType(ctx);
  };

  // Step 4: rx.
  emitRegExpOperand(ctx, fctx, structTypeIdx, dynCompilerIdx, anyToStrIdx, flattenIdx);
  const reLocal = allocLocal(fctx, `__ms_re_${fctx.locals.length}`, { kind: "ref", typeIdx: structTypeIdx });
  fctx.body.push({ op: "local.set", index: reLocal });
  const regexpOverride = { regexpLocal: reLocal, structTypeIdx };

  if (member === "search") return emitSearchResult(ctx, fctx, regexpOverride, inputOverride);
  return emitMatchResult(ctx, fctx, subjLocal, regexpOverride, inputOverride);
}

/**
 * §22.2.6.13 `RegExp.prototype[@@search]` — the match start or `-1`, boxed as a
 * Number. `search` ignores the `g` flag and never advances `lastIndex`, so the
 * shared `__regex_search` sequence is used with its default start-at-0.
 *
 * `__box_number` is resolved AFTER the search sequence: that sequence may add
 * its own late imports, and in the standalone regime `__box_number` can be a
 * DEFINED function (`addUnionImportsAsNativeFuncs`) whose index moves with an
 * import batch — so a funcIdx captured before it would be stale.
 */
function emitSearchResult(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexpOverride: { regexpLocal: number; structTypeIdx: number },
  inputOverride: () => ValType,
): ValType | null {
  const emitted = emitRegexSearchCall(ctx, fctx, null, null, { regexpOverride, inputOverride });
  if (emitted === null) return null;
  const i32Arr = regexI32ArrayType(ctx);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "f64" } },
    then: [
      { op: "local.get", index: emitted.capsLocal },
      { op: "i32.const", value: 0 },
      { op: "array.get", typeIdx: i32Arr },
      { op: "f64.convert_i32_s" },
    ],
    else: [{ op: "f64.const", value: -1 }],
  });
  const idxLocal = allocLocal(fctx, `__ms_idx_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: idxLocal });

  const minted = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const boxIdx = ctx.funcMap.get("__box_number") ?? minted;
  if (boxIdx === undefined) return null;
  fctx.body.push({ op: "local.get", index: idxLocal }, { op: "call", funcIdx: boxIdx });
  return { kind: "externref" };
}

/**
 * §22.2.6.8 `RegExp.prototype[@@match]` with the `g` flag resolved at RUNTIME.
 *
 * Global: `__regex_match_all` collects every `[0]` substring and `lastIndex`
 * ends at 0 (the net spec effect of the exec loop). Non-global (incl. sticky):
 * the shared `exec` path. Both arms produce `ref null $__regexp_match_vec`, so
 * one `extern.convert_any` boxes either — and a miss (`ref.null`) becomes a
 * null externref, which the standalone value model reads as `null`.
 */
function emitMatchResult(
  ctx: CodegenContext,
  fctx: FunctionContext,
  subjLocal: number,
  regexpOverride: { regexpLocal: number; structTypeIdx: number },
  inputOverride: () => ValType,
): ValType | null {
  const { regexpLocal, structTypeIdx } = regexpOverride;
  const matchVecTypeIdx = ensureRegexMatchVecType(ctx);
  const matchAllIdx = ensureRegexMatchAll(ctx);
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const resultType: ValType = { kind: "ref_null", typeIdx: matchVecTypeIdx };

  const outer = fctx.body;
  fctx.savedBodies.push(outer);
  const globalArm: Instr[] = [];
  const execArm: Instr[] = [];
  fctx.savedBodies.push(globalArm, execArm);

  fctx.body = globalArm;
  const allLocal = allocLocal(fctx, `__ms_all_${fctx.locals.length}`, resultType);
  fctx.body.push(
    { op: "local.get", index: regexpLocal },
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG },
    { op: "local.get", index: regexpLocal },
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_CLASS_TABLE },
    { op: "local.get", index: regexpLocal },
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NGROUPS },
    { op: "local.get", index: subjLocal },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
    { op: "local.get", index: subjLocal },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
    { op: "local.get", index: subjLocal },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
    { op: "local.get", index: subjLocal },
    { op: "local.get", index: regexpLocal },
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_NSCRATCH },
    { op: "call", funcIdx: matchAllIdx },
    { op: "local.set", index: allLocal },
    // lastIndex = 0 — the net effect of the spec's exec loop on a global regex.
    { op: "local.get", index: regexpLocal },
    { op: "f64.const", value: 0 },
    { op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX },
    { op: "local.get", index: allLocal },
  );

  fctx.body = execArm;
  const exec = emitRegexExecArrayCall(ctx, fctx, null, null, {
    gyLastIndex: "runtime",
    regexpOverride,
    inputOverride,
  });

  fctx.body = outer;
  if (exec === null) return null;
  fctx.body.push(
    { op: "local.get", index: regexpLocal },
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_FLAGS },
    { op: "i32.const", value: RE_FLAG_G },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "val", type: resultType }, then: globalArm, else: execArm },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" };
}
