// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster D / #5197 R3-3) `Promise.{all,race}.call(C, iterable)` for an
 * ORDINARY compiled constructor `C`, natively — no host import.
 *
 * Before this module the `.call` aggregator arm
 * (`call-namespace-static.ts`) admitted a custom receiver only for the shape
 * `Promise.all.call(fn, [])` — an ordinary `function` declaration AND an EMPTY
 * array literal (#4682). Every other shape fell through to the `Promise_all` /
 * `Promise_race` host import, which a standalone module cannot satisfy: the
 * row failed to compile at all (`standalone target emitted host imports:
 * env::Promise_all, env::__js_array_new, …`), so nothing about it was
 * observable. 28 ES2015 rows of the #6651 cluster-D manifest sat there.
 *
 * What this emits is the §27.2.4.1.1 / §27.2.4.3.1 element pipeline over the
 * capability `C` produces, using ONLY substrate that already exists:
 *
 *   capability = NewPromiseCapability(C)            // promise-combinators.ts
 *   promiseResolve = Get(C, "resolve")              // __extern_get
 *   for each value in the drained iterable:
 *     next = Call(promiseResolve, C, «value»)       // __apply_closure
 *     Invoke(next, "then", «onFulfilled, onRejected»)
 *
 * where for `race` the two handlers ARE the capability's own resolve/reject
 * slots (spec §27.2.4.3.1 step 4.j — this is what `race/same-resolve-function.js`
 * and `race/same-reject-function.js` assert), and for `all` the fulfil handler
 * is a per-index **resolve-element function**: a real builtin-function object
 * (`ensureBuiltinFnMetaType` carrier ⇒ `name` "", `length` 1, no [[Construct]])
 * with an `[[AlreadyCalled]]` bit, writing into the shared values array and
 * settling the capability when `[[RemainingElements]]` reaches 0.
 *
 * Deliberate boundaries (documented residuals, not oversights):
 *   - `C` must be an ordinary compiled function (declaration or function
 *     expression). A `class X { constructor(executor) {…} }` receiver still
 *     takes the old path — standalone has no `Construct(C, «executor»)` for a
 *     compiled class (#5197 G9/G10, DEFERRED there too).
 *   - `allSettled`/`any` with a custom `C` are not admitted here; their
 *     manifest rows are all class-receiver rows anyway.
 *   - The iterable is DRAINED (`__combinator_to_vec`) before the element loop,
 *     so `IteratorClose` on an abrupt element step is not performed — the
 *     #5197 R3-4 interleaved-drive slice owns that.
 *   - `Get(C, "resolve")` is performed once, before the drain, per spec order;
 *     a THROWING `resolve` getter is not caught yet (R3-2/R3-4 territory).
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureBuiltinFnMetaType } from "./builtin-fn-meta.js";
import {
  closureBagInitInstr,
  getFuncRefWrapperRootTypeIdx,
  getOrCreateFuncRefWrapperTypes,
} from "./closures/funcref-wrapper-types.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js";
import { coerceType, compileExpression } from "./shared.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { ensureExnTag } from "./registry/imports.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs, ensureNativeStringHelpers } from "./native-strings.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import {
  buildCustomCapabilityExecutorInstrs,
  customCapabilityTypeError,
  ensureCombinatorFunctions,
  ensureCombinatorToVec,
  ensureCustomCapabilityRuntime,
  resolveExternrefVecArg,
  type NativeCombinator,
} from "./promise-combinators.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

/**
 * How the combinator's iterable argument reached us: either already a
 * canonical externref vec (`vec` — an array-shaped argument, possibly
 * re-materialized from a typed vec) or a value that still has to go through
 * `__combinator_to_vec` (`drain` — strings, `any`, custom iterables).
 */
type CustomCombinatorIterable = { kind: "vec" | "drain"; local: number };

/** The combinators this module lowers for a CUSTOM receiver. */
export function isCustomCombinatorMethod(method: string): method is "all" | "race" {
  return method === "all" || method === "race";
}

interface CustomCombinatorRuntime {
  /** `$__promise_custom_comb_state { capResolve, capReject, vals: ref $arr_ext, len: i32, remaining: mut i32, settled: mut i32 }`. */
  stateTypeIdx: number;
  /** The per-index resolve-element closure struct (builtin-fn-meta subtype). */
  elemTypeIdx: number;
  /** Field index of `state` inside the element closure (after the meta header). */
  elemStateFieldIdx: number;
  /** externref array typeIdx used for the values buffer. */
  arrTypeIdx: number;
}

type CtxWithCustomCombinator = CodegenContext & { __promiseCustomCombinator?: CustomCombinatorRuntime };

/** §7.3.14 step 2 message for a non-callable `then` on a resolved element. */
const THEN_NOT_CALLABLE_MSG = "Promise combinator element then is not a function";

/** Names the runtime functions are registered under (re-read from funcMap at every bake). */
const FINISH_FN = "__promise_custom_comb_finish";
const ELEM_FN = "__promise_custom_comb_elem";
const ALL_FN = "__promise_custom_comb_all";
const RACE_FN = "__promise_custom_comb_race";

/**
 * Everything the four runtime bodies below read. Passing one record keeps each
 * builder a pure function of registered indices — no closure capture, so the
 * bodies can live outside the registration function (and stay under the
 * #3400 per-function budget).
 */
interface CombBodyRes {
  readonly ctx: CodegenContext;
  readonly stateTypeIdx: number;
  readonly elemTypeIdx: number;
  readonly elemStateFieldIdx: number;
  readonly elemMetaTypeIdx: number;
  readonly arrTypeIdx: number;
  readonly vecTypeIdx: number;
  readonly promiseTypeIdx: number;
  readonly wrapperRoot: number;
  readonly vecNewIdx: number;
  readonly vecPushIdx: number;
  readonly applyIdx: number;
  readonly externGetIdx: number;
  readonly finishFuncIdx: number;
  readonly elemFuncIdx: number;
}

/** Locals of `__promise_custom_comb_finish` (params: 0 = state). */
const finishLocals = (): { name: string; type: ValType }[] => [
  { name: "arr", type: EXTERNREF },
  { name: "i", type: I32 },
  { name: "n", type: I32 },
  { name: "args", type: EXTERNREF },
  { name: "err", type: EXTERNREF },
];

function buildCustomCombFinishBody(res: CombBodyRes): Instr[] {
  const { ctx, stateTypeIdx, arrTypeIdx, vecNewIdx, vecPushIdx, applyIdx } = res;
  // ── __promise_custom_comb_finish(state) — build the values Array and hand
  //    it to the capability's [[Resolve]] slot exactly once. ───────────────
  // params: 0=state · locals: 1=arr(externref) 2=i(i32) 3=n(i32)
  const finishBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    // already settled? (defensive — the counter should make this unreachable)
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 5 },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "i32.const", value: 1 },
    { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: 5 },
    // arr = __objvec_new(); for i in 0..len: push(vals[i])
    { op: "call", funcIdx: vecNewIdx },
    { op: "local.set", index: 1 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 0 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 3 },
    { op: "local.set", index: 3 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 2 },
            { op: "local.get", index: 3 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 1 },
            { op: "local.get", index: 0 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 2 },
            { op: "local.get", index: 2 },
            { op: "array.get", typeIdx: arrTypeIdx },
            { op: "call", funcIdx: vecPushIdx },
            { op: "local.get", index: 2 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 2 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Call(capability.[[Resolve]], undefined, «valuesArray»). §27.2.4.1.1 runs
    // this INSIDE PerformPromiseAll, so an abrupt completion is the spec's
    // IfAbruptRejectPromise: the capability is rejected with the thrown value
    // (`all/capability-resolve-throws-{reject,no-close}.js`), never rethrown
    // into the caller.
    buildTargetTaggedTry(
      ctx,
      { kind: "empty" },
      [
        { op: "local.get", index: 0 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 0 },
        { op: "ref.null.extern" },
        { op: "call", funcIdx: vecNewIdx },
        { op: "local.set", index: 4 },
        { op: "local.get", index: 4 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: vecPushIdx },
        { op: "local.get", index: 4 },
        { op: "call", funcIdx: applyIdx },
        { op: "drop" },
      ],
      [
        {
          tagIdx: ensureExnTag(ctx),
          body: [
            { op: "local.set", index: 5 },
            { op: "local.get", index: 0 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 1 },
            { op: "ref.null.extern" },
            { op: "call", funcIdx: vecNewIdx },
            { op: "local.set", index: 4 },
            { op: "local.get", index: 4 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: vecPushIdx },
            { op: "local.get", index: 4 },
            { op: "call", funcIdx: applyIdx },
            { op: "drop" },
          ],
        },
      ],
    ),
  ];
  return finishBody;
}

function buildCustomCombElemBody(res: CombBodyRes): Instr[] {
  const { stateTypeIdx, elemTypeIdx, elemStateFieldIdx, arrTypeIdx, finishFuncIdx } = res;
  // ── __promise_custom_comb_elem(self, value) — the resolve-element
  //    function: one-shot, writes vals[index], decrements remaining. ────────
  const elemBody: Instr[] = [
    // e = cast(self); if e.called: return
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: elemTypeIdx },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: elemTypeIdx, fieldIdx: elemStateFieldIdx + 2 },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "i32.const", value: 1 },
    { op: "struct.set", typeIdx: elemTypeIdx, fieldIdx: elemStateFieldIdx + 2 },
    // st = e.state; st.vals[e.index] = value
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: elemTypeIdx, fieldIdx: elemStateFieldIdx },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 2 },
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: elemTypeIdx, fieldIdx: elemStateFieldIdx + 1 },
    { op: "local.get", index: 1 },
    { op: "array.set", typeIdx: arrTypeIdx },
    // st.remaining -= 1; if 0 → finish
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 4 },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: 4 },
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 4 },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: finishFuncIdx },
      ],
    },
  ];
  return elemBody;
}

/**
 * The `all` and `race` element loops. They differ only in the two handlers
 * handed to `then` and in the `all`-side values/`[[RemainingElements]]`
 * bookkeeping, so they share one builder rather than two near-copies.
 */
function buildCustomCombLoopBody(res: CombBodyRes, kind: "all" | "race"): Instr[] {
  const {
    ctx,
    stateTypeIdx,
    elemTypeIdx,
    elemStateFieldIdx,
    elemMetaTypeIdx,
    arrTypeIdx,
    vecTypeIdx,
    promiseTypeIdx,
    wrapperRoot,
    vecNewIdx,
    vecPushIdx,
    applyIdx,
    externGetIdx,
    finishFuncIdx,
    elemFuncIdx,
  } = res;
  // Shared element-invocation tail: Invoke(next, "then", «h1, h2»).
  const thenKeyInstrs = (): Instr[] => stringConstantExternrefInstrs(ctx, "then");

  // ── __promise_custom_comb_all(C, resolveFn, capResolve, capReject, vec) ──
  // params 0..4 · locals 5=n 6=i 7=state 8=next 9=args 10=elem 11=thenFn
  const lenInstrs = (): Instr[] => [
    { op: "local.get", index: 4 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: 4 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      ],
    },
    { op: "local.set", index: 5 },
  ];
  /** `vec[i]` → externref on the stack. */
  const elementAt = (): Instr[] => [
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 6 },
    { op: "array.get", typeIdx: arrTypeIdx },
  ];
  /** `next = Call(resolveFn, C, «vec[i]»)` → local 8. */
  const callResolveForElement = (): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: vecNewIdx },
    { op: "local.set", index: 9 },
    { op: "local.get", index: 9 },
    ...elementAt(),
    { op: "call", funcIdx: vecPushIdx },
    { op: "local.get", index: 9 },
    { op: "call", funcIdx: applyIdx },
    { op: "local.set", index: 8 },
  ];
  /**
   * `Invoke(next, "then", «h1, h2»)` where the handler instrs push externrefs.
   *
   * §7.3.20 Invoke → §7.3.14 Call: a `then` that is not callable is a
   * TypeError, and here that TypeError is what rejects the aggregate (the
   * enclosing `guardedElementWork` catches it). Without the explicit throw the
   * apply bridge would answer its undefined sentinel and the element would
   * simply never settle — a silent hang instead of a rejection.
   *
   * The native `$Promise` carrier is EXEMPT: a value read of `.then` on a
   * native promise instance answers undefined today (#5197 G7), so throwing
   * here would reject aggregates over native promise elements that the old
   * host path resolved. Those keep the pre-existing behaviour.
   */
  const invokeThen = (h1: Instr[], h2: Instr[]): Instr[] => [
    { op: "local.get", index: 8 },
    ...thenKeyInstrs(),
    { op: "call", funcIdx: externGetIdx },
    { op: "local.set", index: 11 },
    { op: "local.get", index: 11 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: wrapperRoot },
    { op: "i32.eqz" },
    { op: "local.get", index: 8 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...stringConstantExternrefInstrs(ctx, THEN_NOT_CALLABLE_MSG),
        { op: "call", funcIdx: ctx.funcMap.get("__new_TypeError") ?? -1 },
        { op: "throw", tagIdx: ensureExnTag(ctx) },
      ],
    },
    { op: "call", funcIdx: vecNewIdx },
    { op: "local.set", index: 9 },
    { op: "local.get", index: 9 },
    ...h1,
    { op: "call", funcIdx: vecPushIdx },
    { op: "local.get", index: 9 },
    ...h2,
    { op: "call", funcIdx: vecPushIdx },
    { op: "local.get", index: 11 },
    { op: "local.get", index: 8 },
    { op: "local.get", index: 9 },
    { op: "call", funcIdx: applyIdx },
    { op: "drop" },
  ];

  /**
   * §27.2.4.1.1 step 4 / §27.2.4.3.1 step 4 abrupt handling: a throwing
   * `C.resolve`, a throwing `Get(next, "then")` or a throwing `then` REJECTS
   * the capability (IfAbruptRejectPromise) and ends the loop — it never
   * escapes into the caller. `aborted` (local 13) is the loop's exit flag: a
   * flag rather than a branch out of the handler, so the try-table's own
   * depth bookkeeping is never a correctness question.
   */
  const guardedElementWork = (work: Instr[]): Instr[] => [
    buildTargetTaggedTry(ctx, { kind: "empty" }, work, [
      {
        tagIdx: ensureExnTag(ctx),
        body: [
          { op: "local.set", index: 12 },
          { op: "local.get", index: 3 },
          { op: "ref.null.extern" },
          { op: "call", funcIdx: vecNewIdx },
          { op: "local.set", index: 9 },
          { op: "local.get", index: 9 },
          { op: "local.get", index: 12 },
          { op: "call", funcIdx: vecPushIdx },
          { op: "local.get", index: 9 },
          { op: "call", funcIdx: applyIdx },
          { op: "drop" },
          { op: "i32.const", value: 1 },
          { op: "local.set", index: 13 },
        ],
      },
    ]),
  ];

  const allBody: Instr[] = [
    ...lenInstrs(),
    // state = { capResolve, capReject, vals: new array(n), len: n, remaining: 1, settled: 0 }
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "ref.null.extern" },
    { op: "local.get", index: 5 },
    { op: "array.new", typeIdx: arrTypeIdx },
    { op: "local.get", index: 5 },
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: stateTypeIdx },
    { op: "local.set", index: 7 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 6 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 6 },
            { op: "local.get", index: 5 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 13 },
            { op: "br_if", depth: 1 },
            ...guardedElementWork([
              ...callResolveForElement(),
              // elem = new $elem(state, i)
              { op: "ref.func", funcIdx: elemFuncIdx },
              { op: "i32.const", value: 1 },
              closureBagInitInstr(),
              { op: "i32.const", value: 0 },
              { op: "i32.const", value: elemMetaTypeIdx },
              { op: "local.get", index: 7 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 6 },
              { op: "i32.const", value: 0 },
              { op: "struct.new", typeIdx: elemTypeIdx },
              { op: "extern.convert_any" },
              { op: "local.set", index: 10 },
              // remaining += 1 (spec step 4.j, BEFORE the Invoke)
              { op: "local.get", index: 7 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 7 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: 4 },
              ...invokeThen([{ op: "local.get", index: 10 }], [{ op: "local.get", index: 3 }]),
            ]),
            { op: "local.get", index: 6 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 6 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // remaining -= 1; if 0 → resolve with the values array. Skipped after an
    // abrupt element step: PerformPromiseAll returned, the capability is
    // already rejected, and the spec never reaches step 4.d.
    { op: "local.get", index: 13 },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 7 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 7 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: 4 },
        { op: "local.get", index: 7 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 4 },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 7 },
            { op: "call", funcIdx: finishFuncIdx },
          ],
        },
      ],
    },
  ];

  // ── __promise_custom_comb_race(C, resolveFn, capResolve, capReject, vec) ──
  const raceBody: Instr[] = [
    ...lenInstrs(),
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 6 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 6 },
            { op: "local.get", index: 5 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 13 },
            { op: "br_if", depth: 1 },
            ...guardedElementWork([
              ...callResolveForElement(),
              // §27.2.4.3.1 step 4.j — the capability's OWN settle functions.
              ...invokeThen([{ op: "local.get", index: 2 }], [{ op: "local.get", index: 3 }]),
            ]),
            { op: "local.get", index: 6 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 6 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
  return kind === "all" ? allBody : raceBody;
}

/** Locals shared by both element loops (params: 0..4). */
const combLocals = (stateRefNull: ValType): { name: string; type: ValType }[] => [
  { name: "n", type: I32 },
  { name: "i", type: I32 },
  { name: "state", type: stateRefNull },
  { name: "next", type: EXTERNREF },
  { name: "args", type: EXTERNREF },
  { name: "elem", type: EXTERNREF },
  { name: "thenFn", type: EXTERNREF },
  { name: "err", type: EXTERNREF },
  { name: "aborted", type: I32 },
];

/**
 * Idempotently register the custom-combinator state/element types and the four
 * runtime helpers. Every dependency (object runtime, apply bridge, objvec
 * builders, the "then" string constant) is ensured BEFORE any body is built, so
 * no dependency append can land between a bake and its use.
 */
function ensureCustomCombinatorRuntime(ctx: CodegenContext): CustomCombinatorRuntime | null {
  const cached = (ctx as CtxWithCustomCombinator).__promiseCustomCombinator;
  if (cached) return cached;
  if (!isStandalonePromiseActive(ctx)) return null;

  const ids = ensureCombinatorFunctions(ctx);
  ensureObjectRuntime(ctx);
  const vecBuilders = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  if (ctx.nativeStrings) ensureNativeStringHelpers(ctx);
  addStringConstantGlobal(ctx, "then");
  addStringConstantGlobal(ctx, THEN_NOT_CALLABLE_MSG);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, null);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined || vecBuilders.newIdx === undefined || vecBuilders.pushIdx === undefined) return null;

  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF], []);
  const wrapperRoot = getFuncRefWrapperRootTypeIdx(ctx);
  if (!wrapper || wrapperRoot === undefined) return null;

  const arrTypeIdx = ids.arrTypeIdx;

  // ── state struct ────────────────────────────────────────────────────────
  const stateFields = [
    { name: "capResolve", type: EXTERNREF, mutable: false },
    { name: "capReject", type: EXTERNREF, mutable: false },
    { name: "vals", type: { kind: "ref" as const, typeIdx: arrTypeIdx }, mutable: false },
    { name: "len", type: I32, mutable: false },
    { name: "remaining", type: I32, mutable: true },
    { name: "settled", type: I32, mutable: true },
  ];
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: "$__promise_custom_comb_state", fields: stateFields });
  ctx.structMap.set("$__promise_custom_comb_state", stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, "$__promise_custom_comb_state");
  ctx.structFields.set(
    "$__promise_custom_comb_state",
    stateFields.map((f) => ({ ...f })),
  );

  // ── resolve-element closure struct (§27.2.4.1.2: an anonymous builtin
  //    function object, `length` 1, `[[AlreadyCalled]]`) ────────────────────
  const elemMetaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrapper.structTypeIdx,
    wrapper.closureInfo,
    "promise:customelem",
    "",
    1,
  );
  const elemMetaFields = (
    ctx.mod.types[elemMetaTypeIdx] as { fields: { name: string; type: ValType; mutable: boolean }[] }
  ).fields;
  const elemStateFieldIdx = elemMetaFields.length;
  const elemFields = [
    ...elemMetaFields.map((f) => ({ ...f })),
    { name: "state", type: { kind: "ref" as const, typeIdx: stateTypeIdx }, mutable: false },
    { name: "index", type: I32, mutable: false },
    { name: "called", type: I32, mutable: true },
  ];
  const elemTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__promise_custom_comb_elem",
    fields: elemFields,
    superTypeIdx: elemMetaTypeIdx,
  });
  ctx.structMap.set("$__promise_custom_comb_elem", elemTypeIdx);
  ctx.typeIdxToStructName.set(elemTypeIdx, "$__promise_custom_comb_elem");
  ctx.structFields.set(
    "$__promise_custom_comb_elem",
    elemFields.map((f) => ({ ...f })),
  );

  const runtime: CustomCombinatorRuntime = {
    stateTypeIdx,
    elemTypeIdx,
    elemStateFieldIdx,
    arrTypeIdx,
  };

  const stateRefNull: ValType = { kind: "ref_null", typeIdx: stateTypeIdx };
  const vecRefNull: ValType = { kind: "ref_null", typeIdx: ids.vecTypeIdx };

  // Mint every handle BEFORE any body is built: the bodies bake each other's
  // indices (`elem` calls `finish`, both loops call both), and a stable mint
  // never shifts.
  const finishFuncIdx = mintDefinedFunc(ctx);
  const elemFuncIdx = mintDefinedFunc(ctx);
  const allFuncIdx = mintDefinedFunc(ctx);
  const raceFuncIdx = mintDefinedFunc(ctx);
  const res: CombBodyRes = {
    ctx,
    stateTypeIdx,
    elemTypeIdx,
    elemStateFieldIdx,
    elemMetaTypeIdx,
    arrTypeIdx,
    vecTypeIdx: ids.vecTypeIdx,
    promiseTypeIdx: ids.promiseTypeIdx,
    wrapperRoot,
    vecNewIdx: vecBuilders.newIdx,
    vecPushIdx: vecBuilders.pushIdx,
    applyIdx,
    externGetIdx,
    finishFuncIdx,
    elemFuncIdx,
  };
  const combTypeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF, vecRefNull], []);

  pushDefinedFunc(ctx, finishFuncIdx, {
    name: FINISH_FN,
    typeIdx: addFuncType(ctx, [stateRefNull], []),
    locals: finishLocals(),
    body: buildCustomCombFinishBody(res),
    exported: false,
  });
  ctx.funcMap.set(FINISH_FN, finishFuncIdx);

  pushDefinedFunc(ctx, elemFuncIdx, {
    name: ELEM_FN,
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [
      { name: "e", type: { kind: "ref_null", typeIdx: elemTypeIdx } },
      { name: "st", type: stateRefNull },
    ],
    body: buildCustomCombElemBody(res),
    exported: false,
  });
  ctx.funcMap.set(ELEM_FN, elemFuncIdx);

  pushDefinedFunc(ctx, allFuncIdx, {
    name: ALL_FN,
    typeIdx: combTypeIdx,
    locals: combLocals(stateRefNull),
    body: buildCustomCombLoopBody(res, "all"),
    exported: false,
  });
  ctx.funcMap.set(ALL_FN, allFuncIdx);

  pushDefinedFunc(ctx, raceFuncIdx, {
    name: RACE_FN,
    typeIdx: combTypeIdx,
    locals: combLocals(stateRefNull),
    body: buildCustomCombLoopBody(res, "race"),
    exported: false,
  });
  ctx.funcMap.set(RACE_FN, raceFuncIdx);

  (ctx as CtxWithCustomCombinator).__promiseCustomCombinator = runtime;
  return runtime;
}

/**
 * True when `arg` denotes an ordinary compiled constructor — a `function`
 * declaration or a `function` expression initializer, never a generator or an
 * `async` function. Shared admission predicate for the `.call` arms so the
 * settle arm and the combinator arm can never drift apart.
 */
function resolveOrdinaryCapabilityCtor(ctx: CodegenContext, arg: ts.Expression): boolean {
  const decl = ts.isIdentifier(arg) ? ctx.oracle.valueDeclarationOf(arg) : arg;
  const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
  const expr = init ?? decl;
  if (expr !== undefined && ts.isFunctionExpression(expr) && expr.asteriskToken === undefined) {
    return !(expr.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
  }
  if (
    decl !== undefined &&
    ts.isFunctionDeclaration(decl) &&
    decl.asteriskToken === undefined &&
    !(decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false)
  ) {
    return true;
  }
  return false;
}

/**
 * Re-materialize a TYPED `__vec_*` argument (elements are closed struct refs,
 * `f64`, or `i32`) as the canonical externref vec the element pipeline reads.
 *
 * Why this exists: `[p1, p2]` where `p1`/`p2` are object literals with a `then`
 * method compiles to a vec of the CLOSED STRUCT type, not to `__vec_externref`.
 * `__combinator_to_vec` answers null for that shape, so without this the whole
 * `call-resolve-element` family rejected with "argument is not iterable"
 * (measured: 9 of the 28 target rows). The elements are already in a wasm
 * array — this loop lifts each one to externref rather than pretending the
 * value was not iterable.
 *
 * Returns the local holding `(ref null $__vec_externref)`, or undefined when
 * the element representation is outside the admitted set (caller falls back).
 */
function emitTypedVecToExternrefVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  srcLocal: number,
  srcVecTypeIdx: number,
  srcArrTypeIdx: number,
  dstVecTypeIdx: number,
  dstArrTypeIdx: number,
): number | undefined {
  const arrDef = ctx.mod.types[srcArrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return undefined;
  const elem = arrDef.element as ValType;
  const lift: Instr[] = [];
  if (elem.kind === "externref") {
    // nothing to do
  } else if (elem.kind === "ref" || elem.kind === "ref_null" || elem.kind === "anyref" || elem.kind === "eqref") {
    lift.push({ op: "extern.convert_any" });
  } else if (elem.kind === "f64" || elem.kind === "i32") {
    ensureLateImport(ctx, "__box_number", [F64], [EXTERNREF]);
    flushLateImportShifts(ctx, fctx);
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return undefined;
    if (elem.kind === "i32") lift.push({ op: "f64.convert_i32_s" });
    lift.push({ op: "call", funcIdx: boxIdx });
  } else {
    return undefined;
  }

  const nLocal = allocLocal(fctx, `__comb_conv_n_${fctx.locals.length}`, I32);
  const iLocal = allocLocal(fctx, `__comb_conv_i_${fctx.locals.length}`, I32);
  const arrLocal = allocLocal(fctx, `__comb_conv_arr_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: dstArrTypeIdx,
  });
  const outLocal = allocLocal(fctx, `__comb_conv_vec_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: dstVecTypeIdx,
  });
  fctx.body.push(
    { op: "local.get", index: srcLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: srcLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 0 },
      ],
    },
    { op: "local.set", index: nLocal },
    { op: "local.get", index: nLocal },
    { op: "array.new_default", typeIdx: dstArrTypeIdx },
    { op: "local.set", index: arrLocal },
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
            { op: "local.get", index: arrLocal },
            { op: "ref.as_non_null" },
            { op: "local.get", index: iLocal },
            { op: "local.get", index: srcLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: srcVecTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: iLocal },
            { op: "array.get", typeIdx: srcArrTypeIdx },
            ...lift.map((instr) => ({ ...instr }) as Instr),
            { op: "array.set", typeIdx: dstArrTypeIdx },
            { op: "local.get", index: iLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: iLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: nLocal },
    { op: "local.get", index: arrLocal },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: dstVecTypeIdx },
    { op: "local.set", index: outLocal },
  );
  return outLocal;
}

/**
 * Compile the combinator's iterable argument into the representation the
 * element pipeline consumes. Tries the argument's NATURAL type first (an array
 * lowers to a `__vec_*` struct, which is the common shape) and only falls back
 * to the externref drain — the natural probe is rolled back transactionally
 * when it is not a vec, so nothing it allocated survives.
 */
function emitCustomCombinatorIterableArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg: ts.Expression,
): CustomCombinatorIterable | undefined {
  const ids = ensureCombinatorFunctions(ctx);
  const snap = snapshotSpeculative(ctx, fctx);
  const natural = compileExpression(ctx, fctx, arg);
  const externShape = resolveExternrefVecArg(ctx, natural);
  if (externShape && externShape.vecTypeIdx === ids.vecTypeIdx) {
    const local = allocLocal(fctx, `__promise_custom_iter_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: externShape.vecTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: local });
    return { kind: "vec", local };
  }
  const naturalTypeIdx =
    natural && (natural.kind === "ref" || natural.kind === "ref_null")
      ? ((natural as { typeIdx?: number }).typeIdx ?? -1)
      : -1;
  const naturalName = naturalTypeIdx >= 0 ? ctx.typeIdxToStructName.get(naturalTypeIdx) : undefined;
  if (naturalTypeIdx >= 0 && naturalName?.startsWith("__vec_")) {
    const srcArrTypeIdx = getArrTypeIdxFromVec(ctx, naturalTypeIdx);
    if (srcArrTypeIdx >= 0) {
      const srcLocal = allocLocal(fctx, `__promise_custom_srcvec_${fctx.locals.length}`, {
        kind: "ref_null",
        typeIdx: naturalTypeIdx,
      });
      fctx.body.push({ op: "local.set", index: srcLocal });
      const converted = emitTypedVecToExternrefVec(
        ctx,
        fctx,
        srcLocal,
        naturalTypeIdx,
        srcArrTypeIdx,
        ids.vecTypeIdx,
        ids.arrTypeIdx,
      );
      if (converted !== undefined) return { kind: "vec", local: converted };
    }
  }
  rollbackSpeculative(ctx, fctx, snap);
  const asExtern = compileExpression(ctx, fctx, arg, EXTERNREF);
  if (asExtern === null) return undefined;
  if (asExtern.kind !== "externref") coerceType(ctx, fctx, asExtern, EXTERNREF);
  const local = allocLocal(fctx, `__promise_custom_iter_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: local });
  return { kind: "drain", local };
}

/**
 * Emit `Promise.{all,race}.call(C, iterable)` natively for an ordinary compiled
 * constructor. Leaves the capability's promise (the value `C` returned) on the
 * stack as an externref and returns true; returns false — having emitted
 * nothing — when the shape is outside the admitted cohort (the caller rolls
 * back and keeps its previous route).
 *
 * `constructorLocal` must already hold `C` as an externref function value.
 */
function emitStandalonePromiseCustomCombinator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: NativeCombinator,
  constructorLocal: number,
  iterable: CustomCombinatorIterable | undefined,
): boolean {
  if (!isStandalonePromiseActive(ctx)) return false;
  if (!isCustomCombinatorMethod(method)) return false;
  const capability = ensureCustomCapabilityRuntime(ctx);
  const runtime = ensureCustomCombinatorRuntime(ctx);
  const ids = ensureCombinatorFunctions(ctx);
  ensureCombinatorToVec(ctx);
  const wrapperRoot = getFuncRefWrapperRootTypeIdx(ctx);
  if (!capability || !runtime || wrapperRoot === undefined) return false;
  const toVecIdx = ctx.funcMap.get("__combinator_to_vec");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (toVecIdx === undefined || externGetIdx === undefined) return false;
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const typeErrorIdx = ctx.funcMap.get("__new_TypeError");
  if (typeErrorIdx === undefined) return false;
  const applyIdx = reserveApplyClosure(ctx);
  const vecBuilders = ensureObjVecBuilders(ctx);
  if (vecBuilders.newIdx === undefined || vecBuilders.pushIdx === undefined) return false;
  const notIterableMsg = `Promise.${method} argument is not iterable`;
  addStringConstantGlobal(ctx, notIterableMsg);
  addStringConstantGlobal(ctx, `Promise.${method} resolve is not callable`);
  addStringConstantGlobal(ctx, "resolve");

  const stateLocal = allocLocal(fctx, `__promise_capability_state_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: capability.stateTypeIdx,
  });
  const executorLocal = allocLocal(fctx, `__promise_capability_executor_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: capability.executorTypeIdx,
  });
  const resultLocal = allocLocal(fctx, `__promise_custom_result_${fctx.locals.length}`, EXTERNREF);
  const resolveFnLocal = allocLocal(fctx, `__promise_custom_resolvefn_${fctx.locals.length}`, EXTERNREF);
  const drainedLocal = allocLocal(fctx, `__promise_custom_drained_${fctx.locals.length}`, EXTERNREF);
  const vecLocal = allocLocal(fctx, `__promise_custom_vec_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ids.vecTypeIdx,
  });
  const argsLocal = allocLocal(fctx, `__promise_custom_args_${fctx.locals.length}`, EXTERNREF);

  // ── 1. NewPromiseCapability(C): construct C with the native capability
  //       executor; a throwing C propagates (ctx-ctor-throws). ─────────────
  fctx.body.push(
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: capability.stateTypeIdx },
    { op: "local.set", index: stateLocal },
    ...buildCustomCapabilityExecutorInstrs(capability, stateLocal),
    { op: "local.set", index: executorLocal },
  );
  // `C` is invoked through the generic `__apply_closure` bridge rather than a
  // baked `call_ref` on its lifted signature. That is the whole reason this
  // arm reaches the test262 cohort at all: every row here writes a STATIC onto
  // the constructor (`C.resolve = …`), which moves the value the identifier
  // reads onto the `$Object` function-carrier — a `call_ref` through
  // `closureInfoByTypeIdx` then finds a null funcref and throws the
  // NewPromiseCapability TypeError before `C`'s body ever runs (measured:
  // `checkPoint === 0` on every probe with a static). The bridge dispatches
  // both representations.
  fctx.body.push(
    { op: "local.get", index: constructorLocal },
    { op: "ref.null.extern" },
    { op: "call", funcIdx: vecBuilders.newIdx },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    { op: "local.get", index: executorLocal },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: vecBuilders.pushIdx },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: applyIdx },
    { op: "local.set", index: resultLocal },
  );

  // ── 2. NewPromiseCapability steps 8-9 — both slots must be callable.
  //       A zero-argument C never invokes the executor, so this is where
  //       `S25.4.4.1_A4.1_T1`'s TypeError comes from. ─────────────────────
  const slotCallable = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: stateLocal },
    { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: wrapperRoot },
  ];
  fctx.body.push(...slotCallable(0), ...slotCallable(1), { op: "i32.and" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: customCapabilityTypeError(ctx) });

  // ── 3. promiseResolve = Get(C, "resolve"), once, before the iterable is
  //       touched (§27.2.4.1 step 4 / GetPromiseResolve). ─────────────────
  fctx.body.push(
    { op: "local.get", index: constructorLocal },
    ...stringConstantExternrefInstrs(ctx, "resolve"),
    { op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx },
    { op: "local.set", index: resolveFnLocal },
  );

  // ── 4. IsCallable(promiseResolve) — abrupt ⇒ IfAbruptRejectPromise: the
  //       capability is REJECTED with a TypeError, not thrown.
  //       A FACTORY, never a shared array: the same `Instr` object spliced
  //       into two arrays would be double-remapped by the late-import walk.
  const rejectWithTypeError = (message: string): Instr[] => [
    { op: "local.get", index: stateLocal },
    { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx: 1 },
    { op: "ref.null.extern" },
    { op: "call", funcIdx: vecBuilders.newIdx },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    ...stringConstantExternrefInstrs(ctx, message),
    { op: "call", funcIdx: typeErrorIdx },
    { op: "call", funcIdx: vecBuilders.pushIdx },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: applyIdx },
    { op: "drop" },
  ];

  // ── 5. Drain the iterable (no IteratorClose — documented residual) and run
  //       the element pipeline; a non-iterable argument rejects. ──────────
  const combFnIdx = ctx.funcMap.get(method === "race" ? RACE_FN : ALL_FN);
  if (combFnIdx === undefined) return false;
  const pipeline: Instr[] = [];
  const runElementLoop = (): Instr[] => [
    { op: "local.get", index: constructorLocal },
    { op: "local.get", index: resolveFnLocal },
    { op: "local.get", index: stateLocal },
    { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: stateLocal },
    { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: vecLocal },
    { op: "call", funcIdx: combFnIdx },
  ];
  if (iterable === undefined) {
    pipeline.push(...rejectWithTypeError(notIterableMsg));
  } else if (iterable.kind === "vec") {
    pipeline.push(
      { op: "local.get", index: iterable.local },
      { op: "local.set", index: vecLocal },
      ...runElementLoop(),
    );
  } else {
    pipeline.push(
      { op: "local.get", index: iterable.local },
      { op: "call", funcIdx: toVecIdx },
      { op: "local.set", index: drainedLocal },
      { op: "local.get", index: drainedLocal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: rejectWithTypeError(notIterableMsg),
        else: [
          { op: "local.get", index: drainedLocal },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: ids.vecTypeIdx },
          { op: "local.set", index: vecLocal },
          ...runElementLoop(),
        ],
      },
    );
  }
  // IsCallable gate around the whole pipeline.
  fctx.body.push(
    { op: "local.get", index: resolveFnLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: wrapperRoot },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: pipeline,
      else: rejectWithTypeError(`Promise.${method} resolve is not callable`),
    },
  );

  fctx.body.push({ op: "local.get", index: resultLocal });
  return true;
}

/**
 * The `Promise.{all,race}.call(C, iterable)` arm itself, lifted out of
 * `compileNamespaceStaticCall` so the dispatcher stays a dispatcher (and the
 * god-file does not grow by the size of a protocol). Returns the result type
 * when it emitted the native lowering, `undefined` when it refused — a refusal
 * is transactional: the speculative snapshot is rolled back, so the caller's
 * remaining arms see an untouched function body.
 *
 * Admitted: an ordinary compiled `C` (never `Promise` itself — that spelling
 * reshapes to the direct intrinsic form further down), one or two arguments.
 */
export function tryEmitCustomCombinatorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: NativeCombinator,
): ValType | undefined {
  const ctorArg = expr.arguments[0];
  if (ctorArg === undefined || expr.arguments.length > 2) return undefined;
  if (ts.isIdentifier(ctorArg) && ctorArg.text === "Promise") return undefined;
  if (!resolveOrdinaryCapabilityCtor(ctx, ctorArg)) return undefined;

  const snap = snapshotSpeculative(ctx, fctx);
  // `C` is taken as an externref FUNCTION VALUE, not as a nominal closure ref:
  // every row in this cohort writes a static onto the constructor
  // (`C.resolve = …`), and the emitter invokes it through the generic
  // `__apply_closure` bridge, which dispatches both representations.
  const ctorType = compileExpression(ctx, fctx, ctorArg, EXTERNREF);
  let emitted = false;
  if (ctorType !== null) {
    if (ctorType.kind !== "externref") coerceType(ctx, fctx, ctorType, EXTERNREF);
    const ctorLocal = allocLocal(fctx, `__promise_custom_ctor_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "local.set", index: ctorLocal });
    // The iterable ARGUMENT is evaluated before the method body runs (ordinary
    // argument evaluation); the drain (`GetIterator`) happens later, inside the
    // emitter, after `Get(C, "resolve")`.
    const iterableArg = expr.arguments[1];
    const iterable = iterableArg === undefined ? undefined : emitCustomCombinatorIterableArg(ctx, fctx, iterableArg);
    emitted = emitStandalonePromiseCustomCombinator(ctx, fctx, method, ctorLocal, iterable);
  }
  if (emitted) return EXTERNREF;
  rollbackSpeculative(ctx, fctx, snap);
  return undefined;
}
