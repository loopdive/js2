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
import { awaitIsStaticallyResolved } from "../ir/async-static.js"; // (#3723) settled-local flow test
import {
  ASYNC_CPS_ENABLED,
  FORAWAIT_ITER_SPILL,
  type AsyncGenDelegates,
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
  listTopLevelYieldStarCalls,
  listTopLevelRtDelegateYieldStars,
  loopAsyncSpillInfo,
  planAsyncCfg,
  planAsyncGenCfg,
  planLinearAwaits,
  tryCatchAsyncSpillInfo,
} from "./async-cps.js";
import { ensureNativeGeneratorResultType } from "./generators-native.js";
import { canonicalUndefinedExternInstrs, undefinedExternInstrs } from "./any-helpers.js"; // (#3178) canonical undefined for the done-result value
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3 / #2710) stable-regime minting
import { buildNativeAwaitClassification, buildNativeAwaitSuspendArm } from "./prepared-native-async-await.js";
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
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  ERROR_FIELD,
  MODE_FIELD,
  MODE_NEXT,
  MODE_THROW,
  PARAM_FIELD_OFFSET,
  RESULT_DONE_FIELD,
  RESULT_VALUE_FIELD,
  SENT_FIELD,
  STATE_FIELD,
  defaultSpillInstr,
  initializeSpillLocals,
  restoreSpills,
  sanitizeTypeName,
  setStateI32FromConst,
  storeSpills,
} from "./frame-core.js";
import { ensureI32Condition, resolveWasmType } from "./index.js";
import { ensureExnTag } from "./registry/imports.js";
import { addFuncType, getOrRegisterRefCellType, getOrRegisterVecType } from "./registry/types.js";
import { coerceType, compileExpression, compileStatement, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { resolveSpillLocalValType } from "./statements/variables.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";

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
  /** Exact prepared Promise<void> fulfillment provider. */
  undefinedIdx?: number;
}

function asyncUndefinedInstrs(ctx: CodegenContext, info: AsyncFrameInfo): Instr[] {
  if (info.hostImports?.undefinedIdx !== undefined) {
    return [{ op: "call", funcIdx: info.hostImports.undefinedIdx }];
  }
  return info.canonicalUndefinedResult ? canonicalUndefinedExternInstrs(ctx) : [{ op: "ref.null.extern" }];
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
 * **(#2967 slice 1 — engine convergence)** This predicate now claims EVERY
 * linear shape `planLinearAwaits` can drive, including the single-tail-await
 * population the CPS lane (`asyncFnNeedsCps`) used to own exclusively — the
 * #1042 `!asyncFnNeedsCps` disjointness exclusion is dropped. Single-await is
 * the N=1 case of the N-state machine, so one engine drives both.
 *
 * (#2967 slice 2 status) The two slice-1 carve-outs are now migrated:
 * closures were admitted in slice 2a (`planAsyncClosureActivation`, with the
 * #2873 park-fix hazard gate), and binding-pattern params in slice 2b-2 —
 * their prologue-derived locals ride the frame as live-initialized spill
 * fields (see `emitAsyncFrameStateMachine`). The only remaining CPS re-lanes
 * are hazard DECLINES (cell-boxed spills / cell-boxed derived params), not
 * population carve-outs. Pre-#2967 host-drive shapes (multi-await,
 * try/finally-across-await) are unaffected — for them `asyncFnNeedsCps` was
 * already false.
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
  // (#2967 slice 2b-2) Binding-pattern params are DRIVEN: the entry fn's
  // destructuring prologue has already derived the bound locals by the time
  // the activation emits (maybeActivateAsync / the closure body emit both run
  // AFTER the param prologue), so `emitAsyncFrameStateMachine` captures them
  // into the frame as LIVE-INITIALIZED spill fields (initialized from the
  // entry locals at struct.new, restored on every resume, stored back at
  // every suspend — which also preserves the CPS lane's
  // mutation-before-the-await semantics). Rest params never needed a
  // carve-out at all: an identifier rest param IS a raw wasm param (the
  // caller builds the vec — ctx.funcRestParams), captured by name like any
  // other param. (#2967 phase 3a) A derived binding that a nested
  // function-like captures mutably is FORCE-BOXED into a cell-typed frame
  // field (buildAsyncFrameInfo `spillCellInfo`) — no pattern-shape decline
  // remains.
  const linear = planLinearAwaits(fn, plan);
  if (linear === null) {
    // (#3587) try/catch-across-await — the #2906 3c CFG machine (catch regions
    // as states + routed dispatcher) drives this shape on the HOST settle
    // backend too: rejection delivery is backend-agnostic (the reject step
    // adapter stashes ERROR + MODE_THROW, the resume prelude re-throws, the
    // route enters the catch chain). Before this, the shape fell to the legacy
    // synchronous pass-through, which CANNOT deliver an awaited rejection —
    // execution continued straight past the rejected await and the catch never
    // ran (the exact construct signalling "I care about this rejection" was
    // what disabled rejection handling). Same widened spill-safe rule as the
    // native lane.
    const tc = computeTryCatchSpills(ctx, fn, plan);
    if (tc !== null) return tc.spillTypes.every(isSpillSafeType);
    return false;
  }
  // Parity with asyncFnNeedsCps/asyncFnNeedsDrive: a lone `await Promise.all(...)`
  // already yields a real Promise the legacy identity path resolves correctly.
  if (
    linear.finalizer === null &&
    linear.segments.length === 1 &&
    awaitedExprIsPromiseCombinator(linear.segments[0]!.awaitedExpr)
  ) {
    return false;
  }
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
  /**
   * The async function/method declaration this frame belongs to. Prepared IR
   * frames omit it because their CFG and value carriers are already closed.
   */
  decl?: ts.FunctionLikeDeclaration;
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
  /**
   * (#2967 slice 2b-2) Spill index → ENTRY-fn local index for pattern-DERIVED
   * param bindings. Only meaningful inside the activating fctx: at frame
   * struct.new these spill fields are initialized from the listed live locals
   * (post-destructuring-prologue values) instead of `defaultSpillInstr`.
   */
  derivedSpillInit?: Map<number, number>;
  /**
   * (#2967 phase 3a) Spill index → ref-cell metadata for FORCE-BOXED class-1
   * hazardous spills (nested-mutable-captured locals / derived params). The
   * field (and `spillTypes[i]`) is the CELL ref type; `valType` is the boxed
   * value type. Entry creates the cell at struct.new; the resume prologue
   * registers the name in `boxedCaptures` so all reads/writes/inits and the
   * closures.ts capture aliasing flow through the cell.
   */
  spillCellInfo?: Map<number, { refCellTypeIdx: number; valType: ValType }>;
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
  /**
   * Prepared native IR Promise<void> frames settle with the canonical native
   * undefined singleton. Transitional direct native async/generator frames
   * retain their existing null-sentinel behavior until that path is retired.
   */
  canonicalUndefinedResult?: boolean;
  /**
   * Prepared native IR awaits always resume through the microtask ring, even
   * when their operand is already settled. This preserves the mandatory
   * asynchronous turn without widening the transitional direct-native path.
   */
  alwaysAsyncAwait?: boolean;
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
   * (#3389 slice 2a) The `settleDone` state id of this gen's CFG. The
   * `.return()`/`.throw()` driver helpers set `frame.STATE` to it after
   * settling/rejecting, so a subsequent `.next()` re-dispatches into settleDone
   * → `{value: undefined, done: true}` — completing the frame WITHOUT touching
   * the shared resume dispatch. Set in `ensureAsyncResumeFunction`; async-gen only.
   */
  settleDoneStateId?: number;
  /**
   * (#3178) The synthetic COMPLETED pseudo-state id (== `cfg.states.length`,
   * one past the dense real ids). Its dispatch arm fulfils `{value: undefined,
   * done: true}` and RUNS NO LEADS — unlike the real `settleDone` state, which
   * carries any trailing body statements after the last yield as leads, so
   * re-pointing STATE at it re-executes body code (§27.6.3.x forbids: a
   * completed generator runs no further body). The uncaught-throw catch and
   * the `.return()`/`.throw()` drivers complete the frame by pointing STATE
   * here. Set in `ensureAsyncResumeFunction`; async-gen only.
   */
  completedStateId?: number;
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
  derivedParams?: DerivedParamCapture[],
  activatingFctx?: FunctionContext,
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
  // (#2967 slice 2b-2) Pattern-DERIVED param bindings ride the frame as
  // LIVE-INITIALIZED spill fields: excluded from the liveness-computed spill
  // set (whose entries the resume fn expects a segment lead to initialize —
  // a derived binding has no lead statement, and its declared-type GUESS
  // would be an externref default anyway), then appended with their ACTUAL
  // entry-local ValTypes. `derivedSpillInit` maps their spill indices to the
  // entry locals so `emitAsyncFrameStateMachine` initializes the fields with
  // the post-prologue values at struct.new instead of inert defaults. As
  // ordinary (mutable) spill fields they are restored on every resume AND
  // stored back at every suspend, so a mutation before an await survives it —
  // the same observable semantics the CPS continuation snapshot gave them.
  const derived = derivedParams ?? [];
  const { spillNames, spillTypes } = computeAsyncSpills(
    ctx,
    decl,
    plan,
    derived.length === 0 ? paramNames : paramNames.concat(derived.map((d) => d.name)),
    // (#2906 3c-ii) The native backend admits return-in-try; the spill
    // computation must see the SAME plan the gate/producer admitted.
    hostImports === undefined,
  );
  const derivedSpillInit = new Map<number, number>();
  for (const d of derived) {
    derivedSpillInit.set(spillNames.length, d.entryLocalIdx);
    spillNames.push(d.name);
    spillTypes.push(d.type);
  }
  const nestedCaptureTypes =
    decl.body === undefined ? new Map<string, ValType>() : collectCurrentNestedCaptureTypes(ctx, decl.body);
  const nestedRefsAndAssigns =
    decl.body === undefined
      ? {
          referencedInNested: new Set<string>(),
          referencedInNamedNested: new Set<string>(),
          assigned: new Set<string>(),
        }
      : collectNestedRefsAndAssigns(decl.body);
  const bodyBindingsByName = collectVarDeclsByName(decl);
  // The function-body hoist has already chosen concrete local/cell
  // representations before async activation. Prefer that exact contract over
  // checker reconstruction for body destructuring (where minified JS often has
  // an `any` checker type but a scalar local selected from the initializer).
  for (let i = 0; i < spillNames.length; i++) {
    const name = spillNames[i]!;
    const nestedCaptureType = nestedCaptureTypes.get(name);
    if (nestedCaptureType !== undefined || nestedRefsAndAssigns.referencedInNested.has(name)) {
      const local = activatingFctx?.localMap.get(name);
      const liveType =
        activatingFctx === undefined || local === undefined ? undefined : getLocalType(activatingFctx, local);
      if (liveType !== undefined) spillTypes[i] = liveType;
      else if (nestedCaptureType !== undefined) spillTypes[i] = nestedCaptureType;
      continue;
    }
    const boxed = activatingFctx?.boxedCaptures?.get(name);
    if (boxed !== undefined) {
      spillTypes[i] = boxed.valType;
      continue;
    }
    const binding = bodyBindingsByName.get(name);
    if (binding !== undefined && ts.isBindingElement(binding)) {
      const local = activatingFctx?.localMap.get(name);
      const liveType =
        activatingFctx === undefined || local === undefined ? undefined : getLocalType(activatingFctx, local);
      if (liveType !== undefined) spillTypes[i] = liveType;
    }
  }

  // (#2967 phase 3a) Cell-aware fields — FORCE-BOX class-1 hazardous spills.
  // A spill name that a NESTED function-like captures mutably gets cell-boxed
  // by body compile (closures.ts), which used to invalidate the frame layout
  // (the #2873 class-1 decline). Instead of predicting closures.ts's decision,
  // we make it: the frame field is typed `(ref null $__ref_cell_<T>)`, the
  // ENTRY fn creates the cell at struct.new (a live cell for a derived param,
  // a default-valued one for a body local), and the resume prologue binds the
  // NAME to the restored cell + registers it in `boxedCaptures` — so the
  // declaration-init (#1177 boxedForInitStore), reads/writes (identifiers/
  // assignment/unary-updates), and nested-closure creation (the closures.ts
  // `alreadyBoxed` aliasing branch) ALL flow through existing machinery, and
  // `storeSpills` stores the cell ref back into a matching field. Cell
  // IDENTITY survives suspends (the same heap cell is restored), so a nested
  // closure and post-await states observe each other's writes. Read-only
  // captures are boxed only for named declarations whose capture ABI is
  // remapped to the resume frame; anonymous arrows keep their by-value ABI.
  // Body locals require a defaultable value type (the entry cell needs
  // `defaultSpillInstr`);
  // derived params are live-initialized, so any value type boxes. Async
  // GENERATOR frames are untouched (every own local spills there; the yield
  // machine has its own discipline).
  const spillCellInfo = new Map<number, { refCellTypeIdx: number; valType: ValType }>();
  if (decl.asteriskToken === undefined && decl.body !== undefined && spillNames.length > 0) {
    const { referencedInNested, referencedInNamedNested, assigned } = nestedRefsAndAssigns;
    if (referencedInNested.size > 0) {
      const declByName = collectVarDeclsByName(decl);
      const derivedNames = new Set(derived.map((d) => d.name));
      for (let i = 0; i < spillNames.length; i++) {
        const name = spillNames[i]!;
        if (!referencedInNested.has(name)) continue;
        const isDerived = derivedNames.has(name);
        const binding = declByName.get(name);
        if (binding === undefined && !isDerived) continue;
        // Match the closure hoist's actual cell contract. A read-only captured
        // aggregate (for example `var disposed = []` captured by disposer
        // callbacks) remains a by-value ref; wrapping it in a ref-cell here
        // makes the resumed outer body cast the cell as the aggregate. Ordinary
        // named declarations remain the read-only exception because their
        // capture ABI is explicitly remapped through the synthetic frame.
        if (!assigned.has(name) && !isDerived && !referencedInNamedNested.has(name)) continue;
        // A read-only callable copied from an object property is already a
        // stable host/Wasm function value. Boxing it changes `.call` from the
        // host callable path to the ref-cell carrier and can turn an async
        // built-in rejection into a synchronous throw. Keep that narrow shape
        // by-value; the remaining nested references retain the cell carrier
        // required by independently-produced nested/resume layouts.
        const initializer =
          binding !== undefined && ts.isVariableDeclaration(binding) ? binding.initializer : undefined;
        const readOnlyCallableProperty =
          !assigned.has(name) &&
          initializer !== undefined &&
          (ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer)) &&
          binding !== undefined &&
          ctx.oracle.typeFactOf(binding.name).kind === "function";
        if (readOnlyCallableProperty) continue;
        const valType = spillTypes[i]!;
        if (!isDerived && !isSpillSafeType(valType)) continue; // no inert cell default
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, valType);
        spillCellInfo.set(i, { refCellTypeIdx, valType });
        spillTypes[i] = { kind: "ref_null", typeIdx: refCellTypeIdx };
      }
    }
  }

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
    derivedSpillInit: derivedSpillInit.size > 0 ? derivedSpillInit : undefined,
    spillCellInfo: spillCellInfo.size > 0 ? spillCellInfo : undefined,
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
 * (#3132 PR-2) The sanitized per-gen STEM (`__async_gen_next_<stem>` /
 * `$AsyncFrame_<stem>`), derived identically to `emitAsyncGenerator` and the
 * `isAsyncGenDriveCandidate` stem-collision guard. Exported so the
 * `widenAsyncGenFallback` pre-pass can dedup stems the SAME way emit does — two
 * same-named gens collide on one helper (typed for the first frame) and the
 * second falls to legacy, so the pre-pass must count a duplicate stem as
 * non-drivable to stay consistent with emit.
 */
export function asyncGenStem(decl: ts.FunctionLikeDeclaration): string {
  return sanitizeTypeName(asyncFnName(decl));
}

/**
 * The Wasm ValType a resume binding (`const x = await P`) settles to — the
 * coercion target the continuation writes `SENT_FIELD` into, and (when the
 * binding survives a later await) the type of its frame spill field. Resolved
 * consistently in ONE place so the spill field and the resume-function local
 * agree and round-trip through `struct.get`/`struct.set`.
 */
function resumeBindingValType(
  ctx: CodegenContext,
  rb: { name: string; type: ts.TypeNode | undefined; target?: ts.Identifier },
): ValType {
  const typeSite = rb.type ?? rb.target;
  return typeSite ? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(typeSite)) : { kind: "externref" };
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
/**
 * (#3723) Can this `await` actually SUSPEND?
 *
 * `await v` on a non-thenable never yields control to a pending job — §27.7.5.3
 * resumes with `v` unchanged. So an await whose operand type carries no `then`
 * is a pass-through no matter what the syntax looks like.
 *
 * This exists because {@link import("../ir/async-static.js").awaitIsStaticallyResolved}
 * cannot answer it. That helper is deliberately a checker-free LEAF module (it
 * imports only `ts-api`, so the IR front-end can consume it without closing the
 * #3324 import cycle), which means it recognises literals and
 * `Promise.resolve(<static>)` but must answer "unknown" for a bare identifier —
 * "which may hold a pending Promise". For `let n = 8; await (n + 1)` that is
 * needlessly pessimistic: `n` is a `number`.
 *
 * The cost of the pessimism was not a missed optimisation. Under WASI the drive
 * lane returns a real `$Promise` externref, and there is no host microtask queue
 * to drain it, so a numeric consumer coerced the externref to `f64` and read
 * **NaN**. Declining to claim an await that provably cannot suspend puts the
 * function back on the AG0 synchronous path, which returns the value.
 *
 * Conservative by construction — it must never claim "cannot suspend" for
 * something that can:
 *   - `any` / `unknown` may hold a thenable at runtime → assume it can suspend.
 *   - a union is safe only if EVERY constituent is non-thenable.
 *   - anything carrying a `then` member (a real Promise, a custom thenable) →
 *     can suspend.
 *
 * Being wrong in the safe direction just keeps today's behaviour (claim it, run
 * the frame machine); being wrong the other way would silently drop a real
 * suspension.
 */
/** Strip the wrappers that do not change an awaited value's identity. */
function unwrapAwaitOperand(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * (#3723) `await p` where `p` is a local whose ONLY value is a statically
 * settled one — `let p = Promise.resolve(7); … await p`.
 *
 * The syntactic analysis in `async-static.ts` stops at "a bare identifier may
 * hold a pending Promise", which is true in general and wrong here: this binding
 * is written once, from an initializer that helper itself certifies as settled.
 * Under WASI that pessimism is not a lost optimisation — see
 * {@link awaitProvablyCannotSuspend} — it produces NaN.
 *
 * Soundness rests on SYMBOL identity, not on names: the operand's symbol must
 * have exactly one declaration, that declaration must be a variable with an
 * initializer {@link awaitIsStaticallyResolved} accepts, and no assignment
 * anywhere in the enclosing function may target that same symbol. Comparing
 * symbols (rather than text) is what makes shadowing, a same-named parameter,
 * and a same-named binding in a sibling scope all safe — each is a different
 * symbol, so none of them can be mistaken for this one.
 *
 * The assignment scan walks nested functions too, so a closure that mutates the
 * binding disqualifies it. Every uncertain answer is `false`, which just leaves
 * today's behaviour in place.
 */
function awaitedLocalIsProvablySettled(ctx: CodegenContext, awaitExpr: ts.AwaitExpression): boolean {
  const checker = ctx.checker;
  const operand = unwrapAwaitOperand(awaitExpr.expression);
  if (!ts.isIdentifier(operand)) return false;

  const symbol = checker.getSymbolAtLocation(operand);
  if (symbol === undefined) return false;
  const decls = symbol.getDeclarations() ?? [];
  if (decls.length !== 1) return false; // re-declared / ambiguous → not provable
  const decl = decls[0]!;
  if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return false;
  if (decl.initializer === undefined) return false; // `let p;` — value comes from elsewhere
  if (!awaitIsStaticallyResolved(decl.initializer)) return false;

  // The scope to police: the function (or file) the declaration lives in. Any
  // write to this symbol inside it means the value at the await is not provable.
  let scope: ts.Node = decl;
  while (scope.parent !== undefined && !ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) {
    scope = scope.parent;
  }

  let assigned = false;
  const targetsSymbol = (e: ts.Expression): boolean => {
    const bare = unwrapAwaitOperand(e);
    return ts.isIdentifier(bare) && checker.getSymbolAtLocation(bare) === symbol;
  };
  const scan = (node: ts.Node): void => {
    if (assigned) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      targetsSymbol(node.left)
    ) {
      assigned = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      targetsSymbol(node.operand as ts.Expression)
    ) {
      assigned = true;
      return;
    }
    forEachChild(node, scan);
  };
  scan(scope);
  return !assigned;
}

function awaitProvablyCannotSuspend(ctx: CodegenContext, awaitExpr: ts.AwaitExpression): boolean {
  const operandType = ctx.checker.getTypeAtLocation(awaitExpr.expression);
  const parts = operandType.isUnion() ? operandType.types : [operandType];
  for (const part of parts) {
    if ((part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
    if (part.getProperty("then") !== undefined) return false;
  }
  return true;
}

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
  // (#3723) An await is a real suspension only if it is neither statically
  // resolved (syntactic, `async-static.ts`) nor provably non-thenable (typed,
  // `awaitProvablyCannotSuspend`). The second test is what the checker-free leaf
  // module cannot make.
  const anyRealSuspension = plan.awaitPoints.some(
    (a) =>
      plan.awaitedStaticallyResolved.get(a) !== true &&
      !awaitProvablyCannotSuspend(ctx, a) &&
      !awaitedLocalIsProvablySettled(ctx, a),
  );
  if (!anyRealSuspension) return false; // fully await-elidable → sync + resolved promise
  // (#2906 3c-ii) The native gate admits return-in-try (return-through-finally
  // via the return hook's finalizer replay); the host gate does not.
  const linear = planLinearAwaits(fn, plan, { allowReturnInTry: true });
  if (linear === null) {
    // (#2906 slice 3a) `while`-with-await loop shape (native drive lane only).
    // Eligible when every widened loop spill local has a spill-safe type — a
    // non-spill-safe field (e.g. a non-nullable ref with no inert default) would
    // make the frame layout invalid, so those fall back to legacy.
    const loop = computeLoopSpills(ctx, fn, plan);
    if (loop !== null) return loop.spillTypes.every(isSpillSafeType);
    // (#2906 3c) try/catch-around-await shape (native drive lane only) — same
    // widened spill-safe rule as the loop machine.
    const tc = computeTryCatchSpills(ctx, fn, plan);
    if (tc !== null) return tc.spillTypes.every(isSpillSafeType);
    return false;
  }
  // Parity with asyncFnNeedsCps: a lone `await Promise.all(...)`/`.race`/… already
  // yields a real Promise — keep it on the legacy identity path.
  if (
    linear.finalizer === null &&
    linear.segments.length === 1 &&
    awaitedExprIsPromiseCombinator(linear.segments[0]!.awaitedExpr)
  ) {
    return false;
  }
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
    const resolved = declNode ? resolveSpillBindingValType(ctx, declNode) : null;
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
    const resolved = declNode ? resolveSpillBindingValType(ctx, declNode) : null;
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
 * (#2906 3c) The spill layout for the bounded try/catch-around-await shape:
 * EVERY own body local, conservatively (the catch chain can read pre-try
 * locals after any number of suspends, so per-await liveness buys little), a
 * resume-binding name typed via {@link resumeBindingValType} (matching the
 * SENT-coercion target), others via `resolveSpillLocalValType` defaulting to
 * externref — the same widened rule the 3a loop machine uses — PLUS the catch
 * param (externref: the exn-tag payload / rejection reason). Returns `null`
 * when the body is not the bounded shape, or when the catch param SHADOWS an
 * own local / fn param (the shared local slot would alias — bounded slice).
 */
function computeTryCatchSpills(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): { spillNames: string[]; spillTypes: ValType[] } | null {
  const info = tryCatchAsyncSpillInfo(decl, plan);
  if (info === null) return null;
  const declByName = collectVarDeclsByName(decl);
  // `collectVarDeclsByName` also picks up a CATCH clause's own
  // variableDeclaration (it IS a ts.VariableDeclaration) — those entries are
  // the catch params themselves, not shadowing body locals.
  const isCatchClauseDecl = (node: SpillDeclaration): boolean =>
    ts.isVariableDeclaration(node) && node.parent !== undefined && ts.isCatchClause(node.parent);
  const paramNames = new Set<string>();
  for (const p of decl.parameters) if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
  for (const cp of info.catchParamNames) {
    const existing = declByName.get(cp);
    if (existing !== undefined && !isCatchClauseDecl(existing)) return null; // shadows a body local
    if (paramNames.has(cp)) return null; // shadows a fn param
  }
  const rbTypeByName = new Map<string, ValType>();
  for (const seg of info.segments) {
    if (seg.resumeBinding) rbTypeByName.set(seg.resumeBinding.name, resumeBindingValType(ctx, seg.resumeBinding));
  }
  const spillNames: string[] = [];
  const spillTypes: ValType[] = [];
  for (const [name, node] of declByName) {
    if (paramNames.has(name)) continue;
    if (isCatchClauseDecl(node)) continue; // catch-param spills are added below (externref)
    const rbType = rbTypeByName.get(name);
    spillNames.push(name);
    spillTypes.push(rbType ?? resolveSpillBindingValType(ctx, node) ?? { kind: "externref" });
  }
  for (const cp of info.catchParamNames) {
    spillNames.push(cp);
    spillTypes.push({ kind: "externref" });
  }
  for (const { iteratorSpill, indexSpill, source } of info.iteratorSpills) {
    if (!spillNames.includes(iteratorSpill)) {
      const sourceFact = ctx.oracle.typeFactOf(source);
      let iteratorType: ValType = { kind: "externref" };
      if (sourceFact.kind === "array" || sourceFact.kind === "tuple") {
        const elementFacts = sourceFact.kind === "array" ? [sourceFact.element] : sourceFact.elements;
        const numeric = elementFacts.length > 0 && elementFacts.every((fact) => fact.kind === "number");
        const elemType: ValType = numeric ? { kind: "f64" } : { kind: "externref" };
        const vecTypeIdx = getOrRegisterVecType(ctx, numeric ? "f64" : "externref", elemType);
        iteratorType = { kind: "ref_null", typeIdx: vecTypeIdx };
      }
      spillNames.push(iteratorSpill);
      spillTypes.push(iteratorType);
    }
    if (!spillNames.includes(indexSpill)) {
      spillNames.push(indexSpill);
      spillTypes.push({ kind: "i32" });
    }
  }
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
  // (#2906 3c-ii) True on the native backend — mirrors the native gate's
  // `allowReturnInTry` so the spill computation sees the SAME linear plan.
  allowReturnInTry = false,
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
      spillTypes.push(resolveSpillBindingValType(ctx, node) ?? { kind: "externref" });
    }
    // (#2570) One persisted externref slot per `yield* <call>` delegate — the
    // inner frame carrier, created lazily in the delegate INIT state and live
    // across every pump suspend. Numbered in source order, matching the CFG
    // planner's `__yieldstar_iter_<i>` naming exactly (both walk the same
    // top-level statement list).
    const delegateCalls = listTopLevelYieldStarCalls(decl);
    for (let i = 0; i < delegateCalls.length; i++) {
      spillNames.push(`__yieldstar_iter_${i}`);
      spillTypes.push({ kind: "externref" });
    }
    // (#3388) One persisted externref slot per RUNTIME-DELEGATION `yield* <expr>`
    // (non-call, non-array-literal operand) — the GetAsyncIterator result, live
    // across every settleYield suspend of the delegation loop. Numbered in
    // source order matching the CFG planner's `__yieldstar_rtiter_<i>` naming
    // (both walk the same top-level statement list via
    // `listTopLevelRtDelegateYieldStars`).
    const rtDelegates = listTopLevelRtDelegateYieldStars(decl);
    for (let i = 0; i < rtDelegates.length; i++) {
      spillNames.push(`__yieldstar_rtiter_${i}`);
      spillTypes.push({ kind: "externref" });
    }
    return { spillNames, spillTypes };
  }
  const linear = planLinearAwaits(decl, plan, { allowReturnInTry });
  if (linear === null) {
    // (#2906 slice 3a) `while`-with-await loop: widened spill set (all loop
    // own-locals). (#2906 slice 3b) for-await drive: loop own-locals + the
    // synthetic async-iterator carrier local. (#2906 3c) try/catch-around-await:
    // widened own-local set + the catch param. Returns empty for any other body.
    return (
      computeLoopSpills(ctx, decl, plan) ??
      computeForAwaitSpills(ctx, decl, plan) ??
      computeTryCatchSpills(ctx, decl, plan) ?? { spillNames: [], spillTypes: [] }
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
      const resolved = declNode ? resolveSpillBindingValType(ctx, declNode) : null;
      spillNames.push(name);
      spillTypes.push(resolved ?? { kind: "externref" });
    }
  }
  return { spillNames, spillTypes };
}

type SpillDeclaration = ts.VariableDeclaration | ts.BindingElement;

function resolveSpillBindingValType(ctx: CodegenContext, decl: SpillDeclaration): ValType | null {
  if (ts.isVariableDeclaration(decl)) return resolveSpillLocalValType(ctx, decl);
  if (!ts.isIdentifier(decl.name)) return null;
  switch (ctx.oracle.typeFactOf(decl).kind) {
    case "number":
      return { kind: "f64" };
    case "boolean":
      return { kind: "i32" };
    case "bigint":
      return { kind: "i64" };
    default:
      return { kind: "externref" };
  }
}

/** Map each body `var`/`let`/`const` binding name → its declaration node. */
function collectVarDeclsByName(decl: ts.FunctionLikeDeclaration): Map<string, SpillDeclaration> {
  const out = new Map<string, SpillDeclaration>();
  const body = decl.body;
  if (body === undefined) return out;
  const collectBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) return;
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (ts.isIdentifier(element.name)) out.set(element.name.text, element);
      else collectBinding(element.name);
    }
  };
  const walk = (node: ts.Node): void => {
    if (isNestedScope(node)) return;
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) out.set(node.name.text, node);
      else collectBinding(node.name);
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
 * (#2967 slice 2b-2 / 2a park fix shared analysis) Conservative syntactic
 * capture/assignment survey of an async body, mirroring the closures.ts
 * cell-boxing trigger (`writtenInClosure ∪ writtenInOuter`):
 *   - `referencedInNested`: names referenced anywhere inside a nested
 *     function-like (capture candidates);
 *   - `assigned`: names assigned anywhere in the body, incl. inside nested
 *     closures.
 * A name in BOTH sets is cell-boxed at the nested closure's creation site
 * (localMap rebind to a `(ref null $cell)` local) — the class-1 frame-layout
 * hazard for anything the frame spills or re-materializes by declared type.
 */
function collectNestedRefsAndAssigns(body: ts.Node): {
  referencedInNested: Set<string>;
  referencedInNamedNested: Set<string>;
  assigned: Set<string>;
} {
  const referencedInNested = new Set<string>();
  const referencedInNamedNested = new Set<string>();
  const assigned = new Set<string>();

  const noteAssignment = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      assigned.add(node.left.text);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      assigned.add(node.operand.text);
    }
  };

  const collectNestedRefs = (node: ts.Node, refs = referencedInNested): void => {
    noteAssignment(node);
    if (ts.isIdentifier(node)) {
      // Skip pure property-name positions (`a.b`'s `b`, `{ b: 1 }`'s `b`).
      const p = node.parent;
      const isPropName =
        p !== undefined &&
        ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node));
      if (!isPropName) refs.add(node.text);
      return;
    }
    forEachChild(node, (child) => collectNestedRefs(child, refs));
  };

  const walk = (node: ts.Node): void => {
    if (isNestedScope(node)) {
      forEachChild(node, collectNestedRefs);
      // Native/host async generators retain their own by-value capture ABI;
      // only ordinary named declarations are remapped to the outer resume
      // frame's synthetic capture cells.
      if (ts.isFunctionDeclaration(node) && node.asteriskToken === undefined) {
        forEachChild(node, (child) => collectNestedRefs(child, referencedInNamedNested));
      }
      return;
    }
    noteAssignment(node);
    forEachChild(node, walk);
  };
  forEachChild(body, walk);
  return { referencedInNested, referencedInNamedNested, assigned };
}

/**
 * Capture types published by the just-completed nested-declaration hoist for
 * this async body. Async activation runs immediately after that hoist, so the
 * bare-name registry still describes these direct declarations; later package
 * declarations have not had a chance to overwrite it. Prefer the published
 * mutable value type because it is the exact leading-cell ABI their calls use.
 */
function collectCurrentNestedCaptureTypes(ctx: CodegenContext, body: ts.Node): Map<string, ValType> {
  const out = new Map<string, ValType>();
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) {
        for (const capture of ctx.nestedFuncCaptures.get(node.name.text) ?? []) {
          if (capture.mutable && capture.valType !== undefined) out.set(capture.name, capture.valType);
        }
      }
      return;
    }
    if (isNestedScope(node)) return;
    forEachChild(node, walk);
  };
  forEachChild(body, walk);
  return out;
}

/**
 * (#2967 slice 2b-2) Every identifier bound by a binding-PATTERN parameter of
 * `fn` (recursing through nested patterns; includes rest ELEMENTS inside a
 * pattern like `[a, ...rest]`). These are the names the entry fn's
 * destructuring prologue derives into locals — the frame must capture them for
 * the resume fn to see them. Identifier params (incl. an identifier REST
 * param, whose vec the CALLER builds) are raw wasm params and are NOT listed.
 */
function collectPatternParamBindingNames(fn: ts.FunctionLikeDeclaration): string[] {
  const out: string[] = [];
  const walkPattern = (pattern: ts.BindingPattern): void => {
    for (const el of pattern.elements) {
      if (!ts.isBindingElement(el)) continue; // OmittedExpression (array holes)
      if (ts.isIdentifier(el.name)) out.push(el.name.text);
      else walkPattern(el.name);
    }
  };
  for (const p of fn.parameters) {
    if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) walkPattern(p.name);
  }
  return out;
}

/**
 * (#2967 slice 2b-2) Resolve the pattern-derived param bindings of `decl`
 * against the ACTIVATING FunctionContext — must be called AFTER the param
 * destructuring prologue has run (both activation entry points are), so each
 * derived name maps to a live entry local whose ValType is the ACTUAL local
 * rep (no TS-resolved guess → no rep-divergence hazard). Names the prologue
 * did not materialize are skipped (they stay exactly as broken/absent as on
 * the legacy path — never worse).
 */
export interface DerivedParamCapture {
  name: string;
  type: ValType;
  /** Local index in the ACTIVATING (entry) fctx — used only at frame struct.new. */
  entryLocalIdx: number;
}

function collectDerivedPatternParams(decl: ts.FunctionLikeDeclaration, fctx: FunctionContext): DerivedParamCapture[] {
  const out: DerivedParamCapture[] = [];
  for (const name of collectPatternParamBindingNames(decl)) {
    const idx = fctx.localMap.get(name);
    if (idx === undefined) continue;
    const type = idx < fctx.params.length ? fctx.params[idx]!.type : fctx.locals[idx - fctx.params.length]?.type;
    if (type === undefined) continue;
    out.push({ name, type, entryLocalIdx: idx });
  }
  return out;
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
    if (t.kind === "settleReturn" && !inRange(t.resumeState))
      return `settleReturn.resumeState ${t.resumeState} out of range`;
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
    // (#2906 3c-iii) Nested regions are admitted for FINALIZER-FREE regions
    // only: the nesting is encoded statically in the handler tags (an inner
    // catch chunk is tagged with the enclosing region id), so the flat
    // id-dispatch route needs no parent-chain walk. A nested region WITH a
    // finalizer would need innermost-first finalizer-chain replay on one
    // abrupt — not modeled; the producer never emits it, and this gate keeps
    // it that way.
    if (h.parent !== 0) {
      if (h.finalizer.length > 0) {
        return `nested handler region ${h.id} (parent ${h.parent}) with a finalizer not supported`;
      }
      if (h.parent < 1 || h.parent > cfg.handlers.length) return `handler ${h.id} parent ${h.parent} out of range`;
      if (h.parent >= h.id) return `handler ${h.id} parent ${h.parent} must be an earlier region`;
    }
    // (#2906 3c) A routed catch region: the route enters catchState like a goto,
    // so it must exist and carry no resume prelude.
    if (h.catchState !== undefined) {
      if (!inRange(h.catchState)) return `handler ${h.id} catchState ${h.catchState} out of range`;
      if (cfg.states[h.catchState]!.resumeFrom !== null) {
        return `handler ${h.id} catchState ${h.catchState} has a resume prelude (route enters it like a goto)`;
      }
    }
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
function planAsyncResumeCfg(
  ctx: CodegenContext,
  info: AsyncFrameInfo,
  plan: AsyncCpsPlan | null,
  preparedCfg: AsyncCfgPlan | undefined,
): AsyncCfgPlan | null {
  if (preparedCfg) return preparedCfg;
  if (!info.decl) return null;
  if (info.asyncGen) {
    // #2570: keep delegate mode on the same carrier split as admission.
    return planAsyncGenCfg(
      info.decl,
      isStandalonePromiseActive(ctx) ? { oracle: ctx.oracle } : null,
      asyncGenDelegatesForPlan(ctx, info.decl, isStandalonePromiseActive(ctx) ? "carrier" : "awaitFree"),
    );
  }
  if (!plan) return null;
  // #3587: both settlement backends admit try/catch across await; host still
  // refuses return-in-try and loops until its suspension rounds are widened.
  return planAsyncCfg(ctx, info.decl, plan, {
    allowLoops: !info.host,
    allowTryCatch: true,
    allowReturnInTry: !info.host,
  });
}

export function ensureAsyncResumeFunction(
  ctx: CodegenContext,
  info: AsyncFrameInfo,
  plan: AsyncCpsPlan | null,
  preparedCfg?: AsyncCfgPlan,
): number {
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
  const cfg = planAsyncResumeCfg(ctx, info, plan, preparedCfg);
  if (cfg === null) {
    if (!info.decl) {
      throw new Error("internal: prepared async-frame resume has no closed CFG");
    }
    reportError(ctx, info.decl, "internal: async-frame resume built on an unsupported body shape (#2906 slice 1/3a)");
    info.resumeFuncIdx = -1;
    return -1;
  }

  const cfgError = validateAsyncCfg(cfg);
  if (cfgError !== null) {
    if (!info.decl) throw new Error(`internal: prepared async CFG violates the emitter contract — ${cfgError}`);
    reportError(ctx, info.decl, `internal: async CFG plan violates the emitter contract — ${cfgError} (#2906)`);
    info.resumeFuncIdx = -1;
    return -1;
  }

  // (#3389 slice 2a) Record this gen's `settleDone` state id so the
  // `.return()`/`.throw()` drivers can complete the frame by re-pointing STATE
  // there (subsequent `.next()` → `{value: undefined, done: true}`). Exactly one
  // settleDone per gen cfg (the terminal state).
  if (info.asyncGen) {
    const doneState = cfg.states.find((s) => s.terminator.kind === "settleDone");
    if (doneState !== undefined) info.settleDoneStateId = doneState.id;
    // (#3178) Reserve the synthetic COMPLETED pseudo-state id (leads-free
    // `{value: undefined, done: true}` arm appended past the dense real ids by
    // `buildStateArm`'s base case). See the AsyncFrameInfo field doc.
    info.completedStateId = cfg.states.length;
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
    body: [{ op: "unreachable" }],
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
  // Prepared plans restore exact live subsets at state entry. AST plans keep
  // eager hydration; frame-core also preserves force-boxed capture aliases.
  const selectiveSpillRestores = cfg.states.some((state) => state.restoreSpillNames !== undefined);
  initializeSpillLocals(info, resumeFctx, frameLocal, !selectiveSpillRestores, info.spillCellInfo);
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
        resumeFctx.body.push({ op: "ref.cast", typeIdx: layout.castToTypeIdx });
        resumeFctx.body.push({ op: "local.set", index: castLocal });
        selfForCaptures = castLocal;
      }
      for (const entry of layout.entries) {
        const idx = allocLocal(resumeFctx, entry.name, entry.localType);
        resumeFctx.body.push({ op: "local.get", index: selfForCaptures });
        resumeFctx.body.push({ op: "struct.get", typeIdx: layout.structTypeIdx, fieldIdx: entry.fieldIdx });
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
  // (#2967 phase 3a) A FORCE-BOXED spilled binding's slot holds the ref CELL;
  // record the cell metadata so `emitDeliver` writes the settled value THROUGH
  // it (struct.set field 0) instead of clobbering the cell local.
  const cellBySpillName = new Map<string, { refCellTypeIdx: number; valType: ValType }>();
  if (info.spillCellInfo !== undefined) {
    for (const [i, cell] of info.spillCellInfo) cellBySpillName.set(info.spillNames[i]!, cell);
  }
  const bindingLocal = new Map<
    string,
    { local: number; type: ValType; cell?: { refCellTypeIdx: number; valType: ValType } }
  >();
  for (const st of cfg.states) {
    const rb = st.resumeFrom?.binding;
    if (!rb) continue;
    const inferred = resumeBindingValType(ctx, rb);
    const existing = resumeFctx.localMap.get(rb.name);
    const type = existing !== undefined ? (getLocalType(resumeFctx, existing) ?? inferred) : inferred;
    const local = existing !== undefined ? existing : allocLocal(resumeFctx, rb.name, type);
    bindingLocal.set(rb.name, {
      local,
      type,
      cell: existing !== undefined ? cellBySpillName.get(rb.name) : undefined,
    });
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
  // (#2906 3c) ROUTED dispatcher: when any region carries a catchState, the
  // per-call try/catch moves INSIDE the re-dispatch loop
  // (`block { loop { try { chain } catch { route } } }`) so an abrupt
  // completion can become a state transition into the region's catch chain
  // (`br` back to the loop). Every arm's br-to-loop depth shifts by +1 (the
  // try wraps the chain). Plans without a catchState keep the pre-3c
  // `try { block { loop { chain } } } catch` wrap BYTE-IDENTICALLY.
  const routedDispatch = cfg.handlers.some((h) => h.catchState !== undefined);
  // (#3587) HOST-lane `catch_all` reason source, pre-registered BEFORE any
  // state body / finalizer body is built: registering it later would shift
  // defined-function indices already baked into detached instr arrays the
  // shift walker cannot reach (the finalizer bodies ride plain local arrays
  // until final assembly). Import indices are append-stable, so capturing the
  // number here is safe. No-op (pure funcMap lookup) when already registered.
  let hostGetCaughtIdx: number | undefined;
  if (info.host && routedDispatch) {
    hostGetCaughtIdx = ensureLateImport(ctx, "__get_caught_exception", [], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, resumeFctx);
  }

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
      },
      { op: "throw", tagIdx: exnTag },
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
    });
    if (rp.binding) {
      const bl = bindingLocal.get(rp.binding.name)!;
      if (bl.cell !== undefined) {
        // (#2967 phase 3a) Force-boxed binding: `bl.local` holds the ref CELL
        // (a nested closure aliases the same cell) — deliver the settled value
        // THROUGH it so the closure observes it and the cell ref stays intact.
        out.push({ op: "local.get", index: bl.local });
        out.push({ op: "local.get", index: frameLocal });
        out.push({
          op: "struct.get",
          typeIdx: info.stateTypeIdx,
          fieldIdx: SENT_FIELD,
        });
        coerceType(ctx, resumeFctx, { kind: "externref" }, bl.cell.valType);
        out.push({ op: "struct.set", typeIdx: bl.cell.refCellTypeIdx, fieldIdx: 0 });
      } else {
        out.push({ op: "local.get", index: frameLocal });
        out.push({
          op: "struct.get",
          typeIdx: info.stateTypeIdx,
          fieldIdx: SENT_FIELD,
        });
        coerceType(ctx, resumeFctx, { kind: "externref" }, bl.type);
        out.push({ op: "local.set", index: bl.local });
      }
    }
  };

  // One CFG state → one dispatch arm: handler reset, resume prelude, lead, and terminator.
  // Suspend keeps the slice-1/2 emission verbatim (parameterized by
  // `resumeState`); `goto`/`condGoto` are `STATE=<target>; br <re-dispatch
  // loop>` — a target ≤ the current id is a loop back-edge, which is how
  // while-await / for-await planners express iteration with NO emitter change.
  const buildStateBody = (st: AsyncCfgState): Instr[] => {
    const saved = resumeFctx.body;
    const previousAliases = st.lexicalAliases?.map(({ sourceName }) => ({
      sourceName,
      local: resumeFctx.localMap.get(sourceName),
    }));
    for (const { sourceName, targetName } of st.lexicalAliases ?? []) {
      const targetLocal = resumeFctx.localMap.get(targetName);
      if (targetLocal !== undefined) resumeFctx.localMap.set(sourceName, targetLocal);
    }
    ctx.liveBodies.add(saved);
    const out: Instr[] = [];
    resumeFctx.body = out;
    // `br` depth of the re-dispatch loop from this arm's top level: br0 = this
    // arm's own `if`, br1..br(st.id) = the enclosing if-chain arms, br(st.id+1)
    // = if(state==0), br(st.id+2) = the loop. Valid because state ids are dense
    // and equal to their if-chain nesting depth (validateAsyncCfg).
    // (#2906 3c) The routed dispatcher wraps the chain in an in-loop `try`,
    // adding one block level — the single depth-accounting site.
    const loopDepth = st.id + (routedDispatch ? 3 : 2);
    try {
      // Reset the handler region at arm entry, including fast re-dispatch.
      let curHandler = 0;
      if (hasHandlers) out.push(...setHandler(0));
      out.push(...restoreSpills(info, resumeFctx, frameLocal, st.restoreSpillNames ?? []));
      if (st.resumeFrom) emitDeliver(out, st.resumeFrom);
      // (#3228) Destructuring for-await head: bind the settled element carrier
      // into the head's pattern AFTER delivery, BEFORE the leads read the bound
      // names. `undefined` (no hook) for every other plan and identifier heads.
      if (st.postDeliverEmit) st.postDeliverEmit(ctx, resumeFctx);

      // Compile the lead, toggling the region local at each boundary so a throw
      // in an in-region statement (or the terminator's own evaluation) runs the
      // region's finalizer; a throw outside (or in the inline finally itself)
      // does not.
      // (#2906 3c-ii) While a lead is IN a region with a non-empty finalizer,
      // arm the return hook's `pendingFinalizer` so a `return v` in that lead
      // replays the finalizer before settling (return-through-finally).
      for (const { stmt, handler } of st.lead) {
        if (hasHandlers && handler !== curHandler) {
          curHandler = handler;
          out.push(...setHandler(curHandler));
        }
        if (resumeFctx.asyncDriveReturn !== undefined) {
          const fin = handler !== 0 ? cfg.handlers[handler - 1]?.finalizer : undefined;
          resumeFctx.asyncDriveReturn.pendingFinalizer = fin !== undefined && fin.length > 0 ? fin : undefined;
          resumeFctx.asyncDriveReturn.handlerLocal = hasHandlers ? inSrcTryLocal : undefined;
        }
        compileStatement(ctx, resumeFctx, stmt);
      }
      if (resumeFctx.asyncDriveReturn !== undefined) {
        resumeFctx.asyncDriveReturn.pendingFinalizer = undefined;
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
            out.push({ op: "ref.null.extern" });
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
            out.push(...storeSpills(info, resumeFctx, frameLocal, term.spillNames));
            out.push({ op: "local.get", index: pHostLocal });
            out.push({ op: "i32.const", value: info.stepFulfillCbId! });
            out.push({ op: "local.get", index: frameLocal });
            out.push({ op: "extern.convert_any" });
            out.push({ op: "call", funcIdx: hostImports!.makeCbIdx });
            out.push({ op: "i32.const", value: info.stepRejectCbId! });
            out.push({ op: "local.get", index: frameLocal });
            out.push({ op: "extern.convert_any" });
            out.push({ op: "call", funcIdx: hostImports!.makeCbIdx });
            out.push({ op: "call", funcIdx: hostImports!.then2Idx });
            out.push({ op: "drop" });
            out.push({ op: "return" });
            break;
          }

          // Classify the assimilated value; set suspendedLocal + SENT/ERROR/MODE.
          // No `br` inside these nested ifs — the single advance/suspend
          // `br`/`return` is emitted flat below at a known control depth.
          out.push(
            ...buildNativeAwaitClassification({
              alwaysAsync: info.alwaysAsyncAwait === true,
              awaitedLocal,
              promiseLocal: pLocal,
              frameLocal,
              suspendedLocal,
              promiseTypeIdx: info.promiseTypeIdx,
              stateTypeIdx: info.stateTypeIdx,
              sentField: SENT_FIELD,
              errorField: ERROR_FIELD,
              enqueueFuncIdx: rt?.enqueueFuncIdx ?? -1,
              fulfillStepFuncIdx: info.stepFulfillFuncIdx ?? -1,
              rejectStepFuncIdx: info.stepRejectFuncIdx ?? -1,
              markRejectionHandledFuncIdx: rt?.markRejectionHandledFuncIdx ?? -1,
              setThrowMode: setStateI32FromConst(info, frameLocal, MODE_FIELD, MODE_THROW),
            }),
          );

          // Advance-or-suspend. STATE = resumeState for both (suspend → the
          // microtask resume enters it; advance → the re-dispatch enters it).
          out.push(...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.resumeState));
          const suspendArm: Instr[] = [
            ...storeSpills(info, resumeFctx, frameLocal, term.spillNames),
            // promise.callbacks = $PromiseCallback{stepFulfill, frame, stepReject, frame, promise.callbacks}
            { op: "local.get", index: pLocal },
            { op: "ref.func", funcIdx: info.stepFulfillFuncIdx! },
            { op: "local.get", index: frameLocal },
            { op: "extern.convert_any" },
            { op: "ref.func", funcIdx: info.stepRejectFuncIdx! },
            { op: "local.get", index: frameLocal },
            { op: "extern.convert_any" },
            { op: "local.get", index: pLocal },
            {
              op: "struct.get",
              typeIdx: info.promiseTypeIdx,
              fieldIdx: 2,
            },
            { op: "struct.new", typeIdx: rt!.callbackTypeIdx },
            { op: "extern.convert_any" },
            {
              op: "struct.set",
              typeIdx: info.promiseTypeIdx,
              fieldIdx: 2,
            },
            { op: "return" },
          ];
          // Advance: `br` to the dispatch `loop` to re-enter at STATE=resumeState.
          const advanceArm: Instr[] = [{ op: "br", depth: loopDepth }];
          const suspendOrQueuedArm = buildNativeAwaitSuspendArm(
            info.alwaysAsyncAwait === true,
            suspendedLocal,
            suspendArm,
            [...storeSpills(info, resumeFctx, frameLocal, term.spillNames), { op: "return" }],
          );
          out.push({ op: "local.get", index: suspendedLocal });
          out.push({
            op: "if",
            blockType: { kind: "empty" },
            then: suspendOrQueuedArm,
            else: advanceArm,
          });
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
          out.push({ op: "br", depth: loopDepth - 1 });
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
              { op: "br", depth: loopDepth },
            ],
            else: [
              ...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.whenFalse),
              { op: "br", depth: loopDepth },
            ],
          });
          break;
        }
        case "settleSent": {
          // `return await P` — fulfil the result promise with SENT directly.
          // (#2906 3c-ii-b) When this settle state was entered from an IN-REGION
          // await (`return await P` inside a try/finally), replay the region's
          // await-free finalizer BEFORE fulfilling — the delivered value sits
          // stably in SENT (the finalizer cannot await, so nothing overwrites
          // it). Region local resets first: a throw inside the finally rejects
          // WITHOUT re-entering the region (same rule as the inline finally
          // leads and the return hook's replay). Empty finalizers (the 3c
          // catch-only regions) emit nothing — byte-identical.
          const settleRegion = st.resumeFrom !== null && st.resumeFrom.handler !== 0 ? st.resumeFrom.handler : 0;
          const settleFin = settleRegion !== 0 ? cfg.handlers[settleRegion - 1]?.finalizer : undefined;
          if (settleFin !== undefined && settleFin.length > 0) {
            if (hasHandlers) out.push(...setHandler(0));
            for (const f of settleFin) compileStatement(ctx, resumeFctx, f);
          }
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
          out.push(...asyncUndefinedInstrs(ctx, info));
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
            out.push({ op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: SENT_FIELD });
          } else if (term.value === null) {
            out.push({ op: "ref.null.extern" }); // `yield;` → undefined
          } else {
            const vt = isEmitOperand(term.value)
              ? term.value.emit(ctx, resumeFctx)
              : compileExpression(ctx, resumeFctx, term.value);
            if (vt !== null && vt !== undefined) {
              coerceType(ctx, resumeFctx, vt as ValType, { kind: "externref" });
            } else {
              out.push({ op: "ref.null.extern" });
            }
          }
          out.push({ op: "local.set", index: yieldValLocal });
          // result_promise.fulfil( IteratorResult{value: yieldVal, done: 0} )
          out.push({ op: "local.get", index: resultPromiseLocal });
          out.push({ op: "local.get", index: yieldValLocal });
          out.push({ op: "i32.const", value: 0 }); // done = false
          out.push({ op: "struct.new", typeIdx: resultTypeIdx });
          out.push({ op: "extern.convert_any" });
          out.push({ op: "call", funcIdx: settleFulfillIdx });
          out.push({ op: "drop" });
          // Suspend: STATE=resumeState, persist spills, return (await the next kick).
          out.push(...setStateI32FromConst(info, frameLocal, STATE_FIELD, term.resumeState));
          out.push(...storeSpills(info, resumeFctx, frameLocal));
          out.push({ op: "return" });
          break;
        }
        case "settleReturn": {
          // (#3389) `return E` completion — fulfil the current `next()`-promise
          // with `{value: E, done: true}` (§27.6.3.8 with a return completion),
          // set STATE=resumeState (the trailing settleDone), persist spills, and
          // `return`. The next `next()` kick re-dispatches at settleDone →
          // `{value: undefined, done: true}` on the completed frame. Mirrors
          // `settleYield` but with done=1 and no back-edge.
          const resultTypeIdx = info.asyncGenResultTypeIdx!;
          if (term.value === null) {
            out.push({ op: "ref.null.extern" }); // bare `return;` → undefined
          } else {
            const vt = isEmitOperand(term.value)
              ? term.value.emit(ctx, resumeFctx)
              : compileExpression(ctx, resumeFctx, term.value);
            if (vt !== null && vt !== undefined) {
              coerceType(ctx, resumeFctx, vt as ValType, { kind: "externref" });
            } else {
              out.push({ op: "ref.null.extern" });
            }
          }
          out.push({ op: "local.set", index: yieldValLocal });
          // result_promise.fulfil( IteratorResult{value: retVal, done: 1} )
          out.push({ op: "local.get", index: resultPromiseLocal });
          out.push({ op: "local.get", index: yieldValLocal });
          out.push({ op: "i32.const", value: 1 }); // done = true
          out.push({ op: "struct.new", typeIdx: resultTypeIdx });
          out.push({ op: "extern.convert_any" });
          out.push({ op: "call", funcIdx: settleFulfillIdx });
          out.push({ op: "drop" });
          // Complete the frame: STATE=resumeState (settleDone), persist spills, return.
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
          // value = undefined. (#3178) Under the S1 undefined-singleton regime
          // a null externref reads back as JS *null* — `{ value: undefined,
          // done: true }` must carry the canonical undefined singleton or
          // `assert.sameValue(result.value, undefined)` fails on the completed
          // result. Legacy regime keeps the null extern (byte-identical).
          for (const i of undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } satisfies Instr]) out.push(i);
          out.push({ op: "i32.const", value: 1 }); // done = true
          out.push({ op: "struct.new", typeIdx: resultTypeIdx });
          out.push({ op: "extern.convert_any" });
          out.push({ op: "call", funcIdx: settleFulfillIdx });
          out.push({ op: "drop" });
          out.push({ op: "return" });
          break;
        }
      }
    } finally {
      for (const { sourceName, local } of previousAliases ?? []) {
        if (local === undefined) resumeFctx.localMap.delete(sourceName);
        else resumeFctx.localMap.set(sourceName, local);
      }
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
    if (i >= cfg.states.length) {
      // (#3178) Synthetic COMPLETED arm (async gens only): fulfil `{value:
      // undefined, done: true}` and RUN NO LEADS. The real settleDone state
      // carries trailing body statements as leads, so completion (uncaught
      // throw / `.return()` / `.throw()`) must NOT re-dispatch there —
      // §27.6.3.x: a completed generator executes no further body. Terminal
      // arm; anything else is a machine bug (unreachable).
      if (info.asyncGen && info.completedStateId !== undefined) {
        const completedBody = trackDetached([
          { op: "local.get", index: resultPromiseLocal },
          ...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } satisfies Instr]),
          { op: "i32.const", value: 1 }, // done = true
          { op: "struct.new", typeIdx: info.asyncGenResultTypeIdx! },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: settleFulfillIdx },
          { op: "drop" },
          { op: "return" },
        ]);
        return [
          { op: "local.get", index: frameLocal },
          { op: "struct.get", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
          { op: "i32.const", value: info.completedStateId },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: completedBody,
            else: [{ op: "unreachable" }],
          },
        ];
      }
      return [{ op: "unreachable" }];
    }
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
      },
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
        catchFinallyInstrs.push(
          { op: "local.get", index: inSrcTryLocal },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: fbody,
          },
        );
      } else {
        catchFinallyInstrs.push(
          { op: "local.get", index: inSrcTryLocal },
          { op: "i32.const", value: region.id },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: fbody },
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
  //
  // (#2906 3c) The shared reject tail (also the routed dispatcher's default
  // route): replay any region's await-free finalizer, reject the result
  // promise, and (async gens) re-point at the synthetic COMPLETED arm.
  const rejectTail: Instr[] = [
    // (#2906 Gap 3) run the finally before rejecting, if the throw crossed
    // the try region (inline no-op array when the body has no finally).
    ...catchFinallyInstrs,
    { op: "local.get", index: resultPromiseLocal },
    { op: "local.get", index: reasonLocal },
    { op: "call", funcIdx: settleRejectIdx },
    { op: "drop" },
    // (#3178) §27.6.3.5 AsyncGeneratorStart step 4.f–g: an uncaught throw
    // COMPLETES an async generator ([[AsyncGeneratorState]] = "completed")
    // in addition to rejecting the current result promise. Re-point
    // frame.STATE at the synthetic leads-free COMPLETED arm so a
    // subsequent `.next()` fulfills `{value: undefined, done: true}`
    // instead of re-driving the throwing step and rejecting again (the
    // 280-test yield*-GetIterator/next error-semantics cohort surfaced
    // by the F2 async-completion channel, #3417). NOT the settleDone
    // state — that one carries trailing body statements as leads and
    // would re-execute them. Plain async FUNCTIONS are untouched (no
    // re-entry exists; gate keeps their bytes identical).
    ...(info.asyncGen && info.completedStateId !== undefined
      ? setStateI32FromConst(info, frameLocal, STATE_FIELD, info.completedStateId)
      : []),
  ];
  if (routedDispatch) {
    // (#2906 3c) ROUTED dispatcher: `block { loop { try { chain } catch $exn {
    // route } } }`. The route turns an abrupt completion raised while a
    // catch-carrying region is active into a STATE TRANSITION: bind the reason
    // to the catch param (local now, spill for later suspends), consume the
    // throw (MODE=NEXT — the prelude re-throw arm must not re-fire on stale
    // MODE inside the catch chain), point STATE at the region's catch entry,
    // and `br` the loop (depth 2 from inside the route's `if`: if=0, try=1,
    // loop=2). No active region (or a region without a catchState) falls
    // through to the shared reject tail, exactly the pre-3c behavior.
    const routeCore: Instr[] = [];
    for (const region of cfg.handlers) {
      if (region.catchState === undefined) continue;
      const bindInstrs: Instr[] = [];
      if (region.catchParamName !== undefined) {
        const paramLocal = resumeFctx.localMap.get(region.catchParamName);
        if (paramLocal !== undefined) {
          bindInstrs.push({ op: "local.get", index: reasonLocal }, { op: "local.set", index: paramLocal });
        }
        const spillIdx = info.spillNames.indexOf(region.catchParamName);
        if (spillIdx >= 0) {
          bindInstrs.push(
            { op: "local.get", index: frameLocal },
            { op: "local.get", index: reasonLocal },
            { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.spillFieldOffset + spillIdx },
          );
        }
      }
      routeCore.push(
        { op: "local.get", index: inSrcTryLocal },
        { op: "i32.const", value: region.id },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...bindInstrs,
            ...setStateI32FromConst(info, frameLocal, MODE_FIELD, MODE_NEXT),
            ...setStateI32FromConst(info, frameLocal, STATE_FIELD, region.catchState),
            { op: "br", depth: 2 }, // if(0) → try(1) → loop(2): re-dispatch
          ],
        },
      );
    }
    routeCore.push(...rejectTail);
    // `catch $exn`: the thrown reason is on the stack.
    const route: Instr[] = [{ op: "local.set", index: reasonLocal }, ...routeCore];
    // (#3587) HOST lane `catch_all` parity: the legacy try/catch lowering also
    // catches FOREIGN JS exceptions (a host import throwing, e.g. a TypeError
    // from a property op) via `catch_all` + `__get_caught_exception`. Without
    // this arm, claiming a try/catch shape on the host backend would let a
    // synchronous host throw inside the try region ESCAPE the machine (result
    // promise strands pending) where the legacy path caught it. The arm
    // retrieves the recorded exception and runs an identical route —
    // `structuredClone`d, never aliased (one Instr[] must not sit in two
    // branches; DCE/late-import walkers would double-remap it). Native lane
    // (`wasi`/`standalone`) has no JS sidecar — no catch_all, byte-identical.
    let catchAllRoute: Instr[] | undefined;
    if (info.host && hostGetCaughtIdx !== undefined) {
      catchAllRoute = [
        { op: "call", funcIdx: hostGetCaughtIdx },
        { op: "local.set", index: reasonLocal },
        ...(structuredClone(routeCore) as Instr[]),
      ];
    }
    resumeFctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [buildTargetTaggedTry(ctx, { kind: "empty" }, chain, [{ tagIdx: exnTag, body: route }], catchAllRoute)],
        },
      ],
    });
  } else {
    const dispatch: Instr[] = [
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [{ op: "loop", blockType: { kind: "empty" }, body: chain }],
      },
    ];
    resumeFctx.body.push(
      buildTargetTaggedTry(ctx, { kind: "empty" }, dispatch, [
        {
          tagIdx: exnTag,
          body: [{ op: "local.set", index: reasonLocal }, ...rejectTail],
        },
      ]),
    );
  }

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
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: info.stateTypeIdx },
    { op: "local.set", index: frameLocal },
    // SENT_FIELD = value (the settled awaited value the continuation reads).
    { op: "local.get", index: frameLocal },
    { op: "local.get", index: valueLocal },
    {
      op: "struct.set",
      typeIdx: info.stateTypeIdx,
      fieldIdx: SENT_FIELD,
    },
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
      },
      ...setStateI32FromConst(info, frameLocal, MODE_FIELD, 2),
    );
  }
  body.push(
    { op: "local.get", index: frameLocal },
    { op: "call", funcIdx: resumeFuncIdx },
    { op: "ref.null.extern" }, // dropped by the drain
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
      fctx.body.push({ op: "ref.null.extern" });
      return;
    }
    hostImports = resolved;
  }
  if (!host) ensureAsyncDriveRuntime(ctx);
  const promiseTypeIdx = host ? -1 : getOrRegisterPromiseType(ctx);
  const paramNames = fctx.params.map((p) => p.name);
  const paramTypes = fctx.params.map((p) => p.type);
  // (#2967 slice 2b-2) Both activation entry points run AFTER the param
  // destructuring prologue, so every pattern-derived binding is a live entry
  // local here — capture them into the frame as live-initialized spill fields
  // (see buildAsyncFrameInfo). Empty for identifier-only params (byte-inert).
  const derivedParams = collectDerivedPatternParams(decl, fctx);
  const info = buildAsyncFrameInfo(
    ctx,
    decl,
    plan,
    paramNames,
    paramTypes,
    promiseTypeIdx,
    hostImports,
    derivedParams,
    fctx,
  );
  // (#2865) A CLOSURE consumer (arrow / fn-expr, #2957 phase 2) may capture
  // outer locals as ref cells (leading params of the lifted fn). The cells ride
  // into frame param fields like ordinary params; the resume body must deref
  // reads/writes through them, so thread the cell metadata onto the resume fctx.
  info.boxedCaptures = fctx.boxedCaptures;
  info.readsCurrentThis = fctx.readsCurrentThis;
  info.selfCaptureLayout = fctx.selfCaptureLayout;
  emitAsyncFrameEntry(ctx, fctx, info, plan);
}

function emitAsyncFrameEntry(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: AsyncFrameInfo,
  plan: AsyncCpsPlan | null,
  preparedCfg?: AsyncCfgPlan,
): void {
  const host = info.host;
  const hostImports = info.hostImports;
  const promiseTypeIdx = info.promiseTypeIdx;
  const resumeFuncIdx = ensureAsyncResumeFunction(ctx, info, plan, preparedCfg);
  if (resumeFuncIdx < 0) {
    if (!info.decl) throw new Error("internal: prepared async-frame resume function unavailable");
    reportError(ctx, info.decl, "internal: async-frame resume function unavailable (#2895 slice 1)");
    fctx.body.push({ op: "ref.null.extern" });
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
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  }
  fctx.body.push({ op: "local.set", index: resultPromiseLocal });

  // Build the $AsyncFrame: state=0, sent=null, mode=0, abrupt=null, error=null,
  // params (from this fn's wasm params), spills(default), result_promise.
  fctx.body.push({ op: "i32.const", value: 0 }); // state
  fctx.body.push({ op: "ref.null.extern" }); // sent
  fctx.body.push({ op: "i32.const", value: 0 }); // mode = MODE_NEXT
  fctx.body.push({ op: "ref.null.extern" }); // abrupt
  fctx.body.push({ op: "ref.null.extern" }); // error
  for (let i = 0; i < info.paramTypes.length; i++) {
    fctx.body.push({ op: "local.get", index: i });
  }
  for (let i = 0; i < info.spillNames.length; i++) {
    // (#2967 slice 2b-2) A pattern-derived param spill field starts LIVE (the
    // entry prologue's post-destructure value from its entry local); all other
    // spill fields start inert and are initialized by their owning segment's
    // lead statements in the resume fn.
    // (#2967 phase 3a) A force-boxed (class-1 hazardous) spill field holds a
    // REF CELL, created HERE exactly once so its identity survives every
    // suspend/resume round-trip (a live cell for a derived param; a
    // default-valued one for a body local, whose declaration then writes the
    // real init through the cell — variables.ts boxedForInitStore).
    const derivedInitLocal = info.derivedSpillInit?.get(i);
    const cell = info.spillCellInfo?.get(i);
    if (cell !== undefined) {
      if (derivedInitLocal !== undefined) {
        fctx.body.push({ op: "local.get", index: derivedInitLocal });
      } else {
        fctx.body.push(defaultSpillInstr(cell.valType));
      }
      fctx.body.push({ op: "struct.new", typeIdx: cell.refCellTypeIdx });
    } else if (derivedInitLocal !== undefined) {
      fctx.body.push({ op: "local.get", index: derivedInitLocal });
    } else {
      fctx.body.push(defaultSpillInstr(info.spillTypes[i]!));
    }
  }
  fctx.body.push({ op: "local.get", index: resultPromiseLocal });
  fctx.body.push({ op: "struct.new", typeIdx: info.stateTypeIdx });
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
  if (!host) fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "return" });
}

/** Emit a prepared, AST-free async CFG through the existing frame engine. */
export function emitPreparedAsyncFrameStateMachine(
  ctx: CodegenContext,
  fctx: FunctionContext,
  info: AsyncFrameInfo,
  cfg: AsyncCfgPlan,
): void {
  emitAsyncFrameEntry(ctx, fctx, info, null, cfg);
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
/**
 * (#3132 PR-2) The carrier-ON drive-SHAPE of an async generator: no top-level
 * rest param (pattern params OK — PR-1), spill-safe own locals, and a bounded
 * body (`isBoundedAsyncGenBody` — the full shape incl. awaited yields the native
 * `$Promise` carrier assimilates). This is EXACTLY the shape
 * `isAsyncGenDriveCandidate` admits under `isStandalonePromiseActive`, factored
 * out so the pre-pass carrier decision (`widenAsyncGenFallback`, async-scheduler)
 * can predict drivability BEFORE any body compiles — WITHOUT the stem-collision
 * guard (which needs cross-decl `asyncGenProducers` state; the pre-pass caller
 * dedups stems itself) and WITHOUT reading `isStandalonePromiseActive` (which
 * depends on the very fallback being decided — reading it here would be
 * circular). A module whose async gens ALL satisfy this shape (no stem
 * collision, fn decl/expr not method) can safely keep the native carrier ON:
 * every gen drives host-free, so there is NO legacy `__gen_*` buffer for a
 * native `$Promise` to mix into (the #2980 07-09 −4 hazard). CONSERVATIVE — any
 * doubt (rest param, unbounded body, unsafe spill) returns false ⇒ the module
 * keeps the pre-#2980 host Promise pipeline, exactly as before.
 */
export function asyncGenDrivableUnderCarrier(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  allowDelegates = true,
): boolean {
  if (!ASYNC_CPS_ENABLED) return false;
  for (const p of decl.parameters) {
    if (p.dotDotDotToken !== undefined) return false;
  }
  for (const node of asyncGenOwnLocalDecls(decl).values()) {
    if (!isSpillSafeType(resolveSpillBindingValType(ctx, node) ?? { kind: "externref" })) return false;
  }
  // (#2570) `yield* inner()` delegate segments are admitted when the inner
  // producer is a resolvable, earlier-declared, itself-drivable top-level
  // async gen. `allowDelegates=false` is the recursion cut when this predicate
  // judges an INNER producer from a delegate accept() — v1 has no nested
  // delegation, so an inner with its own `yield* call` rejects.
  const delegates = allowDelegates ? asyncGenDelegatesForGate(ctx, decl, "carrier") : null;
  return isBoundedAsyncGenBody(decl, delegates);
}

/**
 * (#2570) Resolve a `yield* <callee>(...)` delegate callee to its inner
 * async-generator FunctionDeclaration — PURELY syntactic (no checker, no
 * emit-order state), so the pre-body `widenAsyncGenFallback` carrier pre-pass
 * and the emit-time gate reach the SAME verdict. v1 bounds (correct-or-legacy
 * beyond them):
 *   - OUTER is a top-level `async function*` declaration (its scope chain is
 *     then exactly own params/locals → module, so the shadowing guard below is
 *     complete without checker resolution);
 *   - callee is a plain identifier naming a UNIQUE top-level `async function*`
 *     declaration with a body — not shadowed by an outer param/local/own-scope
 *     nested function declaration;
 *   - the inner is declared strictly BEFORE the outer (function bodies compile
 *     in source order, so the inner's `__async_gen_next_<stem>` driver is
 *     registered by the time the outer's resume machine emits — the same
 *     order-robustness argument as `resolveAsyncGenNextHelperName`), and is
 *     not the outer itself (no self/mutual recursion).
 */
export function resolveAsyncGenDelegateDecl(
  call: ts.CallExpression,
  outer: ts.FunctionLikeDeclaration,
): ts.FunctionDeclaration | null {
  let callee: ts.Expression = call.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (!ts.isIdentifier(callee)) return null;
  const name = callee.text;
  if (!ts.isFunctionDeclaration(outer) || !ts.isSourceFile(outer.parent)) return null;
  // Shadowing guards: an outer param, own local, or own-scope nested function
  // declaration named like the callee would bind the call away from the
  // top-level producer.
  for (const p of outer.parameters) {
    if (bindingNameBinds(p.name, name)) return null;
  }
  if (asyncGenOwnLocalDecls(outer).has(name)) return null;
  if (outer.body !== undefined && ownScopeHasFunctionDeclNamed(outer.body, name)) return null;
  const sf = outer.parent;
  let found: ts.FunctionDeclaration | null = null;
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name !== undefined && st.name.text === name) {
      if (found !== null) return null; // ambiguous duplicate top-level name
      found = st;
    }
  }
  if (found === null || found === outer) return null;
  if (found.asteriskToken === undefined || found.body === undefined) return null;
  const mods = ts.getModifiers(found);
  if (!mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return null;
  if (found.pos >= outer.pos) return null; // must be declared (⇒ emitted) before the outer
  return found;
}

/** (#2570) Does a param binding name (identifier or pattern) bind `name`? */
function bindingNameBinds(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  for (const el of binding.elements) {
    if (!ts.isBindingElement(el)) continue; // OmittedExpression (array holes)
    if (bindingNameBinds(el.name, name)) return true;
  }
  return false;
}

/** (#2570) Own-scope (not crossing nested fn scopes) `function <name>` decl? */
function ownScopeHasFunctionDeclNamed(body: ts.Node, name: string): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node)) {
      if (node.name !== undefined && node.name.text === name) found = true;
      return; // do not descend — its inner decls are its own scope
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) return;
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return found;
}

/**
 * (#2570) The STATIC delegate-admission mode for one outer async gen. Reads no
 * emit-order state (safe for the pre-body carrier pre-pass — see
 * {@link AsyncGenDelegates}). The carrier lane admits any drivable inner (full
 * bounded shape, awaited yields included); the await-free (carrier-off) lane
 * requires the inner itself await-free + spill-safe + rest-free, mirroring the
 * `isAsyncGenDriveCandidate` await-free arm it feeds.
 */
function asyncGenDelegatesForGate(
  ctx: CodegenContext,
  outer: ts.FunctionLikeDeclaration,
  lane: "carrier" | "awaitFree",
): AsyncGenDelegates {
  return {
    accept: (call: ts.CallExpression): boolean => {
      const inner = resolveAsyncGenDelegateDecl(call, outer);
      if (inner === null) return false;
      if (lane === "carrier") return asyncGenDrivableUnderCarrier(ctx, inner, /*allowDelegates*/ false);
      if (!isAwaitFreeAsyncGenBody(inner, null)) return false;
      for (const p of inner.parameters) {
        if (p.dotDotDotToken !== undefined) return false;
      }
      for (const node of asyncGenOwnLocalDecls(inner).values()) {
        if (!isSpillSafeType(resolveSpillBindingValType(ctx, node) ?? { kind: "externref" })) return false;
      }
      return true;
    },
  };
}

/**
 * (#2570) EMIT-time delegates mode: static admission plus registry-backed
 * helper-name resolution for the planner's pump state. Only valid once the
 * inner producers have emitted (guaranteed by the declared-before-outer bound
 * plus source-order body compilation).
 */
function asyncGenDelegatesForPlan(
  ctx: CodegenContext,
  outer: ts.FunctionLikeDeclaration,
  lane: "carrier" | "awaitFree",
): AsyncGenDelegates {
  const base = asyncGenDelegatesForGate(ctx, outer, lane);
  return {
    accept: base.accept,
    helperNameFor: (call: ts.CallExpression): string | null => {
      const inner = resolveAsyncGenDelegateDecl(call, outer);
      if (inner === null) return null;
      const stem = asyncGenStem(inner);
      const reg = ctx.asyncGenProducers?.get(stem);
      if (reg === undefined || reg.decl !== inner) return null;
      const name = `__async_gen_next_${stem}`;
      return ctx.funcMap.has(name) ? name : null;
    },
  };
}

/**
 * (#2570) Emit-time verification that every syntactic `yield* <call>` delegate
 * of `decl` resolves to an inner producer that ACTUALLY emitted driven (its
 * `__async_gen_next_<stem>` driver registered against the SAME declaration).
 * Vacuously true for a body with no delegate calls, so non-delegating gens are
 * untouched. A mismatch (e.g. a stem collision made the inner fall to legacy)
 * routes the outer to legacy too — correct-or-legacy, and mix-safe: on
 * standalone the pre-pass has already flagged such a module non-drivable
 * (carrier off), and on wasi a legacy fallback is the pre-existing tolerated
 * arrangement.
 */
function asyncGenDelegatesRegistered(ctx: CodegenContext, decl: ts.FunctionLikeDeclaration): boolean {
  for (const call of listTopLevelYieldStarCalls(decl)) {
    const inner = resolveAsyncGenDelegateDecl(call, decl);
    if (inner === null) return false;
    const stem = asyncGenStem(inner);
    const reg = ctx.asyncGenProducers?.get(stem);
    if (reg === undefined || reg.decl !== inner) return false;
    if (!ctx.funcMap.has(`__async_gen_next_${stem}`)) return false;
  }
  return true;
}

export function isAsyncGenDriveCandidate(ctx: CodegenContext, decl: ts.FunctionLikeDeclaration): boolean {
  if (!ASYNC_CPS_ENABLED) return false;
  // (#3132) Binding-PATTERN params (`f([x])`, `f({x})`) ARE now driven: the
  // param destructuring prologue (function-body.ts, runs BEFORE this emit) has
  // already derived their bound locals into the entry fctx, and
  // `emitAsyncGenerator` captures those as LIVE-INITIALIZED derived spill
  // fields (`collectDerivedPatternParams` → `derivedSpillInit`), the exact
  // #2967 slice-2b-2 machinery the async-FUNCTION path uses. The resume fn then
  // restores each derived name from its spill field, so body reads resolve
  // correctly (this closes the #2865 decline: pattern params only mis-resolved
  // because the gen path did not yet thread `derivedParams`). Identifier params
  // WITH defaults are fine (the default is applied before capture). Still
  // legacy (correct-or-legacy): a TOP-LEVEL identifier REST param
  // (`function*(...args)`), whose caller-built vec has no derived-prologue local
  // to capture — a bounded follow-up. Pattern rest ELEMENTS (`[a, ...rest]`) are
  // fine (their `p.dotDotDotToken` is undefined — the `...` is on the element,
  // which the destructuring prologue derives like any other binding).
  for (const p of decl.parameters) {
    if (p.dotDotDotToken !== undefined) return false;
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
      if (!isSpillSafeType(resolveSpillBindingValType(ctx, node) ?? { kind: "externref" })) return false;
    }
    return true;
  };
  // Under the native-`$Promise` CARRIER (`isStandalonePromiseActive`): the full
  // bounded shape, awaited yields included — the awaited operand lowers to a
  // native `$Promise` the suspend arm can assimilate. Identical to
  // `asyncGenDrivableUnderCarrier` (the pre-pass predicate) plus the
  // stem-collision guard already applied above — the shared helper keeps the
  // emit gate and the `widenAsyncGenFallback` pre-pass provably consistent, so a
  // module the pre-pass judged all-driven never falls a gen to the legacy buffer
  // here (which would re-introduce the native-`$Promise`-into-host-buffer mix).
  // (#2570) Both arms additionally require every `yield* <call>` delegate's
  // inner producer to have ACTUALLY emitted driven (registry-verified) —
  // vacuous for non-delegating bodies.
  if (isStandalonePromiseActive(ctx)) {
    return asyncGenDrivableUnderCarrier(ctx, decl) && asyncGenDelegatesRegistered(ctx, decl);
  }
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
  if (isAsyncDriveActive(ctx)) {
    return (
      isAwaitFreeAsyncGenBody(decl, asyncGenDelegatesForGate(ctx, decl, "awaitFree")) &&
      spillsSafe() &&
      asyncGenDelegatesRegistered(ctx, decl)
    );
  }
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
  // (#3132) A binding-PATTERN param's bound names are derived by the entry
  // fn's destructuring prologue (function-body.ts, already run) — capture them
  // as LIVE-INITIALIZED derived spill fields so the resume fn sees them, the
  // same #2967 mechanism the async-FUNCTION path uses. Empty (byte-inert) for
  // identifier-only params, so no existing driven async-gen shape changes.
  const derivedParams = collectDerivedPatternParams(decl, fctx);
  const info = buildAsyncFrameInfo(
    ctx,
    decl,
    plan,
    paramNames,
    paramTypes,
    promiseTypeIdx,
    undefined,
    derivedParams,
    fctx,
  );
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
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }

  // Per-gen re-entrant next() driver + the generic reader probes (once/module).
  emitAsyncGenNextHelper(ctx, info, promiseTypeIdx);
  // (#3389 slice 2a) Per-gen `.return(v)` / `.throw(e)` drivers.
  emitAsyncGenReturnThrowHelpers(ctx, info, promiseTypeIdx);
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
      returnHelperName: `__async_gen_return_${stem}`,
      throwHelperName: `__async_gen_throw_${stem}`,
      decl,
    });
  }

  // Build the frame WITHOUT kicking (lazy): state=0, sent/mode/abrupt/error inert,
  // params, [no spills — bounded shape], result_promise = fresh pending.
  fctx.body.push({ op: "i32.const", value: 0 }); // state
  fctx.body.push({ op: "ref.null.extern" }); // sent
  fctx.body.push({ op: "i32.const", value: 0 }); // mode = MODE_NEXT
  fctx.body.push({ op: "ref.null.extern" }); // abrupt
  fctx.body.push({ op: "ref.null.extern" }); // error
  for (let i = 0; i < info.paramTypes.length; i++) {
    fctx.body.push({ op: "local.get", index: i });
  }
  for (let i = 0; i < info.spillNames.length; i++) {
    // (#3132) A pattern-DERIVED param spill field starts LIVE from its entry
    // local (the post-destructure value); every other spill field starts inert
    // and is initialized by its owning segment's lead in the resume fn. Mirrors
    // the async-FUNCTION struct.new (emitAsyncFrameStateMachine). `spillCellInfo`
    // is empty for generators (buildAsyncFrameInfo gates force-boxing on
    // `decl.asteriskToken === undefined`), so the cell arm is inert here — kept
    // for parity/robustness.
    const derivedInitLocal = info.derivedSpillInit?.get(i);
    const cell = info.spillCellInfo?.get(i);
    if (cell !== undefined) {
      if (derivedInitLocal !== undefined) {
        fctx.body.push({ op: "local.get", index: derivedInitLocal });
      } else {
        fctx.body.push(defaultSpillInstr(cell.valType));
      }
      fctx.body.push({ op: "struct.new", typeIdx: cell.refCellTypeIdx });
    } else if (derivedInitLocal !== undefined) {
      fctx.body.push({ op: "local.get", index: derivedInitLocal });
    } else {
      fctx.body.push(defaultSpillInstr(info.spillTypes[i]!));
    }
  }
  // result_promise: fresh pending $Promise (overwritten by the first next()).
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "struct.new", typeIdx: info.stateTypeIdx });

  // Return the frame as the async-gen object (externref carrier).
  fctx.body.push({ op: "extern.convert_any" });
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
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: info.stateTypeIdx },
    { op: "local.set", index: fLocal },
    // fresh pending result promise
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: promiseTypeIdx },
    { op: "local.set", index: pLocal },
    // frame.result_promise = p
    { op: "local.get", index: fLocal },
    { op: "local.get", index: pLocal },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.resultPromiseFieldIdx },
    // kick the resume machine
    { op: "local.get", index: fLocal },
    { op: "call", funcIdx: resumeIdx },
    // return p (as externref)
    { op: "local.get", index: pLocal },
    { op: "extern.convert_any" },
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
 * (#3389 slice 2a) Build + export the per-gen `.return(v)` / `.throw(e)` drivers
 * `__async_gen_return_<stem>(frame, arg) -> Promise` /
 * `__async_gen_throw_<stem>(frame, arg) -> Promise`.
 *
 * For every body the DRIVEN lane admits, try/finally + catch ACROSS a yield stay
 * legacy (2b), so a suspended-at-yield `.return`/`.throw` runs NO further body —
 * it just COMPLETES the frame. So the drivers do not kick the resume machine:
 *   `.return(v)`: mint a fresh pending result promise, store it, fulfil it with
 *     `{value: v, done: true}` (§27.6.3.8 return completion), and complete the
 *     frame by re-pointing `frame.STATE` at its `settleDone` state (a subsequent
 *     `.next()` then re-dispatches there → `{value: undefined, done: true}`).
 *   `.throw(e)`: mint + store the promise, REJECT it with `e` (§27.6.3.9), and
 *     complete the frame the same way.
 * A completed frame's `.return`/`.throw` takes the identical path (STATE is
 * already at settleDone; settling/rejecting a fresh promise is correct). No
 * change to the shared resume dispatch — zero regression surface on it.
 */
function emitAsyncGenReturnThrowHelpers(ctx: CodegenContext, info: AsyncFrameInfo, promiseTypeIdx: number): void {
  const stem = sanitizeTypeName(info.functionName);
  const rt = ensureAsyncDriveRuntime(ctx);
  const resultTypeIdx = ensureNativeGeneratorResultType(ctx, { kind: "externref" });
  const frameRef: ValType = { kind: "ref", typeIdx: info.stateTypeIdx };
  const promiseRef: ValType = { kind: "ref", typeIdx: promiseTypeIdx };
  // (#3178) Prefer the synthetic leads-free COMPLETED arm: the real settleDone
  // state carries trailing body statements (after the last yield) as leads, so
  // completing the frame by re-pointing STATE there made a subsequent `.next()`
  // re-execute body code — §27.6.3.8/.9 require a completed generator to run
  // no further body. settleDoneStateId kept as fallback for safety.
  const doneStateId = info.completedStateId ?? info.settleDoneStateId ?? 0;

  // Shared prologue: cast the carrier, mint a fresh pending result promise, store
  // it into `frame.result_promise`. Leaves the frame ref in $f (local 2) and the
  // promise ref in $p (local 3). Params: 0 = frame externref, 1 = arg externref.
  const prologue = (fLocal: number, pLocal: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: info.stateTypeIdx },
    { op: "local.set", index: fLocal },
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: promiseTypeIdx },
    { op: "local.set", index: pLocal },
    { op: "local.get", index: fLocal },
    { op: "local.get", index: pLocal },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: info.resultPromiseFieldIdx },
  ];
  // Shared epilogue: complete the frame (STATE = settleDone) and return $p.
  const epilogue = (fLocal: number, pLocal: number): Instr[] => [
    { op: "local.get", index: fLocal },
    { op: "i32.const", value: doneStateId },
    { op: "struct.set", typeIdx: info.stateTypeIdx, fieldIdx: STATE_FIELD },
    { op: "local.get", index: pLocal },
    { op: "extern.convert_any" },
  ];

  const register = (name: string, settleIdx: number, buildValue: (fLocal: number, pLocal: number) => Instr[]): void => {
    if (ctx.funcMap.has(name)) return;
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      `${name}_type`,
    );
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    const fLocal = 2;
    const pLocal = 3;
    const body: Instr[] = [
      ...prologue(fLocal, pLocal),
      // settle: settleIdx(p, <value>) → drop
      { op: "local.get", index: pLocal },
      ...buildValue(fLocal, pLocal),
      { op: "call", funcIdx: settleIdx },
      { op: "drop" },
      ...epilogue(fLocal, pLocal),
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
  };

  // `.return(v)` → fulfil with IteratorResult {value: arg, done: true}.
  register(`__async_gen_return_${stem}`, rt.fulfillFuncIdx, () => [
    { op: "local.get", index: 1 }, // arg (value)
    { op: "i32.const", value: 1 }, // done = true
    { op: "struct.new", typeIdx: resultTypeIdx },
    { op: "extern.convert_any" },
  ]);
  // `.throw(e)` → reject with the raw reason `arg`.
  register(`__async_gen_throw_${stem}`, rt.rejectFuncIdx, () => [{ op: "local.get", index: 1 }]);
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
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: promiseTypeIdx },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 }, // state
  ]);

  // promise → (promise.value as IteratorResult).done (i32).
  register("__async_gen_result_done", { kind: "i32" }, [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: promiseTypeIdx },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 }, // value (IteratorResult, boxed)
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: resultTypeIdx },
    { op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: RESULT_DONE_FIELD },
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
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: promiseTypeIdx },
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 }, // value (IteratorResult)
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: resultTypeIdx },
      { op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD }, // element (boxed number)
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
