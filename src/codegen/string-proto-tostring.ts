// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3992) The shared `? ToString(x)` lowering for reflective
 * `String.prototype.<member>` closure bodies, plus the table of no-argument
 * string-returning members that share one body.
 *
 * Both live here rather than in the `array-object-proto` dispatcher for the
 * same reason `char-at-transfer.ts` and `string-proto-substring.ts` do: the
 * dispatcher should stay a dispatcher, and this is the one rule those bodies
 * kept re-deriving.
 */
import type { Instr } from "../ir/types.js";
import { runtimeToPrimitiveInstrs } from "./coercion-engine.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { ensureStandaloneRegExpToStringDyn, standaloneRegExpStructTypeIdx } from "./regexp-standalone.js";

/**
 * The reflective `String.prototype` members that take NO arguments and return a
 * STRING, mapped to the standalone-native helper implementing them — the SAME
 * helpers the direct `"x".trim()` / `"x".toLowerCase()` path uses in
 * `string-ops.ts`.
 *
 * (#1470) `toLocale{Lower,Upper}Case` fold onto the non-locale helpers: absent
 * ECMA-402, §22.1.3.{27,29} are defined to match `to{Lower,Upper}Case` except
 * for locale-sensitive mappings, and a standalone module carries no ICU tables.
 * The direct path already makes exactly this substitution, so routing the
 * reflective body to the same helper keeps the two paths in agreement rather
 * than inventing a second answer.
 */
export const NO_ARG_STRING_MEMBER_HELPER: Readonly<Record<string, string>> = {
  trim: "__str_trim",
  trimStart: "__str_trimStart",
  trimEnd: "__str_trimEnd",
  toLowerCase: "__str_toLowerCase",
  toUpperCase: "__str_toUpperCase",
  toLocaleLowerCase: "__str_toLowerCase",
  toLocaleUpperCase: "__str_toUpperCase",
};

// (#2742) SUPERSEDED-WIRING CARVE-OUT. For these five members the #2875
// reflective body is strictly worse than the legacy borrowed-receiver path it
// intercepts, so refuse here and let the caller fall through.
//
// Why this is a carve-out and NOT "remove the wiring": #2875 was written when
// legacy `.call` dropped `thisArg`; #3254 later fixed that with a
// `receiverOverride` covering `STANDALONE_STR_PROTO_METHODS`. But #2875 also
// carries semantics legacy never had — `emitStringRequireObjectCoercible` —
// so the wiring is superseded for SOME members and still load-bearing for
// others. Measured, blanket removal costs 13 `this-value-not-obj-coercible`
// and `trimStart`/`trimEnd` files; this per-member set costs zero.
//
// Test262 A/B (450 files, same box/run/list, both arms one tree; rows floored
// 450/450, zero timeouts): **+18 fail→pass, 0 pass→fail**, the 13 files that a
// blanket removal regresses all HELD, `substring`/`charAt` control unmoved,
// and zero off-target moves. Full ledger + the two rejected variants are in
// plan/issues/2742-string-prototype-generic-receiver-tostring-this-coercion.md.
//
// Deliberately EXCLUDED (their wired bodies still win — do not "simplify"
// this set without re-running the A/B): `charCodeAt`, `indexOf`,
// `lastIndexOf`, `trimStart`, `trimEnd`, `at`, `substring`, `charAt`.
//
// (ES5 standalone lane, 2026-08-19) `trim` REMOVED from the set. Its wired
// body is `? RequireObjectCoercible(this)` → `? ToString(this)` →
// `__str_trim`, where ToString runs the runtime `__to_primitive`; the legacy
// borrowed path it was deferring to stringifies the receiver STRUCTURALLY.
// So `String.prototype.trim.call(child)` answered `"[object Object]"` for a
// receiver whose `toString` is INHERITED from its constructor's prototype,
// while every sibling with a real body (`slice`/`substring`/`charAt`/
// `toUpperCase`/`indexOf`, measured on one module) answered `"abc"`. The
// #2742 A/B's finding was that a BLANKET removal costs 13 files; `trim`
// individually is not one of them — re-measured here on the 551-file ES5
// standalone guard, which stays 551/551.
export const SUPERSEDED_BY_BORROWED_PATH: ReadonlySet<string> = new Set([
  "codePointAt",
  "includes",
  "startsWith",
  "endsWith",
]);

/**
 * Emit `flatten(? ToString(param<paramIdx>))`, leaving the flat `$NativeString`
 * on the stack.
 *
 * §22.1.3 says `ToString(thisValue)`, and ToString of an OBJECT is
 * `ToPrimitive(input, string)` first — that is what consults `toString` /
 * `valueOf` (§7.1.1 OrdinaryToPrimitive). The generic reflective bodies used to
 * skip straight to `$__any_to_string`, which stringifies an object receiver
 * structurally: `new Object(true)` came out as `"[object Object]"`, and a user
 * `toString` was never called at all.
 *
 * That was invisible until #3992 fixed the transferred-method dispatch, because
 * every such call previously answered `null` before reaching a body. The two
 * members that DID work (`charAt`, `substring`) are exactly the two whose
 * bespoke bodies already did the ToPrimitive step — so this was the third and
 * fourth spelling of one rule.
 *
 * When `__to_primitive` is unavailable (host/gc lowering) the previous
 * byte-identical sequence is emitted instead, so non-standalone output is
 * unchanged.
 */
export function emitStringProtoToStringFlat(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramIdx: number,
  anyToStrIdx: number,
  flattenIdx: number,
): void {
  // §7.1.17 step 1: ToString of a SYMBOL throws — unlike the deliberately
  // printable `$__any_to_string` fallback, and ToPrimitive passes a Symbol
  // through unchanged (it is already primitive). Guarding HERE covers every
  // caller at once: the no-arg receiver bodies (`toLowerCase.call(Symbol())`)
  // and the search family's `ToString(searchString)` operands alike. Same
  // guard the bespoke `substring` body carries.
  const body: Instr[] = [];
  if (ctx.symbolTypeIdx >= 0) {
    const symbolThrow: Instr[] = [];
    emitBrandCheckTypeError(ctx, symbolThrow, "Cannot convert a Symbol value to a string");
    body.push(
      { op: "local.get", index: paramIdx },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: symbolThrow },
    );
  }
  const toPrimitive = runtimeToPrimitiveInstrs(ctx, "string");
  const generic: Instr[] = [{ op: "local.get", index: paramIdx }];
  if (toPrimitive !== null) generic.push(...toPrimitive);
  generic.push({ op: "any.convert_extern" }, { op: "call", funcIdx: anyToStrIdx }, { op: "call", funcIdx: flattenIdx });
  body.push(...withRegExpReceiverArm(ctx, paramIdx, flattenIdx, generic));
  for (const instr of body) fctx.body.push(instr);
}

/**
 * (#4465) Wrap a generic `ToString(param)` sequence with a runtime
 * `$__StandaloneRegExp` arm.
 *
 * §22.1.3 ToString(thisValue) → ToPrimitive(string) → `RegExp.prototype.toString`
 * (§22.2.6.14) for a RegExp receiver, which is `"/" + source + "/" + flags`. The
 * generic runtime walker (`__to_primitive` → `$__any_to_string`) has no RegExp
 * arm: `__to_primitive` returns the struct unchanged (it is neither `$Object`
 * nor a class instance with a user `toString`) and `$__any_to_string`'s terminal
 * for an unrecognized ref is the literal `"[object Object]"`. So the entire
 * `S15.5.4.1[6789]_A1_T14` family answered `"[object object]"`.
 *
 * The arm is emitted ONLY when the module already carries the standalone RegExp
 * struct AND the runtime renderer could be minted — a module that never mentions
 * RegExp gets the unchanged `generic` sequence, byte for byte. Both branches
 * leave one flat `$NativeString` on the stack, so callers are unaffected.
 */
function withRegExpReceiverArm(ctx: CodegenContext, paramIdx: number, flattenIdx: number, generic: Instr[]): Instr[] {
  const structTypeIdx = standaloneRegExpStructTypeIdx(ctx);
  if (structTypeIdx === undefined) return generic;
  const toStringIdx = ensureStandaloneRegExpToStringDyn(ctx);
  if (toStringIdx === undefined) return generic;
  const flatType = ctx.mod.types[ctx.nativeStrTypeIdx];
  if (flatType === undefined) return generic;
  return [
    { op: "local.get", index: paramIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: structTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: ctx.nativeStrTypeIdx } },
      then: [
        { op: "local.get", index: paramIdx },
        { op: "any.convert_extern" },
        { op: "call", funcIdx: toStringIdx },
        { op: "call", funcIdx: flattenIdx },
      ],
      else: generic,
    },
  ];
}
