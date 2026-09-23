// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster E, slice E4) Real §23.2.2.1 `%TypedArray%.from` / §23.2.2.2
 * `%TypedArray%.of` BODIES for the first-class function VALUE.
 *
 * ## What was missing
 *
 * `%TypedArray%.from` / `.of` already exist as VALUES: the intrinsic carrier
 * (`emitTypedArrayIntrinsicCtorObject`, `array-object-proto.ts`) seeds them as
 * §17 function-valued own properties whose closures come from
 * `ensureStandaloneNativeMethodClosure(brand, member, "method",
 * {refusalBodyFallback: true})`. `refusalBodyFallback` is exactly the "no native
 * body is wired" degrade, so INVOKING either value threw
 * "…is not yet implemented in --target standalone" — the E3 triage measured
 * that the `.call` plumbing works and the BODY is the hole.
 *
 * The compile-time lowerings that do work are spelling-bound: the static
 * `Float64Array.of(1, 2)` arm in `call-builtin-static.ts`, and the runtime
 * two-arm `tryEmitTaStaticOfFrom` (`call-receiver-method.ts`) for
 * `TA.from(src)` where the call is syntactically a call. Neither can serve
 * `TA.of.call(ctor, 42)`, `var of = TA.of; of()`, or any other shape that reads
 * the method as a VALUE first — which is what `TypedArrayConstructors/{from,of}/**`
 * is almost entirely made of.
 *
 * ## The shape of the body
 *
 * Both members reduce to the same three steps once the source has been
 * normalized to an INDEXABLE CARRIER (anything `__extern_length` /
 * `__extern_get_idx` read):
 *
 *   1. §23.2.2.1 step 2 / §23.2.2.2 step 4 — `IsConstructor(C)`, C = `this`.
 *   2. TypedArrayCreate(C, «len»)  — `Construct(C, «len»)` + ValidateTypedArray
 *      + the "smaller than requested" check.
 *   3. `Set(newObj, k, carrier[k], true)` for every k.
 *
 * …and step 2 has TWO implementations, because standalone represents a
 * TypedArray constructor three different ways:
 *
 *   - a `$__ta_ctor` struct (the `testWithTypedArrayConstructors` loop value),
 *   - the identity-stable `ctor:Int8Array` `$Object` carrier (#4490 wave 2),
 *   - the `%TypedArray%` INTRINSIC `$Object` carrier (§23.2.1).
 *
 * For those three the existing shared native `__ta_from_arraylike(ctor,
 * carrier)` already IS steps 2+3 — it builds a same-kind `$__ta_dyn_view`,
 * ToNumber's and byte-encodes every element, and (kind < 0) raises the
 * abstract-constructor TypeError at the point §23.2.2.1 puts it, which is why
 * E2 routed the intrinsic through it rather than refusing earlier. Reusing it
 * keeps the VALUE path and the CALL-SITE path answering identically by
 * construction instead of by review.
 *
 * Everything else — a user `function ctor(len) { return new TA(len); }` — is an
 * ORDINARY [[Construct]], so it goes through the `__native_construct_1` driver
 * (#3981) that the dynamic-`new` lowering already uses, followed by an explicit
 * ValidateTypedArray and the §10.4.5.5 element writes via `__extern_set`.
 *
 * ## Why `IsConstructor` is a DISJUNCTION, not just `__reflect_is_constructor`
 *
 * `__reflect_is_constructor` answers for ordinary callables. The three carriers
 * above are not callables at all — a `$__ta_ctor` is a two-i32 struct and the
 * other two are `$Object`s — so the predicate declines for them. Taking that
 * decline literally would make `TypedArray.of.call(Float64Array, 1)` throw at
 * step 4, and (worse) would make `TypedArray.from(badIterable)` surface the
 * abstract-constructor TypeError BEFORE the drain, re-opening exactly the
 * ordering defect E2 closed. So the three carrier identities are OR'd in, and
 * the intrinsic's own TypeError is left to `__ta_from_arraylike`'s kind < 0 arm.
 *
 * ## Standalone only
 *
 * Every dependency (`__ta_from_arraylike`, the object runtime, the native
 * construct driver, native JS errors) is a `noJsHost` construct. A missing
 * dependency DECLINES (returns null), which restores the pre-E4 refusal body
 * rather than half-implementing the step.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import {
  buildInt8ArrayCarrierMatch,
  ensureTaFromArrayLikeHelper,
  explicitUndefinedExternTestInstrs,
  isViewRefTestInstrs,
  nullishOrUndefinedExternTestInstrs,
} from "./dataview-native.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { getArrTypeIdxFromVec, taCtorIdentityTestInstrs } from "./registry/types.js";
import { buildTypedArrayIntrinsicCarrierMatch, taStaticFromOfSingletonInstrs } from "./ta-static-from-of-spec.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";
import { reserveNativeConstructDriver } from "./native-construct.js";
import { armConstructIsConstructorGuard } from "./construct-is-constructor-guard.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureNativeArrayFromIterN } from "./iterator-native.js";
import { ensureStandaloneNativeMethodClosure } from "./native-proto.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";

const EXTERNREF: ValType = { kind: "externref" };

/** The two §23.2.2 statics this module gives a real body. */
export function isTaStaticFromOfMember(member: string): boolean {
  return member === "from" || member === "of";
}

/** §17 `length`: `%TypedArray%.from` is 1, `%TypedArray%.of` is 0. */
export function taStaticFromOfSpecLength(member: string): number | undefined {
  return member === "from" ? 1 : member === "of" ? 0 : undefined;
}

/**
 * BOTH members take the packed `(self, thisValue, argsVec)` ABI. `of` because
 * `( ...items )` is genuinely variadic; `from` because §23.2.2.1 step 3 turns on
 * whether `mapfn` was SUPPLIED. Through fixed param slots an omitted trailing
 * argument arrives as `ref.null.extern`, which is also JS `null`, so a
 * three-slot `from` could not tell `from.call(C, src)` (map nothing) from
 * `from.call(C, src, null)` (TypeError) — the vector's length can. `.length`
 * (1 / 0) is unaffected: it reads the spec arity, never the func type.
 */
export function taStaticFromOfIsVariadic(member: string): boolean {
  return isTaStaticFromOfMember(member);
}

/**
 * Emit `carrier = <a fresh $ObjVec holding every element of the closure's
 * packed args vector>` — §23.2.2.2's `items`.
 *
 * The copy is deliberate. The closure's own `(ref null $vec_externref)` is a
 * DIFFERENT GC type from the object runtime's `$ObjVec`, and both
 * `__ta_from_arraylike` and `__extern_get_idx` read the latter; rebuilding
 * through `__objvec_new`/`__objvec_push` gives one carrier shape that every
 * downstream consumer already understands, instead of teaching each of them a
 * second geometry.
 */
function emitArgsVecToCarrier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argsVecParamIdx: number,
  vecTypeIdx: number,
  carrierLocal: number,
): void {
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);

  const nLocal = allocLocal(fctx, `__tasv_n_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = allocLocal(fctx, `__tasv_i_${fctx.locals.length}`, { kind: "i32" });
  const dataLocal = allocLocal(fctx, `__tasv_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });

  fctx.body.push({ op: "call", funcIdx: newIdx }, { op: "local.set", index: carrierLocal });
  fctx.body.push({ op: "local.get", index: argsVecParamIdx }, { op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [
      { op: "local.get", index: argsVecParamIdx },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: nLocal },
      { op: "local.get", index: argsVecParamIdx },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: dataLocal },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iLocal },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: iLocal },
              { op: "local.get", index: nLocal },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: carrierLocal },
              { op: "local.get", index: dataLocal },
              { op: "ref.as_non_null" },
              { op: "local.get", index: iLocal },
              { op: "array.get", typeIdx: arrTypeIdx },
              { op: "call", funcIdx: pushIdx },
              { op: "local.get", index: iLocal },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iLocal },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * §23.2.4.6 TypedArrayCreate(C, «len») + the element writes, for a C that is
 * NOT one of the three recognized TypedArray-constructor carriers — i.e. an
 * ordinary user constructor, the `custom-ctor` family.
 *
 * Returns the instruction list; `newObjLocal` holds the result on exit.
 */
function buildOrdinaryTypedArrayCreateAndFill(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: {
    recvLocal: number;
    carrierLocal: number;
    constructIdx: number;
    externLenIdx: number;
    externSetIdx: number;
    externGetIdxIdx: number;
    boxNumIdx: number;
  },
  mapping?: FromMapping,
): Instr[] {
  const { recvLocal, carrierLocal, constructIdx, externLenIdx, externSetIdx, externGetIdxIdx, boxNumIdx } = deps;
  const lenLocal = allocLocal(fctx, `__tatc_len_${fctx.locals.length}`, { kind: "f64" });
  const newObjLocal = allocLocal(fctx, `__tatc_obj_${fctx.locals.length}`, EXTERNREF);
  const newAnyLocal = allocLocal(fctx, `__tatc_any_${fctx.locals.length}`, { kind: "anyref" });
  const kLocal = allocLocal(fctx, `__tatc_k_${fctx.locals.length}`, { kind: "i32" });
  const nLocal = allocLocal(fctx, `__tatc_n_${fctx.locals.length}`, { kind: "i32" });

  // A FACTORY, not a shared array: the same shape is spliced into two arms of
  // one body, and aliasing one `Instr[]` across both would double-remap on a
  // later import shift (the discipline `ta-ctor-meta.ts` records for `keyIs`).
  const notATypedArray = (): Instr[] =>
    buildThrowJsErrorInstrs(
      ctx,
      "TypeError",
      "TypeError: TypedArrayCreate: the constructor did not return a TypedArray of the requested length",
    );

  return [
    // len = LengthOfArrayLike(carrier)
    { op: "local.get", index: carrierLocal },
    { op: "call", funcIdx: externLenIdx },
    { op: "local.set", index: lenLocal },
    // §23.2.4.6 step 1 — Construct(C, «len»). `proto` null lets the driver read
    // `C.prototype` itself, which is the ordinary-[[Construct]] contract.
    { op: "local.get", index: recvLocal },
    { op: "ref.null.extern" },
    { op: "local.get", index: lenLocal },
    { op: "call", funcIdx: boxNumIdx },
    { op: "call", funcIdx: constructIdx },
    { op: "local.set", index: newObjLocal },
    { op: "local.get", index: newObjLocal },
    { op: "any.convert_extern" },
    { op: "local.set", index: newAnyLocal },
    // step 2 — ValidateTypedArray, and step 3's "smaller than requested" check.
    ...isViewRefTestInstrs(ctx, newAnyLocal),
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: notATypedArray(),
    },
    { op: "local.get", index: newObjLocal },
    { op: "call", funcIdx: externLenIdx },
    { op: "local.get", index: lenLocal },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: notATypedArray(),
    },
    // Set(newObj, ToString(k), carrier[k], true) for every k.
    { op: "local.get", index: lenLocal },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: nLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: kLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: kLocal },
            { op: "local.get", index: nLocal },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: newObjLocal },
            { op: "local.get", index: kLocal },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: boxNumIdx },
            { op: "local.get", index: carrierLocal },
            { op: "local.get", index: kLocal },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdxIdx },
            ...(mapping ? mapKValueInstrs(ctx, fctx, mapping, kLocal, boxNumIdx) : []),
            { op: "call", funcIdx: externSetIdx },
            { op: "local.get", index: kLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: kLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: newObjLocal },
  ];
}

/** (#6651 E5) §23.2.2.1's `mapping` flag and the two values step 3 unpacked. */
interface FromMapping {
  mappingLocal: number;
  mapfnLocal: number;
  thisArgLocal: number;
}

/**
 * (#6651 E5) `kValue` on the stack → `mapping ? Call(mapfn, thisArg, « kValue,
 * 𝔽(k) ») : kValue` — exactly two arguments, the §23.2.2.1 step 7.e.iii /
 * 11.c call, made for element k right before that element's Set.
 */
function mapKValueInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  m: FromMapping,
  kLocal: number,
  boxNumIdx: number,
): Instr[] {
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const vLocal = allocLocal(fctx, `__tatc_kv_${fctx.locals.length}`, EXTERNREF);
  const argsLocal = allocLocal(fctx, `__tatc_margs_${fctx.locals.length}`, EXTERNREF);
  return [
    { op: "local.set", index: vLocal },
    { op: "local.get", index: m.mappingLocal },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        { op: "call", funcIdx: newIdx },
        { op: "local.set", index: argsLocal },
        { op: "local.get", index: argsLocal },
        { op: "local.get", index: vLocal },
        { op: "call", funcIdx: pushIdx },
        { op: "local.get", index: argsLocal },
        { op: "local.get", index: kLocal },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: boxNumIdx },
        { op: "call", funcIdx: pushIdx },
        { op: "local.get", index: m.mapfnLocal },
        { op: "local.get", index: m.thisArgLocal },
        { op: "local.get", index: argsLocal },
        { op: "call", funcIdx: applyIdx },
      ],
      else: [{ op: "local.get", index: vLocal }],
    },
  ];
}

/**
 * §23.2.2.1 steps 3–6 for the VALUE body: unpack `(source, mapfn, thisArg)`
 * from the packed args vector, gate `mapfn`, and leave `carrierLocal` holding
 * an indexable carrier of the UNMAPPED source values (E5: mapping happens per
 * element, after TypedArrayCreate — see `ensureTaFromArrayLikeMappedHelper`).
 *
 * Step 3 is `If mapfn is not undefined and IsCallable(mapfn) is false, throw`,
 * BEFORE step 4's `@@iterator` GET (`mapfn-is-not-callable.js` counts that GET).
 * Arguments the caller did not pass are padded with `undefined`, so an omitted
 * `mapfn` maps nothing while an explicit `null` throws — the distinction a
 * fixed-slot ABI (omitted slot = `ref.null.extern` = JS `null`) cannot make.
 */
function emitFromSourceToCarrier(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecTypeIdx: number,
  undefinedInstrs: Instr[],
  carrierLocal: number,
): FromMapping {
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const iterNIdx = ensureNativeArrayFromIterN(ctx);
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  const nLocal = allocLocal(fctx, `__tasf_n_${fctx.locals.length}`, { kind: "i32" });
  const argLocals = ["src", "mapfn", "this"].map((n) =>
    allocLocal(fctx, `__tasf_${n}_${fctx.locals.length}`, EXTERNREF),
  );
  const [srcLocal, mapfnLocal, thisArgLocal] = argLocals as [number, number, number];
  const argsVec = 2;
  fctx.body.push(
    { op: "local.get", index: argsVec },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: argsVec },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      ],
    },
    { op: "local.set", index: nLocal },
  );
  argLocals.forEach((local, i) =>
    fctx.body.push(
      { op: "local.get", index: nLocal },
      { op: "i32.const", value: i },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: EXTERNREF },
        then: [
          { op: "local.get", index: argsVec },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
          { op: "i32.const", value: i },
          { op: "array.get", typeIdx: arrTypeIdx },
        ],
        else: [...undefinedInstrs],
      },
      { op: "local.set", index: local },
    ),
  );
  // mapping = mapfn is not undefined (a padded omission reads as undefined).
  const mappingLocal = allocLocal(fctx, `__tasf_mapping_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(...explicitUndefinedExternTestInstrs(ctx, mapfnLocal), { op: "i32.eqz" });
  fctx.body.push({ op: "local.set", index: mappingLocal });
  if (typeofFunctionIdx !== undefined) {
    fctx.body.push(
      { op: "local.get", index: mappingLocal },
      { op: "local.get", index: mapfnLocal },
      { op: "call", funcIdx: typeofFunctionIdx },
      { op: "i32.eqz" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "TypeError", "TypeError: %TypedArray%.from mapfn is not a function"),
      },
    );
  }
  // Step 5 `GetMethod(source, @@iterator)` is a GetV, which throws for a
  // nullish source — the iterable drain below would read it as empty.
  fctx.body.push(...nullishOrUndefinedExternTestInstrs(ctx, srcLocal), {
    op: "if",
    blockType: { kind: "empty" },
    then: buildThrowJsErrorInstrs(ctx, "TypeError", "TypeError: %TypedArray%.from source is null or undefined"),
  });
  // (#6651 E5) The source is normalized WITHOUT mapping: §23.2.2.1 maps inside
  // the element loop that follows TypedArrayCreate, one Set at a time (see
  // `ensureTaFromArrayLikeMappedHelper`), never over the whole list up front.
  fctx.body.push(
    { op: "local.get", index: srcLocal },
    { op: "f64.const", value: -1 },
    { op: "call", funcIdx: iterNIdx },
    { op: "local.set", index: carrierLocal },
  );
  return { mappingLocal, mapfnLocal, thisArgLocal };
}

/**
 * The real §23.2.2.1 / §23.2.2.2 body. `fctx` is the native-proto closure
 * context: param 0 is the closure self, param 1 is `this` (C), and the
 * last param is the packed JS argument vector (both members are variadic).
 *
 * Returns the result ValType, or `null` to DECLINE — which leaves the caller's
 * pre-E4 `refusalBodyFallback` in charge rather than emitting half a step.
 */
export function emitTaStaticFromOfBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  if (!noJsHost(ctx)) return null;
  if (!isTaStaticFromOfMember(member)) return null;
  // Register the carrier arms' natives FIRST, before any index below is
  // resolved or any instruction pushed; their later calls are cache hits.
  if (member === "of") {
    ensureObjVecBuilders(ctx);
  } else {
    ensureNativeArrayFromIterN(ctx);
    ensureObjVecBuilders(ctx);
    reserveApplyClosure(ctx);
  }

  const taFromIdx = ensureTaFromArrayLikeHelper(ctx);
  if (taFromIdx === undefined) return null;
  const taFromMappedIdx = member === "from" ? ensureTaFromArrayLikeMappedHelper(ctx) : undefined;
  if (member === "from" && taFromMappedIdx === undefined) return null;
  ensureObjectRuntime(ctx);
  const externLenIdx = ctx.funcMap.get("__extern_length");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  const boxNumIdx = ctx.funcMap.get("__box_number");
  if (
    externLenIdx === undefined ||
    externSetIdx === undefined ||
    externGetIdxIdx === undefined ||
    boxNumIdx === undefined
  ) {
    return null;
  }

  // EVERY decline has to happen before the first `fctx.body.push`: the caller
  // falls through to the refusal emitter on a null return, and a half-emitted
  // prefix would be spliced in front of it. So the param-shape checks the two
  // arms below depend on are made here, not where they are used.
  const argsVecTypeIdx = ((): number | undefined => {
    const t = fctx.params[2]?.type;
    if (!t || (t.kind !== "ref" && t.kind !== "ref_null")) return undefined;
    return t.typeIdx;
  })();
  if (argsVecTypeIdx === undefined || getArrTypeIdxFromVec(ctx, argsVecTypeIdx) < 0) return null;
  // `from`'s omitted arguments are `undefined` (§10.2.1 argument padding), and
  // "is it undefined?" is the §23.2.2.1 step 3 predicate. Both reserve the
  // `$AnyValue` type, so they are resolved here, before the first push.
  const undefinedInstrs = canonicalUndefinedExternInstrs(ctx);

  // The ordinary-[[Construct]] driver for a custom `this`. Reserved (not
  // called) exactly like every dynamic-`new` site: the body is filled at
  // finalize over the complete closure-shape table. `armConstructIsConstructorGuard`
  // is what makes that driver throw §13.3.5.1's TypeError for a callee with no
  // [[Construct]] rather than quietly returning an object.
  addStringConstantGlobal(ctx, "prototype");
  armConstructIsConstructorGuard(ctx, fctx);
  const constructIdx = reserveNativeConstructDriver(ctx, 1, stringConstantExternrefInstrs(ctx, "prototype"));
  const isCtorIdx = ensureReflectIsConstructor(ctx);

  const recvLocal = 1;
  const cAnyLocal = allocLocal(fctx, `__tast_c_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push(
    { op: "local.get", index: recvLocal },
    { op: "any.convert_extern" },
    { op: "local.set", index: cAnyLocal },
  );

  // ── §23.2.2.1 step 2 / §23.2.2.2 step 4 — IsConstructor(C) ───────────────
  // A DISJUNCTION, because the three TypedArray-constructor carriers are not
  // callables and `__reflect_is_constructor` correctly declines for them.
  const markCtor = (local: number): Instr[] => [
    { op: "i32.const", value: 1 },
    { op: "local.set", index: local },
  ];
  const isCtorLocal = allocLocal(fctx, `__tast_isctor_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: recvLocal }, { op: "call", funcIdx: isCtorIdx });
  fctx.body.push(...taCtorIdentityTestInstrs(ctx, [{ op: "local.get", index: cAnyLocal }]));
  fctx.body.push({ op: "i32.or" }, { op: "local.set", index: isCtorLocal });
  fctx.body.push(...buildInt8ArrayCarrierMatch(ctx, cAnyLocal, markCtor(isCtorLocal)));
  fctx.body.push(...buildTypedArrayIntrinsicCarrierMatch(ctx, cAnyLocal, markCtor(isCtorLocal)));
  fctx.body.push(
    { op: "local.get", index: isCtorLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", `TypeError: %TypedArray%.${member} called on a non-constructor`),
    },
  );

  // Which arm builds the result: the shared `__ta_from_arraylike` for a
  // recognized TypedArray constructor (including the abstract intrinsic, whose
  // TypeError that helper raises at the spec's point), the ordinary
  // [[Construct]] path otherwise.
  const taIshLocal = allocLocal(fctx, `__tast_taish_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(...taCtorIdentityTestInstrs(ctx, [{ op: "local.get", index: cAnyLocal }]));
  fctx.body.push({ op: "local.set", index: taIshLocal });
  fctx.body.push(...buildInt8ArrayCarrierMatch(ctx, cAnyLocal, markCtor(taIshLocal)));
  fctx.body.push(...buildTypedArrayIntrinsicCarrierMatch(ctx, cAnyLocal, markCtor(taIshLocal)));

  // ── The source → indexable carrier ───────────────────────────────────────
  const carrierLocal = allocLocal(fctx, `__tast_carrier_${fctx.locals.length}`, EXTERNREF);
  let mapping: FromMapping | undefined;
  if (member === "of") {
    emitArgsVecToCarrier(ctx, fctx, 2, argsVecTypeIdx, carrierLocal);
  } else {
    mapping = emitFromSourceToCarrier(ctx, fctx, argsVecTypeIdx, undefinedInstrs, carrierLocal);
  }

  // ── TypedArrayCreate + the element writes ────────────────────────────────
  const ordinaryArm = buildOrdinaryTypedArrayCreateAndFill(
    ctx,
    fctx,
    { recvLocal, carrierLocal, constructIdx, externLenIdx, externSetIdx, externGetIdxIdx, boxNumIdx },
    mapping,
  );
  const taArm: Instr[] = [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: carrierLocal },
    { op: "call", funcIdx: taFromIdx },
  ];
  fctx.body.push({ op: "local.get", index: taIshLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    // (#6651 E5) A mapping `from` maps per element inside the shared helper.
    then:
      mapping && taFromMappedIdx !== undefined
        ? [
            { op: "local.get", index: mapping.mappingLocal },
            {
              op: "if",
              blockType: { kind: "val", type: EXTERNREF },
              then: [
                { op: "local.get", index: recvLocal },
                { op: "local.get", index: carrierLocal },
                { op: "local.get", index: mapping.mapfnLocal },
                { op: "local.get", index: mapping.thisArgLocal },
                { op: "call", funcIdx: taFromMappedIdx },
              ],
              else: taArm,
            },
          ]
        : taArm,
    else: ordinaryArm,
  });
  return EXTERNREF;
}

/**
 * (#6651 E5) `__ta_from_arraylike_mapped(ctor, carrier, mapfn, thisArg)` — the
 * mapping twin of `__ta_from_arraylike`, for a recognized TypedArray `ctor`.
 *
 * §23.2.2.1 maps INSIDE the element loop that runs AFTER TypedArrayCreate:
 * `mappedValue = ? Call(mapfn, thisArg, « kValue, 𝔽(k) »)` then
 * `? Set(targetObj, Pk, mappedValue, true)`, one element at a time. The old
 * lowering mapped the whole source up front through `__array_from_mapped`
 * (= `__hof_map`), which is wrong three ways, each a test262 row:
 *  - the callback got `Array.prototype.map`'s THREE arguments
 *    (`from/mapfn-arguments.js`: `arguments.length` 3, spec 2);
 *  - every mapfn call ran before the FIRST element's ToNumber, so an abrupt
 *    ToNumber on element k no longer stopped the mapping of k+1
 *    (`from/set-value-abrupt-completion.js`: `lastValue` was the last element);
 *  - the abstract `%TypedArray%` TypeError came after every mapfn call.
 * Splicing the call into the shared helper's loop — between the carrier read
 * and the ToNumber that IS that element's Set — gives the spec's interleaving
 * without a second copy of the element codec. The fresh view is not reachable
 * from `mapfn`, so writing it at the end is unobservable.
 */
export function ensureTaFromArrayLikeMappedHelper(ctx: CodegenContext): number | undefined {
  if (!noJsHost(ctx)) return undefined;
  const existing = ctx.funcMap.get("__ta_from_arraylike_mapped");
  if (existing !== undefined) return existing;
  // Every dependency is registered BEFORE the helper mints its index; the hook
  // below only reads them.
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const boxNumIdx = ctx.funcMap.get("__box_number");
  if (boxNumIdx === undefined) return undefined;
  return ensureTaFromArrayLikeHelper(ctx, {
    helperName: "__ta_from_arraylike_mapped",
    extraParams: ["mapfn", "thisArg"], // params 2, 3
    mapElement: (fctx, iLocal) => {
      const vLocal = allocLocal(fctx, "mapK", EXTERNREF);
      const argsLocal = allocLocal(fctx, "mapArgs", EXTERNREF);
      fctx.body.push(
        { op: "local.set", index: vLocal },
        { op: "call", funcIdx: newIdx },
        { op: "local.set", index: argsLocal },
        { op: "local.get", index: argsLocal },
        { op: "local.get", index: vLocal },
        { op: "call", funcIdx: pushIdx },
        { op: "local.get", index: argsLocal },
        { op: "local.get", index: iLocal },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: boxNumIdx },
        { op: "call", funcIdx: pushIdx },
        { op: "local.get", index: 2 },
        { op: "local.get", index: 3 },
        { op: "local.get", index: argsLocal },
        { op: "call", funcIdx: applyIdx },
      );
    },
  });
}

/**
 * (#6651 E5) `<ConcreteTA>.from` / `.of` read as a VALUE from the constructor
 * NAME — `Int32Array.from.call(C, …)`. §23.2.6 makes the concrete constructor
 * inherit both from `%TypedArray%`, so the answer is the intrinsic's own
 * singleton (`Int32Array.from === TypedArray.from`). E4's inherited-value arm
 * only answers a DYNAMIC read on a constructor VALUE, and deliberately never
 * mints (it runs at finalize); this static spelling is compiled in a function
 * body, where minting the closure is the ordinary reserve-time operation — the
 * one `emitTypedArrayIntrinsicCtorObject` performs when it seeds the carrier.
 * Returns `undefined` (nothing pushed) to decline.
 */
export function emitTaStaticFromOfInheritedValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  intrinsicBrand: number | undefined,
  member: string,
): ValType | undefined {
  if (!ctx.standalone || intrinsicBrand === undefined || !isTaStaticFromOfMember(member)) return undefined;
  const closure = ensureStandaloneNativeMethodClosure(ctx, intrinsicBrand, member, "method", {
    refusalBodyFallback: true,
  });
  if (!closure) return undefined;
  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, closure));
  return closure.type;
}

/**
 * (#6651 E4) The `__extern_get` receiver arm that makes §23.2.2's `from` / `of`
 * INHERITED by every concrete TypedArray constructor. Returns the instructions
 * to `unshift` onto `__extern_get`'s body (and registers the locals it needs on
 * `getFn`), or `[]` to decline.
 *
 * A SEPARATE front-spliced arm rather than two more keys in the existing
 * `$__ta_ctor` arm of `fillTaDynViewMopArms`, for two reasons.
 *
 *  1. That arm casts the receiver to `$__ta_ctor` to read its `kind`. The
 *     Int8Array constructor is NOT one — it is the identity-stable `$Object`
 *     carrier (#4490 wave 2) — so it has to reach these keys without the cast.
 *     `testWithTypedArrayConstructors` loops over all nine constructors, so an
 *     arm that serves eight of them is an arm that fails the row.
 *  2. It must answer through `__extern_get` ONLY, never
 *     `__builtinfn_get_meta`. Claiming a key in `get_meta` is precisely what
 *     makes `hasOwnProperty` true — `ta-ctor-meta.ts` says so where it claims
 *     `prototype` — and `inherited.js`'s second assertion is
 *     `TA.hasOwnProperty("of") === false`. Answering the VALUE while leaving
 *     the OWN-key surface untouched IS the inheritance.
 *
 * KNOWN NARROWING, stated rather than hidden: the arm sits in FRONT of the
 * receiver's own-property lookup, so a user `Int8Array.of = f` — §23.2.2 makes
 * these properties writable, and writing one on a concrete constructor creates
 * a SHADOWING own property — would be masked by the inherited value. Nothing in
 * this family writes one, and the alternative is a `__hasOwnProperty` call on
 * every dynamic constructor property read.
 */
export function buildTaCtorInheritedFromOfGetArm(
  ctx: CodegenContext,
  getFn: WasmFunction,
  toPropertyKeyIdx: number,
  anyStrTypeIdx: number,
  keyIs: (keyLocal: number, literal: string) => Instr[],
): Instr[] {
  const members = (["from", "of"] as const)
    .map((m) => ({ m, instrs: taStaticFromOfSingletonInstrs(ctx, m) }))
    .filter((e): e is { m: "from" | "of"; instrs: Instr[] } => e.instrs !== undefined);
  if (members.length === 0) return [];

  const base = 2 + getFn.locals.length;
  const anyLocal = base;
  const keyLocal = base + 1;
  const hitLocal = base + 2;
  getFn.locals.push(
    { name: "__tasfo_any", type: { kind: "anyref" } },
    { name: "__tasfo_key", type: { kind: "externref" } },
    { name: "__tasfo_hit", type: { kind: "i32" } },
  );

  const armBody: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: toPropertyKeyIdx },
    { op: "local.set", index: keyLocal },
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: members.flatMap(({ m, instrs }): Instr[] => [
        ...keyIs(keyLocal, m),
        { op: "if", blockType: { kind: "empty" }, then: [...instrs, { op: "return" }] },
      ]),
    },
  ];

  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
    ...taCtorIdentityTestInstrs(ctx, [{ op: "local.get", index: anyLocal }]),
    { op: "local.set", index: hitLocal },
    ...buildInt8ArrayCarrierMatch(ctx, anyLocal, [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: hitLocal },
    ]),
    { op: "local.get", index: hitLocal },
    { op: "if", blockType: { kind: "empty" }, then: armBody },
  ];
}
