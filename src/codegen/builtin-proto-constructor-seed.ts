// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T9) `<Builtin>.prototype.constructor` as an entry in the #2175
 * COMPANION — the own-property table a materialized builtin prototype answers
 * reflective queries from.
 *
 * ## What was missing, and what was NOT
 *
 * #4200 gave `constructor` its own arm for the two consumers that resolve a
 * builtin proto SYNTACTICALLY: the value read `<B>.prototype.constructor` and
 * the #2885 Site-2 gOPD synthesis on a literal `<B>.prototype` receiver. Both
 * work. Measured on this tree, standalone:
 *
 * ```js
 * Object.getOwnPropertyDescriptor(Error.prototype, "constructor")  // an object
 * var P = Error.prototype;
 * Object.getOwnPropertyDescriptor(P, "constructor")                // undefined
 * P.hasOwnProperty("constructor")                                  // true
 * ```
 *
 * The third consumer is the one `propertyHelper.js` uses: `verifyProperty`
 * takes the prototype through an ANY-typed harness parameter, so the receiver
 * arrives as a materialized `$NativeProto` value and every query routes to the
 * companion. `constructor` was never installed there, so the descriptor read
 * `undefined` while `hasOwnProperty` — which `native-proto-own-props.ts`
 * answers from the SPEC, unconditionally — said `true`. A property that is own
 * but has no descriptor is exactly what `verifyProperty` reports as
 * "constructor descriptor value should be …".
 *
 * ## Why `constructor` is not simply added to `memberCsv` (checked, load-bearing)
 *
 * `native-proto.ts` says "constructors have their own carrier and are not part
 * of `memberCsv`", and #4200's header says why in full: the glue CSVs drive a
 * shared consumer that mints a brand-keyed **method closure** per member, so
 * `Error.prototype.constructor` would become a callable refusal stub rather
 * than the constructor object — and `gOPD(p,"constructor").value ===
 * p.constructor` is an assertion in the corpus. The exclusion stays. This module
 * seeds the companion with the SAME carrier #4200 resolves, so the third
 * consumer agrees with the other two by construction rather than by luck.
 *
 * ## Which prototypes get one
 *
 * Exactly those with an identity-stable carrier
 * ({@link hasBuiltinProtoConstructorCarrier}): the #3006 `__builtin_ctor_<N>`
 * set (Set, Map, Weak*, RegExp, Number, String, Boolean, …) and the #2907
 * `__builtin_<N>` namespaces (Object, Array, Math, JSON, Reflect, the Error
 * family). `Date` and `Function` still DECLINE — they have no carrier, and
 * minting one changes what the BARE identifier reads, which #4200 deliberately
 * left to a follow-up that can measure that change on its own. So
 * `getOwnPropertyDescriptor/15.2.3.3-4-{34,116}` (Function.prototype /
 * Date.prototype) are NOT addressed here; they remain #4200 follow-ups.
 *
 * ## Attributes
 *
 * §17: `{writable: true, enumerable: false, configurable: true}` — the same
 * `__defineProperty_value` flag word the seeder already uses for a proto METHOD
 * (`PROTO_METHOD_DEFINE_FLAGS`), which is the same rule, so the constant is
 * passed in by the caller rather than re-derived here.
 */
import type { ValType } from "../ir/types.js";
import { emitBuiltinProtoConstructorValue, hasBuiltinProtoConstructorCarrier } from "./builtin-proto-constructor.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { coerceType, flushLateImportShifts } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };

/**
 * Push `__defineProperty_value(companion, "constructor", <carrier>, flags)` into
 * `seedFctx`, for the companion `$Object` held in param 0.
 *
 * Returns `false` having pushed NOTHING when `builtinName` has no carrier — the
 * same "a decline leaves no partial instructions" contract #4200's `tryEmit*`
 * keeps, which is what lets the caller gate without a rollback.
 *
 * `__defineProperty_value` is re-resolved from `funcMap` AFTER the carrier is
 * emitted, and the late-import shifts are flushed first: materializing a carrier
 * runs `emitBuiltinConstructorIdentity` / `emitBuiltinNamespaceObject`, either of
 * which may register a late import, and that shifts every DEFINED func index —
 * including the one the caller captured before the member loop (#329/#1899).
 */
export function pushCompanionConstructorSeed(
  ctx: CodegenContext,
  seedFctx: FunctionContext,
  builtinName: string,
  defineFlags: number,
): boolean {
  if (!hasBuiltinProtoConstructorCarrier(builtinName)) return false;

  const body = seedFctx.body;
  body.push({ op: "local.get", index: 0 });
  addStringConstantGlobal(ctx, "constructor");
  for (const instr of stringConstantExternrefInstrs(ctx, "constructor")) body.push(instr);

  const valueType = emitBuiltinProtoConstructorValue(ctx, seedFctx, builtinName);
  if (valueType === null) {
    // Unreachable: the carrier predicate above is the exact gate for a non-null
    // return. Kept as an assertion rather than a silent partial push.
    body.length = body.length - 1 - stringConstantExternrefInstrs(ctx, "constructor").length;
    return false;
  }
  if (valueType.kind !== "externref") coerceType(ctx, seedFctx, valueType, EXTERNREF);

  flushLateImportShifts(ctx, seedFctx);
  const defineValueIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineValueIdx === undefined) return false;

  seedFctx.body.push({ op: "f64.const", value: defineFlags });
  seedFctx.body.push({ op: "call", funcIdx: defineValueIdx });
  seedFctx.body.push({ op: "drop" }); // the helper returns the target
  return true;
}
