// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-5 T7, slice B) The §20.2.2 OWN-property surface of the realm's
 * `%Function%` value under `--target standalone` with the runtime-eval provider
 * linked.
 *
 * ## What was missing
 *
 * `Object` / `Array` / `String` / `RegExp` all answer
 * `hasOwnProperty("prototype")` correctly because a bare read of those
 * identifiers mints the #3006 `__builtin_ctor_*` carrier, a real `$Object`
 * whose own properties `pushBuiltinCtorOwnPropSeed` seeds. A bare `Function`
 * read is the ONE builtin that does not take that route: it is an
 * `intrinsic-value` boundary site, so it resolves through the provider realm
 * and arrives as the canonical `$RuntimeEvalInterpretedCallback` marker with
 * `kind = INTRINSIC_FUNCTION` (`function-intrinsic-carrier.ts`'s header records
 * this as failure mode 1). `Function` is even present in `BUILTIN_CTOR_ARITY`
 * — the seed simply never reaches this value.
 *
 * The marker is a nominal struct, so `__hasOwnProperty` / `__object_hasOwn`
 * `ref.test $Object`, miss, and answer FALSE for every key. Measured on this
 * branch's base with the real `runTest262File` (`--target standalone`, quickjs
 * provider active):
 *
 * | probe                                | base    | spec   |
 * | ------------------------------------ | ------- | ------ |
 * | `Function.hasOwnProperty("prototype")` | `false` | `true` |
 * | `Function.hasOwnProperty("length")`    | `false` | `true` |
 * | `Function.hasOwnProperty("name")`      | `false` | `true` |
 * | `typeof Function.prototype`            | `object`| `object` (already right) |
 *
 * ## Why the marker grows a surface instead of being swapped for the carrier
 *
 * Swapping the bare read to `__builtin_ctor_Function` is the fix #4440 built
 * and rejected twice, for a reason that has not changed: the carrier has no
 * [[Call]] slot, and `var F = Function; F("a", "return a")` must keep working
 * in a provider-linked module — and the value must stay identity-equal to the
 * `%Function%` the provider hands back for an interpreted function's
 * `.constructor`. So the marker keeps its identity and this module answers the
 * three §20.2.2 own properties on it directly.
 *
 * ## Scope — INTRINSIC_FUNCTION only, and `prototype` is the reason
 *
 * The arm fires only for `kind === INTRINSIC_FUNCTION`, i.e. the bare
 * `Function` VALUE. A `kind = GENERIC` marker (the result of `Function(src)`)
 * also owns a `prototype` per §20.2.1.1, but answering `true` there would be a
 * silent lie: no `prototype` OBJECT exists for it to hand back, so
 * `f.hasOwnProperty("prototype")` would be `true` while `f.prototype` stayed
 * `undefined` — two surfaces disagreeing about one value, which is the exact
 * defect class this slice exists to remove. Minting that object needs a mutable
 * slot on a struct type that is STRUCTURALLY shared with the separately
 * compiled provider module, i.e. a cross-module ABI change; it is priced and
 * declined in the issue's T7 plan, not smuggled in here.
 *
 * `name` and `length` for a GENERIC marker are already served (the universal
 * property getter's marker arm in `runtime-eval-callable.ts` reads them out of
 * the marker's own `name`/`length` fields), so this module adds nothing there.
 *
 * ## `delete` ships with visibility, not after it (#4010's ordering law)
 *
 * test262's `isConfigurable` is `delete obj[name]; return !hasOwnProperty(obj,
 * name)`, so a property that becomes VISIBLE without a matching `delete`
 * answer reads as "configurable: true" to every `verifyProperty`. §20.2.2 makes
 * `Function.prototype` `{writable: false, enumerable: false, configurable:
 * false}`, so the honest `delete` answer for that ONE key is `false`, and
 * `built-ins/Function/prototype/S15.3.3.1_A3.js` asserts exactly that
 * (`verifyNotConfigurable` first, then `assert.sameValue(delete
 * Function.prototype, false)`).
 *
 * `length` and `name` are `configurable: true` and are deliberately NOT claimed
 * by the delete arm — there is no store on the marker to record a tombstone in,
 * so a `delete` that answered `true` would leave the key visible and the two
 * surfaces would contradict each other. They keep the pre-existing answer.
 * Stated residual: `delete Function.length` does not remove it. That is a
 * narrower wrong answer than the property being absent outright, and
 * `Object.getOwnPropertyDescriptor(Function, "length")` — which already answers
 * correctly on base (`built-ins/Function/length/15.3.3.2-1.js` passes) — is
 * untouched either way.
 *
 * ## (#4624) The DESCRIPTOR surface, added after the fact
 *
 * The sentence above is true only of the **literal-receiver** fold
 * (`builtin-static-gopd.ts`). Through a dynamic receiver — which is the ONLY
 * kind `propertyHelper.js` has — `gOPD(Function, key)` answered `undefined` for
 * all three keys, because `__getOwnPropertyDescriptor` walks `$Object` and the
 * marker is a nominal struct. So presence said "own" while the descriptor said
 * "absent", and the deprecated verifiers read the descriptor DIRECTLY
 * (`.writable` / `.configurable`), which is what made
 * `built-ins/Function/prototype/S15.3.3.1_A1.js` and `_A3.js` vacuous passes
 * before #4519 and honest failures after it. `spliceIntrinsicFunctionGopd`
 * below closes that; see its doc for the measured table and the value sources.
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers, nativeStringLiteralInstrs } from "./native-strings.js";
import { BUILTIN_CTOR_ARITY } from "./builtin-value-read.js";
import { buildLazyNativeProtoGetInstrs, getBuiltinBrand } from "./native-proto.js";
import {
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A,
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B,
  RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION,
} from "./runtime-eval-boundary.js";

/** §20.2.2 — the own properties of the `%Function%` constructor object. */
const FUNCTION_INTRINSIC_OWN_KEYS = ["prototype", "length", "name"] as const;

/**
 * `__create_descriptor`'s flag word: bit 0 writable, bit 1 enumerable, bit 2
 * configurable. The same encoding `builtin-static-gopd.ts` passes for the
 * SYNTACTIC `gOPD(Function, …)` answer — shared so the two spellings of one
 * property's attributes cannot drift.
 */
const FLAG_CONFIGURABLE = 0x04;

/**
 * The keys whose §20.2.2 attributes make `delete` FAIL, paired with the answer
 * the arm returns. Only `prototype` is `configurable: false`; see the module
 * header for why `length` / `name` are left to the pre-existing body.
 */
const FUNCTION_INTRINSIC_UNDELETABLE_KEYS = ["prototype"] as const;

/**
 * The three natives this module widens, and what its arm answers on a match.
 * `__hasOwnProperty` / `__object_hasOwn` / `__delete_property` all have the
 * shape `(externref obj, externref key) -> i32`, which is what makes one
 * emitter serve all three.
 */
const WIDENED_NATIVES: ReadonlyArray<readonly [string, readonly string[], number]> = [
  ["__hasOwnProperty", FUNCTION_INTRINSIC_OWN_KEYS, 1],
  ["__object_hasOwn", FUNCTION_INTRINSIC_OWN_KEYS, 1],
  ["__delete_property", FUNCTION_INTRINSIC_UNDELETABLE_KEYS, 0],
];

/**
 * Splice the `%Function%` own-key arm onto `__hasOwnProperty`,
 * `__object_hasOwn` and `__delete_property`. All are
 * `(externref obj, externref key) -> i32`.
 *
 * Runs at FINALIZE, next to `fillRuntimeEvalCallablePropertyGetArm`, because
 * the marker type index is only known once a boundary site has minted it.
 * Declines — writing nothing at all — whenever the module has no marker type,
 * no native strings, or no string helpers, so a module that never links the
 * provider is byte-identical.
 */
export function fillRuntimeEvalIntrinsicFunctionOwnProps(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const markerTypeIdx = ctx.runtimeEvalInterpretedCallbackTypeIdx;
  if (markerTypeIdx === undefined) return;
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined) return;

  for (const [name, keys, answer] of WIDENED_NATIVES) {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (!fn) continue;
    unshiftIntrinsicFunctionArm(ctx, fn, markerTypeIdx, flattenIdx, equalsIdx, (keyEquals) => {
      const keyArms: Instr[] = [];
      for (const key of keys) {
        keyArms.push(...keyEquals(key), {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: answer }, { op: "return" }],
        });
      }
      return keyArms;
    });
  }

  // (#4624) …and the descriptor surface for the same three keys.
  spliceIntrinsicFunctionGopd(ctx, markerTypeIdx, flattenIdx, equalsIdx);
}

/**
 * (#4624) `__getOwnPropertyDescriptor(%Function%, key)` — the §20.2.2 data
 * descriptor for `prototype` / `length` / `name` on the intrinsic marker.
 *
 * ## Why the trio above was not enough
 *
 * #4491 T7-B widened presence (`__hasOwnProperty` / `__object_hasOwn`) and
 * `delete`, which is what `propertyHelper.js`'s `isConfigurable` /
 * `isWritable` probes exercise — but the deprecated verifiers ALSO read the
 * descriptor directly (`__getOwnPropertyDescriptor(obj, name).writable`,
 * line 411; `.configurable`, line 457). That native only walks `$Object`, and
 * the marker is a nominal struct, so it answered `undefined`. Measured on this
 * branch's base, `--target standalone`, real `runTest262File`:
 *
 * | shape                                                | base        | spec     |
 * | ---------------------------------------------------- | ----------- | -------- |
 * | `gOPD(Function, "prototype")`, LITERAL receiver       | descriptor  | descriptor |
 * | `gOPD(o, "a")` through a parameter, plain object      | descriptor  | descriptor |
 * | `gOPD(obj, name)` through a parameter, `obj = Function`| **undefined** | descriptor |
 * | `Function.hasOwnProperty("prototype")`                | true        | true     |
 *
 * The third row is the defect: presence said the property exists while the
 * descriptor said it does not. Until #4519 that read `!undefined` as
 * `writable: false` and both `built-ins/Function/prototype/S15.3.3.1_A1.js`
 * and `_A3.js` passed VACUOUSLY; with #4519's member-get guard merged the same
 * read throws and both rows fail honestly. This arm makes them pass for a real
 * reason.
 *
 * ## The values are the SAME ones the syntactic fold answers
 *
 * `prototype`'s value is `buildLazyNativeProtoGetInstrs(Function)` — the
 * identity-stable `$NativeProto` singleton that `builtin-static-gopd.ts` hands
 * the LITERAL-receiver fold, so `gOPD(Function,"prototype").value ===
 * Function.prototype` holds through either path (verified on base for the
 * literal arm before this change). `length` comes from the shared
 * `BUILTIN_CTOR_ARITY` table and `name` is the literal `"Function"` — again the
 * static arm's own sources. A descriptor whose `value` disagreed with the
 * direct read would be worse than no descriptor at all, which is exactly what
 * `verifyNotWritable` cross-checks.
 *
 * ## Attributes (ECMA-262 §20.2.2)
 *
 * - `prototype` — `{w:false, e:false, c:false}` (flag word `0`).
 * - `length` / `name` — `{w:false, e:false, c:true}` (§17).
 *
 * ## Absent-not-wrong, and the exact decline condition
 *
 * Each key is emitted ONLY when its value can be produced honestly, and the
 * `prototype` one genuinely cannot always be. `buildLazyNativeProtoGetInstrs`
 * answers `null` unless the `Function` proto GLUE is registered — which happens
 * when the module mentions `Function.prototype` (or a `Function.prototype.<m>`)
 * SYNTACTICALLY. Registering that glue from here would mean minting glue and a
 * struct type at FINALIZE, out of regime, so the arm DECLINES instead: the
 * `prototype` key keeps the base `undefined` while `length`/`name` still
 * answer. Measured, and pinned as an `it.fails` residual.
 *
 * In practice every `propertyHelper.js`-using row has
 * `Function.prototype.call.bind(...)` in the harness, so the acceptance rows
 * are unaffected. Same discipline for `length`: no `__box_number` in `funcMap`
 * ⇒ no `length` arm. With no arm left the splice writes nothing at all, so the
 * module stays byte-identical.
 *
 * ## Known residual, deliberately not papered over
 *
 * `delete Function.length` still does not remove the key (#4491's stated
 * residual: the marker has no store to tombstone in), so `length`/`name` now
 * report `configurable: true` through a surface whose `delete` refuses. That
 * asymmetry already existed on the LITERAL-receiver fold — this arm makes the
 * two receivers agree with each other, and the `delete` half needs the
 * cross-module marker-slot ABI change #4491 priced and declined. Pinned as
 * `it.fails` in `tests/issue-4624.test.ts`.
 */
function spliceIntrinsicFunctionGopd(
  ctx: CodegenContext,
  markerTypeIdx: number,
  flattenIdx: number,
  equalsIdx: number,
): void {
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__getOwnPropertyDescriptor");
  if (!fn) return;
  // Resolved by NAME from `funcMap` at fill time — never a fresh
  // `ensureLateImport`, which at finalize would shift every baked funcIdx.
  const createDescIdx = ctx.funcMap.get("__create_descriptor");
  if (createDescIdx === undefined) return;
  const boxNumberIdx = ctx.funcMap.get("__box_number");

  // `getBuiltinBrand`, NOT `tryEnsureNativeProtoBrand`: the brand id is a table
  // lookup and always resolves, but REGISTERING the proto glue is what
  // `tryEnsure…` does, and doing that at finalize is out of regime. So the
  // builder answers `null` for a module whose glue nobody registered, and the
  // `prototype` key declines. `prependBuiltinFnObjectSemantics` (object-runtime,
  // same finalize phase) reaches the identical singleton exactly this way.
  const functionBrand = getBuiltinBrand(ctx, "Function");
  const protoValue = functionBrand === undefined ? null : buildLazyNativeProtoGetInstrs(ctx, functionBrand);

  const arity = BUILTIN_CTOR_ARITY["Function"];
  const descriptors: Array<{ key: string; value: Instr[]; flags: number }> = [];
  if (protoValue) descriptors.push({ key: "prototype", value: protoValue, flags: 0 });
  if (boxNumberIdx !== undefined && arity !== undefined) {
    descriptors.push({
      key: "length",
      value: [
        { op: "f64.const", value: arity },
        { op: "call", funcIdx: boxNumberIdx },
      ],
      flags: FLAG_CONFIGURABLE,
    });
  }
  descriptors.push({
    key: "name",
    value: [...nativeStringLiteralInstrs(ctx, "Function"), { op: "extern.convert_any" }],
    flags: FLAG_CONFIGURABLE,
  });
  if (descriptors.length === 0) return;

  unshiftIntrinsicFunctionArm(ctx, fn, markerTypeIdx, flattenIdx, equalsIdx, (keyEquals) => {
    const keyArms: Instr[] = [];
    for (const { key, value, flags } of descriptors) {
      keyArms.push(...keyEquals(key), {
        op: "if",
        blockType: { kind: "empty" },
        then: [...value, { op: "i32.const", value: flags }, { op: "call", funcIdx: createDescIdx }, { op: "return" }],
      });
    }
    return keyArms;
  });
}

/**
 * Unshift the shared `receiver is the %Function% intrinsic marker AND the key
 * is a string` guard onto `fn`, wrapping the key arms `buildKeyArms` produces.
 *
 * Extracted so the presence/delete trio and the descriptor arm ask the SAME
 * question about the SAME struct fields — two spellings of one brand check is
 * how the surfaces drift apart. Every caller's function has two params, so
 * appended locals start at `2 + locals.length`.
 *
 * Falling out of the arm without returning leaves the pre-existing body to
 * answer, so a marker key this slice does not own (`call`, an expando) keeps
 * exactly today's answer rather than a fabricated one.
 */
function unshiftIntrinsicFunctionArm(
  ctx: CodegenContext,
  fn: WasmFunction,
  markerTypeIdx: number,
  flattenIdx: number,
  equalsIdx: number,
  buildKeyArms: (keyEquals: (key: string) => Instr[]) => Instr[],
): void {
  const markerLocal = 2 + fn.locals.length;
  fn.locals.push({ name: "__fnintrinsic_marker", type: { kind: "ref_null", typeIdx: markerTypeIdx } });
  const keyAnyLocal = 2 + fn.locals.length;
  fn.locals.push({ name: "__fnintrinsic_key_any", type: { kind: "anyref" } });

  const keyEquals = (key: string): Instr[] => [
    { op: "local.get", index: keyAnyLocal },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    ...nativeStringLiteralInstrs(ctx, key),
    { op: "call", funcIdx: equalsIdx },
  ];

  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: markerTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: markerTypeIdx },
        { op: "local.set", index: markerLocal },
        { op: "local.get", index: markerLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: markerTypeIdx, fieldIdx: 1 },
        { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A },
        { op: "i32.eq" },
        { op: "local.get", index: markerLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: markerTypeIdx, fieldIdx: 2 },
        { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B },
        { op: "i32.eq" },
        { op: "i32.and" },
        { op: "local.get", index: markerLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: markerTypeIdx, fieldIdx: 3 },
        { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION },
        { op: "i32.eq" },
        { op: "i32.and" },
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: keyAnyLocal },
        { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: buildKeyArms(keyEquals) },
      ],
    },
  );
}
