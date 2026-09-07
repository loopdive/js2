// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#5318 r5) Object-literal ACCESSOR members whose ComputedPropertyName is only
 * known when the literal is evaluated.
 *
 * `literals.ts`'s accessor pre-pass pairs `get x()` with `set x(v)` by resolving
 * each key to a compile-time string (`resolveAccessorPropName`). A key it cannot
 * fold — a symbol-valued variable, a call, `x || "k"` — used to be skipped
 * outright ("arbitrary computed key: out of scope"), so `{ get [s]() {} }`
 * installed NOTHING: the read answered `undefined`, and a later `A[s] = v`
 * quietly created a plain DATA property where the spec has an accessor. Nothing
 * threw; the object simply behaved as if the member had not been written.
 *
 * This is the object-literal twin of the mechanism #5318 r4 built for classes.
 * Two properties carry it:
 *
 *  - **No compile-time pairing.** Only the literal's evaluation knows which key
 *    expressions produce the same property key, so each half installs itself
 *    alone, at its own source position, evaluating its own key exactly once —
 *    which is also what §13.2.5.5 wants (`get [f()]` and `set [f()]` call `f`
 *    twice).
 *  - **Per-half "specified" bits.** The flag word marks WHICH half this call
 *    defines (bits 8/9), so §10.1.6.3 merges it into a live accessor under the
 *    same evaluated key instead of replacing both slots. Without them a
 *    `set [k]` following a `get [k]` blanks the getter — the same defect the
 *    class lane hit (`class-proto-accessors.ts::classAccessorInstallFlags`).
 *
 * A literal whose accessor keys all fold keeps the legacy encoding and its
 * modules are byte-identical on host, wasi and standalone.
 */

import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { allocLocal } from "./context/locals.js";

/**
 * `__defineProperty_accessor` flags for an object-literal accessor:
 * `{enumerable: true, configurable: true}` (writable is N/A for an accessor
 * descriptor) — `computeRuntimeFlags(undefined, true, true, false)` from
 * `object-ops.ts`. Bits: enumerable_specified (1<<4) | enumerable_value (1<<1)
 * | configurable_specified (1<<5) | configurable_value (1<<2).
 */
export const OBJLIT_ACCESSOR_FLAGS = (1 << 4) | (1 << 1) | (1 << 5) | (1 << 2);

/** "This call defines the getter half" — see the module header. */
const ACCESSOR_GET_SPECIFIED = 1 << 8;
/** "This call defines the setter half". */
const ACCESSOR_SET_SPECIFIED = 1 << 9;

/**
 * The literal's accessor halves whose key does NOT fold at compile time, in
 * source order. `resolveKey` is injected (rather than imported from
 * `literals.ts`) to keep this module out of that file's import cycle; callers
 * pass the same `resolveAccessorPropName` the pairing pre-pass used, so the two
 * partitions of the literal's accessors are exactly complementary.
 */
export function collectDynamicAccessorHalves(
  ctx: CodegenContext,
  expr: ts.ObjectLiteralExpression,
  resolveKey: (ctx: CodegenContext, name: ts.PropertyName) => string | undefined,
): ts.AccessorDeclaration[] {
  const out: ts.AccessorDeclaration[] = [];
  for (const p of expr.properties) {
    if (!ts.isGetAccessorDeclaration(p) && !ts.isSetAccessorDeclaration(p)) continue;
    if (resolveKey(ctx, p.name) !== undefined) continue;
    if (!ts.isComputedPropertyName(p.name)) continue;
    out.push(p);
  }
  return out;
}

/**
 * Emit one dynamic-keyed accessor half's install, leaving nothing on the stack.
 *
 * `emitKey` evaluates the ComputedPropertyName to an externref property key;
 * `emitHalf` compiles the accessor function to a callable externref and reports
 * whether it managed to. Both are injected for the same import-cycle reason as
 * {@link collectDynamicAccessorHalves}.
 *
 * On a declined half the key's side effects have already run (spec evaluation
 * order) and the property is simply not defined — the same decline the
 * runtime-keyed METHOD arm takes. A half-written install is NOT an option here:
 * with only one "specified" bit set, a null in the other slot reads as "this
 * half is absent", not "leave the sibling alone".
 */
export function emitDynamicObjectLiteralAccessorHalf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  half: ts.AccessorDeclaration,
  objLocal: number,
  defineAccessorIdx: () => number,
  emitKey: (expression: ts.Expression) => void,
  emitHalf: (half: ts.AccessorDeclaration, isGetter: boolean) => boolean,
): void {
  if (!ts.isComputedPropertyName(half.name)) return;
  const isGetter = ts.isGetAccessorDeclaration(half);
  const push = (instr: Instr): void => {
    fctx.body.push(instr);
  };
  push({ op: "local.get", index: objLocal });
  emitKey(half.name.expression);
  if (!emitHalf(half, isGetter)) {
    push({ op: "drop" });
    push({ op: "drop" });
    return;
  }
  // The stack must read [obj, key, getter|null, setter|null, flags]. A getter
  // half is already in its slot and only needs the null setter after it; a
  // setter half sits in the GETTER slot, so park it and re-push it after the
  // null.
  if (isGetter) {
    push({ op: "ref.null.extern" });
  } else {
    const tmp = allocLocal(fctx, `__objlit_dynset_${fctx.locals.length}`, { kind: "externref" });
    push({ op: "local.set", index: tmp });
    push({ op: "ref.null.extern" });
    push({ op: "local.get", index: tmp });
  }
  push({
    op: "f64.const",
    value: OBJLIT_ACCESSOR_FLAGS | (isGetter ? ACCESSOR_GET_SPECIFIED : ACCESSOR_SET_SPECIFIED),
  });
  push({ op: "call", funcIdx: defineAccessorIdx() });
  push({ op: "drop" }); // the helper returns the target; discard
}

/**
 * §13.2.5.5 PropertyDefinitionEvaluation attributes for a DATA property or a
 * METHOD in an object literal: `{writable: true, enumerable: true,
 * configurable: true}` plus a value — `computeRuntimeFlags(true, true, true,
 * true)` in the `__defineProperty_value` encoding (bits 0/1/2 are the W/E/C
 * VALUES, 3/4/5 "this attribute is specified", 7 "has value").
 */
export const OBJLIT_DATA_DEFINE_FLAGS = (1 << 7) | (1 << 3) | (1 << 0) | (1 << 4) | (1 << 1) | (1 << 5) | (1 << 2);

/**
 * Store one data-property / method member, `[obj, key, value]` already on the
 * stack, leaving nothing behind.
 *
 * `__extern_set` is [[Set]]: under a key that already carries a live accessor
 * it CALLS the setter (and with a getter-only accessor it does nothing at all)
 * instead of replacing the property. That is the wrong verb for an object
 * literal — §13.2.5.5 uses CreateDataPropertyOrThrow, which DEFINES, so a
 * later same-key member overrides the earlier one whatever kind it was.
 *
 * The distinction is only observable once a member of the SAME literal has
 * installed a real accessor under that key, which only the evaluated-key
 * accessor arm above can do: a folded-key accessor is paired at compile time
 * and emitted once, and a duplicate folded key is resolved by the pre-pass
 * before any code is emitted. So `defineValueIdx` is supplied only for the
 * members that FOLLOW such an install, and every other literal keeps the
 * legacy `__extern_set` encoding byte-for-byte.
 */
export function emitObjectLiteralDataStore(
  fctx: FunctionContext,
  setIdx: number,
  defineValueIdx: number | undefined,
): void {
  if (defineValueIdx === undefined) {
    fctx.body.push({ op: "call", funcIdx: setIdx });
    return;
  }
  fctx.body.push({ op: "f64.const", value: OBJLIT_DATA_DEFINE_FLAGS });
  fctx.body.push({ op: "call", funcIdx: defineValueIdx });
  fctx.body.push({ op: "drop" }); // the helper returns the target; discard
}

/**
 * Function indices the define-flavoured spread copy needs. The symbol pair is
 * optional: a lane that cannot resolve both `__getOwnPropertySymbols` and the
 * enumerability predicate skips the symbol pass rather than mis-copying a
 * non-enumerable symbol key.
 */
export interface ObjLitDefineCopyHelpers {
  objectKeysIdx: number;
  externLengthIdx: number;
  externGetIdxIdx: number;
  externGetIdx: number;
  definePropertyValueIdx: number;
  ownSymbolsIdx?: number | undefined;
  propertyIsEnumerableIdx?: number | undefined;
}

/**
 * (#5318 r5 review r2) Copy `source`'s own enumerable properties onto `target`
 * with DEFINE semantics — §7.3.25 CopyDataProperties, which a `SpreadElement`
 * in an object literal (§13.2.5.5) reaches through CreateDataPropertyOrThrow.
 *
 * `__object_assign` is [[Set]]-shaped: over a key that already carries a
 * getter-only accessor it throws in strict code instead of replacing the
 * property. That is only reachable once an evaluated-key accessor has been
 * installed earlier in the SAME literal, which is why the caller supplies this
 * path exclusively for spreads that FOLLOW such an install; every other spread
 * keeps the `__object_assign` encoding byte-for-byte.
 *
 * `source` here is the scratch object `__object_assign` already merged into, so
 * the spread's own source handling (nullish no-op, primitive wrapping, a source
 * getter invoked through [[Get]], proxies) is untouched — this pass only
 * re-lands the RESULT onto the literal with the right verb. Strings first, then
 * symbols, matching §7.3.25's OwnPropertyKeys order.
 */
export function emitObjectLiteralDefineCopy(
  fctx: FunctionContext,
  targetLocal: number,
  sourceLocal: number,
  h: ObjLitDefineCopyHelpers,
): void {
  const keysLocal = allocLocal(fctx, `__objlit_dcp_keys_${fctx.locals.length}`, { kind: "externref" });
  const keyLocal = allocLocal(fctx, `__objlit_dcp_key_${fctx.locals.length}`, { kind: "externref" });
  const nLocal = allocLocal(fctx, `__objlit_dcp_n_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = allocLocal(fctx, `__objlit_dcp_i_${fctx.locals.length}`, { kind: "i32" });
  // `__defineProperty_value(target, key, __extern_get(source, key), FLAGS)`.
  const defineOne: Instr[] = [
    { op: "local.get", index: targetLocal },
    { op: "local.get", index: keyLocal },
    { op: "local.get", index: sourceLocal },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: h.externGetIdx },
    { op: "f64.const", value: OBJLIT_DATA_DEFINE_FLAGS },
    { op: "call", funcIdx: h.definePropertyValueIdx },
    { op: "drop" },
  ];
  const emitPass = (keysIdx: number, guard: Instr[] | undefined): void => {
    const step: Instr[] =
      guard === undefined ? defineOne : [...guard, { op: "if", blockType: { kind: "empty" }, then: defineOne }];
    fctx.body.push({ op: "local.get", index: sourceLocal });
    fctx.body.push({ op: "call", funcIdx: keysIdx });
    fctx.body.push({ op: "local.set", index: keysLocal });
    fctx.body.push({ op: "local.get", index: keysLocal });
    fctx.body.push({ op: "call", funcIdx: h.externLengthIdx });
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    fctx.body.push({ op: "local.set", index: nLocal });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: iLocal });
    fctx.body.push({
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
            { op: "local.get", index: keysLocal },
            { op: "local.get", index: iLocal },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: h.externGetIdxIdx },
            { op: "local.set", index: keyLocal },
            ...step,
            { op: "local.get", index: iLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: iLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    });
  };
  emitPass(h.objectKeysIdx, undefined);
  if (h.ownSymbolsIdx !== undefined && h.propertyIsEnumerableIdx !== undefined) {
    // `__getOwnPropertySymbols` is NOT enumerability-filtered, so each symbol
    // key is screened before it is defined.
    emitPass(h.ownSymbolsIdx, [
      { op: "local.get", index: sourceLocal },
      { op: "local.get", index: keyLocal },
      { op: "call", funcIdx: h.propertyIsEnumerableIdx },
    ]);
  }
}
