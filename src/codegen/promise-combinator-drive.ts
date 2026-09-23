// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster D, slice D2b) `Promise.all` / `Promise.race` over a DYNAMIC
 * iterable, driven step by step in spec order (§27.2.4.1 / §27.2.4.5):
 *
 *   NewPromiseCapability(C)
 *   promiseResolve = GetPromiseResolve(C)        -- IfAbruptRejectPromise
 *   iteratorRecord = GetIterator(iterable)       -- IfAbruptRejectPromise
 *   Repeat:
 *     next = IteratorStep(iteratorRecord)        -- abrupt: [[Done]] = true, reject
 *     if next is false: finish (all: drop the remaining-elements sentinel)
 *     nextValue = IteratorValue(next)            -- abrupt: [[Done]] = true, reject
 *     nextPromise = Call(promiseResolve, C, «nextValue»)
 *     Invoke(nextPromise, "then", «onFulfilled, capability.[[Reject]]»)
 *   on an abrupt completion of the loop body with [[Done]] false:
 *     IteratorClose(iteratorRecord, completion)  -- the ORIGINAL throw wins
 *     IfAbruptRejectPromise
 *
 * WHY a new emitter, and not a fix inside `__combinator_to_vec`: the legacy
 * dynamic path DRAINS the iterable into a vec before the first element is
 * resolved. That is unobservable only while `resolve`/`then` are the
 * intrinsics and `next()` never throws. It is wrong in three measured ways:
 *
 *   1. a throwing `next()` / `done` getter / `value` getter escapes the drain
 *      SYNCHRONOUSLY instead of rejecting the capability (`iter-step-err-reject`,
 *      `iter-next-val-err-reject`, `S25.4.4.{1_A5.1,3_A4.1}_T1`);
 *   2. an abrupt `Call(resolve)` / `Invoke(then)` can never close an iterator
 *      that was already exhausted (`invoke-{resolve,then}-*-close`), and an
 *      infinite iterator whose resolve throws on the first element hangs;
 *   3. (H1, D2's finding) the drain's user arm needs the closed-struct
 *      `__call_@@iterator` dispatcher, which is not EMITTED unless some struct
 *      carries an `@@iterator` member — so `o[Symbol.iterator] = fn` on a plain
 *      `$Object` is "not iterable" to it, while `for…of` over the same object
 *      works. The drive calls GetIterator through `__iterator`, the SAME native
 *      `for…of` and the #6651 G1 destructuring drive use, whose OBJ arm (#3119)
 *      reads the symbol-keyed expando. H1 is therefore fixed by construction
 *      here and deliberately NOT inside the legacy drain (D2: doing it there
 *      would turn the `*-close` rows from fast failures into hangs).
 *
 * `Promise.all` needs a results list whose length is unknown until the
 * iterator is done, while a resolve-element function may run SYNCHRONOUSLY
 * inside `Invoke(then)` (a user thenable). The legacy `$CombinatorState` has an
 * immutable `resultsArr`/`length`, so the drive registers its own
 * `$CombinatorDriveState` (same field order, mutable array + length) plus the
 * three reaction bodies over it — built by the SAME body builders the legacy
 * runtime uses (`combinator-bodies.ts`), parameterised only by type index.
 * `race` needs none of that: its handlers settle the capability directly.
 *
 * Scope: all/race over an argument that is neither an array literal nor an
 * externref/f64 vec nor a Set/Map (those keep their existing, byte-identical
 * lowerings), and not on a Promise-subclass receiver. `allSettled`/`any` and
 * the custom-constructor `.call` protocol are unchanged. When `resolve`/`then`
 * are not observable (the #5197 R3-2 source gate), each element takes the
 * legacy `__combinator_subscribe`-shaped reaction directly — the per-element
 * Get/Call/Invoke of the intrinsics is unobservable then — but the iterator is
 * still driven step by step, which is what fixes (1) and (3).
 */
import type { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  buildAllFulfillBody,
  buildAllFulfillLocals,
  buildRejectBody,
  buildSettleWrapperLocals,
  buildSubscribeBody,
  buildSubscribeLocals,
} from "../runtime/wasmgc/promise/combinator-bodies.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { closureBagInitInstr, getOrCreateFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { addFuncType } from "./registry/types.js";
import { ensureExnTag } from "./registry/imports.js";
import { ensureNativeIteratorRuntime } from "./iterator-native.js";
import { compileExpression } from "./shared.js";
import { PROMISE_STATE_PENDING, ensureAsyncDriveRuntime } from "./async-scheduler.js";
import {
  combinatorReactionFns,
  emitObservableCombinatorElement,
  emitObservableCombinatorPreparation,
  ensureCombinatorFunctions,
  ensureObservableCombinatorRuntime,
  type CombinatorRuntime,
  type ObservableCombinatorPreparation,
  type ObservableCombinatorRuntime,
  type NativeCombinator,
  type ObservableElementCarrier,
} from "./promise-combinators.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** Field order is `$CombinatorState`'s, so the shared body builders apply unchanged. */
const DRIVE_STATE_ARR = 1;
const DRIVE_STATE_LENGTH = 2;
const DRIVE_STATE_REMAINING = 3;

interface DriveAllRuntime {
  stateTypeIdx: number;
  elemCapsTypeIdx: number;
  /** Present once an OBSERVABLE drive needed a real resolve-element function object. */
  resolveCap?: { typeIdx: number; metaTypeIdx: number };
}

const driveAllByCtx = new WeakMap<CodegenContext, DriveAllRuntime>();

function registerStruct(
  ctx: CodegenContext,
  name: string,
  fields: { name: string; type: ValType; mutable: boolean }[],
): number {
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name, fields });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(
    name,
    fields.map((f) => ({ ...f })),
  );
  return typeIdx;
}

/**
 * Register `$CombinatorDriveState` / `$CombinatorDriveElemCaps` and the three
 * reaction bodies over them. Idempotent; only a module that compiles a driven
 * `Promise.all` ever pays for it. Function indices are NOT cached — emit sites
 * re-read `ctx.funcMap`, so a later late-import shift cannot strand them.
 */
function ensureDriveAllRuntime(
  ctx: CodegenContext,
  ids: CombinatorRuntime,
  observable: ObservableCombinatorRuntime | null,
): DriveAllRuntime | undefined {
  let drive = driveAllByCtx.get(ctx);
  if (!drive) {
    const rt = ensureAsyncDriveRuntime(ctx);
    const resolveValueIdx = ctx.funcMap.get("__promise_resolve_value");
    if (resolveValueIdx === undefined) return undefined;
    const stateTypeIdx = registerStruct(ctx, "$CombinatorDriveState", [
      { name: "resultPromise", type: { kind: "ref", typeIdx: ids.promiseTypeIdx }, mutable: false },
      { name: "resultsArr", type: { kind: "ref", typeIdx: ids.arrTypeIdx }, mutable: true },
      { name: "length", type: I32, mutable: true },
      { name: "remaining", type: I32, mutable: true },
    ]);
    const elemCapsTypeIdx = registerStruct(ctx, "$CombinatorDriveElemCaps", [
      { name: "state", type: { kind: "ref", typeIdx: stateTypeIdx }, mutable: false },
      { name: "index", type: I32, mutable: false },
    ]);
    const captures = { elemCapsTypeIdx, stateTypeIdx };
    const wrapperTypeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
    const subscribeTypeIdx = addFuncType(
      ctx,
      [EXTERNREF, EXTERNREF, I32, { kind: "funcref" }, { kind: "funcref" }],
      [],
    );
    const subscribeIdx = mintDefinedFunc(ctx);
    const fulfillIdx = mintDefinedFunc(ctx);
    const rejectIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, subscribeIdx, {
      name: "__combinator_drive_subscribe",
      typeIdx: subscribeTypeIdx,
      locals: buildSubscribeLocals(ids.promiseTypeIdx),
      body: buildSubscribeBody({
        ...captures,
        promiseTypeIdx: ids.promiseTypeIdx,
        callbackTypeIdx: rt.callbackTypeIdx,
        enqueueFuncIdx: rt.enqueueFuncIdx,
        markRejectionHandledFuncIdx: rt.markRejectionHandledFuncIdx >= 0 ? rt.markRejectionHandledFuncIdx : undefined,
        resolveValueFuncIdx: resolveValueIdx,
        bagInit: { op: "ref.null.extern" },
      }),
      exported: false,
    });
    ctx.funcMap.set("__combinator_drive_subscribe", subscribeIdx);
    pushDefinedFunc(ctx, fulfillIdx, {
      name: "__combinator_drive_all_fulfill",
      typeIdx: wrapperTypeIdx,
      locals: buildAllFulfillLocals(captures),
      body: buildAllFulfillBody({
        ...captures,
        arrTypeIdx: ids.arrTypeIdx,
        vecTypeIdx: ids.vecTypeIdx,
        fulfillFuncIdx: rt.fulfillFuncIdx,
      }),
      exported: false,
    });
    ctx.funcMap.set("__combinator_drive_all_fulfill", fulfillIdx);
    pushDefinedFunc(ctx, rejectIdx, {
      name: "__combinator_drive_reject",
      typeIdx: wrapperTypeIdx,
      locals: buildSettleWrapperLocals(captures),
      body: buildRejectBody(captures, rt.rejectFuncIdx),
      exported: false,
    });
    ctx.funcMap.set("__combinator_drive_reject", rejectIdx);
    drive = { stateTypeIdx, elemCapsTypeIdx };
    driveAllByCtx.set(ctx, drive);
  }
  if (observable && !drive.resolveCap) {
    const resolveCap = registerDriveResolveElement(ctx, observable, drive.elemCapsTypeIdx);
    if (!resolveCap) return undefined;
    drive.resolveCap = resolveCap;
  }
  return drive;
}

/**
 * The §27.2.4.1.3 resolve-element FUNCTION OBJECT for the observable drive: the
 * shape of #5197 R3-2's `$__combinator_all_resolve_cap` (a builtin-fn-meta
 * subtype, so `IsCallable`, `__apply_closure` and `Object.getPrototypeOf` treat
 * it as a function), capturing a drive elem-caps instead of the legacy one.
 */
function registerDriveResolveElement(
  ctx: CodegenContext,
  observable: ObservableCombinatorRuntime,
  elemCapsTypeIdx: number,
): { typeIdx: number; metaTypeIdx: number } | undefined {
  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF], []);
  const fulfillIdx = ctx.funcMap.get("__combinator_drive_all_fulfill");
  if (!wrapper || fulfillIdx === undefined) return undefined;
  const metaTypeIdx = observable.allResolveMetaTypeIdx;
  const metaFields = (ctx.mod.types[metaTypeIdx] as { fields: { name: string; type: ValType; mutable: boolean }[] })
    .fields;
  const elemCapsFieldIdx = metaFields.length;
  const calledFieldIdx = elemCapsFieldIdx + 1;
  const fields = [
    ...metaFields.map((field) => ({ ...field })),
    { name: "$elemCaps", type: { kind: "ref", typeIdx: elemCapsTypeIdx } as ValType, mutable: false },
    { name: "$called", type: I32, mutable: true },
  ];
  const typeIdx = ctx.mod.types.length;
  const name = "$__combinator_drive_resolve_cap";
  ctx.mod.types.push({ kind: "struct", name, fields, superTypeIdx: metaTypeIdx });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(
    name,
    fields.map((field) => ({ ...field })),
  );
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__combinator_drive_resolve_element",
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [{ name: "$cap", type: { kind: "ref", typeIdx } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "ref.cast", typeIdx },
      { op: "local.set", index: 2 },
      // [[AlreadyCalled]]: a second call is a no-op (§27.2.4.1.3 steps 2-4).
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx, fieldIdx: calledFieldIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 1 },
          { op: "struct.set", typeIdx, fieldIdx: calledFieldIdx },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx, fieldIdx: elemCapsFieldIdx },
          { op: "extern.convert_any" },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fulfillIdx },
          { op: "drop" },
        ],
      },
    ],
    exported: false,
  });
  ctx.funcMap.set("__combinator_drive_resolve_element", funcIdx);
  return { typeIdx, metaTypeIdx };
}

/** Everything the drive loop threads between its phases. */
interface DriveLocals {
  argLocal: number;
  iterLocal: number;
  doneLocal: number;
  valueLocal: number;
  indexLocal: number;
  stateLocal: number;
  exnLocal: number;
}

/**
 * Emit a driven `Promise.all(arg0)` / `Promise.race(arg0)`. Answers `undefined`
 * BEFORE emitting anything when the substrate is unavailable, so the caller's
 * legacy fall-through stays intact.
 */
export function emitStandalonePromiseCombinatorDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: NativeCombinator,
  arg0: ts.Expression,
  observableProtocol: boolean,
): ValType | undefined {
  // `allSettled` / `any` keep the legacy drain (their reaction bodies are
  // index-array based; no measured row needs them driven yet).
  if (method !== "all" && method !== "race") return undefined;
  // Registration strictly precedes emission (the #2919 bake-before-land rule).
  ensureNativeIteratorRuntime(ctx);
  const ids = ensureCombinatorFunctions(ctx);
  const rt = ensureAsyncDriveRuntime(ctx);
  const observable = observableProtocol ? ensureObservableCombinatorRuntime(ctx, ids) : null;
  if (observableProtocol && !observable) return undefined;
  const drive = method === "all" ? ensureDriveAllRuntime(ctx, ids, observable) : undefined;
  if (method === "all" && !drive) return undefined;
  const reaction = combinatorReactionFns(ctx, ids, method);
  const tagIdx = ensureExnTag(ctx);
  if (
    ctx.funcMap.get("__iterator") === undefined ||
    ctx.funcMap.get("__iterator_next") === undefined ||
    ctx.funcMap.get("__iterator_return") === undefined
  ) {
    return undefined;
  }

  // Argument evaluation completes before the builtin runs.
  compileExpression(ctx, fctx, arg0, EXTERNREF);
  const L: DriveLocals = {
    argLocal: allocLocal(fctx, `__comb_drive_arg_${fctx.locals.length}`, EXTERNREF),
    iterLocal: allocLocal(fctx, `__comb_drive_iter_${fctx.locals.length}`, EXTERNREF),
    doneLocal: allocLocal(fctx, `__comb_drive_done_${fctx.locals.length}`, I32),
    valueLocal: allocLocal(fctx, `__comb_drive_value_${fctx.locals.length}`, EXTERNREF),
    indexLocal: allocLocal(fctx, `__comb_drive_index_${fctx.locals.length}`, I32),
    stateLocal: allocLocal(fctx, `__comb_drive_state_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: drive ? drive.stateTypeIdx : ids.stateTypeIdx,
    }),
    exnLocal: allocLocal(fctx, `__comb_drive_exn_${fctx.locals.length}`, EXTERNREF),
  };
  fctx.body.push({ op: "local.set", index: L.argLocal });

  // Steps 1-3: the capability and (observable only) GetPromiseResolve. The
  // resolve Get happens BEFORE GetIterator, so a throwing `resolve` getter
  // wins over a throwing `@@iterator` getter (`invoke-resolve-get-error`).
  const prep: ObservableCombinatorPreparation = observable
    ? emitObservableCombinatorPreparation(ctx, fctx, ids, rt, observable, method)
    : emitPlainPreparation(fctx, ids);
  const rejectWith = (reason: Instr[]): Instr[] => [
    { op: "local.get", index: prep.resultLocal },
    ...reason,
    { op: "call", funcIdx: rt.rejectFuncIdx },
    { op: "drop" },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: prep.abortedLocal },
  ];
  const catchToReject = (): { tagIdx: number; body: Instr[] }[] => [
    {
      tagIdx,
      body: [{ op: "local.set", index: L.exnLocal }, ...rejectWith([{ op: "local.get", index: L.exnLocal }])],
    },
  ];

  // Step 4: GetIterator — abrupt ⇒ reject, and there is no iterator to close.
  fctx.body.push(
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L.doneLocal },
    { op: "local.get", index: prep.abortedLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        buildTargetTaggedTry(
          ctx,
          { kind: "empty" },
          [
            { op: "local.get", index: L.argLocal },
            { op: "call", funcIdx: ctx.funcMap.get("__iterator")! },
            { op: "local.set", index: L.iterLocal },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: L.doneLocal },
          ],
          catchToReject(),
        ),
      ],
    },
  );

  emitDriveState(fctx, ids, drive, prep, L);

  // Step 6: the Repeat. Built detached, then wrapped in block/loop, so the
  // element emitter (which appends to `fctx.body`) lands inside the loop while
  // every nested body stays reachable to the late-import shifter.
  const saved = pushBody(fctx);
  let loopBody: Instr[];
  try {
    fctx.body.push(
      { op: "local.get", index: prep.abortedLocal },
      { op: "br_if", depth: 1 },
      { op: "local.get", index: L.doneLocal },
      { op: "br_if", depth: 1 },
      // IteratorStep + IteratorValue. [[Done]] is raised BEFORE the call: an
      // abrupt `next()` / `done` / `value` leaves it true (§7.4.6), which is
      // exactly what suppresses IteratorClose (`iter-step-err-reject`).
      { op: "i32.const", value: 1 },
      { op: "local.set", index: L.doneLocal },
      buildTargetTaggedTry(
        ctx,
        { kind: "empty" },
        [
          { op: "local.get", index: L.iterLocal },
          { op: "call", funcIdx: ctx.funcMap.get("__iterator_next")! },
          { op: "local.set", index: L.valueLocal },
          { op: "local.set", index: L.doneLocal },
        ],
        catchToReject(),
      ),
      { op: "local.get", index: prep.abortedLocal },
      { op: "br_if", depth: 1 },
      { op: "local.get", index: L.doneLocal },
      { op: "br_if", depth: 1 },
    );
    if (drive) emitAppendSlot(fctx, ids, drive, L);
    if (observable) {
      emitObservableCombinatorElement(
        ctx,
        fctx,
        ids,
        rt,
        observable,
        prep,
        method,
        drive ? driveReaction(ctx) : reaction,
        L.stateLocal,
        [{ op: "local.get", index: L.indexLocal }],
        [{ op: "local.get", index: L.valueLocal }],
        drive ? driveCarrier(ctx, drive) : undefined,
      );
    } else {
      emitPlainElement(ctx, fctx, ids, drive, drive ? driveReaction(ctx) : reaction, L);
    }
    fctx.body.push(
      // An abrupt Call(resolve) / Invoke(then) rejected the capability and
      // raised `aborted`; [[Done]] is still false here, so close the iterator.
      // The close's own throw is swallowed — the original completion wins
      // (§7.4.9 step 5) — and the loop head then exits.
      { op: "local.get", index: prep.abortedLocal },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          buildTargetTaggedTry(
            ctx,
            { kind: "empty" },
            [
              { op: "local.get", index: L.iterLocal },
              { op: "call", funcIdx: ctx.funcMap.get("__iterator_return")! },
            ],
            [{ tagIdx, body: [{ op: "drop" }] }],
          ),
        ],
      },
      { op: "local.get", index: L.indexLocal },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: L.indexLocal },
      { op: "br", depth: 0 },
    );
  } finally {
    loopBody = fctx.body;
    popBody(fctx, saved);
  }
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  if (drive) emitDriveAllComplete(ctx, fctx, ids, drive, prep, L);
  fctx.body.push({ op: "local.get", index: prep.resultLocal }, { op: "extern.convert_any" });
  return EXTERNREF;
}

/** The non-observable prologue: just the capability promise and the abort flag. */
function emitPlainPreparation(fctx: FunctionContext, ids: CombinatorRuntime): ObservableCombinatorPreparation {
  const resultLocal = allocLocal(fctx, `__comb_drive_result_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ids.promiseTypeIdx,
  });
  const abortedLocal = allocLocal(fctx, `__comb_drive_abrupt_${fctx.locals.length}`, I32);
  fctx.body.push(
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    closureBagInitInstr(),
    { op: "struct.new", typeIdx: ids.promiseTypeIdx },
    { op: "local.set", index: resultLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: abortedLocal },
  );
  return { resultLocal, abortedLocal, ctorLocal: -1, resolveLocal: -1, raceFulfillLocal: -1, rejectLocal: -1 };
}

/**
 * The aggregate state. `all`: a drive state with an EMPTY results array and the
 * remaining-elements count at its completion sentinel (1). `race`: a legacy
 * `$CombinatorState` — its reactions read only `resultPromise`.
 */
function emitDriveState(
  fctx: FunctionContext,
  ids: CombinatorRuntime,
  drive: DriveAllRuntime | undefined,
  prep: ObservableCombinatorPreparation,
  L: DriveLocals,
): void {
  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L.indexLocal },
    { op: "local.get", index: prep.resultLocal },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: ids.arrTypeIdx },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: drive ? 1 : 0 },
    { op: "struct.new", typeIdx: drive ? drive.stateTypeIdx : ids.stateTypeIdx },
    { op: "local.set", index: L.stateLocal },
  );
}

/**
 * `all` only: append an `undefined` slot for this element (§27.2.4.1.2 step
 * 6.f), growing the backing array geometrically. The vec built at fulfilment
 * carries `length`, not the array's capacity, so spare capacity is invisible.
 */
function emitAppendSlot(fctx: FunctionContext, ids: CombinatorRuntime, drive: DriveAllRuntime, L: DriveLocals): void {
  const grownLocal = allocLocal(fctx, `__comb_drive_grown_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ids.arrTypeIdx,
  });
  const st = drive.stateTypeIdx;
  fctx.body.push(
    { op: "local.get", index: L.indexLocal },
    { op: "local.get", index: L.stateLocal },
    { op: "struct.get", typeIdx: st, fieldIdx: DRIVE_STATE_ARR },
    { op: "array.len" },
    { op: "i32.ge_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.indexLocal },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "i32.const", value: 2 },
        { op: "i32.mul" },
        { op: "array.new_default", typeIdx: ids.arrTypeIdx },
        { op: "local.set", index: grownLocal },
        { op: "local.get", index: grownLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L.stateLocal },
        { op: "struct.get", typeIdx: st, fieldIdx: DRIVE_STATE_ARR },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L.stateLocal },
        { op: "struct.get", typeIdx: st, fieldIdx: DRIVE_STATE_ARR },
        { op: "array.len" },
        { op: "array.copy", dstTypeIdx: ids.arrTypeIdx, srcTypeIdx: ids.arrTypeIdx },
        { op: "local.get", index: L.stateLocal },
        { op: "local.get", index: grownLocal },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: st, fieldIdx: DRIVE_STATE_ARR },
      ],
    },
    { op: "local.get", index: L.stateLocal },
    { op: "local.get", index: L.indexLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "struct.set", typeIdx: st, fieldIdx: DRIVE_STATE_LENGTH },
  );
}

/**
 * Non-observable element: PromiseResolve + PerformPromiseThen through the
 * subscribe body (the intrinsics' observable effect when neither `resolve` nor
 * `then` can have been replaced). `all` counts the element first, exactly as
 * the observable pipeline does before its Invoke.
 */
function emitPlainElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ids: CombinatorRuntime,
  drive: DriveAllRuntime | undefined,
  reaction: { fulfillIdx: number; rejectIdx: number },
  L: DriveLocals,
): void {
  if (drive) {
    fctx.body.push(
      { op: "local.get", index: L.stateLocal },
      { op: "local.get", index: L.stateLocal },
      { op: "struct.get", typeIdx: drive.stateTypeIdx, fieldIdx: DRIVE_STATE_REMAINING },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: drive.stateTypeIdx, fieldIdx: DRIVE_STATE_REMAINING },
    );
  }
  fctx.body.push(
    { op: "local.get", index: L.valueLocal },
    { op: "local.get", index: L.stateLocal },
    { op: "extern.convert_any" },
    { op: "local.get", index: L.indexLocal },
    { op: "ref.func", funcIdx: reaction.fulfillIdx },
    { op: "ref.func", funcIdx: reaction.rejectIdx },
    {
      op: "call",
      funcIdx: drive ? ctx.funcMap.get("__combinator_drive_subscribe")! : ids.subscribeFuncIdx,
    },
  );
}

function driveReaction(ctx: CodegenContext): { fulfillIdx: number; rejectIdx: number } {
  return {
    fulfillIdx: ctx.funcMap.get("__combinator_drive_all_fulfill")!,
    rejectIdx: ctx.funcMap.get("__combinator_drive_reject")!,
  };
}

/** Re-target the observable element pipeline at the drive state's types. */
function driveCarrier(ctx: CodegenContext, drive: DriveAllRuntime): ObservableElementCarrier {
  const cap = drive.resolveCap!;
  return {
    stateTypeIdx: drive.stateTypeIdx,
    elemCapsTypeIdx: drive.elemCapsTypeIdx,
    subscribeFuncIdx: ctx.funcMap.get("__combinator_drive_subscribe")!,
    buildAllResolveClosure: (elemCapsLocal: number): Instr[] => [
      { op: "ref.func", funcIdx: ctx.funcMap.get("__combinator_drive_resolve_element")! },
      { op: "i32.const", value: 1 },
      closureBagInitInstr(),
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: cap.metaTypeIdx },
      { op: "local.get", index: elemCapsLocal },
      { op: "i32.const", value: 0 },
      { op: "struct.new", typeIdx: cap.typeIdx },
      { op: "extern.convert_any" },
    ],
  };
}

/**
 * `all` step 6.d.ii-iii: iteration finished normally — drop the completion
 * sentinel; if that was the last outstanding unit, fulfil with the values.
 * Skipped when an abrupt completion already rejected the capability.
 */
function emitDriveAllComplete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  ids: CombinatorRuntime,
  drive: DriveAllRuntime,
  prep: ObservableCombinatorPreparation,
  L: DriveLocals,
): void {
  const rt = ensureAsyncDriveRuntime(ctx);
  const st = drive.stateTypeIdx;
  const remainingLocal = allocLocal(fctx, `__comb_drive_remaining_${fctx.locals.length}`, I32);
  fctx.body.push(
    { op: "local.get", index: prep.abortedLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L.stateLocal },
        { op: "local.get", index: L.stateLocal },
        { op: "struct.get", typeIdx: st, fieldIdx: DRIVE_STATE_REMAINING },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.tee", index: remainingLocal },
        { op: "struct.set", typeIdx: st, fieldIdx: DRIVE_STATE_REMAINING },
        { op: "local.get", index: remainingLocal },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: prep.resultLocal },
            { op: "local.get", index: L.stateLocal },
            { op: "struct.get", typeIdx: st, fieldIdx: DRIVE_STATE_LENGTH },
            { op: "local.get", index: L.stateLocal },
            { op: "struct.get", typeIdx: st, fieldIdx: DRIVE_STATE_ARR },
            { op: "struct.new", typeIdx: ids.vecTypeIdx },
            { op: "extern.convert_any" },
            { op: "call", funcIdx: rt.fulfillFuncIdx },
            { op: "drop" },
          ],
        },
      ],
    },
  );
}
