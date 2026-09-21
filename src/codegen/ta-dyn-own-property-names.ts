// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster E, slice E2) §10.4.5.6 `[[OwnPropertyKeys]]` for a
 * `$__ta_dyn_view` receiver, on the `__getOwnPropertyNames` native.
 *
 * ## The gap
 * `ta-dyn-mop.ts` already prepends a dyn-view arm to `__object_keys` (integer
 * indices, ascending), and that one is correct. But `Object.getOwnPropertyNames`
 * and — the surface the `internals/OwnPropertyKeys` rows use —
 * `Reflect.ownKeys` are NOT routed through `__object_keys`: the standalone
 * `Reflect.ownKeys` arm in `call-namespace-static.ts` calls
 * `__getOwnPropertyNames` and then appends `__getOwnPropertySymbols`. That
 * native had no dyn-view arm, so a typed array fell through to the generic
 * `$__vec_base` arm (`vec-overlay-keys.ts`), which is written for an ordinary
 * Array and therefore appends `"length"`.
 *
 * Measured on this branch's base, through the REAL harness shape —
 * `testWithTypedArrayConstructors(function (C) { … })`, where `C` is genuinely
 * `any`-typed so the receiver is a `$__ta_dyn_view` (see the warning below):
 *
 * | receiver                       | `Reflect.ownKeys(...)` base | correct           |
 * | ------------------------------ | --------------------------- | ----------------- |
 * | `new C([42, 42, 42])`          | `["0","1","2","length"]`    | `["0","1","2"]`   |
 * | `new C(4)`                     | 4 indices + `"length"`      | 4 indices         |
 * | `new C()`                      | `["length"]`                | `[]`              |
 * | `new C([42,42,42])` + expando  | `["0","1","2","length"]`    | `[…,"test262"]`   |
 *
 * So the base is wrong twice over: `length` is not an own property of an
 * integer-indexed exotic object at all (§10.4.5 has no `length` slot;
 * `%TypedArray%.prototype.length` is an inherited ACCESSOR), and a string key
 * written onto the view (`sample.test262 = 42`, which reads back fine) never
 * appears in the key list because the expando side table is never consulted.
 *
 * ⚠ MEASURING THIS: a probe that binds the constructor as `var TA =
 * [Float64Array][0]` does NOT reproduce it. TypeScript types that expression
 * as `Float64ArrayConstructor`, so `new TA(…)` takes the STATIC path and yields
 * a plain `__vec_f64` compiler vec, not a `$__ta_dyn_view` — a different
 * representation with different (and, for `length`, correct) key semantics.
 * Only an `any`-typed callee reaches `emitTaDynCtorConstructFromLocals`. The
 * first cut of this module was measured against the static shape and read as
 * a no-op for that reason alone.
 *
 * ## The arm
 * §10.4.5.6 order, exactly: every `ToString(i)` for `0 ≤ i < [[ArrayLength]]`
 * in ascending order, then the object's own STRING keys in creation order.
 * The expando side table (`$__ta_dyn_view` field 4, the `$Object` that
 * `__extern_set` / `__defineProperty_value` lazily create for a non-canonical
 * key) holds exactly that second group, and re-entering `__getOwnPropertyNames`
 * on it yields them in creation order — the expando is an ordinary `$Object`,
 * so the recursive call takes the untouched generic path. A canonical numeric
 * key never lands in the expando (`ta-dyn-mop.ts` routes those to element
 * semantics), so the two groups cannot overlap.
 *
 * SYMBOL keys — §10.4.5.6's third group — are deliberately NOT here. They are
 * appended by the caller (`Reflect.ownKeys` concatenates
 * `__getOwnPropertySymbols`), and on a dyn view that native has its own gap:
 * `Reflect.defineProperty(view, sym, …)` returns true but the read back is
 * `undefined` (measured), so there is nothing correct to append yet. Adding a
 * half-working symbol group here would turn a missing key into a wrong one.
 *
 * Prepend-at-index-0 discipline, same as `fillTaDynViewMopArms`: the arm is
 * `unshift`ed in front of the existing body and every local it needs is
 * APPENDED, so no existing local index moves. Non-view receivers fall through
 * byte-identically.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { pushElemSizeForKind, pushTaDynViewInBoundsLen } from "./dataview-native.js";

/**
 * Splice the §10.4.5.6 dyn-view arm into `__getOwnPropertyNames`.
 *
 * No-op unless standalone with a live `$__ta_dyn_view` type and every native
 * the arm composes already registered — a module with no dynamically
 * constructed typed array is byte-identical.
 *
 * MUST run AFTER `fillTaDynViewMopArms` (which is what materializes the
 * dyn-view kind singletons and the element helpers this shares) and after the
 * object runtime's own natives exist, i.e. from the same finalize block.
 */
export function fillTaDynViewOwnPropertyNamesArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const dynIdx = ctx.taDynViewTypeIdx;
  if (dynIdx < 0) return;

  const gopnIdx = ctx.funcMap.get("__getOwnPropertyNames");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx");
  if (
    gopnIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    numToStringIdx === undefined ||
    externLengthIdx === undefined ||
    externGetIdxIdx === undefined
  ) {
    return;
  }
  const gopnFn = definedFuncAt(ctx, gopnIdx);
  if (!gopnFn) return;

  // Locals are APPENDED after whatever the existing body already declares.
  const base = 1 + gopnFn.locals.length; // 1 param: (obj: externref)
  const lAny = base;
  const lDv = base + 1;
  const lKind = base + 2;
  const lEs = base + 3;
  const lLen = base + 4;
  const lVec = base + 5;
  const lI = base + 6;
  const lExp = base + 7;
  const lNames = base + 8;
  const lN = base + 9;
  const lK = base + 10;
  gopnFn.locals.push(
    { name: "__tak_any", type: { kind: "anyref" } },
    { name: "__tak_dv", type: { kind: "ref_null", typeIdx: dynIdx } },
    { name: "__tak_kind", type: { kind: "i32" } },
    { name: "__tak_es", type: { kind: "i32" } },
    { name: "__tak_len", type: { kind: "i32" } },
    { name: "__tak_vec", type: { kind: "externref" } },
    { name: "__tak_i", type: { kind: "i32" } },
    { name: "__tak_exp", type: { kind: "externref" } },
    { name: "__tak_names", type: { kind: "externref" } },
    { name: "__tak_n", type: { kind: "f64" } },
    { name: "__tak_k", type: { kind: "f64" } },
  );

  const inner: Instr[] = [];
  // `pushElemSizeForKind` / `pushTaDynViewInBoundsLen` write through a
  // FunctionContext-shaped view of the function being filled — the same shim
  // `fillTaDynViewMopArms`'s `__object_keys` arm uses.
  const fctxLike = {
    body: inner,
    locals: gopnFn.locals,
    params: [{ name: "obj", type: { kind: "externref" } as ValType }],
    localMap: new Map(),
  } as unknown as FunctionContext;

  inner.push({ op: "local.get", index: lAny });
  inner.push({ op: "ref.cast", typeIdx: dynIdx });
  inner.push({ op: "local.set", index: lDv });
  inner.push({ op: "local.get", index: lDv });
  inner.push({ op: "ref.as_non_null" });
  inner.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 3 });
  inner.push({ op: "local.set", index: lKind });
  pushElemSizeForKind(fctxLike, lKind);
  inner.push({ op: "local.set", index: lEs });
  // §10.4.5.6 step 3 reads [[ArrayLength]]; the shared helper floors a detached
  // buffer's -1 byte length to an effective 0, which is also the right answer
  // here (a detached view has no integer-indexed own keys).
  pushTaDynViewInBoundsLen(ctx, fctxLike, lDv, lEs);
  inner.push({ op: "local.set", index: lLen });
  inner.push({ op: "call", funcIdx: objVecNewIdx });
  inner.push({ op: "local.set", index: lVec });

  // Group 1 — "0" … ToString(len-1), ascending (§10.4.5.6 step 4).
  inner.push({ op: "i32.const", value: 0 });
  inner.push({ op: "local.set", index: lI });
  inner.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: lI },
          { op: "local.get", index: lLen },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: lVec },
          { op: "local.get", index: lI },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: numToStringIdx },
          { op: "call", funcIdx: objVecPushIdx },
          { op: "local.get", index: lI },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: lI },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });

  // Group 2 — the expando's own string keys, creation order (§10.4.5.6 step 5).
  inner.push({ op: "local.get", index: lDv });
  inner.push({ op: "ref.as_non_null" });
  inner.push({ op: "struct.get", typeIdx: dynIdx, fieldIdx: 4 });
  inner.push({ op: "local.set", index: lExp });
  inner.push({ op: "local.get", index: lExp });
  inner.push({ op: "ref.is_null" });
  inner.push({ op: "i32.eqz" });
  inner.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // Re-entrant: the expando is an ordinary `$Object`, so this call takes
      // the untouched generic path below this arm.
      { op: "local.get", index: lExp },
      { op: "call", funcIdx: gopnIdx },
      { op: "local.set", index: lNames },
      { op: "local.get", index: lNames },
      { op: "call", funcIdx: externLengthIdx },
      { op: "local.set", index: lN },
      { op: "f64.const", value: 0 },
      { op: "local.set", index: lK },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: lK },
              { op: "local.get", index: lN },
              { op: "f64.ge" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: lVec },
              { op: "local.get", index: lNames },
              { op: "local.get", index: lK },
              { op: "call", funcIdx: externGetIdxIdx },
              { op: "call", funcIdx: objVecPushIdx },
              { op: "local.get", index: lK },
              { op: "f64.const", value: 1 },
              { op: "f64.add" },
              { op: "local.set", index: lK },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ],
    else: [],
  });

  inner.push({ op: "local.get", index: lVec });
  inner.push({ op: "return" });

  gopnFn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: lAny },
    { op: "ref.test", typeIdx: dynIdx },
    { op: "if", blockType: { kind: "empty" }, then: inner },
  );
}
