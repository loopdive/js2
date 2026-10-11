// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771 S2) Array-like trio arms for two exotic operands, `--target standalone`.
 *
 * Every borrowed §23.1.3 generic and the §23.1.3.1 concat spec loop read an
 * operand through three natives: `__extern_length` (LengthOfArrayLike),
 * `__extern_get_idx` (Get of `ToString(k)`) and `__extern_has_idx`
 * (HasProperty of `ToString(k)`). Their ladders recognise vecs, `$ObjVec`s,
 * array-like `$Object`s, closed structs and proxies; two object kinds fell off
 * the end and answered `0` / `undefined` / `false`:
 *
 *  - a CLOSURE (a function object). §10.2.x: its `length` is the arity (an own
 *    data property) and its index keys are ordinary expandos or inherited from
 *    `Function.prototype`. `__extern_get` already answers all of that for a
 *    closure (the #2896 arity metadata, the closure bag, the Function-brand
 *    companion), so the arm DELEGATES by key, exactly as the `$Object` arm does:
 *    `[].concat(fn)` with `fn[@@isConcatSpreadable] = true` spread nothing
 *    (`concat/Array.prototype.concat_spreadable-function.js`);
 *  - a STRING WRAPPER (`new String(s)`, a `$Object` carrying [[StringData]] in
 *    its `[[PrimitiveValue]]` slot). §10.4.3: `length` is the string's length
 *    and every in-range integer index is an own property — neither is a table
 *    entry, so the ordinary `$Object` arm read `length` as `undefined` → 0
 *    (`concat/Array.prototype.concat_spreadable-string-wrapper.js`,
 *    `Array.prototype.forEach.call(new String("abc"), f)`). The index READ
 *    already works — `__extern_get`'s String-exotic arm answers canonical index
 *    keys — so only `length` and HasProperty get an arm here.
 *
 * Spliced FRONT at finalize (after every closure type and the wrapper-slot
 * helper exist), the same discipline as `ta-dyn-mop.ts`'s `__extern_length`
 * arm. A module with neither a closure nor the wrapper helper keeps its bytes.
 */
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { BUILTIN_INSTANCE_CARRIER_STRUCT_NAMES } from "../builtin-instance-key-presence.js";
import { collectClosureBaseWrapperTypeIdxs } from "../closure-classifier.js";
import { definedFuncAt } from "../func-space.js";
import { nativeStringLiteralInstrs } from "../native-string-literals.js";
import { buildArrayLikeToLengthFromExternref } from "../helpers/core-delegates.js"; // (#6797) late-bound core

const ANYREF: ValType = { kind: "anyref" };

/** The native named `name`, if the module has it. */
function nativeFn(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const idx = ctx.funcMap.get(name);
  return idx === undefined ? undefined : definedFuncAt(ctx, idx);
}

/** Append a scratch local to `fn` and return its index. */
function appendLocal(fn: WasmFunction, numParams: number, name: string, type: ValType): number {
  fn.locals.push({ name, type });
  return numParams + fn.locals.length - 1;
}

/**
 * `local.get v; any.convert_extern; local.set any` then one `ref.test` arm per
 * closure root, each with FRESH `onMatch` instructions (an aliased subtree
 * would be shifted twice by the funcIdx fixups).
 */
function closureArms(roots: readonly number[], anyLocal: number, onMatch: () => Instr[]): Instr[] {
  const out: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
  ];
  for (const root of roots) {
    out.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: root },
      { op: "if", blockType: { kind: "empty" }, then: onMatch() },
    );
  }
  return out;
}

/** `ToString(idx)` of the f64 index in param 1 (canonical integer key). */
function indexKey(numberToStringIdx: number): Instr[] {
  return [{ op: "local.get", index: 1 }, { op: "f64.trunc" }, { op: "call", funcIdx: numberToStringIdx }];
}

/**
 * Every carrier whose array-like view is its ordinary `[[Get]]`: closure roots,
 * and the builtin-instance carriers (#4010: RegExp / Date / Promise — their
 * expandos live in the identity-keyed bag `__extern_get` reads, and
 * `RegExp.prototype[0]` on the brand companion it walks). `var re = /abc/;
 * re[0] = 1, re.length = 3` with `re[@@isConcatSpreadable] = true` spread
 * nothing (`concat/Array.prototype.concat_spreadable-reg-exp.js`).
 */
function delegatingCarrierTypeIdxs(ctx: CodegenContext): number[] {
  const out = collectClosureBaseWrapperTypeIdxs(ctx);
  for (const name of BUILTIN_INSTANCE_CARRIER_STRUCT_NAMES) {
    const idx = ctx.structMap.get(name);
    if (idx !== undefined && !out.includes(idx)) out.push(idx);
  }
  return out;
}

function fillClosureArms(ctx: CodegenContext): void {
  const roots = delegatingCarrierTypeIdxs(ctx);
  const externGet = ctx.funcMap.get("__extern_get");
  const externHas = ctx.funcMap.get("__extern_has");
  const numberToString = ctx.funcMap.get("number_toString");
  if (roots.length === 0 || externGet === undefined || externHas === undefined || numberToString === undefined) {
    return;
  }
  const lenFn = nativeFn(ctx, "__extern_length");
  if (lenFn) {
    // Locals 2/3/4 are the ToLength scratch `__extern_length` registers by name.
    const any = appendLocal(lenFn, 1, "__ale_any", ANYREF);
    lenFn.body.unshift(
      ...closureArms(roots, any, () => [
        { op: "local.get", index: 0 },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "extern.convert_any" },
        { op: "call", funcIdx: externGet },
        ...buildArrayLikeToLengthFromExternref(ctx, ctx.symbolTypeIdx),
        { op: "return" },
      ]),
    );
  }
  const getFn = nativeFn(ctx, "__extern_get_idx");
  if (getFn) {
    const any = appendLocal(getFn, 2, "__ale_any", ANYREF);
    getFn.body.unshift(
      ...closureArms(roots, any, () => [
        { op: "local.get", index: 0 },
        ...indexKey(numberToString),
        { op: "call", funcIdx: externGet },
        { op: "return" },
      ]),
    );
  }
  const hasFn = nativeFn(ctx, "__extern_has_idx");
  if (hasFn) {
    const any = appendLocal(hasFn, 2, "__ale_any", ANYREF);
    hasFn.body.unshift(
      ...closureArms(roots, any, () => [
        { op: "local.get", index: 0 },
        ...indexKey(numberToString),
        { op: "call", funcIdx: externHas },
        { op: "return" },
      ]),
    );
  }
}

/**
 * `sd = [[StringData]](v)` for a `$Object` wrapper (null otherwise) into the
 * appended local; the caller's `then` runs when it is non-null.
 */
function wrapperDataPrologue(objectTypeIdx: number, slotIdx: number, sdLocal: number, then: Instr[]): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: slotIdx },
        { op: "local.tee", index: sdLocal },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then },
      ],
    },
  ];
}

function fillStringWrapperArms(ctx: CodegenContext): void {
  const slotIdx = ctx.funcMap.get("__wrapper_string_value");
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  const anyStr = ctx.anyStrTypeIdx;
  if (slotIdx === undefined || objectTypeIdx === undefined || anyStr < 0) return;
  const sdType: ValType = { kind: "ref_null", typeIdx: anyStr };
  // `$AnyString` field 0 is the length (the String-exotic index arm's bound).
  const strLen = (sd: number): Instr[] => [
    { op: "local.get", index: sd },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyStr, fieldIdx: 0 },
  ];
  const lenFn = nativeFn(ctx, "__extern_length");
  if (lenFn) {
    const sd = appendLocal(lenFn, 1, "__ale_sd", sdType);
    lenFn.body.unshift(
      ...wrapperDataPrologue(objectTypeIdx, slotIdx, sd, [
        ...strLen(sd),
        { op: "f64.convert_i32_s" },
        { op: "return" },
      ]),
    );
  }
  const hasFn = nativeFn(ctx, "__extern_has_idx");
  if (hasFn) {
    // §10.4.3.5 StringGetOwnProperty: an integral index in [0, len) is own.
    // Anything else falls through to the ordinary HasProperty below.
    const sd = appendLocal(hasFn, 2, "__ale_sd", sdType);
    hasFn.body.unshift(
      ...wrapperDataPrologue(objectTypeIdx, slotIdx, sd, [
        { op: "local.get", index: 1 },
        { op: "local.get", index: 1 },
        { op: "f64.trunc" },
        { op: "f64.eq" },
        { op: "local.get", index: 1 },
        { op: "f64.const", value: 0 },
        { op: "f64.ge" },
        { op: "i32.and" },
        { op: "local.get", index: 1 },
        ...strLen(sd),
        { op: "f64.convert_i32_s" },
        { op: "f64.lt" },
        { op: "i32.and" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
      ]),
    );
  }
}

/**
 * (#6771 S2c) The `$__ta_dyn_view` `__extern_length` arm's §10.4.5 answer is
 * the live element count — unless the INSTANCE owns a `"length"` data property
 * (`Object.defineProperty(ta, "length", {value: 4000})`). `"length"` is not a
 * CanonicalNumericIndexString, so §10.4.5.1 [[GetOwnProperty]] is ordinary for
 * it and the own property shadows the `%TypedArray%.prototype` accessor:
 * LengthOfArrayLike reads it (`concat_{large,small}-typed-array.js`). The own
 * property lives in the view's expando bag (field 4, created on first
 * ordinary write). Emitted inside the arm, after the view is cast into
 * `dvLocal`; empty when a helper is missing.
 */
export function taDynViewOwnLengthArm(
  ctx: CodegenContext,
  lenFn: { locals: { name: string; type: ValType }[] },
  dvLocal: number,
  dynIdx: number,
): Instr[] {
  const hasOwn = ctx.funcMap.get("__hasOwnProperty");
  const externGet = ctx.funcMap.get("__extern_get");
  if (hasOwn === undefined || externGet === undefined) return [];
  const exp = 1 + lenFn.locals.length;
  lenFn.locals.push({ name: "__ale_exp", type: { kind: "externref" } });
  const lengthKey = (): Instr[] => [...nativeStringLiteralInstrs(ctx, "length"), { op: "extern.convert_any" }];
  return [
    { op: "local.get", index: dvLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: dynIdx, fieldIdx: 4 },
    { op: "local.tee", index: exp },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: exp },
        ...lengthKey(),
        { op: "call", funcIdx: hasOwn },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: exp },
            ...lengthKey(),
            { op: "call", funcIdx: externGet },
            ...buildArrayLikeToLengthFromExternref(ctx, ctx.symbolTypeIdx),
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** Finalize fill: front arms for closures and String wrappers (standalone only). */
export function fillArrayLikeExoticArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  fillClosureArms(ctx);
  fillStringWrapperArms(ctx);
}
