import type { Instr, ValType, WasmFunction } from "../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host-free async-frame substrate (#2895 PATH B, slice 1 — foundation).
 *
 * This is the **frame-layout layer** of the standalone/WASI async drive: it
 * registers the per-async-function `$AsyncFrame` state struct and the
 * {@link AsyncFrameInfo} that the resume-function emitter (next slice) consumes.
 * It deliberately mirrors the Wasm-native **generator** substrate
 * (`generators-native.ts` `buildNativeGeneratorInfo`) so both suspendable
 * lowerings share one frame ABI ({@link import("./frame-core.js").FrameLayout})
 * and one set of spill helpers (`frame-core.ts`) instead of forking.
 *
 * **Why a separate drive layer at all** (the measured #2865 AG0 root cause): a
 * *genuinely-pending* await — a promise that only settles on a later microtask
 * (an executor that resolves async, `Promise.all` of pending promises, a `.then`
 * chain observed across a microtask) — cannot be served by AG0's one-level
 * `$Promise.value` unwrap (`expressions.ts` `emitStandaloneAwaitUnwrap`): the
 * value is simply not present during the synchronous body execution. PATH B
 * builds a real resumable frame: at an await we spill live locals into the
 * frame, register a reaction (a resume-step funcref + the frame) on the awaited
 * `$Promise`'s callback list, and return the result `$Promise`; the microtask
 * drain resumes the frame at the saved state with the settled value. The
 * `$Promise` + reaction-node + microtask-ring + settle substrate already exists
 * (`async-scheduler.ts`), so this layer only adds the *frame* and the resume
 * trampoline; it reuses the scheduler verbatim via {@link
 * import("./async-scheduler.js").ensureAsyncDriveRuntime}.
 *
 * **Slice scope.** This file lands the inert foundation (predicate + frame
 * struct + info builder). It is NOT yet wired into `function-body.ts`, so
 * compilation output is byte-identical — exactly the #2384 frame-core extraction
 * pattern. The resume-function emitter, await-suspend lowering, settle-on-return,
 * call-site allocation, and the runner microtask-drain hook follow in the next
 * slices, and the broad `isStandalonePromiseActive` gate is re-widened to
 * `standalone` only *together with* that drive layer (re-widening it before the
 * drive layer exists is precisely the AG0 −31 regression).
 */
import { forEachChild, ts } from "../ts-api.js";
import type { AsyncCfgPlan, AsyncCfgState, AsyncCpsPlan, AsyncResumePoint } from "./async-cps.js";
import {
  ASYNC_CPS_ENABLED,
  FORAWAIT_ITER_SPILL,
  analyzeAsyncBody,
  asyncFnNeedsCps,
  awaitedExprIsPromiseCombinator,
  forAwaitAsyncNeedsDrive,
  forAwaitNeedsDrive,
  asyncGenOwnLocalDecls,
  forAwaitSpillInfo,
  isAwaitFreeAsyncGenBody,
  isBoundedAsyncGenBody,
  isEmitOperand,
  loopAsyncSpillInfo,
  planAsyncCfg,
  planAsyncGenCfg,
  planLinearAwaits,
} from "./async-cps.js";
import { ensureNativeGeneratorResultType } from "./generators-native.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3 / #2710) stable-regime minting
import {
  type AsyncDriveRuntime,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_PENDING,
  PROMISE_STATE_REJECTED,
  ensureAsyncDriveRuntime,
  getOrRegisterPromiseType,
  isStandalonePromiseActive,
} from "./async-scheduler.js";
import { reportError } from "./context/errors.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  ERROR_FIELD,
  MODE_FIELD,
  MODE_THROW,
  PARAM_FIELD_OFFSET,
  RESULT_DONE_FIELD,
  RESULT_VALUE_FIELD,
  SENT_FIELD,
  STATE_FIELD,
  defaultSpillInstr,
  sanitizeTypeName,
  setStateI32FromConst,
  storeSpills,
} from "./frame-core.js";
import { ensureI32Condition, resolveWasmType } from "./index.js";
import { ensureExnTag } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { coerceType, compileExpression, compileStatement } from "./shared.js";
import { resolveSpillLocalValType } from "./statements/variables.js";

/**
 * Is the host-free async **drive layer** (#2895 PATH B) active for this module?
 *
 * Gated on the host-free targets — `--target standalone` and `--target wasi` —
 * where the JS-host async-CPS imports (`Promise_resolve`/`Promise_then2`/
 * `__make_callback`) are unavailable, so a genuinely-suspending async function
 * must be driven by the native `$Promise` + microtask substrate instead. The
 * JS-host path keeps its existing CPS state machine (`async-cps.ts`).
 *
 * NOTE: this is the *drive-layer* gate (does this fn get a real resumable
 * frame), distinct from {@link import("./async-scheduler.js").isStandalonePromiseActive}
 * (the *carrier* gate: does `await`/`Promise.resolve` use the native `$Promise`).
 * The carrier gate stays `wasi`-only until this drive layer makes a native async
 * result observable to the `flags:[async]` harness — see the file header.
 */
export function isAsyncDriveActive(ctx: CodegenContext): boolean {
  return ctx.standalone === true || ctx.wasi === true;
}

/**
 * (#1042) Stable funcMap indices of the six JS-host imports the **host settle
 * backend** of the resume machine emits. All six are pre-registered upfront by
 * the `collectAsyncCpsImports` finalize in `declarations.ts` when a
 * host-drive-eligible async fn exists (see {@link asyncFnNeedsHostDrive}), so
 * every index here is an IMPORT index — stable under late-import appends (new
 * imports append after existing ones; only *defined*-function indices shift).
 */
export interface HostAsyncImports {
  /** `Promise_resolve(v) -> Promise` — §27.7.5.3 PromiseResolve assimilation. */
  promiseResolveIdx: number;
  /** `Promise_then2(p, onFulfilled, onRejected) -> Promise`. */
  then2Idx: number;
  /** `__make_callback(cbId, caps) -> jsFunction` — dispatches `exports.__cb_<id>`. */
  makeCbIdx: number;
  /** `Promise_new_pending() -> Promise` (resolve/reject stashed as `__r`/`__j`). */
  newPendingIdx: number;
  /** `Promise_settle_resolve(p, v) -> externref(undefined)`. */
  settleResolveIdx: number;
  /** `Promise_settle_reject(p, reason) -> externref(undefined)`. */
  settleRejectIdx: number;
}

/**
 * Resolve the six host settle-backend imports from `ctx.funcMap`, or `null`
 * when any is missing (the declarations prepass did not fire — a producer bug;
 * the caller reports and falls back rather than emitting a broken machine).
 */
export function resolveHostAsyncImports(ctx: CodegenContext): HostAsyncImports | null {
  const promiseResolveIdx = ctx.funcMap.get("Promise_resolve");
  const then2Idx = ctx.funcMap.get("Promise_then2");
  const makeCbIdx = ctx.funcMap.get("__make_callback");
  const newPendingIdx = ctx.funcMap.get("Promise_new_pending");
  const settleResolveIdx = ctx.funcMap.get("Promise_settle_resolve");
  const settleRejectIdx = ctx.funcMap.get("Promise_settle_reject");
  if (
    promiseResolveIdx === undefined ||
    then2Idx === undefined ||
    makeCbIdx === undefined ||
    newPendingIdx === undefined ||
    settleResolveIdx === undefined ||
    settleRejectIdx === undefined
  ) {
    return null;
  }
  return {
    promiseResolveIdx,
    then2Idx,
    makeCbIdx,
    newPendingIdx,
    settleResolveIdx,
    settleRejectIdx,
  };
}

/**
 * (#1042 July re-scope) JS-host drive-layer eligibility — the host-lane
 * analogue of {@link asyncFnNeedsDrive}. Routes a genuinely-suspending async
 * function whose body is a LINEAR (multi-)await shape through the SAME #2906
 * N-state resume machine, with **host-Promise settle adapters** (reactions via
 * `Promise_resolve`/`__make_callback`/`Promise_then2`, settle via
 * `Promise_new_pending`/`Promise_settle_*`) instead of the native `$Promise`
 * callback list. One lowering engine, two settle primitives.
 *
 * **Deliberately disjoint from {@link asyncFnNeedsCps}**: every shape the
 * proven single-tail-await CPS lane accepts today keeps taking that lane
 * (byte-stable), so this predicate claims ONLY shapes that today fall through
 * to the legacy synchronous fakery and produce wrong values under genuine
 * suspension (measured 2026-07-02: multi-await → null, spill-across-await →
 * null, try/finally-across-await → null, rejected 2nd await → uncaught wasm
 * exception). Additive by construction: `false` ⇒ output unchanged.
 */
export function asyncFnNeedsHostDrive(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): boolean {
  if (!ASYNC_CPS_ENABLED) return false;
  if (ctx.wasi === true || ctx.standalone === true) return false; // host lane only
  if (plan.awaitPoints.length === 0) return false;
  const anyRealSuspension = plan.awaitPoints.some((a) => plan.awaitedStaticallyResolved.get(a) !== true);
  if (!anyRealSuspension) return false; // fully await-elidable → legacy sync path
  // The single-tail-await CPS lane owns its shapes — never re-route them.
  if (asyncFnNeedsCps(fn, plan)) return false;
  const linear = planLinearAwaits(fn, plan);
  if (linear === null) return false;
  // Parity with asyncFnNeedsCps/asyncFnNeedsDrive: a lone `await Promise.all(...)`
  // already yields a real Promise the legacy identity path resolves correctly.
  if (linear.segments.length === 1 && awaitedExprIsPromiseCombinator(linear.segments[0]!.awaitedExpr)) return false;
  // Type gate: a resume binding spilled across a later await needs a spill-safe
  // type (same rule as the wasi drive layer).
  for (let k = 0; k < linear.segments.length; k++) {
    const rb = linear.segments[k]!.resumeBinding;
    if (!rb) continue;
    if (!bindingLiveAcrossLaterAwait(rb.name, k, plan)) continue;
    if (!isSpillSafeType(resumeBindingValType(ctx, rb))) return false;
  }
  return true;
}

/**
 * Per-async-function frame metadata produced by {@link buildAsyncFrameInfo} and
 * consumed by the resume-function emitter (next slice). Structurally satisfies
 * {@link import("./frame-core.js").FrameLayout} (`stateTypeIdx`, `modeFieldIdx`,
 * `spillNames`, `spillTypes`, `spillFieldOffset`) so the shared `frame-core.ts`
 * spill/state helpers drive it with no wrapper — identical to how
 * `NativeGeneratorInfo` satisfies the same interface.
 */
export interface AsyncFrameInfo {
  /** Source function name (the `__async_resume_f<name>` / struct name stem). */
  functionName: string;
  /** The async function/method declaration this frame belongs to. */
  decl: ts.FunctionLikeDeclaration;
  /** Per-frame `$AsyncFrame_<name>` state struct typeIdx. */
  stateTypeIdx: number;
  /** Field index of the i32 resume mode (`MODE_FIELD`). FrameLayout. */
  modeFieldIdx: number;
  /** Field index of the settled-awaited-value slot (`SENT_FIELD`). */
  sentFieldIdx: number;
  /** Field index of the rejection-reason slot (`ERROR_FIELD`). */
  errorFieldIdx: number;
  /** Captured-parameter names, aligned 1:1 with `paramTypes`. */
  paramNames: string[];
  /** Wasm ValType of each captured parameter. */
  paramTypes: ValType[];
  /** First struct field index of the captured params (`PARAM_FIELD_OFFSET`). */
  paramFieldOffset: number;
  /** Names of body locals live across the await, spilled into the frame. FrameLayout. */
  spillNames: string[];
  /** Wasm ValType of each spilled local, aligned 1:1 with `spillNames`. FrameLayout. */
  spillTypes: ValType[];
  /** First struct field index where spills start. FrameLayout. */
  spillFieldOffset: number;
  /** Field index of the result `$Promise` the async fn returns / settles. */
  resultPromiseFieldIdx: number;
  /**
   * `$Promise` struct typeIdx (the result-promise field's element type).
   * `-1` under the host settle backend (`host: true`) — the result promise is a
   * host Promise (externref), never a native `$Promise` struct.
   */
  promiseTypeIdx: number;
  /**
   * (#1042) `true` when this frame is driven with the **host settle backend**:
   * result promise = host pending Promise (externref field), suspension =
   * `Promise_resolve` assimilation + `Promise_then2` reactions through
   * `__make_callback`-wrapped step adapters (exported `__cb_<id>`), settle =
   * `Promise_settle_resolve`/`Promise_settle_reject`. `false` = the native
   * `$Promise` + microtask-ring backend (standalone/wasi).
   */
  host: boolean;
  /** Host backend import indices (present iff `host`). */
  hostImports?: HostAsyncImports;
  /** Host backend: `__cb_<id>` callback id of the fulfill step adapter. */
  stepFulfillCbId?: number;
  /** Host backend: `__cb_<id>` callback id of the reject step adapter. */
  stepRejectCbId?: number;
  /** `__async_resume_f<name>(frame) -> void` funcIdx — filled by the emitter slice. */
  resumeFuncIdx?: number;
  /** `__async_step_fulfill_f<name>(caps, value) -> externref` funcIdx — emitter slice. */
  stepFulfillFuncIdx?: number;
  /** `__async_step_reject_f<name>(caps, value) -> externref` funcIdx — emitter slice. */
  stepRejectFuncIdx?: number;
  /**
   * (#2906 slice 3d-i) `true` when this frame drives an async GENERATOR producer:
   * the resume machine is built from {@link planAsyncGenCfg} (not `planAsyncCfg`)
   * and the `settleYield`/`settleDone` terminators fulfil the re-minted
   * `next()`-promise with an IteratorResult instead of the async fn's raw value.
   */
  asyncGen?: boolean;
  /** (#2906 slice 3d-i) `{value: externref, done: i32}` IteratorResult struct typeIdx (async-gen only). */
  asyncGenResultTypeIdx?: number;
  /**
   * (#2865) Capture-cell metadata of a NESTED producer (lifted with captures
   * as leading params — nested-declarations.ts). The frame captures the cells
   * as param fields; the resume body must deref reads/writes through them, so
   * `ensureAsyncResumeFunction` copies this onto the resume FunctionContext.
   */
  boxedCaptures?: Map<string, { refCellTypeIdx: number; valType: ValType }>;
  /** (#2865) Threaded from the producer fctx (nested `this`-referencing body). */
  readsCurrentThis?: boolean;
  /**
   * (#2865) The `__self` capture-struct layout of a lifted CLOSURE body
   * (closures.ts model: captures live in the `__self` struct, materialized
   * into named locals by a body prologue). The resume fn re-runs that
   * materialization from the frame-captured `__self` param field.
   */
  selfCaptureLayout?: FunctionContext["selfCaptureLayout"];
}

/**
 * Build (and register the state struct for) the `$AsyncFrame` of one async
 * function. Mirrors `buildNativeGeneratorInfo`: fixed leading frame fields
 * (`STATE`/`SENT`/`MODE`/`ABRUPT`/`ERROR`), then the captured params at
 * `PARAM_FIELD_OFFSET`, then the live-across-await spills, then a trailing
 * result-`$Promise` field (placed after spills so the `spillFieldOffset`
 * indexing the shared helpers use is unaffected — same discipline as the
 * generator `yield*` delegation slots).
 *
 * Field ValTypes:
 *   - `STATE`/`MODE`: i32 (the `br_table` selector + resume mode).
 *   - `SENT`/`ABRUPT`/`ERROR`: externref. Unlike a numeric generator's carrier,
 *     an awaited value is always boxed (`$Promise.value` is externref), so the
 *     settled value, the (unused-here) `.return` carrier, and the rejection
 *     reason are all externref.
 *   - params/spills: their natural Wasm ValType.
 *   - result promise: `(ref $Promise)`.
 *
 * @param promiseTypeIdx the module's `$Promise` struct typeIdx (from
 *   `getOrRegisterPromiseType` — caller registers the drive runtime first so the
 *   type exists and the funcIdx baseline is stable). Pass `-1` with
 *   `hostImports` set for the host settle backend (the result-promise field is
 *   then externref — a host Promise object).
 * @param hostImports host settle-backend import indices — presence selects the
 *   host backend (#1042).
 */
export function buildAsyncFrameInfo(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
  paramNames: string[],
  paramTypes: ValType[],
  promiseTypeIdx: number,
  hostImports?: HostAsyncImports,
): AsyncFrameInfo {
  const functionName = asyncFnName(decl);

  // Fixed leading frame fields (frame-core ABI). SENT/ABRUPT/ERROR are externref
  // for async (awaited values are always boxed), unlike the generator carrier.
  const stateFields: { name: string; type: ValType; mutable: boolean }[] = [
    { name: "state", type: { kind: "i32" }, mutable: true },
    { name: "sent", type: { kind: "externref" }, mutable: true },
    { name: "mode", type: { kind: "i32" }, mutable: true },
    { name: "abrupt", type: { kind: "externref" }, mutable: true },
    { name: "error", type: { kind: "externref" }, mutable: true },
  ];

  for (let i = 0; i < paramTypes.length; i++) {
    stateFields.push({
      name: `param_${paramNames[i] ?? i}`,
      type: paramTypes[i]!,
      mutable: false,
    });
  }

  const spillFieldOffset = PARAM_FIELD_OFFSET + paramTypes.length;
  const { spillNames, spillTypes } = computeAsyncSpills(ctx, decl, plan, paramNames);
  for (let i = 0; i < spillNames.length; i++) {
    stateFields.push({
      name: `spill_${spillNames[i]}`,
      type: spillTypes[i]!,
      mutable: true,
    });
  }

  // Trailing result-promise field — after spills so `spillFieldOffset` is stable.
  // Host backend: the result promise is a host Promise object (externref); there
  // is no native `$Promise` struct in the module at all.
  const resultPromiseFieldIdx = spillFieldOffset + spillNames.length;
  const resultPromiseFieldType: ValType = hostImports
    ? { kind: "externref" }
    : { kind: "ref", typeIdx: promiseTypeIdx };
  stateFields.push({
    name: "result_promise",
    type: resultPromiseFieldType,
    mutable: true,
  });

  const stateName = `$AsyncFrame_${sanitizeTypeName(functionName)}`;
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: stateName, fields: stateFields });
  ctx.structMap.set(stateName, stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, stateName);
  ctx.structFields.set(stateName, stateFields);

  return {
    functionName,
    decl,
    stateTypeIdx,
    modeFieldIdx: MODE_FIELD,
    sentFieldIdx: SENT_FIELD,
    errorFieldIdx: ERROR_FIELD,
    paramNames,
    paramTypes,
    paramFieldOffset: PARAM_FIELD_OFFSET,
    spillNames,
    spillTypes,
    spillFieldOffset,
    resultPromiseFieldIdx,
    promiseTypeIdx,
    host: hostImports !== undefined,
    hostImports,
  };
}

// ── internal ────────────────────────────────────────────────────────────────

/** A stable, sanitizable name for the async function (for the struct + resume fn). */
function asyncFnName(decl: ts.FunctionLikeDeclaration): string {
  if (ts.isFunctionDeclaration(decl) && decl.name) return decl.name.text;
  if ((ts.isMethodDeclaration(decl) || ts.isFunctionExpression(decl)) && decl.name && ts.isIdentifier(decl.name)) {
    return decl.name.text;
  }
  // Arrow / anonymous — synthesize from source position (unique within a module).
  const pos = decl.pos >= 0 ? decl.pos : 0;
  return `anon_${pos}`;
}

/**
 * The Wasm ValType a resume binding (`const x = await P`) settles to — the
 * coercion target the continuation writes `SENT_FIELD` into, and (when the
 * binding survives a later await) the type of its frame spill field. Resolved
 * consistently in ONE place so the spill field and the resume-function local
 * agree and round-trip through `struct.get`/`struct.set`.
 */
function resumeBindingValType(ctx: CodegenContext, rb: { name: string; type: ts.TypeNode | undefined }): ValType {
  return rb.type ? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(rb.type)) : { kind: "externref" };
}

/**
 * ValTypes that spill safely in slice 1: they have a valid inert
 * {@link defaultSpillInstr} AND survive a mutable-field round-trip. Non-null GC
 * refs are excluded — their field default would be a `ref.null` of a non-null
 * type (invalid Wasm) — so a resume binding of such a type that must be spilled
 * makes the fn fall back to the legacy path (a later slice widens this).
 */
function isSpillSafeType(t: ValType): boolean {
  return t.kind === "i32" || t.kind === "f64" || t.kind === "i64" || t.kind === "externref" || t.kind === "ref_null";
}

/** Is `name` (a resume binding delivered by await `k`) read after some LATER
 *  await (`j > k`)? If so it must be preserved across that await's suspend. */
function bindingLiveAcrossLaterAwait(name: string, k: number, plan: AsyncCpsPlan): boolean {
  for (let j = k + 1; j < plan.awaitPoints.length; j++) {
    const live = plan.liveAfterAwait.get(plan.awaitPoints[j]!);
    if (live && live.has(name)) return true;
  }
  return false;
}

/**
 * Host-free drive-layer eligibility (#2906) — the standalone/wasi analogue of
 * {@link import("./async-cps.js").asyncFnNeedsCps}. True when the async fn
 * genuinely suspends AND its body is a LINEAR multi-await shape the general
 * resume machine can drive ({@link planLinearAwaits}) AND every resume binding
 * that must survive a later await has a spill-safe type.
 *
 * **Single-await parity.** For exactly one canonical await this returns the same
 * verdict as `asyncFnNeedsCps` (same real-suspension + Promise-combinator gates;
 * a single await's binding is never crossed by a later await so the type gate is
 * inert), so the wasi single-await routing decision is unchanged by #2906 — only
 * the emitted resume machine generalizes.
 */
export function asyncFnNeedsDrive(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): boolean {
  if (!ASYNC_CPS_ENABLED) return false;
  if (plan.awaitPoints.length === 0) {
    // (#2906 slice 3b) `for await`-only body: no `ts.AwaitExpression`, but a
    // `for await` genuinely suspends per element. Eligible when it is the
    // bounded for-await shape and every widened spill local is spill-safe.
    if (plan.forAwaitPoints.length === 0) return false;
    // (#2906 slice 3b) boxed-array element sources OR (#2906 slice 3d-ii) a
    // host-free async-generator source (`for await (const x of g())`). Both drive
    // on the SAME for-await frame layout (own-locals + iterator spill), so the
    // shared `computeForAwaitSpills` + spill-safe gate applies to either lane.
    if (!forAwaitNeedsDrive(ctx, fn, plan) && !forAwaitAsyncNeedsDrive(ctx, fn, plan)) return false;
    const fa = computeForAwaitSpills(ctx, fn, plan);
    if (fa === null) return false;
    return fa.spillTypes.every(isSpillSafeType);
  }
  const anyRealSuspension = plan.awaitPoints.some((a) => plan.awaitedStaticallyResolved.get(a) !== true);
  if (!anyRealSuspension) return false; // fully await-elidable → sync + resolved promise
  const linear = planLinearAwaits(fn, plan);
  if (linear === null) {
    // (#2906 slice 3a) `while`-with-await loop shape (native drive lane only).
    // Eligible when every widened loop spill local has a spill-safe type — a
    // non-spill-safe field (e.g. a non-nullable ref with no inert default) would
    // make the frame layout invalid, so those fall back to legacy.
    const loop = computeLoopSpills(ctx, fn, plan);
    if (loop === null) return false;
    return loop.spillTypes.every(isSpillSafeType);
  }
  // Parity with asyncFnNeedsCps: a lone `await Promise.all(...)`/`.race`/… already
  // yields a real Promise — keep it on the legacy identity path.
  if (linear.segments.length === 1 && awaitedExprIsPromiseCombinator(linear.segments[0]!.awaitedExpr)) return false;
  // Slice-1 type gate: a resume binding spilled across a later await needs a
  // spill-safe type (see isSpillSafeType).
  for (let k = 0; k < linear.segments.length; k++) {
    const rb = linear.segments[k]!.resumeBinding;
    if (!rb) continue;
    if (!bindingLiveAcrossLaterAwait(rb.name, k, plan)) continue;
    if (!isSpillSafeType(resumeBindingValType(ctx, rb))) return false;
  }
  return true;
}

/**
 * (#2906 slice 3a) The widened spill layout for a `while`-with-await body: every
 * own-local referenced anywhere in the loop statement is live across the
 * loop-carried await (a local read before the await is read again after resume
 * on the next iteration), so the whole set is spilled. Resume-binding names use
 * their {@link resumeBindingValType} (matching the SENT-coercion target); other
 * locals use `resolveSpillLocalValType`, defaulting to externref. Returns `null`
 * when the body is not the bounded while shape.
 */
function computeLoopSpills(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): { spillNames: string[]; spillTypes: ValType[] } | null {
  const loop = loopAsyncSpillInfo(decl, plan);
  if (loop === null) return null;
  const rbTypeByName = new Map<string, ValType>();
  for (const seg of loop.segments) {
    if (seg.resumeBinding) rbTypeByName.set(seg.resumeBinding.name, resumeBindingValType(ctx, seg.resumeBinding));
  }
  const declByName = collectVarDeclsByName(decl);
  const spillNames: string[] = [];
  const spillTypes: ValType[] = [];
  for (const name of loop.names) {
    const rbType = rbTypeByName.get(name);
    if (rbType !== undefined) {
      spillNames.push(name);
      spillTypes.push(rbType);
      continue;
    }
    const declNode = declByName.get(name);
    const resolved = declNode ? resolveSpillLocalValType(ctx, declNode) : null;
    spillNames.push(name);
    spillTypes.push(resolved ?? { kind: "externref" });
  }
  return { spillNames, spillTypes };
}

/**
 * (#2906 slice 3b) The spill layout for a `for await` drive: every loop own-local
 * ({@link forAwaitSpillInfo}, resolved to its declared ValType, defaulting to
 * externref) PLUS the synthetic async-iterator carrier local (externref), which
 * is created once in the entry state and must survive every per-element suspend.
 * Returns `null` when the body is not the bounded for-await shape.
 */
function computeForAwaitSpills(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): { spillNames: string[]; spillTypes: ValType[] } | null {
  const info = forAwaitSpillInfo(decl, plan);
  if (info === null) return null;
  const declByName = collectVarDeclsByName(decl);
  const spillNames: string[] = [];
  const spillTypes: ValType[] = [];
  for (const name of info.names) {
    const declNode = declByName.get(name);
    const resolved = declNode ? resolveSpillLocalValType(ctx, declNode) : null;
    spillNames.push(name);
    spillTypes.push(resolved ?? { kind: "externref" });
  }
  // The persisted async-iterator (`it`), reloaded on every resume, stored on
  // every suspend. Must be LAST — the emitter looks it up by this reserved name.
  spillNames.push(FORAWAIT_ITER_SPILL);
  spillTypes.push({ kind: "externref" });
  return { spillNames, spillTypes };
}

/**
 * The body locals that are live across ANY await and so must be spilled into the
 * frame (the multi-await generalization of the generator's `bodySpills`).
 *
 * The spill set is the UNION, over every await `k`, of the locals live across
 * await `k`'s suspend, MINUS params (captured in param fields) and MINUS await
 * `k`'s OWN resume binding (delivered fresh from `SENT_FIELD` on resume, never
 * snapshotted at suspend time). A resume binding from an EARLIER await that
 * survives a later await IS spilled — it is an ordinary live local at that later
 * suspend. Iterating awaits in order over insertion-ordered `Set`s and skipping
 * only each await's own binding keeps a SINGLE-await body's spill list
 * byte-identical to the pre-#2906 computation.
 *
 * Spill ValTypes: a resume-binding name uses {@link resumeBindingValType} (so the
 * field matches the SENT-coercion target); any other local uses
 * `resolveSpillLocalValType`, defaulting to externref.
 */
function computeAsyncSpills(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
  paramNames: string[],
): { spillNames: string[]; spillTypes: ValType[] } {
  // (#2865) Async GENERATOR (`async function*` — the only asterisked shape that
  // reaches the async frame): EVERY yield is a suspend point (the resume fn
  // returns and re-enters on the next `next()` kick), so every own identifier
  // local is conservatively treated as live-across-suspend and spilled — the
  // same widened rule the 3a loop machine uses. Params live in param fields.
  if (decl.asteriskToken !== undefined) {
    const spillNames: string[] = [];
    const spillTypes: ValType[] = [];
    for (const [name, node] of asyncGenOwnLocalDecls(decl)) {
      spillNames.push(name);
      spillTypes.push(resolveSpillLocalValType(ctx, node) ?? { kind: "externref" });
    }
    return { spillNames, spillTypes };
  }
  const linear = planLinearAwaits(decl, plan);
  if (linear === null) {
    // (#2906 slice 3a) `while`-with-await loop: widened spill set (all loop
    // own-locals). (#2906 slice 3b) for-await drive: loop own-locals + the
    // synthetic async-iterator carrier local. Returns empty for any other body.
    return (
      computeLoopSpills(ctx, decl, plan) ?? computeForAwaitSpills(ctx, decl, plan) ?? { spillNames: [], spillTypes: [] }
    );
  }
  const paramSet = new Set(paramNames);

  const rbTypeByName = new Map<string, ValType>();
  for (const seg of linear.segments) {
    if (seg.resumeBinding) rbTypeByName.set(seg.resumeBinding.name, resumeBindingValType(ctx, seg.resumeBinding));
  }

  const declByName = collectVarDeclsByName(decl);
  const spillNames: string[] = [];
  const spillTypes: ValType[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < linear.segments.length; k++) {
    const live = plan.liveAfterAwait.get(plan.awaitPoints[k]!) ?? new Set<string>();
    const ownBinding = linear.segments[k]!.resumeBinding?.name;
    for (const name of live) {
      if (paramSet.has(name)) continue;
      if (ownBinding !== undefined && name === ownBinding) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const rbType = rbTypeByName.get(name);
      if (rbType !== undefined) {
        spillNames.push(name);
        spillTypes.push(rbType);
        continue;
      }
      const declNode = declByName.get(name);
      const resolved = declNode ? resolveSpillLocalValType(ctx, declNode) : null;
      spillNames.push(name);
      spillTypes.push(resolved ?? { kind: "externref" });
    }
  }
  return { spillNames, spillTypes };
}

/** Map each body `var`/`let`/`const` declaration name → its declaration node. */
function collectVarDeclsByName(decl: ts.FunctionLikeDeclaration): Map<string, ts.VariableDeclaration> {
  const out = new Map<string, ts.VariableDeclaration>();
  const body = decl.body;
  if (body === undefined) return out;
  const walk = (node: ts.Node): void => {
    if (isNestedScope(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      out.set(node.name.text, node);
    }
    forEachChild(node, walk);
  };
  forEachChild(body, walk);
  return out;
}

function isNestedScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * Defensive check of the {@link AsyncCfgPlan} emitter contract (see the
 * contract block in async-cps.ts). Returns a human-readable violation, or
 * `null` when the plan is emittable. Cheap (O(states)); run once per machine so
 * a future planner bug becomes a hard compile error instead of an emitted
 * machine with wrong `br` depths or a mis-routed abrupt completion.
 */
function validateAsyncCfg(cfg: AsyncCfgPlan): string | null {
  const n = cfg.states.length;
  const inRange = (id: number): boolean => id >= 0 && id < n;
  for (let i = 0; i < n; i++) {
    const st = cfg.states[i]!;
    if (st.id !== i) return `state ids not dense (states[${i}].id === ${st.id})`;
    const t = st.terminator;
    if (t.kind === "suspend" && !inRange(t.resumeState)) return `suspend.resumeState ${t.resumeState} out of range`;
    if (t.kind === "settleYield" && !inRange(t.resumeState))
      return `settleYield.resumeState ${t.resumeState} out of range`;
    if (t.kind === "goto" && !inRange(t.target)) return `goto.target ${t.target} out of range`;
    if (t.kind === "condGoto" && (!inRange(t.whenTrue) || !inRange(t.whenFalse))) {
      return `condGoto targets ${t.whenTrue}/${t.whenFalse} out of range`;
    }
    // goto/condGoto targets must not carry a resume prelude (contract rule 2).
    const targets: number[] = t.kind === "goto" ? [t.target] : t.kind === "condGoto" ? [t.whenTrue, t.whenFalse] : [];
    for (const target of targets) {
      if (cfg.states[target]!.resumeFrom !== null) {
        return `goto/condGoto target ${target} has a resume prelude (only a suspend may enter it)`;
      }
    }
  }
  for (let i = 0; i < cfg.handlers.length; i++) {
    const h = cfg.handlers[i]!;
    if (h.id !== i + 1) return `handler ids not dense (handlers[${i}].id === ${h.id})`;
    // Nested regions need parent-chain replay in the catch — 3c follow-up.
    if (h.parent !== 0) return `nested handler region ${h.id} (parent ${h.parent}) not yet supported`;
  }
  return null;
}

// ── PATH B slice 1b: resume function + step adapters + call-site shim ─────────

/**
 * Build (idempotently) the host-free async **resume function**
 * `__async_resume_f<name>(frame) -> void` and its two microtask **step
 * adapters** for one async function. Returns the resume funcIdx.
 *
 * The resume function is a **general N-state machine** (#2906) driven by
 * `frame.STATE_FIELD` over an ordered list of suspend segments
 * ({@link planLinearAwaits}) — the multi-await generalization of the pre-#2906
 * 2-state machine. It mirrors the Wasm-native generator trampoline
 * (`generators-native.ts emitTrampoline`): a `block { loop { if-chain } }` that
 * dispatches on STATE, where a synchronously-settled await advances STATE and
 * `br`s back to re-dispatch (chaining fast-path awaits within one call) and a
 * genuinely-pending await suspends with a `return`.
 *
 * For N awaits there are N+1 states:
 *   - state s (0 ≤ s < N): [for s≥1] re-throw a rejected predecessor await + bind
 *     its value from `SENT_FIELD`; run the lead statements; evaluate await s's
 *     operand and assimilate it to a `$Promise`. FULFILLED → deliver value to
 *     SENT, STATE=s+1, `br` re-dispatch. REJECTED → stash reason in ERROR +
 *     MODE=THROW, STATE=s+1, `br` (the next state's prelude re-throws). PENDING →
 *     `storeSpills`, STATE=s+1, register the reaction (the SAME two step adapters
 *     for every state — they only deliver SENT/ERROR then call resume, which
 *     routes by STATE), `return`. A non-`$Promise` operand is delivered straight.
 *   - state N (final): re-throw / bind the last await's value, then run the tail
 *     (`return v` settles `frame.result_promise` via the `asyncDriveReturn` hook;
 *     fall-through settles undefined). `return await P` settles with SENT directly.
 *
 * Uses the generator slot-reservation discipline (#2079/#1677/#1809): the resume
 * function and both step adapters reserve their funcIdx slots with placeholder
 * bodies BEFORE the resume body is emitted, because `compileStatement` on the
 * lead/tail statements can lazily append helper functions to `ctx.mod.functions`
 * — a stale capture would otherwise repoint every baked `call`/`ref.func`. The
 * N-segment body widens that window (more helpers) but the discipline is the same.
 */
export function ensureAsyncResumeFunction(ctx: CodegenContext, info: AsyncFrameInfo, plan: AsyncCpsPlan): number {
  if (info.resumeFuncIdx !== undefined) return info.resumeFuncIdx;

  // (#2906 slice 3/3a) Build the general CFG plan the emitter drives.
  // `planAsyncCfg` delegates linear bodies to the byte-identical
  // `linearPlanToCfg(planLinearAwaits(...))` path, and — on the native drive lane
  // only (`allowLoops: !info.host`) — lowers a canonical `while`-with-await body
  // into the loop CFG (head condGoto + body suspends + back-edge goto). The host
  // settle backend keeps the linear-only shape (loops there suspend on every
  // await — an N-round follow-up).
  // (#2906 slice 3d-i) An async GENERATOR builds its CFG from the yield-aware
  // `planAsyncGenCfg` (settleYield/settleDone terminators); every other async fn
  // uses the linear/while/for-await `planAsyncCfg`.
  // (#3120) The implicit §27.6.3.8 yield-operand await is classified ONLY on
  // the native-`$Promise` CARRIER lane — the same predicate the admission gate
  // (`isAsyncGenDriveCandidate`) keyed the body's shape check on, so gate and
  // planner always see the same segment split. Type queries go through
  // `ctx.oracle` (the #1930 boundary), not the raw checker.
  const cfg = info.asyncGen
    ? planAsyncGenCfg(info.decl, isStandalonePromiseActive(ctx) ? { oracle: ctx.oracle } : null)
    : planAsyncCfg(ctx, info.decl, plan, { allowLoops: !info.host });
  if (cfg === null) {
    reportError(ctx, info.decl, "internal: async-frame resume built on an unsupported body shape (#2906 slice 1/3a)");
    info.resumeFuncIdx = -1;
    return -1;
  }

  const cfgError = validateAsyncCfg(cfg);
  if (cfgError !== null) {
    reportError(ctx, info.decl, `internal: async CFG plan violates the emitter contract — ${cfgError} (#2906)`);
    info.resumeFuncIdx = -1;
    return -1;
  }

  // Host backend never touches the native scheduler (no `$Promise` struct, no
  // microtask ring) — the JS host's own microtask queue drives resumption.
  const rt = info.host ? null : ensureAsyncDriveRuntime(ctx);
  const hostImports = info.hostImports;
  const frameRef: ValType = { kind: "ref", typeIdx: info.stateTypeIdx };
  const stem = sanitizeTypeName(info.functionName);

  // Reserve slots: resume fn, then the two step adapters. The microtask wrapper
  // ABI is (caps externref, value externref) -> externref (result dropped). N
  // states reuse the SAME two adapters (no per-state ABI change — #2906).
  //
  // Host backend (#1042): the adapters are the reaction callbacks the host
  // invokes through `__make_callback`, whose runtime dispatch is BY EXPORT NAME
  // (`exports["__cb_" + id](caps, value)`), so they are named `__cb_<id>` and
  // exported. Same (caps, value) -> externref ABI — the shapes coincide by
  // design (the wasi adapters were built to the `__cb_` ABI from the start).
  const resumeName = `__async_resume_f${stem}`;
  const resumeTypeIdx = addFuncType(ctx, [frameRef], [], `${resumeName}_type`);
  const stepName = `__async_step_f${stem}`;
  const stepTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    `${stepName}_type`,
  );
  if (info.host) {
    info.stepFulfillCbId = ctx.callbackCounter++;
    info.stepRejectCbId = ctx.callbackCounter++;
  }
  const stepFulfillName = info.host ? `__cb_${info.stepFulfillCbId}` : `${stepName}_fulfill`;
  const stepRejectName = info.host ? `__cb_${info.stepRejectCbId}` : `${stepName}_reject`;

  // (#1916 S3 / #2710) Stable-regime handles: the resume/step-adapter indices
  // are baked into adapter bodies, `ref.func` reaction instrs, funcMap, exports
  // and the cached `info.*FuncIdx` fields — every one of which previously had
  // to be chased by the late-import shifters (and `info.*` was chased by NO
  // shifter, a latent staleness hole). A stable handle never shifts, so all of
  // those bakes are correct by construction.
  const resumeFuncIdx = mintDefinedFunc(ctx);
  info.resumeFuncIdx = resumeFuncIdx;
  ctx.funcMap.set(resumeName, resumeFuncIdx);
  const resumePlaceholder: WasmFunction = {
    name: resumeName,
    typeIdx: resumeTypeIdx,
    locals: [],
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  };
  pushDefinedFunc(ctx, resumeFuncIdx, resumePlaceholder);

  const stepFulfillFuncIdx = mintDefinedFunc(ctx);
  info.stepFulfillFuncIdx = stepFulfillFuncIdx;
  ctx.funcMap.set(stepFulfillName, stepFulfillFuncIdx);
  pushDefinedFunc(ctx, stepFulfillFuncIdx, {
    name: stepFulfillName,
    typeIdx: stepTypeIdx,
    locals: buildStepAdapterLocals(info),
    body: buildStepAdapterBody(info, resumeFuncIdx, /*reject*/ false),
    exported: info.host,
  });
  // Host backend: the `__make_callback` host bridge dispatches by the exported
  // `__cb_<id>` NAME, so the adapters need real export entries (the `exported`
  // flag alone only opts into the module-init guard). The late-import shift
  // walker patches `mod.exports` func indices, so pushing at reservation time
  // is safe.
  if (info.host) {
    ctx.mod.exports.push({
      name: stepFulfillName,
      desc: { kind: "func", index: stepFulfillFuncIdx },
    });
  }

  const stepRejectFuncIdx = mintDefinedFunc(ctx);
  info.stepRejectFuncIdx = stepRejectFuncIdx;
  ctx.funcMap.set(stepRejectName, stepRejectFuncIdx);
  pushDefinedFunc(ctx, stepRejectFuncIdx, {
    name: stepRejectName,
    typeIdx: stepTypeIdx,
    locals: buildStepAdapterLocals(info),
    body: buildStepAdapterBody(info, resumeFuncIdx, /*reject*/ true),
    exported: info.host,
  });
  if (info.host) {
    ctx.mod.exports.push({
      name: stepRejectName,
      desc: { kind: "func", index: stepRejectFuncIdx },
    });
  }

  // ── Build the resume function body. ──
  const resumeFctx: FunctionContext = {
    name: resumeName,
    params: [{ name: "__frame", type: frameRef }],
    locals: [],
    localMap: new Map([["__frame", 0]]),
    returnType: null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    // (#2865) A NESTED producer captures outer locals as ref cells (leading
    // params of the lifted fn, spilled into frame param fields). The resume
    // body compiles the same identifiers, so it needs the same cell-deref
    // routing the lifted body had.
    boxedCaptures: info.boxedCaptures,
    readsCurrentThis: info.readsCurrentThis,
  };
  const frameLocal = 0;

  // Load captured params from the frame into locals.
  for (let i = 0; i < info.paramNames.length; i++) {
    const idx = allocLocal(resumeFctx, info.paramNames[i]!, info.paramTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: frameLocal });
    resumeFctx.body.push({
      op: "struct.get",
      typeIdx: info.stateTypeIdx,
      fieldIdx: info.paramFieldOffset + i,
    });
    resumeFctx.body.push({ op: "local.set", index: idx });
  }
  // Load spills from the frame into locals (overwritten by a segment's lead on
  // first entry into its owning state; restored from the frame on resume).
  for (let i = 0; i < info.spillNames.length; i++) {
    const idx = allocLocal(resumeFctx, info.spillNames[i]!, info.spillTypes[i]!);
    resumeFctx.body.push({ op: "local.get", index: frameLocal });
    resumeFctx.body.push({
      op: "struct.get",
      typeIdx: info.stateTypeIdx,
      fieldIdx: info.spillFieldOffset + i,
    });
    resumeFctx.body.push({ op: "local.set", index: idx });
  }
  // (#2865) A lifted-CLOSURE body (arrow / fn-expr) keeps its captures in the
  // `__self` struct — closures.ts materializes each into a NAMED local in the
  // lifted body's prologue, and every identifier/call site in the body resolves
  // them via localMap (cells deref through `boxedCaptures`). This resume fn
  // compiles the SAME body statements, so re-run that materialization from the
  // frame-captured `__self` param field. Without it, capture resolution falls
  // back to STALE outer-scope local indices (the capture-arg push in calls.ts
  // uses `localMap.get(name) ?? cap.outerLocalIdx`) — a guaranteed miscompile.
  if (info.selfCaptureLayout) {
    const layout = info.selfCaptureLayout;
    const selfIdx = resumeFctx.localMap.get(layout.selfParamName);
    if (selfIdx !== undefined) {
      let selfForCaptures = selfIdx;
      if (layout.castToTypeIdx !== null) {
        const castLocal = allocLocal(resumeFctx, "__self_cast", { kind: "ref", typeIdx: layout.castToTypeIdx });
        resumeFctx.body.push({ op: "local.get", index: selfIdx });
        resumeFctx.body.push({ op: "ref.cast", typeIdx: layout.castToTypeIdx } as Instr);
        resumeFctx.body.push({ op: "local.set", index: castLocal });
        selfForCaptures = castLocal;
      }
      for (const entry of layout.entries) {
        const idx = allocLocal(resumeFctx, entry.name, entry.localType);
        resumeFctx.body.push({ op: "local.get", index: selfForCaptures });
        resumeFctx.body.push({ op: "struct.get", typeIdx: layout.structTypeIdx, fieldIdx: entry.fieldIdx } as Instr);
        resumeFctx.body.push({ op: "local.set", index: idx });
      }
    }
  }
  // Load the result promise into a local; wire the `return` settle hook. Both
  // backends settle through `call <fulfill>(promise, value) -> value; drop` —
  // native `__promise_fulfill` takes `(ref $Promise)`, host
  // `Promise_settle_resolve` takes externref; the import is declared with an
  // externref result so the shared `drop` stays valid.
  const resultPromiseLocal = allocLocal(
    resumeFctx,
    "__async_result",
    info.host ? { kind: "externref" } : { kind: "ref", typeIdx: info.promiseTypeIdx },
  );
  resumeFctx.body.push({ op: "local.get", index: frameLocal });
  resumeFctx.body.push({
    op: "struct.get",
    typeIdx: info.stateTypeIdx,
    fieldIdx: info.resultPromiseFieldIdx,
  });
  resumeFctx.body.push({ op: "local.set", index: resultPromiseLocal });
  const settleFulfillIdx = info.host ? hostImports!.settleResolveIdx : rt!.fulfillFuncIdx;
  const settleRejectIdx = info.host ? hostImports!.settleRejectIdx : rt!.rejectFuncIdx;
  resumeFctx.asyncDriveReturn = {
    resultPromiseLocal,
    promiseTypeIdx: info.promiseTypeIdx,
    fulfillFuncIdx: settleFulfillIdx,
  };

  // Resume-binding locals. A binding that survives a later await is ALREADY a
  // spill local (allocated above) — reuse that slot so the delivered SENT value
  // and the spilled/reloaded value share one local. A binding used only within
  // its own continuation gets a fresh delivery-only local. Typed via
  // `resumeBindingValType` (== the spill field type for the spilled ones).
  const bindingLocal = new Map<string, { local: number; type: ValType }>();
  for (const st of cfg.states) {
    const rb = st.resumeFrom?.binding;
    if (!rb) continue;
    const t = resumeBindingValType(ctx, rb);
    const existing = resumeFctx.localMap.get(rb.name);
    const local = existing !== undefined ? existing : allocLocal(resumeFctx, rb.name, t);
    bindingLocal.set(rb.name, { local, type: t });
  }

  // Transient locals reused across every state arm (only one await is processed
  // per resume-call dispatch, so a single set suffices). The native backend
  // needs the typed `$Promise` classification locals; the host backend cannot
  // inspect a host Promise synchronously (opaque externref), so it keeps only
  // an externref slot for the assimilated promise.
  const awaitedLocal = allocLocal(resumeFctx, "__async_awaited", {
    kind: "externref",
  });
  const pLocal = info.host
    ? -1
    : allocLocal(resumeFctx, "__async_p", {
        kind: "ref",
        typeIdx: info.promiseTypeIdx,
      });
  const suspendedLocal = info.host ? -1 : allocLocal(resumeFctx, "__async_suspended", { kind: "i32" });
  const pHostLocal = info.host ? allocLocal(resumeFctx, "__async_p_host", { kind: "externref" }) : -1;
  const exnTag = ensureExnTag(ctx);
  const reasonLocal = allocLocal(resumeFctx, "__async_reason", {
    kind: "externref",
  });
  // (#2906 slice 3d-i) The yielded value slot for `settleYield` (async gen only).
  const yieldValLocal = info.asyncGen ? allocLocal(resumeFctx, "__async_gen_yield", { kind: "externref" }) : -1;

  // (#2906 Gap 3 → slice 3) Handler regions. `inSrcTryLocal` (an i32
  // resume-local) records the id of the handler region control is currently in
  // (0 = none; slice-2's boolean is the single-region special case, so the
  // emitted i32.const 0/1 toggles are byte-identical). The outer catch routes an
  // abrupt completion by it: run the active region's await-free finalizer, then
  // reject. The local + all associated instrs are emitted ONLY when the plan has
  // handler regions, so non-try async stays byte-identical to slice 1.
  const hasHandlers = cfg.handlers.length > 0;
  const inSrcTryLocal = hasHandlers ? allocLocal(resumeFctx, "__async_in_try", { kind: "i32" }) : -1;
  const setHandler = (v: number): Instr[] => [
    { op: "i32.const", value: v },
    { op: "local.set", index: inSrcTryLocal },
  ];

  // Emit a state's resume prelude: re-throw a rejected predecessor await
  // (MODE_THROW — arming its handler region first so the finalizer runs), then
  // bind the delivered `SENT_FIELD` value to the await's resume binding.
  // MUST be called while `resumeFctx.body === out` (coerceType pushes there).
  const emitDeliver = (out: Instr[], rp: AsyncResumePoint): void => {
    const throwArm: Instr[] = [];
    if (hasHandlers && rp.handler !== 0) throwArm.push(...setHandler(rp.handler));
    throwArm.push(
      { op: "local.get", index: frameLocal },
      {
        op: "struct.get",
        typeIdx: info.stateTypeIdx,
        fieldIdx: ERROR_FIELD,
      } as Instr,
      { op: "throw", tagIdx: exnTag } as Instr,
    );
    out.push({ op: "local.get", index: frameLocal });
    out.push({
      op: "struct.get",
      typeIdx: info.stateTypeIdx,
      fieldIdx: MODE_FIELD,
    });
    out.push({ op: "i32.const", value: MODE_THROW });
    out.push({ op: "i32.eq" });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: throwArm,
    } as Instr);
    if (rp.binding) {
      const bl = bindingLocal.get(rp.binding.name)!;
      out.push({ op: "local.get", index: frameLocal });
      out.push({
        op: "struct.get",
        typeIdx: info.stateTypeIdx,
        fieldIdx: SENT_FIELD,
      });
      coerceType(ctx, resumeFctx, { kind: "externref" }, bl.type);
      out.push({ op: "local.set", index: bl.local });
    }
  };

  // One CFG state → its dispatch-arm body (#2906 slice 3). Every state emits:
  // handler-region reset, the resume prelude (when this state is an await's
  // `resumeState`), the handler-annotated lead statements, then its TERMINATOR.
  // Suspend keeps the slice-1/2 emission verbatim (parameterized by
  // `resumeState`); `goto`/`condGoto` are `STATE=<target>; br <re-dispatch
  // loop>` — a target ≤ the current id is a loop back-edge, which is how
  // while-await / for-await planners express iteration with NO emitter change.
  const buildStateBody = (st: AsyncCfgState): Instr[] => {
    const saved = resumeFctx.body;
    ctx.liveBodies.add(saved);
    const out: Instr[] = [];
    resumeFctx.body = out;
    // `br` depth of the re-dispatch loop from this arm's top level: br0 = this
    // arm's own `if`, br1..br(st.id) = the enclosing if-chain arms, br(st.id+1)
    // = if(state==0), br(st.id+2) = the loop. Valid because state ids are dense
    // and equal to their if-chain nesting depth (validateAsyncCfg).
    const loopDepth = st.id + 2;
    try {
      // Reset the handler-region local at arm entry (a resume enters here
      // fresh; a fast-path advance may re-dispatch from an in-region state).
      let curHandler = 0;
      if (hasHandlers) out.push(...setHandler(0));
      if (st.resumeFrom) emitDeliver(out, st.resumeFrom);

      // Compile the lead, toggling the region local at each boundary so a throw
      // in an in-region statement (or the terminator's own evaluation) runs the
      // region's finalizer; a throw outside (or in the inline finally itself)
      // does not.
      for (const { stmt, handler } of st.lead) {
        if (hasHandlers && handler !== curHandler) {
          curHandler = handler;
          out.push(...setHandler(curHandler));
        }
        compileStatement(ctx, resumeFctx, stmt);
      }

      // (#2906 slice 3b) State-level injected step — the for-await planner uses
      // it for `it = GetAsyncIterator(source)` (entry) and `{done,value} =
      // it.next()` (loop head). Emitted after the lead, before the terminator;
      // leaves the stack balanced. `undefined` (no hook) for every other plan.
      if (st.emit) st.emit(ctx, resumeFctx);

      const term = st.terminator;
      switch (term.kind) {
        case "suspend": {
          if (hasHandlers && term.handler !== curHandler) {
            curHandler = term.handler;
            out.push(...setHandler(curHandler));
          }
          // (#2906 slice 3b) The awaited operand is a `ts.Expression`
          // (linear/while) or an injected emit hook (for-await, whose element
          // value lives in a wasm local, not AST).
          const awaitedType = isEmitOperand(term.awaited)
            ? term.awaited.emit(ctx, resumeFctx)
            : compileExpression(ctx, resumeFctx, term.awaited);
          if (awaitedType !== null && awaitedType !== undefined) {
            coerceType(ctx, resumeFctx, awaitedType as ValType, {
              kind: "externref",
            });
          } else {
            out.push({ op: "ref.null.extern" } as Instr);
          }
          out.push({ op: "local.set", index: awaitedLocal });

          if (info.host) {
            // (#1042 host settle backend) A host Promise is an opaque externref
            // — no synchronous state inspection is possible, so EVERY await
            // suspends: assimilate the awaited value via PromiseResolve
            // (§27.7.5.3 — a non-thenable becomes an already-resolved Promise,
            // a promise passes through unchanged), park the frame
            // (STATE=resumeState + spills), register the two `__cb_<id>` step
            // adapters as reactions via `Promise_then2(p,
            // __make_callback(fulfillId, frame), __make_callback(rejectId,
            // frame))`, and return. The HOST microtask queue resumes us — there
            // is no synchronous fast-path advance, which also makes await
            // timing spec-correct (every await yields ≥1 tick). The cbId
            // constants are shift-immune (runtime dispatch is by export NAME);
            // the five import indices are import-space stable.
            out.push({ op: "local.get", index: awaitedLocal });
            out.push({ op: "call", funcIdx: hostImports!.promiseResolveIdx });
            out.push({ op: "local.set", index: pHostLocal });
            out.push(...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.resumeState));
            out.push(...storeSpills(info, resumeFctx, frameLocal));
            out.push({ op: "local.get", index: pHostLocal });
            out.push({ op: "i32.const", value: info.stepFulfillCbId! });
            out.push({ op: "local.get", index: frameLocal });
            out.push({ op: "extern.convert_any" } as Instr);
            out.push({ op: "call", funcIdx: hostImports!.makeCbIdx });
            out.push({ op: "i32.const", value: info.stepRejectCbId! });
            out.push({ op: "local.get", index: frameLocal });
            out.push({ op: "extern.convert_any" } as Instr);
            out.push({ op: "call", funcIdx: hostImports!.makeCbIdx });
            out.push({ op: "call", funcIdx: hostImports!.then2Idx });
            out.push({ op: "drop" });
            out.push({ op: "return" });
            break;
          }

          // Classify the assimilated value; set suspendedLocal + SENT/ERROR/MODE.
          // No `br` inside these nested ifs — the single advance/suspend
          // `br`/`return` is emitted flat below at a known control depth.
          out.push({ op: "i32.const", value: 0 });
          out.push({ op: "local.set", index: suspendedLocal });

          const deliverFromP: Instr[] = [
            { op: "local.get", index: frameLocal },
            { op: "local.get", index: pLocal },
            {
              op: "struct.get",
              typeIdx: info.promiseTypeIdx,
              fieldIdx: 1,
            } as Instr,
            {
              op: "struct.set",
              typeIdx: info.stateTypeIdx,
              fieldIdx: SENT_FIELD,
            } as Instr,
          ];
          const rejectFromP: Instr[] = [
            { op: "local.get", index: frameLocal },
            { op: "local.get", index: pLocal },
            {
              op: "struct.get",
              typeIdx: info.promiseTypeIdx,
              fieldIdx: 1,
            } as Instr,
            {
              op: "struct.set",
              typeIdx: info.stateTypeIdx,
              fieldIdx: ERROR_FIELD,
            } as Instr,
            ...setStateI32FromConst(info, frameLocal, MODE_FIELD, MODE_THROW),
          ];
          const markPending: Instr[] = [
            { op: "i32.const", value: 1 },
            { op: "local.set", index: suspendedLocal },
          ];
          const deliverPlain: Instr[] = [
            { op: "local.get", index: frameLocal },
            { op: "local.get", index: awaitedLocal },
            {
              op: "struct.set",
              typeIdx: info.stateTypeIdx,
              fieldIdx: SENT_FIELD,
            } as Instr,
          ];
          const pendingOrRejected: Instr[] = [
            { op: "local.get", index: pLocal },
            {
              op: "struct.get",
              typeIdx: info.promiseTypeIdx,
              fieldIdx: 0,
            } as Instr,
            { op: "i32.const", value: PROMISE_STATE_REJECTED },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: rejectFromP,
              else: markPending,
            } as Instr,
          ];
          out.push(
            { op: "local.get", index: awaitedLocal },
            { op: "any.convert_extern" } as Instr,
            { op: "ref.test", typeIdx: info.promiseTypeIdx } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: awaitedLocal },
                { op: "any.convert_extern" } as Instr,
                { op: "ref.cast", typeIdx: info.promiseTypeIdx } as Instr,
                { op: "local.set", index: pLocal },
                { op: "local.get", index: pLocal },
                {
                  op: "struct.get",
                  typeIdx: info.promiseTypeIdx,
                  fieldIdx: 0,
                } as Instr,
                { op: "i32.const", value: PROMISE_STATE_FULFILLED },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: deliverFromP,
                  else: pendingOrRejected,
                } as Instr,
              ],
              else: deliverPlain,
            } as Instr,
          );

          // Advance-or-suspend. STATE = resumeState for both (suspend → the
          // microtask resume enters it; advance → the re-dispatch enters it).
          out.push(...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.resumeState));
          const suspendArm: Instr[] = [
            ...storeSpills(info, resumeFctx, frameLocal),
            // promise.callbacks = $PromiseCallback{stepFulfill, frame, stepReject, frame, promise.callbacks}
            { op: "local.get", index: pLocal },
            { op: "ref.func", funcIdx: info.stepFulfillFuncIdx! } as Instr,
            { op: "local.get", index: frameLocal },
            { op: "extern.convert_any" } as Instr,
            { op: "ref.func", funcIdx: info.stepRejectFuncIdx! } as Instr,
            { op: "local.get", index: frameLocal },
            { op: "extern.convert_any" } as Instr,
            { op: "local.get", index: pLocal },
            {
              op: "struct.get",
              typeIdx: info.promiseTypeIdx,
              fieldIdx: 2,
            } as Instr,
            { op: "struct.new", typeIdx: rt!.callbackTypeIdx } as Instr,
            { op: "extern.convert_any" } as Instr,
            {
              op: "struct.set",
              typeIdx: info.promiseTypeIdx,
              fieldIdx: 2,
            } as Instr,
            { op: "return" },
          ];
          // Advance: `br` to the dispatch `loop` to re-enter at STATE=resumeState.
          const advanceArm: Instr[] = [{ op: "br", depth: loopDepth } as Instr];
          out.push({ op: "local.get", index: suspendedLocal });
          out.push({
            op: "if",
            blockType: { kind: "empty" },
            then: suspendArm,
            else: advanceArm,
          } as Instr);
          break;
        }
        case "goto": {
          // Unconditional state transition (loop back-edge when target ≤ id).
          // (#2906 slice 3a) `loopDepth` (== id+2) is the depth that reaches the
          // re-dispatch `loop` from ONE level inside an `if` arm — that is where
          // the suspend fast-path `advanceArm` br sits (inside `if(suspended)`),
          // the only pre-3a exerciser of the re-dispatch br. This `goto` br is
          // emitted at the STATE-BODY TOP LEVEL (one level shallower), so the
          // loop is one nearer: `loopDepth - 1`. (Fixes the off-by-one the
          // producer-unreachable slice-3 goto shipped with.)
          out.push(...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.target));
          out.push({ op: "br", depth: loopDepth - 1 } as Instr);
          break;
        }
        case "condGoto": {
          // Two-way state transition on a source condition (loop heads / ifs).
          if (hasHandlers && term.handler !== curHandler) {
            curHandler = term.handler;
            out.push(...setHandler(curHandler));
          }
          // (#2906 slice 3b) condition is a `ts.Expression` (while/if) or an
          // emit hook pushing the i32 `done` flag (for-await loop head).
          const condType = isEmitOperand(term.cond)
            ? term.cond.emit(ctx, resumeFctx)
            : compileExpression(ctx, resumeFctx, term.cond);
          ensureI32Condition(resumeFctx, condType, ctx);
          out.push({
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.whenTrue),
              // The br sits inside this `if(cond)` arm — one level deep, exactly
              // like the suspend `advanceArm` br — so it reaches the loop at
              // `loopDepth` (id+2), NOT loopDepth+1.
              { op: "br", depth: loopDepth } as Instr,
            ],
            else: [
              ...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.whenFalse),
              { op: "br", depth: loopDepth } as Instr,
            ],
          } as Instr);
          break;
        }
        case "settleSent": {
          // `return await P` — fulfil the result promise with SENT directly.
          out.push({ op: "local.get", index: resultPromiseLocal });
          out.push({ op: "local.get", index: frameLocal });
          out.push({
            op: "struct.get",
            typeIdx: info.stateTypeIdx,
            fieldIdx: SENT_FIELD,
          });
          out.push({ op: "call", funcIdx: settleFulfillIdx });
          out.push({ op: "drop" });
          out.push({ op: "return" });
          break;
        }
        case "settleUndefined": {
          // Fall off the body — fulfil with undefined. (`return v` inside the
          // lead already settles via the `asyncDriveReturn` hook and returns.)
          out.push({ op: "local.get", index: resultPromiseLocal });
          out.push({ op: "ref.null.extern" } as Instr);
          out.push({ op: "call", funcIdx: settleFulfillIdx });
          out.push({ op: "drop" });
          out.push({ op: "return" });
          break;
        }
        case "settleYield": {
          // (#2906 slice 3d-i) `yield E`: fulfil the current `next()`-promise
          // (`frame.result_promise`, re-minted per next() — already loaded into
          // `resultPromiseLocal` at resume-fn entry) with an IteratorResult
          // `{value: E, done: false}`, set STATE=resumeState, spill, and `return`.
          // No reaction is registered (a yield does not await); the consumer's
          // next `next()` kick re-dispatches at `resumeState`.
          const resultTypeIdx = info.asyncGenResultTypeIdx!;
          // Compute the yielded value (externref) into `yieldValLocal`.
          if (term.fromSent) {
            // `yield await P` — the awaited value delivered into SENT_FIELD.
            out.push({ op: "local.get", index: frameLocal });
            out.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD } as Instr);
          } else if (term.value === null) {
            out.push({ op: "ref.null.extern" } as Instr); // `yield;` → undefined
          } else {
            const vt = isEmitOperand(term.value)
              ? term.value.emit(ctx, resumeFctx)
              : compileExpression(ctx, resumeFctx, term.value);
            if (vt !== null && vt !== undefined) {
              coerceType(ctx, resumeFctx, vt as ValType, { kind: "externref" });
            } else {
              out.push({ op: "ref.null.extern" } as Instr);
            }
          }
          out.push({ op: "local.set", index: yieldValLocal });
          // result_promise.fulfil( IteratorResult{value: yieldVal, done: 0} )
          out.push({ op: "local.get", index: resultPromiseLocal });
          out.push({ op: "local.get", index: yieldValLocal });
          out.push({ op: "i32.const", value: 0 }); // done = false
          out.push({ op: "struct.new", typeIdx: resultTypeIdx } as Instr);
          out.push({ op: "extern.convert_any" } as Instr);
          out.push({ op: "call", funcIdx: settleFulfillIdx });
          out.push({ op: "drop" });
          // Suspend: STATE=resumeState, persist spills, return (await the next kick).
          out.push(...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.resumeState));
          out.push(...storeSpills(info, resumeFctx, frameLocal));
          out.push({ op: "return" });
          break;
        }
        case "settleDone": {
          // (#2906 slice 3d-i) Async-gen body end — fulfil the current
          // `next()`-promise with `{value: undefined, done: true}`.
          const resultTypeIdx = info.asyncGenResultTypeIdx!;
          out.push({ op: "local.get", index: resultPromiseLocal });
          out.push({ op: "ref.null.extern" } as Instr); // value = undefined
          out.push({ op: "i32.const", value: 1 }); // done = true
          out.push({ op: "struct.new", typeIdx: resultTypeIdx } as Instr);
          out.push({ op: "extern.convert_any" } as Instr);
          out.push({ op: "call", funcIdx: settleFulfillIdx });
          out.push({ op: "drop" });
          out.push({ op: "return" });
          break;
        }
      }
    } finally {
      resumeFctx.body = saved;
      ctx.liveBodies.delete(saved);
    }
    return out;
  };

  // (#2710) COMPLETED-but-unassembled state-body arrays must stay reachable by
  // the late-import shifters. `buildStateArm` builds states depth-first: while
  // state i+1 compiles (and may register late imports via ensureLateImport /
  // addStringImports / addUnionImports), state i's finished array is a plain
  // local — not resumeFctx.body, not in ctx.liveBodies, not yet nested under any
  // walked root (its wrapping `if` instr is only created after the recursion
  // returns). Any LIVE-regime defined-func immediate already baked into it would
  // then miss the shift — the exact mechanism behind the invalid-wasm
  // playground async.ts::gc regression (a stale `call <user fn>` in state 0,
  // off by the imports added while compiling later states; see the #2710
  // progress log). Stable handles (#1916 S3) make user-fn callees immune, but
  // calls to still-live-regime helpers (the remaining index.ts mints) ride the
  // same arrays until S3-final — so track every detached array in
  // ctx.liveBodies until the machine is assembled onto resumePlaceholder.body.
  const detachedSegArrays: Instr[][] = [];
  const trackDetached = (arr: Instr[]): Instr[] => {
    detachedSegArrays.push(arr);
    ctx.liveBodies.add(arr);
    return arr;
  };

  // Nested if-chain dispatch (`if(state==s){body}else{…}`), mirroring the
  // generator trampoline. Recursion depth == state id (dense, validated), so
  // each arm's `br`-to-loop depth is `id + 2` inside `buildStateBody`.
  const buildStateArm = (i: number): Instr[] => {
    if (i >= cfg.states.length) return [{ op: "unreachable" } as Instr];
    const st = cfg.states[i]!;
    const then = trackDetached(buildStateBody(st));
    return [
      { op: "local.get", index: frameLocal },
      { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
      { op: "i32.const", value: st.id },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then,
        else: buildStateArm(i + 1),
      } as Instr,
    ];
  };

  const savedFunc = ctx.currentFunc;
  ctx.currentFunc = resumeFctx;
  let chain: Instr[];
  // (#2906 Gap 3 → slice 3) Each handler region's finalizer, compiled a SECOND
  // time for the abrupt path (the first copy runs inline on the normal path via
  // the region's post-try lead). Fresh Instr[] — never aliased with the inline
  // copy. Guarded in the catch by the region-id local so it runs only for a
  // throw/rejected-await that crossed THAT try region. With a single region the
  // guard is the slice-2 truthiness test (byte-identical); sibling regions get
  // an id-equality guard each. Nested regions (parent !== 0) need parent-chain
  // replay and are rejected by validateAsyncCfg until the 3c follow-up.
  const catchFinallyInstrs: Instr[] = [];
  try {
    // (#2710) The returned chain nests every state body, but stays detached
    // from all shifter roots until the `dispatch` push below — track it too
    // (the handler-finalizer compiles between here and there can register
    // late imports).
    chain = trackDetached(buildStateArm(0));
    for (const region of cfg.handlers) {
      const saved = resumeFctx.body;
      ctx.liveBodies.add(saved);
      const fbody: Instr[] = [];
      resumeFctx.body = fbody;
      try {
        for (const f of region.finalizer) compileStatement(ctx, resumeFctx, f);
      } finally {
        resumeFctx.body = saved;
        ctx.liveBodies.delete(saved);
      }
      if (cfg.handlers.length === 1) {
        catchFinallyInstrs.push({ op: "local.get", index: inSrcTryLocal }, {
          op: "if",
          blockType: { kind: "empty" },
          then: fbody,
        } as Instr);
      } else {
        catchFinallyInstrs.push(
          { op: "local.get", index: inSrcTryLocal },
          { op: "i32.const", value: region.id },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: fbody } as Instr,
        );
      }
    }
  } finally {
    ctx.currentFunc = savedFunc;
  }

  // (#2867 Gap 2) Throw → reject routing. A genuine throw — a bare `throw e`, or
  // a rejected await re-thrown by a state prelude's MODE_THROW arm — must settle
  // the result `$Promise` REJECTED, not escape uncaught (trap / strand pending).
  // Wrap the whole `block { loop { if-chain } }` dispatch in `try`/`catch $exn`.
  // Suspend / settle `return`s exit cleanly (a `return` in `try` skips `catch`),
  // so only a real throw reaches the handler.
  const dispatch: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: chain } as Instr],
    } as Instr,
  ];
  resumeFctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: dispatch,
    catches: [
      {
        tagIdx: exnTag,
        body: [
          { op: "local.set", index: reasonLocal },
          // (#2906 Gap 3) run the finally before rejecting, if the throw crossed
          // the try region (inline no-op array when the body has no finally).
          ...catchFinallyInstrs,
          { op: "local.get", index: resultPromiseLocal },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: settleRejectIdx },
          { op: "drop" },
        ],
      },
    ],
  } as Instr);

  resumePlaceholder.locals = resumeFctx.locals;
  resumePlaceholder.body = resumeFctx.body;
  // (#2710) Everything is now reachable from resumePlaceholder.body (walked via
  // mod.functions) — release the detached-array tracking. The shifters' per-run
  // `shifted` Set already dedupes arrays reachable from two roots, so the
  // tracking was safe even across the assembly point.
  for (const arr of detachedSegArrays) ctx.liveBodies.delete(arr);
  return resumeFuncIdx;
}

/** Step-adapter locals: param 0/1 = (caps, value); local 2 = the cast frame. */
function buildStepAdapterLocals(info: AsyncFrameInfo): { name: string; type: ValType }[] {
  return [{ name: "$frame", type: { kind: "ref", typeIdx: info.stateTypeIdx } }];
}

/**
 * `__async_step_f<name>_{fulfill,reject}(caps, value) -> externref`: cast caps
 * back to the frame, store the settled value into `SENT_FIELD` (and, for the
 * reject adapter, the reason into `ERROR_FIELD` + `MODE_FIELD=MODE_THROW`), then
 * call the resume function. This is the funcref enqueued on the awaited
 * promise's reaction list and run by the microtask drain.
 */
function buildStepAdapterBody(info: AsyncFrameInfo, resumeFuncIdx: number, reject: boolean): Instr[] {
  const capsLocal = 0;
  const valueLocal = 1;
  const frameLocal = 2;
  const body: Instr[] = [
    { op: "local.get", index: capsLocal },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: info.stateTypeIdx } as Instr,
    { op: "local.set", index: frameLocal },
    // SENT_FIELD = value (the settled awaited value the continuation reads).
    { op: "local.get", index: frameLocal },
    { op: "local.get", index: valueLocal },
    {
      op: "struct.set",
      typeIdx: info.stateTypeIdx,
      fieldIdx: SENT_FIELD,
    } as Instr,
  ];
  if (reject) {
    // ERROR_FIELD = reason; MODE_FIELD = MODE_THROW (2). (Slice-1 surfaces the
    // reason via SENT for the fast path; the throw-on-rejected-await refinement
    // reads ERROR/MODE — wired here so the field is populated.)
    body.push(
      { op: "local.get", index: frameLocal },
      { op: "local.get", index: valueLocal },
      {
        op: "struct.set",
        typeIdx: info.stateTypeIdx,
        fieldIdx: ERROR_FIELD,
      } as Instr,
      ...setStateI32FromConst(info, frameLocal, MODE_FIELD, 2),
    );
  }
  body.push(
    { op: "local.get", index: frameLocal },
    { op: "call", funcIdx: resumeFuncIdx },
    { op: "ref.null.extern" } as Instr, // dropped by the drain
  );
  return body;
}

/**
 * Call-site / function-body shim (#2895 slice 1c entry point). Emitted in place
 * of the normal statement loop for a host-free async function that genuinely
 * suspends: allocate the `$AsyncFrame` (params spilled into fields, a fresh
 * pending result `$Promise`), kick the resume function once (runs entry to the
 * first real suspension), and leave the result `$Promise` (externref) on the
 * stack as the async function's return value. The function's result type must
 * already be rewritten to externref by the caller.
 */
export function emitAsyncFrameStateMachine(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
  host = false,
): void {
  // Host settle backend (#1042): no native scheduler, no `$Promise` struct —
  // the result promise is a host pending Promise (`Promise_new_pending`) and
  // reactions ride the host microtask queue.
  let hostImports: HostAsyncImports | undefined;
  if (host) {
    const resolved = resolveHostAsyncImports(ctx);
    if (resolved === null) {
      reportError(
        ctx,
        decl,
        "internal: host async-drive imports not pre-registered (collectAsyncCpsImports prepass missing) (#1042)",
      );
      fctx.body.push({ op: "ref.null.extern" } as Instr);
      return;
    }
    hostImports = resolved;
  }
  if (!host) ensureAsyncDriveRuntime(ctx);
  const promiseTypeIdx = host ? -1 : getOrRegisterPromiseType(ctx);
  const paramNames = fctx.params.map((p) => p.name);
  const paramTypes = fctx.params.map((p) => p.type);
  const info = buildAsyncFrameInfo(ctx, decl, plan, paramNames, paramTypes, promiseTypeIdx, hostImports);
  // (#2865) A CLOSURE consumer (arrow / fn-expr, #2957 phase 2) may capture
  // outer locals as ref cells (leading params of the lifted fn). The cells ride
  // into frame param fields like ordinary params; the resume body must deref
  // reads/writes through them, so thread the cell metadata onto the resume fctx.
  info.boxedCaptures = fctx.boxedCaptures;
  info.readsCurrentThis = fctx.readsCurrentThis;
  info.selfCaptureLayout = fctx.selfCaptureLayout;
  const resumeFuncIdx = ensureAsyncResumeFunction(ctx, info, plan);
  if (resumeFuncIdx < 0) {
    reportError(ctx, decl, "internal: async-frame resume function unavailable (#2895 slice 1)");
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return;
  }

  // Fresh pending result promise → local.
  const resultPromiseLocal = allocLocal(
    fctx,
    "__async_resultp",
    host ? { kind: "externref" } : { kind: "ref", typeIdx: promiseTypeIdx },
  );
  if (host) {
    fctx.body.push({ op: "call", funcIdx: hostImports!.newPendingIdx });
  } else {
    fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx } as Instr);
  }
  fctx.body.push({ op: "local.set", index: resultPromiseLocal });

  // Build the $AsyncFrame: state=0, sent=null, mode=0, abrupt=null, error=null,
  // params (from this fn's wasm params), spills(default), result_promise.
  fctx.body.push({ op: "i32.const", value: 0 }); // state
  fctx.body.push({ op: "ref.null.extern" } as Instr); // sent
  fctx.body.push({ op: "i32.const", value: 0 }); // mode = MODE_NEXT
  fctx.body.push({ op: "ref.null.extern" } as Instr); // abrupt
  fctx.body.push({ op: "ref.null.extern" } as Instr); // error
  for (let i = 0; i < info.paramTypes.length; i++) {
    fctx.body.push({ op: "local.get", index: i });
  }
  for (let i = 0; i < info.spillNames.length; i++) {
    fctx.body.push(defaultSpillInstr(info.spillTypes[i]!));
  }
  fctx.body.push({ op: "local.get", index: resultPromiseLocal });
  fctx.body.push({ op: "struct.new", typeIdx: info.stateTypeIdx } as Instr);
  const frameLocal = allocLocal(fctx, "__async_frame", {
    kind: "ref",
    typeIdx: info.stateTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: frameLocal });

  // Kick the resume function once (runs the entry segment to the first real
  // suspension or to synchronous completion). Re-read the funcIdx from
  // `ctx.funcMap` BY NAME rather than trusting the number captured before the
  // resume body was emitted: compiling the segments' lead/tail statements can
  // add late imports, which shifts every defined-function index — the shift
  // walker patches already-emitted bodies and funcMap, but not a stale JS-side
  // capture (#2936/#2941 side-channel lesson). Identical value (and bytes)
  // when no late import fired.
  const kickIdx = ctx.funcMap.get(`__async_resume_f${sanitizeTypeName(info.functionName)}`) ?? resumeFuncIdx;
  fctx.body.push({ op: "local.get", index: frameLocal });
  fctx.body.push({ op: "call", funcIdx: kickIdx });

  // Return the result promise (externref; the host result promise already is one).
  fctx.body.push({ op: "local.get", index: resultPromiseLocal });
  if (!host) fctx.body.push({ op: "extern.convert_any" } as Instr);
  fctx.body.push({ op: "return" });
}

// ── async-generator PRODUCER core (#2906 slice 3d-i) ─────────────────────────

/**
 * Is `decl` a bounded async generator drivable host-free on the async-frame CFG
 * machine? True only on a host-free target (`standalone`/`wasi`) for an async
 * `function*` whose body is the bounded shape {@link isBoundedAsyncGenBody}
 * accepts (a flat sequence of `yield <E>` / `yield await <P>` statements). The
 * call-site routing (`function-body.ts`) uses this to intercept the async gen
 * BEFORE the #680 native-generator gate; everything else stays on the legacy gen
 * path (correct-or-legacy, the #2367 graveyard rule).
 */
export function isAsyncGenDriveCandidate(ctx: CodegenContext, decl: ts.FunctionLikeDeclaration): boolean {
  if (!ASYNC_CPS_ENABLED) return false;
  // (#2865) Params must be plain identifiers: a binding-PATTERN param
  // (`f([...x] = v)`) destructures into derived LOCALS of the lifted fn's
  // prologue, which the fresh resume FunctionContext never sees — the body's
  // reads then mis-resolve (observed: invalid wasm, a null-repaired call arg).
  // A rest param builds a derived array local the same way. Identifier params
  // WITH defaults are fine (the default is applied to the param local before
  // the frame captures it). Correct-or-legacy.
  for (const p of decl.parameters) {
    if (!ts.isIdentifier(p.name) || p.dotDotDotToken !== undefined) return false;
  }
  // (#2865) Stem-collision guard: a SECOND same-named gen (different scope)
  // would share the first's `__async_gen_next_<stem>` helper — typed for the
  // FIRST frame struct — and trap on `ref.cast`. Correct-or-legacy: reject it.
  const registered = ctx.asyncGenProducers?.get(sanitizeTypeName(asyncFnName(decl)));
  if (registered !== undefined && registered.decl !== decl) return false;
  // (#2865) Own body locals become frame spills — every spill field must have a
  // spill-safe type (an inert `struct.new` default), or the layout is invalid.
  const spillsSafe = (): boolean => {
    for (const node of asyncGenOwnLocalDecls(decl).values()) {
      if (!isSpillSafeType(resolveSpillLocalValType(ctx, node) ?? { kind: "externref" })) return false;
    }
    return true;
  };
  // Under the native-`$Promise` CARRIER (`isStandalonePromiseActive`, wasi
  // today): the full bounded shape, awaited yields included — the awaited
  // operand lowers to a native `$Promise` the suspend arm can assimilate.
  if (isStandalonePromiseActive(ctx)) return isBoundedAsyncGenBody(decl) && spillsSafe();
  // (#2865) `--target standalone` with the carrier gate still OFF (#2980):
  // drive the producer host-free ONLY for await-free bodies. With the carrier
  // off an awaited operand does not lower to a native `$Promise`, so
  // `yield await P` would deliver the un-awaited promise object (wrong value)
  // — those bodies keep the legacy path (correct-or-legacy, #680 CE) until the
  // measured carrier widen. An await-free body is carrier-independent: every
  // promise the machine touches is minted by `__async_gen_next_<name>` itself.
  // (#3120: a Promise-typed plain `yield P` deliberately stays PLAIN — and
  // driven, byte-identically — on this lane; its implicit-await value gap is
  // the carrier widen's to close. See ImplicitYieldAwaitMode in async-cps.ts.)
  if (isAsyncDriveActive(ctx)) return isAwaitFreeAsyncGenBody(decl) && spillsSafe();
  return false;
}

/**
 * (#2865) Standalone carrier-off analogue of {@link asyncFnNeedsDrive},
 * restricted to the ONE shape that is carrier-independent: a bounded
 * `for await (const x of g())` CONSUMER over a host-free async generator.
 * Every suspension in that machine awaits a promise MINTED by the producer's
 * own `__async_gen_next_<name>` driver (always a native `$Promise`, regardless
 * of the carrier gate), so it drives correctly under `--target standalone`
 * while plain awaits / Promise statics stay on the legacy path pending the
 * #2980 carrier-widen decision. The 3b boxed-ARRAY for-await variant
 * (`forAwaitNeedsDrive`) is deliberately NOT accepted here — its per-element
 * `Await(value)` operands are host-backed promises under the un-widened
 * carrier, which the suspend arm would mis-classify as settled plain values.
 */
export function asyncGenConsumerNeedsDrive(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): boolean {
  if (!ASYNC_CPS_ENABLED) return false;
  if (plan.awaitPoints.length !== 0) return false; // bare awaits are carrier-dependent
  if (plan.forAwaitPoints.length === 0) return false;
  if (!forAwaitAsyncNeedsDrive(ctx, fn, plan)) return false;
  const fa = computeForAwaitSpills(ctx, fn, plan);
  if (fa === null) return false;
  return fa.spillTypes.every(isSpillSafeType);
}

/**
 * (#2906 slice 3d-i) Emit an async-generator PRODUCER: `g()` builds a resumable
 * `$AsyncFrame` (the generator carrier — a bare externref, NO prototype methods)
 * and returns it WITHOUT running any body code (async generators are lazy: the
 * body starts on the first `next()`). The re-entrant driver is the per-gen
 * `__async_gen_next_<name>(frame) -> Promise<IteratorResult>` helper, which mints
 * a FRESH pending result promise, stores it into the frame's `result_promise`
 * field, kicks the resume machine (runs to the next `yield`/`await`-suspend), and
 * returns that promise. `yield` settles it `{value, done:false}` and suspends;
 * body-end settles `{value:undefined, done:true}`. Native drive lane only.
 *
 * The frame externref + `__async_gen_next_<name>` + the reader probes are the
 * substrate 3d-ii (the `for await (x of g())` consumer) builds on.
 */
export function emitAsyncGenerator(ctx: CodegenContext, fctx: FunctionContext, decl: ts.FunctionLikeDeclaration): void {
  const rt = ensureAsyncDriveRuntime(ctx);
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const resultTypeIdx = ensureNativeGeneratorResultType(ctx, { kind: "externref" });

  const plan = analyzeAsyncBody(ctx, decl);
  const paramNames = fctx.params.map((p) => p.name);
  const paramTypes = fctx.params.map((p) => p.type);
  const info = buildAsyncFrameInfo(ctx, decl, plan, paramNames, paramTypes, promiseTypeIdx);
  info.asyncGen = true;
  info.asyncGenResultTypeIdx = resultTypeIdx;
  // (#2865) Nested producers: thread the lifted fn's capture-cell metadata so
  // the resume body derefs captured reads/writes through the cells.
  info.boxedCaptures = fctx.boxedCaptures;
  info.readsCurrentThis = fctx.readsCurrentThis;
  info.selfCaptureLayout = fctx.selfCaptureLayout;

  const resumeFuncIdx = ensureAsyncResumeFunction(ctx, info, plan);
  if (resumeFuncIdx < 0) {
    reportError(ctx, decl, "internal: async-generator resume function unavailable (#2906 slice 3d-i)");
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return;
  }

  // Per-gen re-entrant next() driver + the generic reader probes (once/module).
  emitAsyncGenNextHelper(ctx, info, promiseTypeIdx);
  ensureAsyncGenReaderProbes(ctx, promiseTypeIdx, resultTypeIdx);

  // (#2865) Register the producer so (a) the `.next()` runtime dispatch chain
  // (calls.ts) can ref.test this frame type → its next helper, and (b) the
  // stem-collision guard in `isAsyncGenDriveCandidate` rejects a SECOND,
  // different gen with the same sanitized name (it would otherwise silently
  // share this helper — typed for THIS frame — and trap on `ref.cast`).
  const stem = sanitizeTypeName(info.functionName);
  if (!ctx.asyncGenProducers) ctx.asyncGenProducers = new Map();
  if (!ctx.asyncGenProducers.has(stem)) {
    ctx.asyncGenProducers.set(stem, {
      stateTypeIdx: info.stateTypeIdx,
      nextHelperName: `__async_gen_next_${stem}`,
      decl,
    });
  }

  // Build the frame WITHOUT kicking (lazy): state=0, sent/mode/abrupt/error inert,
  // params, [no spills — bounded shape], result_promise = fresh pending.
  fctx.body.push({ op: "i32.const", value: 0 }); // state
  fctx.body.push({ op: "ref.null.extern" } as Instr); // sent
  fctx.body.push({ op: "i32.const", value: 0 }); // mode = MODE_NEXT
  fctx.body.push({ op: "ref.null.extern" } as Instr); // abrupt
  fctx.body.push({ op: "ref.null.extern" } as Instr); // error
  for (let i = 0; i < info.paramTypes.length; i++) {
    fctx.body.push({ op: "local.get", index: i });
  }
  for (let i = 0; i < info.spillNames.length; i++) {
    fctx.body.push(defaultSpillInstr(info.spillTypes[i]!));
  }
  // result_promise: fresh pending $Promise (overwritten by the first next()).
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx } as Instr);
  fctx.body.push({ op: "struct.new", typeIdx: info.stateTypeIdx } as Instr);

  // Return the frame as the async-gen object (externref carrier).
  fctx.body.push({ op: "extern.convert_any" } as Instr);
  fctx.body.push({ op: "return" });
  // Keep `rt` referenced (scheduler must be registered before the readers run).
  void rt;
}

/**
 * (#2906 slice 3d-i) Build + export the per-gen re-entrant driver
 * `__async_gen_next_<name>(frame externref) -> Promise externref`: cast the
 * carrier back to the typed frame, mint a fresh pending result promise, store it
 * into `frame.result_promise`, kick the resume machine once, and return the
 * promise. Exported so a direct-drive harness (the 3d-i self-proof) can advance
 * the generator without the for-await consumer (3d-ii).
 */
function emitAsyncGenNextHelper(ctx: CodegenContext, info: AsyncFrameInfo, promiseTypeIdx: number): void {
  const stem = sanitizeTypeName(info.functionName);
  const name = `__async_gen_next_${stem}`;
  if (ctx.funcMap.has(name)) return;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], `${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(name, funcIdx);
  // Re-read the resume funcIdx by name — emitting the resume body may have added
  // late imports that shifted defined indices (the shifter patches funcMap).
  const resumeIdx = ctx.funcMap.get(`__async_resume_f${stem}`) ?? info.resumeFuncIdx!;
  const frameRef: ValType = { kind: "ref", typeIdx: info.stateTypeIdx };
  const promiseRef: ValType = { kind: "ref", typeIdx: promiseTypeIdx };
  const fLocal = 1; // param 0 = carrier externref
  const pLocal = 2;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: info.stateTypeIdx } as Instr,
    { op: "local.set", index: fLocal },
    // fresh pending result promise
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" } as Instr,
    { op: "ref.null.extern" } as Instr,
    { op: "struct.new", typeIdx: promiseTypeIdx } as Instr,
    { op: "local.set", index: pLocal },
    // frame.result_promise = p
    { op: "local.get", index: fLocal },
    { op: "local.get", index: pLocal },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.resultPromiseFieldIdx } as Instr,
    // kick the resume machine
    { op: "local.get", index: fLocal },
    { op: "call", funcIdx: resumeIdx },
    // return p (as externref)
    { op: "local.get", index: pLocal },
    { op: "extern.convert_any" } as Instr,
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [
      { name: "$f", type: frameRef },
      { name: "$p", type: promiseRef },
    ],
    body,
    exported: false,
  });
  ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
}

/**
 * (#2906 slice 3d-i) Register + export the generic async-gen reader probes ONCE
 * per module, letting a host-free direct-drive harness inspect a settled
 * `next()`-promise's IteratorResult:
 *   `__async_gen_p_state(p) -> i32`     — the promise state (0/1/2).
 *   `__async_gen_result_done(p) -> i32` — the settled IteratorResult's `done`.
 *   `__async_gen_result_value(p) -> f64`— the IteratorResult's numeric `value`.
 * Both readers assume the promise is FULFILLED (drive + `__drain_microtasks`
 * first, then check the state).
 */
function ensureAsyncGenReaderProbes(ctx: CodegenContext, promiseTypeIdx: number, resultTypeIdx: number): void {
  if (ctx.funcMap.has("__async_gen_p_state")) return;

  const register = (
    name: string,
    result: ValType,
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): void => {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [result], `${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
    ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
  };

  // promise → state (i32).
  register("__async_gen_p_state", { kind: "i32" }, [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: promiseTypeIdx } as Instr,
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 } as Instr, // state
  ]);

  // promise → (promise.value as IteratorResult).done (i32).
  register("__async_gen_result_done", { kind: "i32" }, [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: promiseTypeIdx } as Instr,
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 } as Instr, // value (IteratorResult, boxed)
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: resultTypeIdx } as Instr,
    { op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: RESULT_DONE_FIELD } as Instr,
  ]);

  // promise → ToNumber((promise.value as IteratorResult).value) (f64). The
  // externref→f64 unbox is routed through the single coercion engine
  // (`coerceType`, #2108) rather than naming `__unbox_number` directly, so this
  // probe adds no hand-rolled coercion vocabulary outside the engine.
  const vfctx: FunctionContext = {
    name: "__async_gen_result_value",
    params: [{ name: "p", type: { kind: "externref" } }],
    locals: [],
    localMap: new Map([["p", 0]]),
    returnType: { kind: "f64" },
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast", typeIdx: promiseTypeIdx } as Instr,
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 } as Instr, // value (IteratorResult)
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast", typeIdx: resultTypeIdx } as Instr,
      { op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD } as Instr, // element (boxed number)
    ],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  const savedFunc = ctx.currentFunc;
  ctx.currentFunc = vfctx;
  try {
    coerceType(ctx, vfctx, { kind: "externref" }, { kind: "f64" });
  } finally {
    ctx.currentFunc = savedFunc;
  }
  register("__async_gen_result_value", { kind: "f64" }, vfctx.body, vfctx.locals);
}
