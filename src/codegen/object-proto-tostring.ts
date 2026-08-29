// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4119 arm 1) The RUNTIME `Object.prototype.toString` classifier for the
 * standalone reflective-closure path — §20.1.3.6 (ES5 §15.2.4.2).
 *
 * ## What was broken
 *
 * `emitProtoMemberBodyRefusal` (array-object-proto.ts) threw
 * `Object.prototype.toString is not yet implemented in --target standalone`
 * for **76** official standalone rows (denominator: 43,505 official files,
 * 16,166 non-pass — fresh baseline 2026-08-04). 71 of the 76 sit under
 * `built-ins/Array/prototype/{slice,splice}`: the ES5 `S15.4.4.10_A*` /
 * `S15.4.4.12_A*` families, which assert genericity with
 *
 * ```js
 * arr.getClass = Object.prototype.toString;
 * if (arr.getClass() !== "[object " + "Array" + "]") { … }
 * ```
 *
 * ## Why the existing #2501 fold could not serve it
 *
 * #2501's `resolveObjectToStringTag` (expressions/calls.ts) is a COMPILE-TIME
 * fold keyed on the receiver's TypeScript type, and it only fires for the
 * syntactic `Object.prototype.toString.call(v)` form. The idiom above stores
 * the method in a property and calls it later, so the receiver is a runtime
 * externref with no static type to key on — the fold cannot reach it. #3201
 * solved this same `getClass` idiom but **host lane only**
 * (`if (!ctx.standalone && !ctx.wasi)`), and its own comment calls the native
 * dispatcher's coverage "a follow-up". This is that follow-up.
 *
 * ## Design: one predicate per question, never a second arm list
 *
 * Every classification question here is delegated to the predicate that already
 * owns it, rather than re-derived:
 *
 * | tag                    | predicate                                     |
 * | ---------------------- | --------------------------------------------- |
 * | `[object Null]`        | `ref.is_null` on the raw externref            |
 * | `[object Undefined]`   | `__typeof_undefined`                          |
 * | `[object Array]`       | `ref.test $__vec_base` (#2186 shared supertype) |
 * | `[object Function]`    | `__typeof_function`                           |
 * | `[object String]`      | `__typeof_string`                             |
 * | `[object Number]`      | `__typeof_number`                             |
 * | `[object Boolean]`     | `__typeof_boolean`                            |
 * | `[object Date]`        | `ref.test $__Date`                            |
 * | `[object Object]`      | `ref.test $Object` (§20.1.3.6 step 13 default) |
 *
 * Using `__typeof_function` rather than an inline closure `ref.test` is
 * load-bearing, not stylistic. Closure structs register **late** — that is the
 * entire reason `fillStandaloneTypeofClosureArms` exists as a FINALIZE pass
 * (typeof-natives-finalize.ts). An arm list baked here, at member-body-emit
 * time, would miss every closure registered afterwards and answer
 * `[object Object]` for a function: a silent wrong answer. Calling the native
 * defers the question to the one body that the finalize pass repairs, so this
 * classifier inherits the fix for free — including #4120's branded
 * `OBJ_FLAG_CALLABLE` builtin-constructor carrier, which is a `$Object` and not
 * a closure struct at all. `$__vec_base` is likewise ONE `ref.test` that
 * matches every `__vec_<elemKind>` regardless of element type (#2186).
 *
 * ## Loud stays loud
 *
 * The chain is deliberately NOT exhaustive, and the fallthrough is the
 * pre-existing `emitThrowTypeError` refusal — not a default `[object Object]`.
 * Receivers this classifier cannot prove (nominal class-instance structs,
 * `$Proxy`, primitive-wrapper OBJECTS, RegExp/Error carriers, boxed
 * symbols/bigints) keep throwing exactly as they do today. Widening the last
 * arm to "anything else is an ordinary object" would convert a loud refusal
 * into a silent mis-tag, which the acceptance bar counts as negative value —
 * see [[reference_bigger_number_bought_with_a_silent_wrong_answer_is_negative_value]].
 * The `$Object` arm is safe because `$Object` is a CLOSED (final) struct
 * (object-runtime.ts, #1100/#2009) reached only by `__new_plain_object`, and
 * the callable brand is filtered ahead of it by `__typeof_function`.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { WRAPPER_PRIMITIVE_KEY, ensureObjectRuntime } from "./object-runtime.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { buildArgumentsIsBrandedCall, reserveArgumentsLengthBrand } from "./arguments-length-brand.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { flushLateImportShifts } from "./shared.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { resolveArrayInfo } from "./array-methods.js";
import { isBooleanType, isNumberType, isStringType } from "../checker/type-mapper.js";
import { TYPED_ARRAY_NAMES, getOrRegisterVecType, resolveWasmType } from "./index.js";
import { bindingIsSingleAssignment } from "./single-assignment-binding.js";
import { ensureDateStruct } from "./expressions/builtins.js";
import { getOrRegisterDvWindowType } from "./dataview-native.js";
import { addFuncType, getOrRegisterTaDynViewType, getOrRegisterTaViewType, TA_CTOR_KINDS } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";

/** §20.1.3.6 result string for a builtin tag. */
const tagString = (tag: string): string => `[object ${tag}]`;

/**
 * The `(externref) -> i32` typeof predicates this classifier consults, paired
 * with the §20.1.3.6 tag each one implies. Order is the emission order and is
 * meaningful only in that `function` must precede the `$Object` arm (a branded
 * builtin carrier is a `$Object` that is callable, so it must classify as
 * Function first). The primitive arms are order-independent.
 */
const TYPEOF_PREDICATE_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["__typeof_function", "Function"],
  ["__typeof_string", "String"],
  ["__typeof_number", "Number"],
  ["__typeof_boolean", "Boolean"],
];

/**
 * The builtin PROTOTYPE objects whose §20.1.3.6 tag is NOT the step-13 default,
 * because the prototype object itself carries the exotic slot its instances do.
 *
 * | prototype           | spec                                     | tag                |
 * | ------------------- | ---------------------------------------- | ------------------ |
 * | `Number.prototype`  | §21.1.3 — IS a Number object, value `+0` | `[object Number]`  |
 * | `String.prototype`  | §22.1.3 — IS a String object, value `""` | `[object String]`  |
 * | `Boolean.prototype` | §20.3.3 — IS a Boolean object, `false`   | `[object Boolean]` |
 * | `Array.prototype`   | §23.1.3 — IS an Array exotic object      | `[object Array]`   |
 * | `Function.prototype`| §20.2.3 — IS a built-in function object  | `[object Function]`|
 *
 * These are the ones the runtime sees as a `$NativeProto` rather than as
 * the carrier its instances use, so the `$__vec_base` / `$Object`-wrapper arms
 * above miss them and the receiver reached the loud refusal. It is the SAME
 * spec fact `unshiftNativeProtoToPrimitiveArm` (native-proto-wrapper-primitive.ts)
 * already encodes for `__to_primitive`; this is the §20.1.3.6 half of it.
 *
 * Deliberately NOT a catch-all over every `$NativeProto`. `Date.prototype`,
 * `RegExp.prototype` and `Error.prototype` WERE exotic in ES5 and are ordinary
 * objects from ES2015 on (so `[object Object]`) — a different right answer from
 * the five listed, which a single default arm would get wrong. Anything not
 * listed keeps falling through to the refusal, which stays loud.
 */
const NATIVE_PROTO_BRAND_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["Number", "Number"],
  ["String", "String"],
  ["Boolean", "Boolean"],
  ["Array", "Array"],
  // (§20.2.3) `Function.prototype` IS a built-in *function* object — it has a
  // [[Call]] slot (it is the `%Function.prototype%` intrinsic that returns
  // undefined for any argument list), so §20.1.3.6 step 6 tags it `Function`,
  // not the step-13 `Object` default every other `X.prototype` gets. Callability
  // is already minted (`function-prototype-callable.ts`); this is the BRAND that
  // makes `Object.prototype.toString.call(Function.prototype)` answer
  // `[object Function]` (test262 `built-ins/Function/prototype/S15.3.4_A1.js`).
  ["Function", "Function"],
  // (#4492, §20.1.3.6 step 13) `%Object.prototype%` is the one entry here whose
  // tag is the DEFAULT rather than an exotic slot — it is listed because it is
  // reached as a RECEIVER (`Object.prototype.toString()`, i.e. `this` is
  // `%Object.prototype%` itself) and, being a `$NativeProto`, it matched no arm
  // and hit the loud refusal. Measured on this branch's base
  // (`.tmp/probes/b4.js`, `--target standalone`): `o.getClass()` and
  // `arr.getClass()` answer `[object Object]` / `[object Array]` while
  // `Object.prototype.getClass2()` threw `Object.prototype.toString is not yet
  // implemented`. That is test262 `built-ins/Object/prototype/S15.2.4_A1_T2`'s
  // FIRST assertion.
  //
  // It is added ALONE, and the table's "not a catch-all" rule is why. A blanket
  // `$NativeProto ⇒ Object` default would be wrong for every brand carrying a
  // `@@toStringTag` (`Map.prototype` is `[object Map]`, `Set`/`Promise`/
  // `DataView`/`ArrayBuffer`/… likewise), and the ES5-era-exotic trio
  // (`Date`/`RegExp`/`Error`.prototype) is `[object Object]` from ES2015 on but
  // was not measured here — those keep the loud refusal rather than an
  // unmeasured widening.
  ["Object", "Object"],
];

/**
 * (#4491 wave-7) The mirror image of {@link NATIVE_PROTO_BRAND_TAGS}: builtin
 * PROTOTYPE objects that are ORDINARY objects — no exotic slot, no own
 * `@@toStringTag` — so §20.1.3.6 gives them the step-13 default
 * `[object Object]`.
 *
 * Measured on the campaign base, standalone, via the stored-method idiom
 * (`Error.prototype.getClass = Object.prototype.toString; …getClass()`), which
 * is what routes a receiver to the runtime classifier rather than to the
 * compile-time fold:
 *
 * ```
 * Error.prototype   → THREW "Object.prototype.toString is not yet implemented"
 * Object.prototype  → THREW  (same)
 * Number.prototype  → "[object Number]"   ← the branded table above already works
 * ```
 *
 * Both throws are `[object Object]` per spec, so the loud refusal is a MISS, not
 * a protection. `built-ins/Error/prototype/S15.11.4_A2.js` and
 * `built-ins/Object/prototype/S15.2.4_A1_T2.js` are those two lines verbatim.
 *
 * This is an EXPLICIT list, not a default arm on `$NativeProto`, and the
 * distinction is load-bearing: most of the remaining builtin prototypes carry an
 * own `@@toStringTag` (§24.1.3.14 `Map.prototype[@@toStringTag]` is `"Map"`,
 * likewise Set / WeakMap / WeakSet / Promise / Symbol / DataView /
 * `%TypedArray%` / Generator), so a blanket "any other `$NativeProto` is
 * Object" would convert today's loud refusal into a silent MIS-tag for every one
 * of them — the exact trade this module's header rejects. Anything not listed
 * still falls through to the refusal.
 *
 * `Date.prototype` and `RegExp.prototype` are in the list on the ES2015+ rule
 * (both were exotic in ES5 and became ordinary objects in ES6); the same fact
 * NATIVE_PROTO_BRAND_TAGS' own comment states as its reason for excluding them
 * from the exotic five.
 */
const NATIVE_PROTO_ORDINARY_BRANDS: readonly string[] = [
  "Object",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
];

/** `$NativeProto` field indices — mirrors native-proto.ts / #4248's reader. */
const NATIVE_PROTO_BRAND_FIELD = 0;
const NATIVE_PROTO_IS_CLASS_FIELD = 1;

/**
 * Emit the §20.1.3.6 runtime classifier for a reflective
 * `Object.prototype.toString` closure body. `this` is closure param 1 (an
 * externref); the result is the uniform closure-call result type (externref
 * holding a NativeString).
 *
 * Returns `true` when at least one arm was emitted (the caller then appends its
 * loud-refusal fallthrough), `false` when the module lacks the substrate to
 * classify anything (no native strings), so the caller refuses wholesale.
 *
 * Stack discipline: each arm is a self-contained `if` whose `then` pushes the
 * tag string and `return`s, so the chain is stack-neutral and the fallthrough
 * inherits an empty stack — the same shape `fillStandaloneTypeofClosureArms`
 * uses for `__typeof`.
 */
export function emitObjectProtoToStringClassifier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  // (#4491 wave-7) Which local holds the receiver. Defaults to 1 — the
  // reflective closure's `this` (param 0 is the closure struct). The minted
  // standalone helper in object-proto-tostring-native.ts passes 0 because its
  // only parameter IS the receiver. Nothing else about the chain changes, which
  // is what keeps the two consumers provably one classifier rather than two
  // copies that can drift.
  receiverIndex = 1,
): boolean {
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0) return false;

  // Late-import adders run FIRST and flush, so every funcIdx fetched BY NAME
  // below is post-shift-correct (the established `emitArrayProtoMemberBody`
  // discipline — see array-object-proto.ts).
  ensureObjectRuntime(ctx);
  // Reserve one canonical witness for every native buffer/view carrier the
  // runtime classifier must recognize. Static per-kind `$__ta_view` structs
  // canonicalize to the same RTT shape; their appended `kind` field carries the
  // exact constructor name. Registering these before the classifier body is
  // baked also covers views constructed by functions compiled later.
  const arrayBufferTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
  const dataViewTypeIdx = getOrRegisterDvWindowType(ctx);
  const taViewTypeIdx = getOrRegisterTaViewType(ctx, "Uint8Array");
  const taDynViewTypeIdx = ctx.moduleUsesDynTaView ? getOrRegisterTaDynViewType(ctx) : -1;
  flushLateImportShifts(ctx, fctx);

  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  const propEntryTypeIdx = ctx.objectRuntimeTypes?.propEntryTypeIdx;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  // `$__vec_base` is only consulted when the module actually registered array
  // types; a module with no arrays cannot receive one, and registering the
  // supertype here purely to emit dead code would churn the type index space.
  const vecBaseTypeIdx = ctx.vecBaseTypeIdx >= 0 ? ctx.vecBaseTypeIdx : -1;
  // (#4491 wave-7) Reserve #4658's arguments-brand natives HERE rather than
  // reading whatever `ctx.funcMap` happens to hold. `reserveArgumentsLengthBrand`
  // is idempotent, append-only (no funcIdx shift) and standalone-only, but it is
  // driven by arguments-vec CONSTRUCTION — which may not have been compiled yet
  // when this classifier is emitted. Measured before this call was added: the
  // brand was correctly applied at run time (`gOPD(args,"length").configurable`
  // answered `true` while an array answered `false`) and the classifier still
  // said `[object Array]`, because `__args_is_branded` was simply not in the map
  // at emit time and the query degraded to its "never branded" empty payload.
  if (vecBaseTypeIdx >= 0) reserveArgumentsLengthBrand(ctx);

  /** `then`-block that materializes a tag string and returns it. */
  const returnTag = (tag: string): Instr[] => {
    const s = tagString(tag);
    addStringConstantGlobal(ctx, s);
    return [...stringConstantExternrefInstrs(ctx, s), { op: "return" } as Instr];
  };

  let emittedAnyArm = false;

  // ── §20.1.3.6 steps 1-2: null / undefined, read off the RAW externref ──────
  // `null` is `ref.null.extern`; `undefined` is a distinct non-null sentinel
  // under the #2106 undefinedSingleton regime, so `ref.is_null` alone misses it
  // and the dedicated predicate is required (the same pairing
  // `emitStringRequireObjectCoercible` uses).
  fctx.body.push(
    { op: "local.get", index: receiverIndex },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: returnTag("Null") },
  );
  emittedAnyArm = true;

  const undefIdx = ctx.funcMap.get("__typeof_undefined");
  if (undefIdx !== undefined) {
    fctx.body.push(
      { op: "local.get", index: receiverIndex },
      { op: "call", funcIdx: undefIdx },
      { op: "if", blockType: { kind: "empty" }, then: returnTag("Undefined") },
    );
  }

  // Recover one anyref once for all WasmGC-native exotic classifiers below.
  const nativeAnyLocal = allocLocal(fctx, `__opts_native_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push(
    { op: "local.get", index: receiverIndex },
    { op: "any.convert_extern" },
    { op: "local.set", index: nativeAnyLocal },
  );

  // ── Native ArrayBuffer/DataView/TypedArray brands ─────────────────────────
  // These MUST precede the generic `$__vec_base` Array arm: ArrayBuffer and
  // TypedArray carriers are vec-base subtypes too, but §20.1.3.6 names their
  // exact exotic brand rather than "Array".
  fctx.body.push(
    { op: "local.get", index: nativeAnyLocal },
    { op: "ref.test", typeIdx: dataViewTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: returnTag("DataView") },
  );

  const typedArrayKindArms = (typeIdx: number, kindFieldIdx: number): Instr[] => {
    const arms: Instr[] = [];
    for (let kind = 0; kind < TA_CTOR_KINDS.length; kind++) {
      arms.push(
        { op: "local.get", index: nativeAnyLocal },
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx: kindFieldIdx },
        { op: "i32.const", value: kind },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: returnTag(TA_CTOR_KINDS[kind]!) },
      );
    }
    return arms;
  };

  fctx.body.push(
    { op: "local.get", index: nativeAnyLocal },
    { op: "ref.test", typeIdx: taViewTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: typedArrayKindArms(taViewTypeIdx, 3),
    },
  );
  if (taDynViewTypeIdx >= 0) {
    fctx.body.push(
      { op: "local.get", index: nativeAnyLocal },
      { op: "ref.test", typeIdx: taDynViewTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: typedArrayKindArms(taDynViewTypeIdx, 3),
      },
    );
  }

  fctx.body.push(
    { op: "local.get", index: nativeAnyLocal },
    { op: "ref.test", typeIdx: arrayBufferTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: returnTag("ArrayBuffer") },
  );

  // ── step 4: Array exotic. ONE `ref.test` over the #2186 shared supertype
  // matches every ordinary `__vec_<elemKind>` after the more-specific native
  // view arms above.
  if (vecBaseTypeIdx >= 0) {
    fctx.body.push(
      { op: "local.get", index: nativeAnyLocal },
      { op: "ref.test", typeIdx: vecBaseTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        // (#4491 wave-7) …but a `$Vec` is not necessarily an Array: an
        // `arguments` exotic shares the carrier (#4667), and §20.1.3.6 step 12
        // gives it `[object Arguments]`. #4658 already mints a runtime brand for
        // exactly this object (`$__arguments_vec` type identity), so the split
        // is one O(1) query.
        //
        // Order is the whole point: the Arguments test runs FIRST and the Array
        // answer is the else. An UNBRANDED arguments object (one #4658's
        // observability proof elided the mark for) still answers `Array` —
        // unchanged from today, and the honest limit of this arm.
        then: [
          ...buildArgumentsIsBrandedCall(ctx, receiverIndex),
          ...(ctx.funcMap.get("__args_is_branded") === undefined
            ? returnTag("Array")
            : ([
                { op: "if", blockType: { kind: "empty" }, then: returnTag("Arguments") },
                ...returnTag("Array"),
              ] as Instr[])),
        ],
      },
    );
  }

  // ── steps 3, 6-8: callable + boxed primitives, via the owning predicates. ──
  for (const [predicate, tag] of TYPEOF_PREDICATE_TAGS) {
    const idx = ctx.funcMap.get(predicate);
    if (idx === undefined) continue;
    fctx.body.push(
      { op: "local.get", index: receiverIndex },
      { op: "call", funcIdx: idx },
      { op: "if", blockType: { kind: "empty" }, then: returnTag(tag) },
    );
  }

  // Date instances are native `__Date` carriers, not `$Object`s.  The
  // standalone runtime classifier must brand them before its `$Object`
  // fallback, otherwise an any-typed value such as the result of a bound
  // constructor is silently reported as `[object Object]`.
  if (ctx.builtinObjectGlobals.has("ctor:Date")) {
    const dateTypeIdx = ensureDateStruct(ctx);
    const dateAnyLocal = allocLocal(fctx, `__opts_date_${fctx.locals.length}`, { kind: "anyref" });
    fctx.body.push(
      { op: "local.get", index: receiverIndex },
      { op: "any.convert_extern" },
      { op: "local.set", index: dateAnyLocal },
      { op: "local.get", index: dateAnyLocal },
      { op: "ref.test", typeIdx: dateTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: returnTag("Date") },
    );
  }

  // ── §21.1.3 / §22.1.3 / §20.3.3 / §23.1.3: a builtin PROTOTYPE object that
  // carries its instances' exotic slot. See NATIVE_PROTO_BRAND_TAGS for the
  // four and for why this is not a catch-all. Placed after the primitive
  // predicates (a `$NativeProto` matches none of them) and before the `$Object`
  // family (a `$NativeProto` is not a `$Object`, so the order is documentary).
  // `$isClass != 0` — a user-class façade proto (#2101) — declines: that is an
  // ordinary object with no exotic slot, and the refusal below is the honest
  // answer until an `[object Object]` default is measured.
  const nativeProtoTypeIdx = ctx.nativeProtoTypeIdx;
  if (nativeProtoTypeIdx !== undefined) {
    const npAnyLocal = allocLocal(fctx, `__opts_np_${fctx.locals.length}`, { kind: "anyref" });
    const brandArms: Instr[] = [];
    const brandArm = (name: string, tag: string): void => {
      const brand = BUILTIN_BRAND_TABLE[name];
      if (brand === undefined) return;
      brandArms.push(
        { op: "local.get", index: npAnyLocal },
        { op: "ref.cast", typeIdx: nativeProtoTypeIdx },
        { op: "struct.get", typeIdx: nativeProtoTypeIdx, fieldIdx: NATIVE_PROTO_BRAND_FIELD },
        { op: "i32.const", value: brand },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: returnTag(tag) },
      );
    };
    for (const [name, tag] of NATIVE_PROTO_BRAND_TAGS) brandArm(name, tag);
    // (#4491 wave-7) …then the ORDINARY builtin prototypes, each answering the
    // step-13 default. Emitted AFTER the exotic five so the exotic answer always
    // wins, and one brand-equality arm each rather than a default `else`, for
    // the reason NATIVE_PROTO_ORDINARY_BRANDS documents: a `$NativeProto` this
    // list does not name still reaches the loud refusal.
    for (const name of NATIVE_PROTO_ORDINARY_BRANDS) brandArm(name, "Object");
    if (brandArms.length > 0) {
      fctx.body.push(
        { op: "local.get", index: receiverIndex },
        { op: "any.convert_extern" },
        { op: "local.set", index: npAnyLocal },
        { op: "local.get", index: npAnyLocal },
        { op: "ref.test", typeIdx: nativeProtoTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: npAnyLocal },
            { op: "ref.cast", typeIdx: nativeProtoTypeIdx },
            { op: "struct.get", typeIdx: nativeProtoTypeIdx, fieldIdx: NATIVE_PROTO_IS_CLASS_FIELD },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: brandArms },
          ],
        },
      );
    }
  }

  // ── steps 5-8 + 13: the `$Object` family. TWO carriers hide behind a single
  // `ref.test $Object` and neither may be answered "Object":
  //
  //   * `$Proxy` is declared a SUBTYPE of `$Object` (object-runtime.ts: "A proxy
  //     IS-A object, so every `ref.test $Object` still matches it"). Its §20.1.3.6
  //     tag is resolved through IsArray, which unwraps to the target and must
  //     throw TypeError for a REVOKED proxy (§7.2.2 step 3a) — neither of which a
  //     constant `[object Object]` can do. Excluded → loud refusal.
  //   * A primitive-WRAPPER object (`new String("x")`, `new Number(5)`,
  //     `new Boolean(true)`) is an ordinary `$Object` carrying its
  //     [[StringData]]/[[NumberData]]/[[BooleanData]] in the reserved internal
  //     `[[PrimitiveValue]]` slot (#1910/#1472 S2). §20.1.3.6 steps 5-8 tag it by
  //     that slot, NOT "Object" — `new String("seamaid")` is `[object String]`.
  //     Measured: without this arm `built-ins/String/S15.5.2.1_A3.js` answers
  //     `[object Object]`, turning a loud refusal into a silent wrong answer.
  //
  // Only a `$Object` that is neither gets the step-13 default.
  if (objectTypeIdx !== undefined && objFindIdx !== undefined && propEntryTypeIdx !== undefined) {
    const objAnyLocal = allocLocal(fctx, `__opts_obj_${fctx.locals.length}`, { kind: "anyref" });
    const slotLocal = allocLocal(fctx, `__opts_slot_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: propEntryTypeIdx,
    });
    const primLocal = allocLocal(fctx, `__opts_prim_${fctx.locals.length}`, { kind: "externref" });

    addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);

    // Wrapper arm: tag by the boxed primitive's own type. A wrapper whose slot
    // holds something else (a Symbol / BigInt wrapper) matches no predicate and
    // falls out to the refusal rather than guessing.
    const wrapperArm: Instr[] = [
      { op: "local.get", index: slotLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
      { op: "extern.convert_any" },
      { op: "local.set", index: primLocal },
    ];
    for (const [predicate, tag] of [
      ["__typeof_string", "String"],
      ["__typeof_number", "Number"],
      ["__typeof_boolean", "Boolean"],
    ] as const) {
      const idx = ctx.funcMap.get(predicate);
      if (idx === undefined) continue;
      wrapperArm.push(
        { op: "local.get", index: primLocal },
        { op: "call", funcIdx: idx },
        { op: "if", blockType: { kind: "empty" }, then: returnTag(tag) },
      );
    }

    const nonProxyArm: Instr[] = [
      { op: "local.get", index: objAnyLocal },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      ...stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: slotLocal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // No [[PrimitiveValue]] slot ⇒ an ordinary object ⇒ step-13 default.
        then: returnTag("Object"),
        else: wrapperArm,
      },
    ];

    fctx.body.push(
      { op: "local.get", index: receiverIndex },
      { op: "any.convert_extern" },
      { op: "local.set", index: objAnyLocal },
      { op: "local.get", index: objAnyLocal },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then:
          proxyTypeIdx === undefined
            ? nonProxyArm
            : [
                { op: "local.get", index: objAnyLocal },
                { op: "ref.test", typeIdx: proxyTypeIdx },
                { op: "i32.eqz" },
                { op: "if", blockType: { kind: "empty" }, then: nonProxyArm },
              ],
      },
    );
  }

  // User function-constructor instances are ordinary ECMAScript objects, but
  // the standalone fnctor lowering carries them in their nominal
  // `$__fnctor_<F>` structs rather than in the open `$Object` carrier above.
  // They have no callable/array/wrapper exotic slot, so §20.1.3.6 step 13 is
  // the correct `[object Object]` answer. Keep this arm keyed to the compiler's
  // registered fnctor carrier types; a blanket "anything not classified is an
  // object" would silently mis-tag proxies and future exotic carriers.
  for (const fnctorTypeIdx of ctx.fnctorReservedTypeIdx.values()) {
    fctx.body.push(
      { op: "local.get", index: receiverIndex },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: fnctorTypeIdx },
      { op: "if", blockType: { kind: "empty" }, then: returnTag("Object") },
    );
  }

  return emittedAnyArm;
}

/**
 * Mint the direct `(externref) -> externref` runtime classifier used when
 * `Object.prototype.toString.call(value)` receives an `any`-typed value whose
 * brand cannot be proven statically. The reflective closure ABI carries an
 * extra `self` parameter, so the shared classifier reads local 1; this helper
 * mirrors that layout with an unused local-0 parameter and lets direct calls
 * avoid a generic Function#call round-trip that erases native GC carrier RTT.
 */
export function ensureObjectProtoToStringRuntimeHelper(ctx: CodegenContext): number | undefined {
  const name = "__object_proto_to_string_runtime";
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  if (!ctx.standalone && !ctx.wasi) return undefined;

  const externref: ValType = { kind: "externref" };
  const helper: FunctionContext = {
    name,
    params: [
      { name: "unusedSelf", type: externref },
      { name: "value", type: externref },
    ],
    locals: [],
    localMap: new Map(),
    returnType: externref,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  if (!emitObjectProtoToStringClassifier(ctx, helper)) return undefined;
  emitThrowTypeError(ctx, helper, "Object.prototype.toString is not yet implemented in --target standalone");
  const typeIdx = addFuncType(ctx, [externref, externref], [externref]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: helper.locals,
    body: helper.body,
    exported: false,
  });
  return funcIdx;
}

/**
 * (#4119 arm 1) The generic `makeGlue` member-body tail: emit
 * `Object.prototype.toString`'s real body, or the unchanged catchable-TypeError
 * refusal for every other `(brand, member)` that has no native body yet.
 *
 * Only `Object.prototype.toString` has a body — the §20.1.3.6 runtime classifier
 * above, which is what the ES5 `S15.4.4.10_A*` / `S15.4.4.12_A*` genericity
 * families need: they stash the method
 * (`arr.getClass = Object.prototype.toString`) and call it later, so #2501's
 * compile-time fold cannot see the receiver.
 *
 * The classifier is deliberately partial, so a receiver it cannot prove falls
 * out of the chain into the SAME refusal every other `Object.prototype` member
 * still gets — never a default `[object Object]`.
 *
 * The refusal is inlined rather than imported from `array-object-proto.ts`'s
 * `emitProtoMemberBodyRefusal`: that module imports THIS one, so reaching back
 * would close an import cycle. It is a one-line `emitThrowTypeError`, and the
 * message text is asserted identical by the callers' tests.
 */
export function emitObjectProtoOrRefusal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  brandName: string,
  member: string,
): ValType | null {
  const refusalMessage = `${brandName}.prototype.${member} is not yet implemented in --target standalone`;
  if (brandName !== "Object" || member !== "toString" || !emitObjectProtoToStringClassifier(ctx, fctx)) {
    emitThrowTypeError(ctx, fctx, refusalMessage);
    return null;
  }
  // Unclassifiable receiver → the same loud refusal, as the chain's fallthrough.
  // `emitThrowTypeError` ends `unreachable`, so the declared externref result is
  // satisfied on every path.
  emitThrowTypeError(ctx, fctx, refusalMessage);
  return { kind: "externref" };
}
/**
 * (#2501) Does `argExpr` denote a value that may be a **Proxy**? A proxy's
 * §20.1.3.6 tag can't be classified statically: `IsArray` (step 4) unwraps the
 * proxy to its target and, for a *revoked* proxy, throws TypeError (§7.2.2 step
 * 3a) — so a static tag is both potentially wrong (the TS type is the *target's*
 * type, e.g. `Proxy.revocable([], …).proxy` types as `never[]`) and unsound (it
 * can't throw). The host's real `Object.prototype.toString` gets every proxy
 * case right (unwrap-to-target, revoked → throw), so the classifier must defer
 * to it. Proxies carry no TS-type brand (`new Proxy(t, h)` types identically to
 * `t`), so detection is purely syntactic on the receiver's provenance:
 *   - `new Proxy(...)` directly,
 *   - `Proxy.revocable(...).proxy`,
 *   - an identifier whose initializer is (transitively) either of the above
 *     (`var p = new Proxy([], {}); …call(p)` / `var pp = new Proxy(p, {})`).
 */
function receiverMayBeProxy(ctx: CodegenContext, argExpr: ts.Expression): boolean {
  const isNewProxy = (node: ts.Expression): boolean =>
    ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Proxy";

  // `Proxy.revocable(...).proxy` — the `.proxy` member of a revocable handle.
  const isRevocableProxyAccess = (node: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "proxy") return false;
    const recv = node.expression;
    return (
      ts.isCallExpression(recv) &&
      ts.isPropertyAccessExpression(recv.expression) &&
      recv.expression.name.text === "revocable" &&
      ts.isIdentifier(recv.expression.expression) &&
      recv.expression.expression.text === "Proxy"
    );
  };

  // `handle.proxy` where `handle = Proxy.revocable(...)` (the revocable result is
  // bound to a variable first — the common test262 shape).
  const isRevocableHandleProxyAccess = (node: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "proxy") return false;
    const recv = node.expression;
    if (!ts.isIdentifier(recv)) return false;
    const sym = ctx.checker.getSymbolAtLocation(recv);
    const decl = sym?.valueDeclaration;
    if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) return false;
    const init = decl.initializer;
    return (
      ts.isCallExpression(init) &&
      ts.isPropertyAccessExpression(init.expression) &&
      init.expression.name.text === "revocable" &&
      ts.isIdentifier(init.expression.expression) &&
      init.expression.expression.text === "Proxy"
    );
  };

  const exprIsProxy = (node: ts.Expression): boolean => {
    const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
    return isNewProxy(inner) || isRevocableProxyAccess(inner) || isRevocableHandleProxyAccess(inner);
  };

  if (exprIsProxy(argExpr)) return true;

  // Identifier bound to a proxy (transitively): `var p = new Proxy(t, h)` then
  // `…call(p)`, including the proxy-of-proxy chain `var pp = new Proxy(p, {})`.
  if (ts.isIdentifier(argExpr)) {
    const sym = ctx.checker.getSymbolAtLocation(argExpr);
    const decl = sym?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && exprIsProxy(decl.initializer)) {
      return true;
    }
  }
  return false;
}

/**
 * The §20.1.3.6 tag for a `<Builtin>.prototype` receiver that carries its
 * instances' exotic slot, or `undefined` for every other `X.prototype`.
 *
 * The receiver must be the AMBIENT builtin: a module that declares its own
 * `Number` (a module global, a top-level function, a class) means something
 * else by the identifier, and answering the intrinsic's tag for it would be the
 * same class of silent wrong answer this helper exists to remove.
 */
function nativeProtoTagOf(ctx: CodegenContext, argExpr: ts.PropertyAccessExpression): string | undefined {
  const base = argExpr.expression;
  if (!ts.isIdentifier(base)) return undefined;
  const name = base.text;
  if (ctx.moduleGlobals.has(name) || ctx.topLevelFunctionNames.has(name) || ctx.classSet.has(name)) return undefined;
  return NATIVE_PROTO_BRAND_TAGS.find(([builtin]) => builtin === name)?.[1];
}

/**
 * Resolve the one ES5 shape where `Object.getPrototypeOf` returns a builtin
 * wrapper prototype through a local binding:
 *
 *     var numberProto = Object.getPrototypeOf(new Number(42));
 *     Object.prototype.toString.call(numberProto);
 *
 * The ordinary static type of that binding is just `any`/`Object`, while the
 * value is the intrinsic `Number.prototype` object and therefore carries the
 * Number brand.  Keep this proof deliberately semantic and narrow: the oracle
 * must identify both constructors as ambient bindings, and the alias must be
 * a single-assignment variable.  A shadowed constructor or a later write
 * declines to the existing path rather than baking a possibly stale tag.
 */
function numberPrototypeAliasTag(ctx: CodegenContext, argExpr: ts.Expression): string | undefined {
  if (!ctx.standalone) return undefined;
  if (!ts.isIdentifier(argExpr) || !bindingIsSingleAssignment(ctx, argExpr)) return undefined;
  const initializer = ctx.oracle.variableInitializerOf(argExpr);
  if (!initializer) return undefined;

  let init: ts.Expression = initializer;
  while (
    ts.isParenthesizedExpression(init) ||
    ts.isAsExpression(init) ||
    ts.isNonNullExpression(init) ||
    ts.isSatisfiesExpression(init) ||
    ts.isTypeAssertionExpression(init)
  ) {
    init = init.expression;
  }
  if (
    !ts.isCallExpression(init) ||
    init.arguments.length !== 1 ||
    !ts.isPropertyAccessExpression(init.expression) ||
    init.expression.name.text !== "getPrototypeOf" ||
    !ts.isIdentifier(init.expression.expression) ||
    init.expression.expression.text !== "Object"
  ) {
    return undefined;
  }
  const objectDecl = ctx.oracle.valueDeclarationOf(init.expression.expression);
  if (objectDecl !== undefined && !objectDecl.getSourceFile().isDeclarationFile) return undefined;

  let target: ts.Expression = init.arguments[0]!;
  while (
    ts.isParenthesizedExpression(target) ||
    ts.isAsExpression(target) ||
    ts.isNonNullExpression(target) ||
    ts.isSatisfiesExpression(target) ||
    ts.isTypeAssertionExpression(target)
  ) {
    target = target.expression;
  }
  if (!ts.isNewExpression(target) || !ts.isIdentifier(target.expression) || target.expression.text !== "Number") {
    return undefined;
  }
  const numberDecl = ctx.oracle.valueDeclarationOf(target.expression);
  if (numberDecl !== undefined && !numberDecl.getSourceFile().isDeclarationFile) return undefined;
  return "Number";
}

/**
 * (#2501) Resolve the §20.1.3.6 `Object.prototype.toString` builtin tag for a
 * statically-known receiver, returning the tag name (e.g. "Array", "Date") or
 * `undefined` when it can't be classified (caller falls back / refuses).
 *
 * Order follows §20.1.3.6 steps 2-14 (the Symbol.toStringTag override of step
 * 15 is a deferred phase-2 — needs dynamic @@toStringTag property lookup):
 *   undefined → Undefined · null → Null · isArray → Array · callable → Function
 *   · Error → Error · Boolean/Number/String primitive → that tag · Date → Date
 *   · RegExp → RegExp · arguments exotic → Arguments · else → Object.
 *
 * (#4491 wave-7) `proof` is an optional OUT parameter. The standalone lane ends
 * this ladder with a `[object Object]` that is a *fallback*, not a
 * classification: it fires for any receiver whose static type lowers to a
 * ref/externref, which under `allowJs` is every `any` — a parameter, a `this`
 * inside a JS callback, an `Object.getPrototypeOf(...)` result. Callers that can
 * do better at RUN time need to tell the two apart, and only this function
 * knows. When the returned tag came from one of those two terminal arms it sets
 * `proof.unprovenDefault = true`; every other return leaves it alone.
 *
 * The flag is deliberately NOT set for the `X.prototype` arm or for the
 * `symName`-driven `deferOrStandalone` arms: those answers rest on a name the
 * checker resolved, which is a proof.
 */
export interface ObjectToStringTagProof {
  /** The tag is the standalone terminal fallback, not a classification. */
  unprovenDefault: boolean;
}

export function resolveObjectToStringTag(
  ctx: CodegenContext,
  argExpr: ts.Expression | undefined,
  proof?: ObjectToStringTagProof,
): string | undefined {
  if (argExpr === undefined) return "Undefined"; // toString.call() with no arg → this=undefined
  // Literal null / undefined keywords.
  if (argExpr.kind === ts.SyntaxKind.NullKeyword) return "Null";
  if (argExpr.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(argExpr) && argExpr.text === "undefined")) {
    return "Undefined";
  }

  // (#2501) IMPORTANT — in **host mode** only return a static tag when we are
  // *certain* it matches §20.1.3.6, and otherwise bail (return undefined) so the
  // caller falls through to the host `__proto_method_call` path, whose real
  // `Object.prototype.toString` already gets every remaining case right
  // (primitives, primitive-wrapper objects, plain objects, `.prototype`
  // objects, and @@toStringTag (step 14/15) objects like JSON / Math). The
  // earlier broad classifier MIS-tagged all of those (`Object([])` /
  // `Object(5)` / `new Number(5)` → [object Object]; `TypeError.prototype` →
  // [object Error]; `JSON` → [object Object]), regressing 35 test262 files.
  //
  // So host mode restricts the static path to exactly the receivers the host
  // gets WRONG — the ones whose underlying Wasm value (a GC vec/struct/closure)
  // is opaque to the host's `Object.prototype.toString`: genuine arrays,
  // callable functions, the `arguments` exotic, and Date/RegExp/Error
  // *instances*. Everything else returns undefined → host fall-through.
  //
  // **Standalone mode** has no host to fall through to (the borrowed `.call`
  // form is otherwise a hard compile error there), so for the would-defer
  // cases it returns the best-available *static* tag instead of undefined:
  // plain objects / primitive wrappers → the §20.1.3.6 step-2-14 builtin tag
  // (the deferred @@toStringTag step-15 override is no worse than the pre-#2501
  // CE). `deferOrStandalone(fallback)` encodes that: host → undefined,
  // standalone → fallback.
  const deferOrStandalone = (fallback: string | undefined): string | undefined =>
    ctx.standalone ? fallback : undefined;

  // Proxy receivers — never static-classify. The §20.1.3.6 tag of a proxy is
  // resolved through `IsArray`, which unwraps to the proxy target and throws
  // TypeError for a *revoked* proxy (§7.2.2 step 3a). The TS type reflects the
  // *target* (a `Proxy.revocable([], …).proxy` types as `never[]`, so the broad
  // array branch below would mis-emit a constant `[object Array]` that can never
  // throw — regressing `proxy-revoked.js`). Defer to the host, which unwraps the
  // proxy and throws on the revoked case correctly. (Standalone has no proxy
  // runtime, so `undefined` → refuse-loud, no worse than the pre-#2501 CE.)
  if (receiverMayBeProxy(ctx, argExpr)) return deferOrStandalone(undefined);

  // Receiver forms that defeat static classification — the spec tag depends on
  // an internal slot the TS type can't reveal. Handle / bail explicitly:
  //   - `Object(x)` ToObject-boxing → §7.1.18: ToObject of a primitive yields
  //     the matching wrapper, ToObject of an object returns it unchanged. So
  //     the §20.1.3.6 tag of `Object(x)` is exactly the tag of `x`. Recurse on
  //     the inner expr (Object([]) → Array, Object(5) → host-defer Number).
  //   - `X.prototype` → a builtin prototype is an ordinary object with NO
  //     [[ErrorData]]/[[Call]] slot, so it is [object Object], not the parent's
  //     tag (TypeError.prototype → Object, Function.prototype → Function — but
  //     the host resolves both precisely, so defer rather than risk a mis-tag).
  if (ts.isCallExpression(argExpr) && ts.isIdentifier(argExpr.expression) && argExpr.expression.text === "Object") {
    // `proof` rides the recursion: `Object(x)`'s tag IS `x`'s tag, so if the
    // inner resolution was the unproven fallback then so is this one.
    return argExpr.arguments.length >= 1 ? resolveObjectToStringTag(ctx, argExpr.arguments[0], proof) : "Object";
  }
  if (ts.isPropertyAccessExpression(argExpr) && argExpr.name.text === "prototype") {
    // …with FOUR exceptions, and they are not a nicety: `Number.prototype` IS
    // a Number object (§21.1.3), `String.prototype` a String object (§22.1.3),
    // `Boolean.prototype` a Boolean object (§20.3.3) and `Array.prototype` an
    // Array exotic object (§23.1.3). "an ordinary object with NO exotic slot"
    // above is true of the OTHER builtin prototypes, not of these. Host mode
    // defers and the real `Object.prototype.toString` gets them right; the
    // standalone fallback answered a constant `[object Object]` — a SILENT
    // wrong answer, which is worse than the refusal it replaced. Same four,
    // same spec facts, as NATIVE_PROTO_BRAND_TAGS above.
    const protoTag = nativeProtoTagOf(ctx, argExpr);
    if (protoTag !== undefined) return protoTag;
    return deferOrStandalone("Object");
  }

  // A `getPrototypeOf(new Number(...))` result is an intrinsic Number
  // prototype even though the local binding's checker type is only Object/any.
  // This must come after the direct `<Builtin>.prototype` case above and
  // before the generic type-based fallback, which would otherwise emit
  // `[object Object]` for this exact ES5 alias shape.
  const numberAliasTag = numberPrototypeAliasTag(ctx, argExpr);
  if (numberAliasTag !== undefined) return numberAliasTag;

  const t = ctx.checker.getTypeAtLocation(argExpr);
  const nn = ctx.checker.getNonNullableType(t);
  // null / undefined via the type system (e.g. a `null`-typed binding).
  if ((t.flags & ts.TypeFlags.Null) !== 0) return "Null";
  if ((t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return "Undefined";

  // `any` and `unknown` carry no reliable internal-slot information. Folding
  // them to the standalone fallback `[object Object]` makes a generic helper
  // permanently ignore its runtime argument (and mis-tags native
  // ArrayBuffer/DataView/TypedArray carriers). Let the caller select the
  // WasmGC runtime classifier instead.
  if ((nn.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return undefined;

  const symName = nn.getSymbol()?.name;

  // (#2597) §23.2.3.38 — `%TypedArray%.prototype[@@toStringTag]` is the typed
  // array's constructor name (`"Int32Array"`, …). §25.x give DataView /
  // ArrayBuffer / SharedArrayBuffer. These receivers are opaque Wasm structs, so
  // the host's `Object.prototype.toString` ALSO mis-tags them — return the static
  // tag unconditionally (correct in BOTH host and standalone), not via
  // `deferOrStandalone`. MUST precede the `resolveArrayInfo` "Array" arm below:
  // a typed array is array-like to that resolver, so without this it would mis-tag
  // `[object Array]` instead of `[object Int32Array]`. `.prototype` of a typed
  // array was filtered earlier (no [[TypedArrayName]] slot → `[object Object]`).
  if (symName !== undefined && TYPED_ARRAY_NAMES.has(symName)) return symName;
  if (symName === "BigInt64Array" || symName === "BigUint64Array") return symName;
  if (symName === "DataView") return "DataView";
  if (symName === "ArrayBuffer") return "ArrayBuffer";
  if (symName === "SharedArrayBuffer") return "SharedArrayBuffer";

  // ES2015 §23.1.5.2.2: an ArrayIterator has the intrinsic
  // `@@toStringTag` value "Array Iterator". Its standalone carrier is
  // represented as a native `$Vec`/`$IterRec` shape, so the generic array
  // classifier below would incorrectly select "Array". Keep host mode on the
  // real dynamic classifier so user mutations remain observable there.
  if (symName === "ArrayIterator") return deferOrStandalone("Array Iterator");

  // (#4747) String iterator carriers are opaque native records in standalone,
  // so their intrinsic prototype tag cannot be discovered through the generic
  // externref classifier. The checker-proven type is narrow enough to avoid
  // reclassifying arbitrary iterator-like objects; host mode keeps the dynamic
  // native path through deferOrStandalone().
  if (symName === "StringIterator") return deferOrStandalone("String Iterator");

  // Array (real `__vec_`/`__arr_` arrays, via the established resolver) — the
  // host sees an opaque GC vec and mis-tags it [object Object].
  if (resolveArrayInfo(ctx, nn)) return "Array";

  // Primitive-wrapper *objects* (`new Number(5)` / `new Boolean(true)` /
  // `new String("")`) box to the corresponding tag, but the host already
  // resolves them correctly — and the static type is unreliable here (one
  // resolves via isStringType, the others fall through). Defer to the host
  // (standalone → emit the matching wrapper tag, the best static answer).
  if (symName === "Number") return deferOrStandalone("Number");
  if (symName === "Boolean") return deferOrStandalone("Boolean");
  if (symName === "String") return deferOrStandalone("String");

  // (#4491 wave-5 T1) The NAMESPACE objects. §21.3.1.9 / §25.5.3 give `Math`
  // and `JSON` an own `@@toStringTag` of their own name, so §20.1.3.6 step 15
  // overrides the step-13 "Object" default. Standalone had no @@toStringTag
  // resolution and fell through to that default, so `Object.prototype.toString
  // .call(Math)` and `String(Math)` both answered "[object Object]" where the
  // spec says "[object Math]". The tag is a compile-time constant here — the
  // receiver is the namespace itself — so no dynamic lookup is needed.
  //
  // `deferOrStandalone`, not an unconditional return: in HOST mode the real
  // `Object.prototype.toString` already gets these right INCLUDING a test that
  // mutates `Math[Symbol.toStringTag]`, which a baked constant could not follow.
  if (symName === "Math") return deferOrStandalone("Math");
  if (symName === "JSON") return deferOrStandalone("JSON");

  // Named builtin exotic *instances* the host mis-tags (opaque Wasm receiver):
  // Date / RegExp / Error(+subclasses) / arguments. `.prototype` of these was
  // already filtered above, so a match here is a real instance.
  if (symName === "Date") return "Date";
  if (symName === "RegExp") return "RegExp";
  if (symName === "Error" || symName?.endsWith("Error")) return "Error";
  if (symName === "IArguments" || symName === "Arguments") return "Arguments";

  // Callable (function) — has call signatures. The host sees an opaque Wasm
  // closure receiver and mis-tags it [object Object].
  const callSigs = nn.getCallSignatures?.();
  if (callSigs && callSigs.length > 0) return "Function";

  // (#4491 wave-5 T7) …and the AMBIENT `Function` interface, which has NO call
  // signature in lib.d.ts (it declares `apply`/`call`/`bind`, not a signature),
  // so the arm above misses it. That is exactly the type of everything the
  // runtime-eval provider hands back as a callable — `Function(src)`,
  // `new Function(src)`, an eval-returned function — plus any `: Function`
  // annotation. Measured on base, standalone: `Object.prototype.toString
  // .call(Function("a", "return a"))` answered `[object Object]` (it fell all
  // the way to the `resolveWasmType` externref arm's step-13 default), while
  // `typeof` on the same value already answered `"function"` — so the module
  // contradicted itself about one value. `built-ins/Function/S15.3.5_A1_T1.js`
  // and `_T2.js` are that contradiction verbatim.
  //
  // `deferOrStandalone`, not an unconditional return: in HOST mode a value of
  // this type may be a genuine host function the real `Object.prototype
  // .toString` already tags correctly, and a `Function`-typed binding is the
  // one shape a test is most likely to point at `Function.prototype` (whose
  // own §20.2.3 tag the `.prototype` arm above already resolves). Keeping host
  // on its existing route makes this slice standalone-only by construction.
  //
  // The same three symbol names `isFunctionValuedReceiverType`
  // (function-intrinsic-carrier.ts) accepts, for the same reason: `Function`
  // is what `new Function(…)` is typed as, and `CallableFunction` /
  // `NewableFunction` are its `strictBindCallApply` variants.
  if (symName === "Function" || symName === "CallableFunction" || symName === "NewableFunction") {
    return deferOrStandalone("Function");
  }

  // Bare primitives (string / number / boolean *types*, not wrapper objects) →
  // §20.1.3.6 boxes them to the matching wrapper tag. Host resolves this
  // precisely; standalone emits the static tag.
  if (isStringType(nn)) return deferOrStandalone("String");
  if (isNumberType(nn)) return deferOrStandalone("Number");
  if (isBooleanType(nn)) return deferOrStandalone("Boolean");

  // Everything else (plain objects, class instances, @@toStringTag objects,
  // unresolved shapes). Host → defer so it computes the spec-correct tag
  // including the step-14/15 @@toStringTag override. Standalone → emit the
  // §20.1.3.6 step-13 default "Object" for object-shaped receivers (no host
  // @@toStringTag resolution exists there yet; still better than a hard CE),
  // else give up (undefined → caller's standalone refuse-loud path).
  const wasm = resolveWasmType(ctx, nn);
  if (wasm.kind === "ref" || wasm.kind === "ref_null" || wasm.kind === "externref") {
    if (proof) proof.unprovenDefault = true;
    return deferOrStandalone("Object");
  }
  if ((nn.flags & ts.TypeFlags.Object) !== 0) {
    if (proof) proof.unprovenDefault = true;
    return deferOrStandalone("Object");
  }
  return undefined;
}
