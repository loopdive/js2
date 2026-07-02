// (#2867 Gap 4) Native, host-free `Promise.all` / `Promise.race` combinators.
//
// Under the native-`$Promise` carrier (`isStandalonePromiseActive`, today
// `--target wasi`; widens to `--target standalone` at the #2895 slice-1d gate),
// `Promise.all([...])` / `Promise.race([...])` must NOT leak the `Promise_all` /
// `Promise_race` host imports (unsatisfiable with no JS host). This module emits
// the combinators directly on the existing carrier substrate
// (`async-scheduler.ts`): the `$Promise` struct, the `$PromiseCallback` reaction
// node, the microtask ring, and the one-shot `__promise_fulfill`/`__promise_reject`
// settle helpers. It forks NOTHING — it composes the same primitives the native
// `.then` machinery and the #2895 async drive layer already use.
//
// Scope: the **array-literal** argument form — `Promise.all([a, b])` — which is
// the dominant test262 shape and statically gives the element count
// (`emitStandalonePromiseCombinator`), plus (#2919 arm 1) the **array-TYPED**
// non-literal form — `Promise.all(arrVar)` — which loops over the argument vec
// at runtime (`emitStandalonePromiseCombinatorRuntime`), plus (#2922 arms 2+3)
// **Set/Map arguments** (compile-time `emitCollectionIteratorVec` projection at
// the calls.ts gate) and the **dynamic argument** form — custom iterables,
// `any`-typed values, and statically-non-iterable primitives — normalized at
// runtime by `__combinator_to_vec` (vec passthrough / user-iterable drain /
// null = not-iterable → the result promise rejects with a native TypeError).
// The `allSettled` / `any` combinators (which additionally need per-element
// status objects / `AggregateError`), string arguments, f64-backed `number[]`
// vecs (the Gap-4 output-representation escalation), and generator-state
// arguments still fall through to the existing host path (follow-ups).
//
// **Inert until the widen.** Every emission site is gated on
// `isStandalonePromiseActive(ctx)`, which is `ctx.wasi`-only today, so the
// default gc/host lane AND the still-host-backed `--target standalone` lane are
// byte-identical. The combinator becomes live for standalone only when slice 1d
// widens the carrier gate (together with all other carrier gaps), never piecemeal
// (the AG0 −31 / #2367-graveyard lesson).

import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { allocLocal } from "./context/locals.js";
import { definedFuncAt } from "./func-space.js"; // (#1916 S2) positional-read chokepoint
import {
  ensureAsyncDriveRuntime,
  getOrRegisterPromiseType,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_PENDING,
  PROMISE_STATE_REJECTED,
} from "./async-scheduler.js";

const EXTERNREF: ValType = { kind: "externref" };

type AsyncDriveRuntimeT = ReturnType<typeof ensureAsyncDriveRuntime>;

/** The combinators this module lowers natively. `allSettled`/`any` are deferred. */
export type NativeCombinator = "all" | "race";

export function isNativeCombinatorMethod(method: string): method is NativeCombinator {
  return method === "all" || method === "race";
}

interface CombinatorRuntime {
  /** `$CombinatorState { resultPromise: ref $Promise, resultsArr: ref $arr_ext, length: i32, remaining (mut) i32 }`. */
  stateTypeIdx: number;
  /** `$CombinatorElemCaps { state: ref $CombinatorState, index: i32 }`. */
  elemCapsTypeIdx: number;
  /** `$Promise` struct typeIdx. */
  promiseTypeIdx: number;
  /** externref vec struct typeIdx (the `Promise.all` result array wrapper). */
  vecTypeIdx: number;
  /** backing externref array typeIdx (inside the vec). */
  arrTypeIdx: number;
  /** `__combinator_subscribe(input, state, index, fulfillFn, rejectFn) -> void`. */
  subscribeFuncIdx: number;
  /** `__combinator_all_fulfill(caps, value) -> value`. */
  allFulfillFuncIdx: number;
  /** `__combinator_race_fulfill(caps, value) -> value`. */
  raceFulfillFuncIdx: number;
  /** `__combinator_reject(caps, reason) -> reason` (shared all/race). */
  rejectFuncIdx: number;
}

type CtxWithCombinators = CodegenContext & { __promiseCombinators?: CombinatorRuntime };

function registerStruct(
  ctx: CodegenContext,
  name: string,
  fields: { name: string; type: ValType; mutable: boolean }[],
): number {
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name, fields });
  // Mirror the bookkeeping $Promise does so the verifier/walker resolve by name.
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(
    name,
    fields.map((f) => ({ name: f.name, type: f.type, mutable: f.mutable })),
  );
  return typeIdx;
}

/**
 * Idempotently register the combinator state/caps struct types and the four
 * shared runtime helpers, reserving their funcIdx slots up-front (the generator
 * slot-reservation discipline — a late funcIdx assignment would shift the
 * indices the call-site `ref.func`s bake in; #1677/#1809/#1899).
 */
export function ensureCombinatorFunctions(ctx: CodegenContext): CombinatorRuntime {
  const cached = (ctx as CtxWithCombinators).__promiseCombinators;
  if (cached) return cached;

  // The async-drive runtime (Promise type, reaction node, microtask ring, settle
  // helpers) MUST be registered first — it appends functions, which would shift
  // our reserved slots if done after. ensureAsyncDriveRuntime is idempotent.
  const rt = ensureAsyncDriveRuntime(ctx);
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  const stateTypeIdx = registerStruct(ctx, "$CombinatorState", [
    { name: "resultPromise", type: { kind: "ref", typeIdx: promiseTypeIdx }, mutable: false },
    { name: "resultsArr", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: false },
    { name: "length", type: { kind: "i32" }, mutable: false },
    { name: "remaining", type: { kind: "i32" }, mutable: true },
  ]);
  const elemCapsTypeIdx = registerStruct(ctx, "$CombinatorElemCaps", [
    { name: "state", type: { kind: "ref", typeIdx: stateTypeIdx }, mutable: false },
    { name: "index", type: { kind: "i32" }, mutable: false },
  ]);

  // Func types. The fulfill/reject wrappers share the microtask wrapper shape
  // `(caps externref, value externref) -> externref` (addFuncType dedups, so this
  // resolves to the existing `$__mt_func_type`). subscribe is void-returning.
  const wrapperTypeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const subscribeTypeIdx = addFuncType(
    ctx,
    [EXTERNREF, EXTERNREF, { kind: "i32" }, { kind: "funcref" }, { kind: "funcref" }],
    [],
  );

  const base = ctx.numImportFuncs + ctx.mod.functions.length;
  const subscribeFuncIdx = base;
  const allFulfillFuncIdx = base + 1;
  const raceFulfillFuncIdx = base + 2;
  const rejectFuncIdx = base + 3;

  const ids: CombinatorRuntime = {
    stateTypeIdx,
    elemCapsTypeIdx,
    promiseTypeIdx,
    vecTypeIdx,
    arrTypeIdx,
    subscribeFuncIdx,
    allFulfillFuncIdx,
    raceFulfillFuncIdx,
    rejectFuncIdx,
  };

  ctx.mod.functions.push({
    name: "__combinator_subscribe",
    typeIdx: subscribeTypeIdx,
    locals: buildSubscribeLocals(promiseTypeIdx),
    body: buildSubscribeBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_subscribe", subscribeFuncIdx);

  ctx.mod.functions.push({
    name: "__combinator_all_fulfill",
    typeIdx: wrapperTypeIdx,
    locals: buildAllFulfillLocals(ids),
    body: buildAllFulfillBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_all_fulfill", allFulfillFuncIdx);

  ctx.mod.functions.push({
    name: "__combinator_race_fulfill",
    typeIdx: wrapperTypeIdx,
    locals: buildSettleWrapperLocals(ids),
    body: buildRaceFulfillBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_race_fulfill", raceFulfillFuncIdx);

  ctx.mod.functions.push({
    name: "__combinator_reject",
    typeIdx: wrapperTypeIdx,
    locals: buildSettleWrapperLocals(ids),
    body: buildRejectBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_reject", rejectFuncIdx);

  (ctx as CtxWithCombinators).__promiseCombinators = ids;
  return ids;
}

// ── __combinator_subscribe ───────────────────────────────────────────────────
// params: 0 input externref, 1 state externref, 2 index i32, 3 fulfillFn funcref,
//         4 rejectFn funcref. locals: 5 p (ref $Promise), 6 caps externref.

function buildSubscribeLocals(promiseTypeIdx: number): LocalDef[] {
  return [
    { name: "$p", type: { kind: "ref", typeIdx: promiseTypeIdx } },
    { name: "$caps", type: EXTERNREF },
  ];
}

function buildSubscribeBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT): Instr[] {
  const INPUT = 0;
  const STATE = 1;
  const INDEX = 2;
  const FULFILL_FN = 3;
  const REJECT_FN = 4;
  const P = 5;
  const CAPS = 6;
  const cbTypeIdx = rt.callbackTypeIdx;
  return [
    // Normalize `input` to a `$Promise`. A native `$Promise` passes through; any
    // other value is wrapped in a synchronously-FULFILLED `$Promise` so the
    // dispatch below is uniform (mirrors spec PromiseResolve for a non-thenable).
    { op: "local.get", index: INPUT },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ids.promiseTypeIdx } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: INPUT },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ids.promiseTypeIdx } as Instr,
        { op: "local.set", index: P },
      ],
      else: [
        { op: "i32.const", value: PROMISE_STATE_FULFILLED },
        { op: "local.get", index: INPUT },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: ids.promiseTypeIdx } as Instr,
        { op: "local.set", index: P },
      ],
    } as Instr,

    // caps = $CombinatorElemCaps{ state, index } (boxed to externref).
    { op: "local.get", index: STATE },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.stateTypeIdx } as Instr,
    { op: "local.get", index: INDEX },
    { op: "struct.new", typeIdx: ids.elemCapsTypeIdx } as Instr,
    { op: "extern.convert_any" },
    { op: "local.set", index: CAPS },

    // Dispatch on the (possibly already-settled) promise state.
    { op: "local.get", index: P },
    { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 0 } as Instr,
    { op: "i32.const", value: PROMISE_STATE_FULFILLED },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // enqueue(fulfillFn, caps, p.value)
        { op: "local.get", index: FULFILL_FN },
        { op: "local.get", index: CAPS },
        { op: "local.get", index: P },
        { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 1 } as Instr,
        { op: "call", funcIdx: rt.enqueueFuncIdx },
      ],
      else: [
        { op: "local.get", index: P },
        { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 0 } as Instr,
        { op: "i32.const", value: PROMISE_STATE_REJECTED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // enqueue(rejectFn, caps, p.value)
            { op: "local.get", index: REJECT_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: P },
            { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 1 } as Instr,
            { op: "call", funcIdx: rt.enqueueFuncIdx },
          ],
          else: [
            // pending: prepend a reaction node onto p.callbacks.
            { op: "local.get", index: P },
            { op: "local.get", index: FULFILL_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: REJECT_FN },
            { op: "local.get", index: CAPS },
            { op: "local.get", index: P },
            { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 2 } as Instr,
            { op: "struct.new", typeIdx: cbTypeIdx } as Instr,
            { op: "extern.convert_any" },
            { op: "struct.set", typeIdx: ids.promiseTypeIdx, fieldIdx: 2 } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
  ];
}

// ── __combinator_all_fulfill ─────────────────────────────────────────────────
// params: 0 caps externref, 1 value externref.
// locals: 2 c (ref $CombinatorElemCaps), 3 st (ref $CombinatorState), 4 rem i32.

function buildAllFulfillLocals(ids: CombinatorRuntime): LocalDef[] {
  return [
    { name: "$c", type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx } },
    { name: "$st", type: { kind: "ref", typeIdx: ids.stateTypeIdx } },
    { name: "$rem", type: { kind: "i32" } },
  ];
}

function buildAllFulfillBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT): Instr[] {
  const CAPS = 0;
  const VALUE = 1;
  const C = 2;
  const ST = 3;
  const REM = 4;
  return [
    { op: "local.get", index: CAPS },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx } as Instr,
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: ST },

    // results[index] = value
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.get", index: VALUE },
    { op: "array.set", typeIdx: ids.arrTypeIdx } as Instr,

    // remaining -= 1
    { op: "local.get", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 3 } as Instr,
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.tee", index: REM },
    { op: "struct.set", typeIdx: ids.stateTypeIdx, fieldIdx: 3 } as Instr,

    // if remaining == 0: fulfill the result promise with the results vec.
    { op: "local.get", index: REM },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 } as Instr,
        // vec = struct.new $vec(length, resultsArr)
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 2 } as Instr,
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 } as Instr,
        { op: "struct.new", typeIdx: ids.vecTypeIdx } as Instr,
        { op: "extern.convert_any" },
        { op: "call", funcIdx: rt.fulfillFuncIdx },
        { op: "drop" },
      ],
    } as Instr,

    { op: "local.get", index: VALUE },
  ];
}

// ── __combinator_race_fulfill / __combinator_reject ──────────────────────────
// params: 0 caps externref, 1 value externref. locals: 2 c, 3 st.

function buildSettleWrapperLocals(ids: CombinatorRuntime): LocalDef[] {
  return [
    { name: "$c", type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx } },
    { name: "$st", type: { kind: "ref", typeIdx: ids.stateTypeIdx } },
  ];
}

function buildSettleResultBody(ids: CombinatorRuntime, settleFuncIdx: number): Instr[] {
  const CAPS = 0;
  const VALUE = 1;
  const C = 2;
  const ST = 3;
  // Settle (fulfill for race, reject for both all & race) the shared result
  // promise with `value`. Settlement is one-shot, so a second settle no-ops —
  // exactly the "first wins" (race) / "first rejection wins" (all) semantics.
  return [
    { op: "local.get", index: CAPS },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx } as Instr,
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.get", index: VALUE },
    { op: "call", funcIdx: settleFuncIdx },
    // __promise_fulfill/__promise_reject return the settled value — that is the
    // wrapper's externref result, so leave it on the stack.
  ];
}

function buildRaceFulfillBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT): Instr[] {
  return buildSettleResultBody(ids, rt.fulfillFuncIdx);
}

function buildRejectBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT): Instr[] {
  return buildSettleResultBody(ids, rt.rejectFuncIdx);
}

/**
 * Emit a native `Promise.all([...])` / `Promise.race([...])`. `elementInstrs` is
 * the pre-compiled list of element expressions (each already coerced to
 * externref). Leaves the aggregate result `$Promise` on the stack as externref.
 */
export function emitStandalonePromiseCombinator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: NativeCombinator,
  elementInstrs: Instr[][],
): ValType {
  const ids = ensureCombinatorFunctions(ctx);
  const rt = ensureAsyncDriveRuntime(ctx);
  const n = elementInstrs.length;

  const resultLocal = allocLocal(fctx, `__comb_result_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.promiseTypeIdx,
  });
  const arrLocal = allocLocal(fctx, `__comb_arr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.arrTypeIdx,
  });
  const stateLocal = allocLocal(fctx, `__comb_state_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.stateTypeIdx,
  });

  // Pending result promise.
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: ids.promiseTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Backing results array (only meaningful for `all`; `race` ignores it).
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "array.new_default", typeIdx: ids.arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // $CombinatorState{ resultPromise, resultsArr, length=n, remaining=n }.
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "struct.new", typeIdx: ids.stateTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: stateLocal });

  if (n === 0) {
    // `Promise.all([])` fulfills immediately with an empty array. `Promise.race([])`
    // stays pending forever (spec) — emit nothing.
    if (method === "all") {
      fctx.body.push({ op: "local.get", index: resultLocal });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "struct.new", typeIdx: ids.vecTypeIdx } as Instr);
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "call", funcIdx: rt.fulfillFuncIdx });
      fctx.body.push({ op: "drop" });
    }
  } else {
    const fulfillFn = method === "all" ? ids.allFulfillFuncIdx : ids.raceFulfillFuncIdx;
    for (let i = 0; i < n; i++) {
      for (const instr of elementInstrs[i]!) fctx.body.push(instr);
      fctx.body.push({ op: "local.get", index: stateLocal });
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "ref.func", funcIdx: fulfillFn } as Instr);
      fctx.body.push({ op: "ref.func", funcIdx: ids.rejectFuncIdx } as Instr);
      fctx.body.push({ op: "call", funcIdx: ids.subscribeFuncIdx });
    }
  }

  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "extern.convert_any" });
  return EXTERNREF;
}

/**
 * (#2919 arm 1) Decide whether a compiled combinator argument is an
 * EXTERNREF-backed array vec — the only shape the runtime-loop combinator can
 * feed to `__combinator_subscribe` without boxing. Returns the vec + backing
 * array type indices, or `null` for anything else (f64-backed `number[]` vecs
 * — the documented Gap-4 output-representation escalation, see module header —
 * `any`/externref values, strings, non-vec structs), which must keep the host
 * fallthrough unchanged.
 */
export function resolveExternrefVecArg(
  ctx: CodegenContext,
  argType: ValType | null,
): { vecTypeIdx: number; arrTypeIdx: number } | null {
  if (!argType || (argType.kind !== "ref" && argType.kind !== "ref_null")) return null;
  const vecTypeIdx = (argType as { typeIdx?: number }).typeIdx;
  if (typeof vecTypeIdx !== "number" || vecTypeIdx < 0) return null;
  // Require a genuine `__vec_*` struct (registered by getOrRegisterVecType) —
  // field-shape sniffing alone could false-positive on an unrelated struct
  // whose field 1 happens to reference an externref array.
  const structName = ctx.typeIdxToStructName.get(vecTypeIdx);
  if (!structName || !structName.startsWith("__vec_")) return null;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return null;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array" || arrDef.element.kind !== "externref") return null;
  return { vecTypeIdx, arrTypeIdx };
}

/**
 * (#2919 arm 1) Emit a native `Promise.all(arrVar)` / `Promise.race(arrVar)`
 * over an ARRAY-TYPED (non-literal) argument: the runtime-count analogue of the
 * compile-time-unrolled `emitStandalonePromiseCombinator`. The argument vec is
 * already compiled and stored in `argVecLocal` (a `ref null <vecTypeIdx>`
 * local whose shape was validated by {@link resolveExternrefVecArg}); this
 * loops `i = 0 .. vec.length` feeding each element (externref, no boxing) to
 * `__combinator_subscribe`.
 *
 * Everything is emitted inline into `fctx.body` — no detached buffer — so a
 * later late-import funcIdx shift (e.g. from a trailing `.then` compile) is
 * applied by the standard `ctx.currentFunc.body`/`savedBodies` walk, and the
 * cached combinator ids are kept in lockstep by
 * `shiftAsyncSideChannelFuncIdxs` (#2918).
 *
 * Leaves the aggregate result `$Promise` on the stack as externref.
 *
 * (#2922 arms 2+3) `opts` — dynamic-argument mode. When present, the caller
 * compiled the argument through `__combinator_to_vec` and `opts.notIterLocal`
 * (i32) is 1 when the argument was NOT iterable (argVecLocal then holds a
 * fresh empty vec so the subscribe loop no-ops). In that case the result
 * promise is REJECTED with `opts.rejectReason` (instrs producing an externref
 * error instance) right after creation. Settlement is one-shot
 * (`buildPromiseSettleBody` returns early on non-PENDING), so the `all`
 * empty-vec fulfill below the reject correctly no-ops — the reject MUST
 * precede it, which is why this lives here and not after the call. With
 * `opts === undefined` the emission is byte-identical to the #2919 arm-1
 * output.
 */
export function emitStandalonePromiseCombinatorRuntime(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: NativeCombinator,
  argVecLocal: number,
  argVecTypeIdx: number,
  argArrTypeIdx: number,
  opts?: { notIterLocal: number; rejectReason: Instr[] },
): ValType {
  const ids = ensureCombinatorFunctions(ctx);
  const rt = ensureAsyncDriveRuntime(ctx);

  const resultLocal = allocLocal(fctx, `__comb_result_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.promiseTypeIdx,
  });
  const arrLocal = allocLocal(fctx, `__comb_arr_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.arrTypeIdx,
  });
  const stateLocal = allocLocal(fctx, `__comb_state_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.stateTypeIdx,
  });
  const nLocal = allocLocal(fctx, `__comb_n_${fctx.locals.length}`, { kind: "i32" });
  const iLocal = allocLocal(fctx, `__comb_i_${fctx.locals.length}`, { kind: "i32" });

  // n = argVec.length — the vec's LOGICAL length (field 0), not the backing
  // array's capacity (`array.len` over-reports after push growth).
  fctx.body.push({ op: "local.get", index: argVecLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 0 } as Instr);
  fctx.body.push({ op: "local.set", index: nLocal });

  // Pending result promise.
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: ids.promiseTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Backing results array sized n (only meaningful for `all`; `race` ignores it).
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: ids.arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: arrLocal });

  // $CombinatorState{ resultPromise, resultsArr, length=n, remaining=n }.
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "struct.new", typeIdx: ids.stateTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: stateLocal });

  // (#2922) Dynamic-argument mode: a not-iterable argument settles the result
  // promise REJECTED with a TypeError (§27.2.4.1 step 3 / IfAbruptRejectPromise).
  // Emitted BEFORE the `all` empty-vec fulfill so the one-shot settle makes the
  // fulfill a no-op (argVecLocal holds an empty vec in this case, so n == 0).
  if (opts) {
    fctx.body.push({ op: "local.get", index: opts.notIterLocal });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resultLocal },
        ...opts.rejectReason,
        { op: "call", funcIdx: rt.rejectFuncIdx },
        { op: "drop" },
      ],
    } as Instr);
  }

  // `Promise.all(<empty>)` fulfills immediately with the empty results vec;
  // `Promise.race(<empty>)` stays pending forever (spec). The subscribe loop
  // below runs zero iterations either way.
  if (method === "all") {
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resultLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: arrLocal },
        { op: "struct.new", typeIdx: ids.vecTypeIdx } as Instr,
        { op: "extern.convert_any" },
        { op: "call", funcIdx: rt.fulfillFuncIdx },
        { op: "drop" },
      ],
    } as Instr);
  }

  // for (i = 0; i < n; i++) __combinator_subscribe(argVec.data[i], state, i,
  //                                                fulfillFn, rejectFn)
  // Subscribe never settles synchronously (already-settled inputs only ENQUEUE),
  // so `remaining` stays == n through the whole loop — no mid-loop settle race.
  const fulfillFn = method === "all" ? ids.allFulfillFuncIdx : ids.raceFulfillFuncIdx;
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
          // depth 1: exit the enclosing block (skip the loop label).
          { op: "br_if", depth: 1 },

          // element: argVec.data[i] — externref, subscribe's input directly.
          { op: "local.get", index: argVecLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 1 } as Instr,
          { op: "local.get", index: iLocal },
          { op: "array.get", typeIdx: argArrTypeIdx } as Instr,
          { op: "local.get", index: stateLocal },
          { op: "extern.convert_any" },
          { op: "local.get", index: iLocal },
          { op: "ref.func", funcIdx: fulfillFn } as Instr,
          { op: "ref.func", funcIdx: ids.rejectFuncIdx } as Instr,
          { op: "call", funcIdx: ids.subscribeFuncIdx },

          // i++
          { op: "local.get", index: iLocal },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: iLocal },
          // depth 0: re-enter the loop label.
          { op: "br", depth: 0 },
        ],
      },
    ],
  } as Instr);

  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "extern.convert_any" });
  return EXTERNREF;
}

// ── __combinator_to_vec (#2922 arms 2+3) ─────────────────────────────────────
//
// `__combinator_to_vec(x externref) -> externref` normalizes an arbitrary
// combinator argument to a canonical externref `$Vec`, or returns
// **null-extern = "not iterable"** (the caller settles the result promise
// REJECTED with a TypeError):
//   - `null`/`undefined`      → null (not iterable, §7.4.3 GetIterator throws)
//   - canonical externref vec → passthrough (covers `any`-typed array values)
//   - custom iterable / bare-`next` iterator (USER carrier) → drained into a
//     fresh `$Vec` (grow-array loop, byte-shaped after `__array_from_iter_n`)
//   - anything else           → null (numbers, booleans, symbols, plain
//     structs — not iterable)
//
// Reserve-then-fill (#2038/#1719): the USER arm needs the closed-struct
// dispatchers (`__call_@@iterator` / `__call_next` / `__sget_value` /
// `__sget_done` / `__is_truthy`), which only exist at FINALIZE. The eager body
// registered here is vec-only (non-vec → null → reject); `fillCombinatorToVec`
// (called from index.ts right after `fillNativeIteratorUserArms`, same
// five-dispatcher condition so the two carriers can never disagree) rebuilds
// it with the USER arm. Locals are pre-sized for the fill — the fill replaces
// only the body.

/** Local layout shared by the eager and filled `__combinator_to_vec` bodies. */
const TOVEC_X = 0;
const TOVEC_IT = 1;
const TOVEC_RES = 2;
const TOVEC_DONE = 3;
const TOVEC_VALUE = 4;
const TOVEC_CAP = 5;
const TOVEC_LEN = 6;
const TOVEC_DATA = 7;
const TOVEC_GROW = 8;

/** Idempotently register `__combinator_to_vec` with the vec-only eager body. */
export function ensureCombinatorToVec(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__combinator_to_vec")) return;
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrRefNull: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: "__combinator_to_vec",
    typeIdx,
    locals: [
      { name: "$it", type: EXTERNREF },
      { name: "$res", type: EXTERNREF },
      { name: "$done", type: { kind: "i32" } },
      { name: "$value", type: EXTERNREF },
      { name: "$cap", type: { kind: "i32" } },
      { name: "$len", type: { kind: "i32" } },
      { name: "$data", type: arrRefNull },
      { name: "$grow", type: arrRefNull },
    ],
    body: buildToVecCommonHead(vecTypeIdx).concat([{ op: "ref.null.extern" } as Instr]),
    exported: false,
  });
  ctx.funcMap.set("__combinator_to_vec", funcIdx);
}

/**
 * The head shared by both bodies: null → return null (not iterable);
 * canonical `$Vec` → return the input unchanged. Falls through otherwise.
 * Built FRESH per call — never alias one Instr[] into two bodies (#2169b:
 * a shared instruction object is double-remapped by DCE's type-index pass).
 */
function buildToVecCommonHead(vecTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: TOVEC_X },
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" } as Instr, { op: "return" } as Instr],
    } as Instr,
    { op: "local.get", index: TOVEC_X },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: TOVEC_X }, { op: "return" } as Instr],
    } as Instr,
  ];
}

/**
 * (#2038-style finalize fill) Rebuild `__combinator_to_vec` with the USER
 * iterable arm once the closed-struct dispatchers exist. No-op when the fn was
 * never registered (no dynamic combinator arg in the module) or any dispatcher
 * is absent (no custom iterable in the module → the vec-only body is already
 * correct: nothing user-iterable can exist at runtime).
 *
 * MUST run after `emitStructFieldGetters` + `emitIteratorMethodExport` (and
 * after the `__is_truthy` force-add) in the finalize sequence — i.e. right
 * after `fillNativeIteratorUserArms`.
 */
export function fillCombinatorToVec(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get("__combinator_to_vec");
  if (funcIdx === undefined) return;
  const callIteratorIdx = ctx.funcMap.get("__call_@@iterator");
  const callNextIdx = ctx.funcMap.get("__call_next");
  const sgetValueIdx = ctx.funcMap.get("__sget_value");
  const sgetDoneIdx = ctx.funcMap.get("__sget_done");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  if (
    callIteratorIdx === undefined ||
    callNextIdx === undefined ||
    sgetValueIdx === undefined ||
    sgetDoneIdx === undefined ||
    isTruthyIdx === undefined
  ) {
    return;
  }
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn) return;

  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  // Bare-`next` iterator structs (generator-shaped objects handed where an
  // iterable is expected — spec-wise %GeneratorPrototype%[@@iterator] returns
  // `this`, so accepting them mirrors GetIterator; same obj-itself fallback the
  // #2038 `__iterator` USER arm uses). Same struct filter as
  // emitIteratorMethodExport's dispatch enumeration.
  const nextStructTypeIdxs: number[] = [];
  for (const [structName] of ctx.structFields) {
    const tIdx = ctx.structMap.get(structName);
    if (tIdx === undefined) continue;
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    ) {
      continue;
    }
    if (!ctx.funcMap.has(`${structName}_next`)) continue;
    nextStructTypeIdxs.push(tIdx);
  }

  // Grow: cap *= 2; grow = new arr[cap]; copy data[0..len] → grow; data = grow.
  const growInstrs: Instr[] = [
    { op: "local.get", index: TOVEC_CAP },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: TOVEC_CAP },
    { op: "local.get", index: TOVEC_CAP },
    { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: TOVEC_GROW },
    { op: "local.get", index: TOVEC_GROW },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: TOVEC_DATA },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: TOVEC_LEN },
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
    { op: "local.get", index: TOVEC_GROW },
    { op: "local.set", index: TOVEC_DATA },
  ];

  // hasNext = OR over `ref.test` of every bare-`next` struct.
  const hasNextChain: Instr[] = [{ op: "i32.const", value: 0 }];
  for (const tIdx of nextStructTypeIdxs) {
    hasNextChain.push({ op: "local.get", index: TOVEC_X });
    hasNextChain.push({ op: "any.convert_extern" } as Instr);
    hasNextChain.push({ op: "ref.test", typeIdx: tIdx } as Instr);
    hasNextChain.push({ op: "i32.or" });
  }

  fn.body = [
    ...buildToVecCommonHead(vecTypeIdx),

    // it = __call_@@iterator(x)  (null when x has no @@iterator method)
    { op: "local.get", index: TOVEC_X },
    { op: "call", funcIdx: callIteratorIdx },
    { op: "local.set", index: TOVEC_IT },
    { op: "local.get", index: TOVEC_IT },
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...hasNextChain,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: TOVEC_X },
            { op: "local.set", index: TOVEC_IT },
          ],
          else: [{ op: "ref.null.extern" } as Instr, { op: "return" } as Instr],
        } as Instr,
      ],
    } as Instr,

    // cap = 4; data = new arr[4]; len = 0
    { op: "i32.const", value: 4 },
    { op: "local.set", index: TOVEC_CAP },
    { op: "local.get", index: TOVEC_CAP },
    { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: TOVEC_DATA },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: TOVEC_LEN },

    // Drain: res = __call_next(it); done = ToBoolean(__sget_done(res));
    // until done: append __sget_value(res). (A malformed `next` result — the
    // §7.4.4 "not an Object ⇒ TypeError" refinement — behaves as the #2038
    // USER arm does today: getters return null, done stays falsy.)
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: TOVEC_IT },
            { op: "call", funcIdx: callNextIdx },
            { op: "local.set", index: TOVEC_RES },
            { op: "local.get", index: TOVEC_RES },
            { op: "call", funcIdx: sgetDoneIdx },
            { op: "call", funcIdx: isTruthyIdx },
            { op: "local.set", index: TOVEC_DONE },
            { op: "local.get", index: TOVEC_DONE },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: TOVEC_RES },
            { op: "call", funcIdx: sgetValueIdx },
            { op: "local.set", index: TOVEC_VALUE },
            // grow when len == cap
            { op: "local.get", index: TOVEC_LEN },
            { op: "local.get", index: TOVEC_CAP },
            { op: "i32.ge_s" },
            { op: "if", blockType: { kind: "empty" }, then: growInstrs, else: [] } as Instr,
            // data[len] = value; len++
            { op: "local.get", index: TOVEC_DATA },
            { op: "local.get", index: TOVEC_LEN },
            { op: "local.get", index: TOVEC_VALUE },
            { op: "array.set", typeIdx: arrTypeIdx } as Instr,
            { op: "local.get", index: TOVEC_LEN },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: TOVEC_LEN },
            { op: "br", depth: 0 },
          ],
        } as Instr,
      ],
    } as Instr,

    // return $Vec{len, data} as externref
    { op: "local.get", index: TOVEC_LEN },
    { op: "local.get", index: TOVEC_DATA },
    { op: "ref.as_non_null" } as Instr,
    { op: "struct.new", typeIdx: vecTypeIdx } as Instr,
    { op: "extern.convert_any" } as Instr,
  ];
}
