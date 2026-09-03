// (#2867 Gap 4) Native, host-free `Promise.all` / `Promise.race` combinators.
//
// Under the native-`$Promise` carrier (`isStandalonePromiseActive` — `--target
// wasi` AND `--target standalone`; see the widen note at the bottom of this
// header), `Promise.all([...])` / `Promise.race([...])` must NOT leak the `Promise_all` /
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
// (#3137) The `allSettled` / `any` combinators lower natively on the same
// machinery: per-element status objects (`$Object` via the object runtime) and
// a native `AggregateError` (`$Error_struct`, `.errors` on `$props`), lazily
// registered ONLY when a module compiles one (ensureSettledAnyCombinators) so
// all/race-only modules stay byte-identical. (#2867 string-combinator slice)
// String arguments drain through `__combinator_to_vec`'s code-point string arm
// under native strings. f64-backed `number[]` vecs (the Gap-4
// output-representation escalation) and generator-state arguments still fall
// through to the existing host path (follow-ups).
//
// **THE WIDEN HAS LANDED — this module is LIVE on `--target standalone`.**
// (#2867 S2 correction, 2026-08-15.) This header said "inert until the widen …
// `ctx.wasi`-only today" for a long time after it stopped being true: slice 1d
// landed with the **#2980 flip on 2026-07-10**, and `isStandalonePromiseActive`
// has read `ctx.standalone === true && !widenAsyncGenFallback(ctx)` ever since
// (`async-scheduler.ts:4686`; `isStandaloneThenChainNativeActive` at `:4743` is
// identical). Only the default **gc/host** lane is still byte-identical.
//
// The stale claim was load-bearing in the wrong direction: it was re-copied into
// the #2867 plan as a "50 CE `env::Promise_all`/`Promise_race` leak, gate not
// widened" work item that **does not exist**. Measured 2026-08-15 on all 729
// `built-ins/Promise` files at `--target standalone`: **zero** results whose
// error mentions emitted host imports, and a direct compile probe of eight
// combinator shapes (array literal, array var, `race`, `resolve`,
// `new Promise`, ctor-input, `all([])`, `any`-typed arg) returns `imports=[]`.
// The last host-route — a **string** argument (`Promise.all('')` →
// `Native-first adapter cannot bind env::Promise_all`) — closed with the
// (#2867 string-combinator slice): `__combinator_to_vec` now has a native
// code-point string arm (see `buildToVecStringArm`).

import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, LocalDef, ValType } from "../ir/types.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterErrorStructType,
  getOrRegisterVecType,
} from "./registry/types.js";
import { allocLocal } from "./context/locals.js";
import { definedFuncAt, mintDefinedFunc, nativeStrHelperHandle, pushDefinedFunc } from "./func-space.js"; // (#1916 S2/S3) positional-read chokepoint + stable mint/push
import {
  CLOSURE_CAPTURE_FIELD_BASE,
  closureArityField,
  closureBagField,
  closureBagInitInstr,
  getClosureFuncSelfTypeIdx,
  getFuncRefWrapperRootTypeIdx,
  getOrCreateFuncRefWrapperTypes,
} from "./closures/funcref-wrapper-types.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { ensureExnTag } from "./registry/imports.js";
import { emitGuardedFuncRefCast } from "./type-coercion.js";
import { emitNullCheckThrow } from "./property-access.js";
// (#3137) allSettled/any additions: status objects live on the object runtime
// ($Object via __new_plain_object/__extern_set), the AggregateError is a native
// $Error_struct (tag from builtin-tags), and the "status"/"fulfilled"/… keys are
// interned native-string constants. All lazily pulled ONLY when a module
// actually compiles a native allSettled/any (see ensureSettledAnyCombinators) so
// all/race-only modules stay byte-identical.
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { ensureNativeStringHelpers, stringConstantExternrefInstrs } from "./native-strings.js";
import { BUILTIN_TYPE_TAGS } from "./builtin-tags.js";
import {
  ensureAsyncDriveRuntime,
  getOrRegisterPromiseType,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_PENDING,
  PROMISE_STATE_REJECTED,
  isStandalonePromiseActive,
} from "./async-scheduler.js";

const EXTERNREF: ValType = { kind: "externref" };

type AsyncDriveRuntimeT = ReturnType<typeof ensureAsyncDriveRuntime>;

/** The combinators this module lowers natively (#2867 Gap 4 `all`/`race`; #3137 `allSettled`/`any`). */
export type NativeCombinator = "all" | "race" | "allSettled" | "any";

export function isNativeCombinatorMethod(method: string): method is NativeCombinator {
  return method === "all" || method === "race" || method === "allSettled" || method === "any";
}

/**
 * (#4682) The small NewPromiseCapability substrate used by the bounded
 * custom-constructor arm.  This is deliberately separate from the aggregate
 * state below: the first slice only admits an empty array, where the only
 * observable combinator work is constructing C and validating the executor's
 * captured resolve/reject pair.
 */
interface CustomCapabilityRuntime {
  stateTypeIdx: number;
  executorTypeIdx: number;
  executorFuncIdx: number;
}

type CtxWithCustomCapability = CodegenContext & { __promiseCustomCapability?: CustomCapabilityRuntime };

function customCapabilityTypeError(ctx: CodegenContext): Instr[] {
  // NewPromiseCapability's executor protocol throws a TypeError before the
  // combinator touches an empty iterable when either captured slot is not
  // callable.  Reuse the in-module standalone Error constructor and native
  // exception tag so this arm never introduces an env import.
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const ctorIdx = ctx.funcMap.get("__new_TypeError");
  if (ctorIdx === undefined) return [{ op: "unreachable" }];
  return [{ op: "ref.null.extern" }, { op: "call", funcIdx: ctorIdx }, { op: "throw", tagIdx: ensureExnTag(ctx) }];
}

/** Register the two-argument capability executor and its mutable slots once. */
function ensureCustomCapabilityRuntime(ctx: CodegenContext): CustomCapabilityRuntime | null {
  const cached = (ctx as CtxWithCustomCapability).__promiseCustomCapability;
  if (cached) return cached;

  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF, EXTERNREF], []);
  if (!wrapper) return null;

  // The capability record stores the two values supplied by C's constructor.
  // `undefined` is represented by a null externref on this native path. The
  // selected Test262 cohort intentionally uses undefined for the first call;
  // a later slice can add a presence bit for explicit null.
  const stateTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__promise_custom_capability",
    fields: [
      { name: "$resolve", type: EXTERNREF, mutable: true },
      { name: "$reject", type: EXTERNREF, mutable: true },
    ],
  });
  ctx.structMap.set("$__promise_custom_capability", stateTypeIdx);
  ctx.typeIdxToStructName.set(stateTypeIdx, "$__promise_custom_capability");
  ctx.structFields.set("$__promise_custom_capability", [
    { name: "$resolve", type: EXTERNREF, mutable: true },
    { name: "$reject", type: EXTERNREF, mutable: true },
  ]);

  // This subtype is a normal `(externref, externref) -> void` closure with one
  // capture: the mutable capability record. Its inherited header makes it
  // callable by the ordinary `executor(...)` lowering in a compiled C body.
  const executorTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__promise_custom_capability_executor",
    fields: [
      { name: "func", type: { kind: "funcref" }, mutable: false },
      closureArityField(),
      closureBagField(),
      { name: "$capability", type: { kind: "ref", typeIdx: stateTypeIdx }, mutable: false },
    ],
    superTypeIdx: wrapper.structTypeIdx,
  });
  ctx.structMap.set("$__promise_custom_capability_executor", executorTypeIdx);
  ctx.typeIdxToStructName.set(executorTypeIdx, "$__promise_custom_capability_executor");
  ctx.structFields.set("$__promise_custom_capability_executor", [
    { name: "func", type: { kind: "funcref" }, mutable: false },
    closureArityField(),
    closureBagField(),
    { name: "$capability", type: { kind: "ref", typeIdx: stateTypeIdx }, mutable: false },
  ]);

  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const typeErrorIdx = ctx.funcMap.get("__new_TypeError");
  const exnTag = ensureExnTag(ctx);
  const executorFuncIdx = mintDefinedFunc(ctx);
  const stateLocal = 3;
  // "this slot already holds a stored value" — i.e. it is neither null nor
  // undefined. Leaves the incoming externref consumed and an i32 on the stack.
  const nullishIdx = ctx.funcMap.get("__extern_is_nullish");
  const slotIsStoredTail: Instr[] =
    nullishIdx === undefined
      ? [{ op: "ref.is_null" }, { op: "i32.eqz" }]
      : [{ op: "call", funcIdx: nullishIdx }, { op: "i32.eqz" }];
  const body: Instr[] = [
    // state = self.$capability
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: executorTypeIdx },
    { op: "struct.get", typeIdx: executorTypeIdx, fieldIdx: CLOSURE_CAPTURE_FIELD_BASE },
    { op: "local.set", index: stateLocal },
    // A second call is only an error once a non-undefined slot was stored.
    // (#5197 R3-1) `undefined` is NOT `ref.null.extern` under the #2864
    // singleton regime: `executor(undefined, undefined)` and the zero-argument
    // `executor()` (padded by `__apply_closure`) store the canonical
    // `$AnyValue` undefined singleton, a NON-null externref. Guarding with a
    // bare `ref.is_null` therefore treated that spec-legal state as "already
    // stored" and made the following `executor(f, g)` throw. Consult the
    // object runtime's own nullish predicate when it is registered; when it is
    // not (legacy regime, where undefined IS the null bit pattern) keep the
    // original `ref.is_null` body byte-for-byte.
    { op: "local.get", index: stateLocal },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 0 },
    ...slotIsStoredTail,
    { op: "local.get", index: stateLocal },
    { op: "struct.get", typeIdx: stateTypeIdx, fieldIdx: 1 },
    ...slotIsStoredTail,
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then:
        typeErrorIdx === undefined
          ? [{ op: "unreachable" }]
          : [{ op: "ref.null.extern" }, { op: "call", funcIdx: typeErrorIdx }, { op: "throw", tagIdx: exnTag }],
    },
    // Capture resolve and reject even when either is undefined. This mirrors
    // GetCapabilitiesExecutor's sentinel semantics for the selected cohort.
    { op: "local.get", index: stateLocal },
    { op: "local.get", index: 1 },
    { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: stateLocal },
    { op: "local.get", index: 2 },
    { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: 1 },
  ];
  const funcTypeIdx = wrapper.liftedFuncTypeIdx;
  pushDefinedFunc(ctx, executorFuncIdx, {
    name: "__promise_custom_capability_executor",
    typeIdx: funcTypeIdx,
    locals: [{ name: "$capability", type: { kind: "ref", typeIdx: stateTypeIdx } }],
    body,
    exported: false,
  });
  ctx.funcMap.set("__promise_custom_capability_executor", executorFuncIdx);

  const result: CustomCapabilityRuntime = {
    stateTypeIdx,
    executorTypeIdx,
    executorFuncIdx,
  };
  (ctx as CtxWithCustomCapability).__promiseCustomCapability = result;
  return result;
}

/**
 * (#4682) Invoke an ordinary compiled constructor with a native capability
 * executor and validate the captured slots. This is intentionally limited to
 * an empty iterable; callers use the established native combinator emitter for
 * the resulting aggregate once this protocol completes.
 */
export function emitStandalonePromiseCustomCapabilityCheck(
  ctx: CodegenContext,
  fctx: FunctionContext,
  constructorLocal: number,
  constructorInfo: ClosureInfo,
  constructorSelfTypeIdx: number,
): boolean {
  if (!isStandalonePromiseActive(ctx)) return false;
  if (
    constructorInfo.returnType !== null &&
    constructorInfo.returnType.kind !== "externref" &&
    constructorInfo.returnType.kind !== "ref" &&
    constructorInfo.returnType.kind !== "ref_null"
  ) {
    return false;
  }
  const runtime = ensureCustomCapabilityRuntime(ctx);
  const wrapperRoot = getFuncRefWrapperRootTypeIdx(ctx);
  if (!runtime || wrapperRoot === undefined) return false;

  const stateLocal = allocLocal(fctx, `__promise_capability_state_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: runtime.stateTypeIdx,
  });
  fctx.body.push(
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: runtime.stateTypeIdx },
    { op: "local.set", index: stateLocal },
  );
  const executorLocal = allocLocal(fctx, `__promise_capability_executor_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: runtime.executorTypeIdx,
  });
  fctx.body.push(
    { op: "ref.func", funcIdx: runtime.executorFuncIdx },
    { op: "i32.const", value: 2 },
    closureBagInitInstr(),
    { op: "local.get", index: stateLocal },
    { op: "struct.new", typeIdx: runtime.executorTypeIdx },
    { op: "local.set", index: executorLocal },
  );

  // C's lifted closure ABI always carries its self struct first. The
  // capability executor itself is passed as the first user parameter; any
  // extra formals get their ordinary default values.
  fctx.body.push({ op: "local.get", index: constructorLocal });
  for (let i = 0; i < constructorInfo.paramTypes.length; i++) {
    const p = constructorInfo.paramTypes[i]!;
    if (i === 0) {
      fctx.body.push({ op: "local.get", index: executorLocal }, { op: "extern.convert_any" });
    } else {
      // This arm is admitted only for the one-parameter constructors in the
      // Test262 capability cohort. Keep a defensive default for malformed
      // declarations instead of emitting an invalid stack shape.
      if (p.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
      else if (p.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
      else if (p.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
      else fctx.body.push({ op: "ref.null", typeIdx: (p as { typeIdx: number }).typeIdx });
    }
  }
  const constructorSelf = getClosureFuncSelfTypeIdx(ctx, constructorInfo.funcTypeIdx) ?? constructorSelfTypeIdx;
  fctx.body.push(
    { op: "local.get", index: constructorLocal },
    { op: "struct.get", typeIdx: constructorSelf, fieldIdx: 0 },
  );
  emitGuardedFuncRefCast(fctx, constructorInfo.funcTypeIdx);
  emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: constructorInfo.funcTypeIdx });
  fctx.body.push({ op: "call_ref", typeIdx: constructorInfo.funcTypeIdx });
  if (constructorInfo.returnType !== null) fctx.body.push({ op: "drop" });

  // NewPromiseCapability validates both captured values after C returns.
  const resolveCallable = [
    { op: "local.get", index: stateLocal } as Instr,
    { op: "struct.get", typeIdx: runtime.stateTypeIdx, fieldIdx: 0 } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.test", typeIdx: wrapperRoot } as Instr,
  ];
  const rejectCallable = [
    { op: "local.get", index: stateLocal } as Instr,
    { op: "struct.get", typeIdx: runtime.stateTypeIdx, fieldIdx: 1 } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.test", typeIdx: wrapperRoot } as Instr,
  ];
  fctx.body.push(...resolveCallable, ...rejectCallable, { op: "i32.and" });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: [], else: customCapabilityTypeError(ctx) });
  return true;
}

/**
 * (#4727) Invoke C with a native capability, then call one of its settle slots.
 *
 * (#5197 Slice D) `settle` selects which slot the value is handed to, because
 * §27.2.4.7 `Promise.resolve` and §27.2.4.6 `Promise.reject` differ ONLY in
 * that step — both are `NewPromiseCapability(C)` followed by
 * `Call(capability.[[Resolve|Reject]], undefined, «x»)`. The capability record's
 * field 0 is `[[Resolve]]` and field 1 is `[[Reject]]`, so the slot index is the
 * whole difference and no second protocol is needed.
 */
export function emitStandalonePromiseCustomSettle(
  ctx: CodegenContext,
  fctx: FunctionContext,
  constructorLocal: number,
  constructorInfo: ClosureInfo,
  constructorSelfTypeIdx: number,
  valueInstrs: Instr[],
  settle: "resolve" | "reject",
): boolean {
  if (!isStandalonePromiseActive(ctx)) return false;
  const runtime = ensureCustomCapabilityRuntime(ctx);
  const wrapperRoot = getFuncRefWrapperRootTypeIdx(ctx);
  const vec = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  if (!runtime || wrapperRoot === undefined || vec.newIdx === undefined || vec.pushIdx === undefined) return false;
  const resultLocal = allocLocal(fctx, `__promise_resolve_result_${fctx.locals.length}`, { kind: "externref" });
  const valueLocal = allocLocal(fctx, `__promise_resolve_value_${fctx.locals.length}`, { kind: "externref" });
  const argsLocal = allocLocal(fctx, `__promise_resolve_args_${fctx.locals.length}`, { kind: "externref" });
  const stateLocal = allocLocal(fctx, `__promise_capability_state_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: runtime.stateTypeIdx,
  });
  const executorLocal = allocLocal(fctx, `__promise_capability_executor_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: runtime.executorTypeIdx,
  });
  fctx.body.push(...valueInstrs, { op: "local.set", index: valueLocal });
  fctx.body.push(
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: runtime.stateTypeIdx },
    { op: "local.set", index: stateLocal },
    { op: "ref.func", funcIdx: runtime.executorFuncIdx },
    { op: "i32.const", value: 2 },
    closureBagInitInstr(),
    { op: "local.get", index: stateLocal },
    { op: "struct.new", typeIdx: runtime.executorTypeIdx },
    { op: "local.set", index: executorLocal },
  );
  fctx.body.push({ op: "local.get", index: constructorLocal });
  for (let i = 0; i < constructorInfo.paramTypes.length; i++) {
    const p = constructorInfo.paramTypes[i]!;
    if (i === 0) fctx.body.push({ op: "local.get", index: executorLocal }, { op: "extern.convert_any" });
    else if (p.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
    else if (p.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (p.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else fctx.body.push({ op: "ref.null", typeIdx: (p as { typeIdx: number }).typeIdx });
  }
  const constructorSelf = getClosureFuncSelfTypeIdx(ctx, constructorInfo.funcTypeIdx) ?? constructorSelfTypeIdx;
  fctx.body.push(
    { op: "local.get", index: constructorLocal },
    { op: "struct.get", typeIdx: constructorSelf, fieldIdx: 0 },
  );
  emitGuardedFuncRefCast(fctx, constructorInfo.funcTypeIdx);
  emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: constructorInfo.funcTypeIdx });
  fctx.body.push({ op: "call_ref", typeIdx: constructorInfo.funcTypeIdx });
  if (constructorInfo.returnType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (constructorInfo.returnType.kind !== "externref") fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: resultLocal });
  const resolveCallable = [
    { op: "local.get", index: stateLocal } as Instr,
    { op: "struct.get", typeIdx: runtime.stateTypeIdx, fieldIdx: 0 } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.test", typeIdx: wrapperRoot } as Instr,
  ];
  const rejectCallable = [
    { op: "local.get", index: stateLocal } as Instr,
    { op: "struct.get", typeIdx: runtime.stateTypeIdx, fieldIdx: 1 } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.test", typeIdx: wrapperRoot } as Instr,
  ];
  fctx.body.push(...resolveCallable, ...rejectCallable, { op: "i32.and" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: customCapabilityTypeError(ctx),
  });
  fctx.body.push(
    { op: "call", funcIdx: vec.newIdx },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: vec.pushIdx },
    { op: "local.get", index: stateLocal },
    // §27.2.4.7 step 5 / §27.2.4.6 step 4 — `Call(capability.[[Resolve]] or
    // [[Reject]], undefined, «x»)`. `undefined` for the receiver is the null
    // externref the apply helper already treats as "no thisArg".
    { op: "struct.get", typeIdx: runtime.stateTypeIdx, fieldIdx: settle === "reject" ? 1 : 0 },
    { op: "ref.null.extern" },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: applyIdx },
    { op: "drop" },
    { op: "local.get", index: resultLocal },
  );
  return true;
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
  // ── (#3137) allSettled/any wrappers — lazily minted by
  // ensureSettledAnyCombinators ONLY when a module compiles a native
  // allSettled/any, so all/race-only modules stay byte-identical. Every field
  // MUST also be listed in COMBINATOR_FUNC_IDX_KEYS (async-scheduler.ts) — the
  // late-import lockstep shift (#2918) — because emit sites bake
  // `ref.func`/`call` from these long after registration.
  /** `__combinator_allsettled_fulfill(caps, value) -> value` — stores `{status:"fulfilled", value}`. */
  allSettledFulfillFuncIdx?: number;
  /** `__combinator_allsettled_reject(caps, reason) -> reason` — stores `{status:"rejected", reason}`; never rejects the aggregate. */
  allSettledRejectFuncIdx?: number;
  /** `__combinator_any_reject(caps, reason) -> reason` — stores the reason; last rejection rejects with an AggregateError. */
  anyRejectFuncIdx?: number;
  /** `__combinator_new_aggregate_error(errorsVec) -> externref` — native $Error_struct with tag AggregateError + `.errors` on $props. */
  aggErrNewFuncIdx?: number;
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

  // (#1916 S3 / #2710) Four explicit stable mints replace the implicit
  // consecutive-position `base + k` sibling derivation (same conversion as the
  // JSON parse trio in S3b batch 3). The handles are baked into each other's
  // bodies below and into `ref.func`/`call` sites at use time — stable handles
  // never shift, so no ordering constraint against ensureAsyncDriveRuntime's
  // appends (the "claim the slot last" comment above is now historical for
  // the index reservation; rt must still be built first for its own values).
  const subscribeFuncIdx = mintDefinedFunc(ctx);
  const allFulfillFuncIdx = mintDefinedFunc(ctx);
  const raceFulfillFuncIdx = mintDefinedFunc(ctx);
  const rejectFuncIdx = mintDefinedFunc(ctx);

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

  pushDefinedFunc(ctx, subscribeFuncIdx, {
    name: "__combinator_subscribe",
    typeIdx: subscribeTypeIdx,
    locals: buildSubscribeLocals(promiseTypeIdx),
    body: buildSubscribeBody(ids, rt, ctx.funcMap.get("__promise_resolve_value") ?? -1),
    exported: false,
  });
  ctx.funcMap.set("__combinator_subscribe", subscribeFuncIdx);

  pushDefinedFunc(ctx, allFulfillFuncIdx, {
    name: "__combinator_all_fulfill",
    typeIdx: wrapperTypeIdx,
    locals: buildAllFulfillLocals(ids),
    body: buildAllFulfillBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_all_fulfill", allFulfillFuncIdx);

  pushDefinedFunc(ctx, raceFulfillFuncIdx, {
    name: "__combinator_race_fulfill",
    typeIdx: wrapperTypeIdx,
    locals: buildSettleWrapperLocals(ids),
    body: buildRaceFulfillBody(ids, rt),
    exported: false,
  });
  ctx.funcMap.set("__combinator_race_fulfill", raceFulfillFuncIdx);

  pushDefinedFunc(ctx, rejectFuncIdx, {
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

/** (#3137) CombinatorRuntime with the allSettled/any wrapper fields guaranteed present. */
type SettledAnyCombinatorRuntime = CombinatorRuntime &
  Required<
    Pick<
      CombinatorRuntime,
      "allSettledFulfillFuncIdx" | "allSettledRejectFuncIdx" | "anyRejectFuncIdx" | "aggErrNewFuncIdx"
    >
  >;

/**
 * (#3137) Lazily mint the allSettled/any reaction wrappers on top of the shared
 * combinator runtime. Kept OUT of ensureCombinatorFunctions so `all`/`race`-only
 * modules never pull the object runtime / error struct / key-string constants —
 * their emitted bytes stay identical to pre-#3137 output.
 *
 * Registration discipline mirrors ensureCombinatorFunctions: all dependencies
 * (object runtime for `__new_plain_object`/`__extern_set`, the `$Error_struct`,
 * the interned key strings) are ensured BEFORE the wrappers are minted/built, so
 * no dependency append can shift a baked index mid-build. The minted funcIdxs
 * are stored on `ctx.__promiseCombinators` and listed in
 * COMBINATOR_FUNC_IDX_KEYS (async-scheduler.ts) for the #2918 late-import
 * lockstep shift.
 */
function ensureSettledAnyCombinators(ctx: CodegenContext): SettledAnyCombinatorRuntime {
  const ids = ensureCombinatorFunctions(ctx);
  if (ids.allSettledFulfillFuncIdx !== undefined && ids.anyRejectFuncIdx !== undefined) {
    return ids as SettledAnyCombinatorRuntime;
  }
  const rt = ensureAsyncDriveRuntime(ctx);
  ensureObjectRuntime(ctx);
  const errStructTypeIdx = getOrRegisterErrorStructType(ctx);

  // Intern every key/message string BEFORE building bodies (the same
  // "register, then materialize" order emitErrorStructConstructor uses).
  const STRINGS = [
    "status",
    "fulfilled",
    "rejected",
    "value",
    "reason",
    "errors",
    "AggregateError",
    ANY_REJECT_MESSAGE,
  ];
  for (const s of STRINGS) addStringConstantGlobal(ctx, s);

  const newPlainObjIdx = ctx.funcMap.get("__new_plain_object");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  if (newPlainObjIdx === undefined || externSetIdx === undefined) {
    // Structurally impossible after ensureObjectRuntime; keep the invariant loud.
    throw new Error("#3137: object runtime did not register __new_plain_object/__extern_set");
  }

  const aggErrNewFuncIdx = mintDefinedFunc(ctx);
  const allSettledFulfillFuncIdx = mintDefinedFunc(ctx);
  const allSettledRejectFuncIdx = mintDefinedFunc(ctx);
  const anyRejectFuncIdx = mintDefinedFunc(ctx);

  const wrapperTypeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const aggErrTypeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF]);

  pushDefinedFunc(ctx, aggErrNewFuncIdx, {
    name: "__combinator_new_aggregate_error",
    typeIdx: aggErrTypeIdx,
    locals: [{ name: "$props", type: EXTERNREF }],
    body: buildNewAggregateErrorBody(ctx, errStructTypeIdx, newPlainObjIdx, externSetIdx),
    exported: false,
  });
  ctx.funcMap.set("__combinator_new_aggregate_error", aggErrNewFuncIdx);

  pushDefinedFunc(ctx, allSettledFulfillFuncIdx, {
    name: "__combinator_allsettled_fulfill",
    typeIdx: wrapperTypeIdx,
    locals: buildSettledWrapperLocals(ids),
    body: buildAllSettledBody(ctx, ids, rt, "fulfilled", newPlainObjIdx, externSetIdx),
    exported: false,
  });
  ctx.funcMap.set("__combinator_allsettled_fulfill", allSettledFulfillFuncIdx);

  pushDefinedFunc(ctx, allSettledRejectFuncIdx, {
    name: "__combinator_allsettled_reject",
    typeIdx: wrapperTypeIdx,
    locals: buildSettledWrapperLocals(ids),
    body: buildAllSettledBody(ctx, ids, rt, "rejected", newPlainObjIdx, externSetIdx),
    exported: false,
  });
  ctx.funcMap.set("__combinator_allsettled_reject", allSettledRejectFuncIdx);

  pushDefinedFunc(ctx, anyRejectFuncIdx, {
    name: "__combinator_any_reject",
    typeIdx: wrapperTypeIdx,
    locals: buildAllFulfillLocals(ids),
    body: buildAnyRejectBody(ids, rt, aggErrNewFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__combinator_any_reject", anyRejectFuncIdx);

  ids.aggErrNewFuncIdx = aggErrNewFuncIdx;
  ids.allSettledFulfillFuncIdx = allSettledFulfillFuncIdx;
  ids.allSettledRejectFuncIdx = allSettledRejectFuncIdx;
  ids.anyRejectFuncIdx = anyRejectFuncIdx;
  return ids as SettledAnyCombinatorRuntime;
}

/** (#3137) V8-compatible `Promise.any` total-rejection message (§27.2.4.3 AggregateError). */
const ANY_REJECT_MESSAGE = "All promises were rejected";

/**
 * (#3137) Per-method reaction-wrapper selection for the two combinator
 * emitters. MUST be called at the TOP of an emitter (before element buffers /
 * loop code splice into fctx.body) — the settled/any arm lazily registers
 * functions, and the emitters' ordering contract requires every registration
 * to precede the copy (see the #2919 liveBodies note at the literal call site).
 */
function combinatorReactionFns(
  ctx: CodegenContext,
  ids: CombinatorRuntime,
  method: NativeCombinator,
): { fulfillIdx: number; rejectIdx: number } {
  switch (method) {
    case "all":
      return { fulfillIdx: ids.allFulfillFuncIdx, rejectIdx: ids.rejectFuncIdx };
    case "race":
      return { fulfillIdx: ids.raceFulfillFuncIdx, rejectIdx: ids.rejectFuncIdx };
    case "allSettled": {
      const e = ensureSettledAnyCombinators(ctx);
      return { fulfillIdx: e.allSettledFulfillFuncIdx, rejectIdx: e.allSettledRejectFuncIdx };
    }
    case "any": {
      // First fulfillment settles the aggregate — exactly the race fulfill
      // wrapper; only the rejection side (collect + AggregateError) is new.
      const e = ensureSettledAnyCombinators(ctx);
      return { fulfillIdx: e.raceFulfillFuncIdx, rejectIdx: e.anyRejectFuncIdx };
    }
  }
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

function buildSubscribeBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT, resolveValueFuncIdx: number): Instr[] {
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
    { op: "ref.test", typeIdx: ids.promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: INPUT },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ids.promiseTypeIdx },
        { op: "local.set", index: P },
      ],
      else:
        resolveValueFuncIdx >= 0
          ? // (#5143 Step 1a) Spec PromiseResolve(C, x): allocate a fresh
            // PENDING `$Promise` and drive it through
            // `__promise_resolve_value`, which implements §27.2.1.3.2 in full
            // — a user THENABLE element gets a PromiseResolveThenableJob on
            // the microtask ring (its `then` is actually invoked), a poisoned
            // `then` getter rejects, and a plain value still fulfils
            // synchronously (same observable result as the old sync-FULFILLED
            // wrap, one extra struct + call).
            ([
              { op: "i32.const", value: PROMISE_STATE_PENDING },
              { op: "ref.null.extern" },
              { op: "ref.null.extern" },
              closureBagInitInstr(),
              { op: "struct.new", typeIdx: ids.promiseTypeIdx },
              { op: "local.set", index: P },
              { op: "local.get", index: P },
              { op: "local.get", index: INPUT },
              { op: "call", funcIdx: resolveValueFuncIdx },
              { op: "drop" },
            ] satisfies Instr[])
          : ([
              { op: "i32.const", value: PROMISE_STATE_FULFILLED },
              { op: "local.get", index: INPUT },
              { op: "ref.null.extern" },
              closureBagInitInstr(),
              { op: "struct.new", typeIdx: ids.promiseTypeIdx },
              { op: "local.set", index: P },
            ] satisfies Instr[]),
    },

    // caps = $CombinatorElemCaps{ state, index } (boxed to externref).
    { op: "local.get", index: STATE },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.stateTypeIdx },
    { op: "local.get", index: INDEX },
    { op: "struct.new", typeIdx: ids.elemCapsTypeIdx },
    { op: "extern.convert_any" },
    { op: "local.set", index: CAPS },

    // (#2958) Subscribing to this input attaches a reaction — the combinator is
    // now handling its (possible) rejection, so clear its unhandled flag. Covers
    // an inlined `Promise.reject(x)` element that would otherwise be reported as
    // unhandled even though the combinator consumes it. No-op when inactive.
    ...(rt.markRejectionHandledFuncIdx >= 0
      ? ([
          { op: "local.get", index: P },
          { op: "call", funcIdx: rt.markRejectionHandledFuncIdx },
        ] satisfies Instr[])
      : []),

    // Dispatch on the (possibly already-settled) promise state.
    { op: "local.get", index: P },
    { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 0 },
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
        { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 1 },
        { op: "call", funcIdx: rt.enqueueFuncIdx },
      ],
      else: [
        { op: "local.get", index: P },
        { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 0 },
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
            { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 1 },
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
            { op: "struct.get", typeIdx: ids.promiseTypeIdx, fieldIdx: 2 },
            { op: "struct.new", typeIdx: cbTypeIdx },
            { op: "extern.convert_any" },
            { op: "struct.set", typeIdx: ids.promiseTypeIdx, fieldIdx: 2 },
          ],
        },
      ],
    },
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
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx },
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: ST },

    // results[index] = value
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: VALUE },
    { op: "array.set", typeIdx: ids.arrTypeIdx },

    // remaining -= 1
    { op: "local.get", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.tee", index: REM },
    { op: "struct.set", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },

    // if remaining == 0: fulfill the result promise with the results vec.
    { op: "local.get", index: REM },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 },
        // vec = struct.new $vec(length, resultsArr)
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 },
        { op: "struct.new", typeIdx: ids.vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: rt.fulfillFuncIdx },
        { op: "drop" },
      ],
    },

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
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx },
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 },
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

// ── (#3137) __combinator_allsettled_fulfill / _reject ────────────────────────
// params: 0 caps externref, 1 value externref.
// locals: 2 c (ref $CombinatorElemCaps), 3 st (ref $CombinatorState), 4 rem i32,
//         5 obj externref (the {status, value|reason} result object).

function buildSettledWrapperLocals(ids: CombinatorRuntime): LocalDef[] {
  return [
    { name: "$c", type: { kind: "ref", typeIdx: ids.elemCapsTypeIdx } },
    { name: "$st", type: { kind: "ref", typeIdx: ids.stateTypeIdx } },
    { name: "$rem", type: { kind: "i32" } },
    { name: "$obj", type: EXTERNREF },
  ];
}

/**
 * (#3137) `allSettled` reaction wrapper body (§27.2.4.2.2/.3): build the
 * `{ status: "fulfilled", value }` / `{ status: "rejected", reason }` result
 * object as a plain `$Object`, store it at the element index, and — this is the
 * allSettled-defining difference from `all` — count down on BOTH arms and only
 * ever FULFILL the aggregate. Insertion order status→value|reason matches the
 * spec's CreateDataProperty order.
 */
function buildAllSettledBody(
  ctx: CodegenContext,
  ids: CombinatorRuntime,
  rt: AsyncDriveRuntimeT,
  status: "fulfilled" | "rejected",
  newPlainObjIdx: number,
  externSetIdx: number,
): Instr[] {
  const CAPS = 0;
  const VALUE = 1;
  const C = 2;
  const ST = 3;
  const REM = 4;
  const OBJ = 5;
  return [
    // obj = __new_plain_object(); obj.status = <status>; obj.<value|reason> = value
    { op: "call", funcIdx: newPlainObjIdx },
    { op: "local.set", index: OBJ },
    { op: "local.get", index: OBJ },
    ...stringConstantExternrefInstrs(ctx, "status"),
    ...stringConstantExternrefInstrs(ctx, status),
    { op: "call", funcIdx: externSetIdx },
    { op: "local.get", index: OBJ },
    ...stringConstantExternrefInstrs(ctx, status === "fulfilled" ? "value" : "reason"),
    { op: "local.get", index: VALUE },
    { op: "call", funcIdx: externSetIdx },

    { op: "local.get", index: CAPS },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx },
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: ST },

    // results[index] = obj
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: OBJ },
    { op: "array.set", typeIdx: ids.arrTypeIdx },

    // remaining -= 1
    { op: "local.get", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.tee", index: REM },
    { op: "struct.set", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },

    // if remaining == 0: FULFILL the aggregate with the results vec (never reject).
    { op: "local.get", index: REM },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 },
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 },
        { op: "struct.new", typeIdx: ids.vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: rt.fulfillFuncIdx },
        { op: "drop" },
      ],
    },

    { op: "local.get", index: VALUE },
  ];
}

// ── (#3137) __combinator_any_reject ──────────────────────────────────────────
// params: 0 caps externref, 1 reason externref. Locals as buildAllFulfillLocals.

/**
 * (#3137) `Promise.any` rejection wrapper (§27.2.4.3.2): store the reason at the
 * element index, count down; when the LAST input rejects, reject the aggregate
 * with a native AggregateError carrying the reasons vec as `.errors`.
 * Fulfillment settles via the shared race-fulfill wrapper (first value wins).
 */
function buildAnyRejectBody(ids: CombinatorRuntime, rt: AsyncDriveRuntimeT, aggErrNewFuncIdx: number): Instr[] {
  const CAPS = 0;
  const VALUE = 1;
  const C = 2;
  const ST = 3;
  const REM = 4;
  return [
    { op: "local.get", index: CAPS },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ids.elemCapsTypeIdx },
    { op: "local.set", index: C },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: ST },

    // errors[index] = reason
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: C },
    { op: "struct.get", typeIdx: ids.elemCapsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: VALUE },
    { op: "array.set", typeIdx: ids.arrTypeIdx },

    // remaining -= 1
    { op: "local.get", index: ST },
    { op: "local.get", index: ST },
    { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.tee", index: REM },
    { op: "struct.set", typeIdx: ids.stateTypeIdx, fieldIdx: 3 },

    // if remaining == 0: reject the aggregate with AggregateError(errorsVec).
    { op: "local.get", index: REM },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 0 },
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: ids.stateTypeIdx, fieldIdx: 1 },
        { op: "struct.new", typeIdx: ids.vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: aggErrNewFuncIdx },
        { op: "call", funcIdx: rt.rejectFuncIdx },
        { op: "drop" },
      ],
    },

    { op: "local.get", index: VALUE },
  ];
}

// ── (#3137) __combinator_new_aggregate_error ─────────────────────────────────
// params: 0 errorsVec externref. locals: 1 props externref.

/**
 * (#3137) Build a native AggregateError `$Error_struct` (§20.5.7.1 semantics
 * for the combinator's internal use): tag = BUILTIN_TYPE_TAGS.AggregateError
 * (so `instanceof AggregateError` discriminates), message = the V8-compatible
 * total-rejection message, and `.errors` stored on the `$props` own-field
 * backing object (#2101a R5 — reads route through `__extern_get`'s error arm).
 * Deliberately NOT named `__new_AggregateError`: that funcMap name is the
 * 3-param HOST import contract (#1467, new-super.ts) and must not be shadowed
 * with a different arity.
 */
function buildNewAggregateErrorBody(
  ctx: CodegenContext,
  errStructTypeIdx: number,
  newPlainObjIdx: number,
  externSetIdx: number,
): Instr[] {
  const ERRVEC = 0;
  const PROPS = 1;
  return [
    // props = __new_plain_object(); props.errors = errorsVec
    { op: "call", funcIdx: newPlainObjIdx },
    { op: "local.set", index: PROPS },
    { op: "local.get", index: PROPS },
    ...stringConstantExternrefInstrs(ctx, "errors"),
    { op: "local.get", index: ERRVEC },
    { op: "call", funcIdx: externSetIdx },
    // struct.new $Error_struct { tag, message, name, stack, userClassId, props }
    { op: "i32.const", value: BUILTIN_TYPE_TAGS.AggregateError },
    ...stringConstantExternrefInstrs(ctx, ANY_REJECT_MESSAGE),
    ...stringConstantExternrefInstrs(ctx, "AggregateError"),
    { op: "ref.null.extern" },
    { op: "i32.const", value: -1 },
    { op: "local.get", index: PROPS },
    { op: "struct.new", typeIdx: errStructTypeIdx },
    { op: "extern.convert_any" },
  ];
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
  // (#3137) MUST run before any element buffer splices into fctx.body — the
  // allSettled/any arm lazily registers wrapper functions (see the ordering
  // note above about ensure* preceding the buffer copy).
  const reaction = combinatorReactionFns(ctx, ids, method);
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
  fctx.body.push(closureBagInitInstr());
  fctx.body.push({ op: "struct.new", typeIdx: ids.promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Backing results array (only meaningful for `all`; `race` ignores it).
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "array.new_default", typeIdx: ids.arrTypeIdx });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // $CombinatorState{ resultPromise, resultsArr, length=n, remaining=n }.
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "i32.const", value: n });
  fctx.body.push({ op: "struct.new", typeIdx: ids.stateTypeIdx });
  fctx.body.push({ op: "local.set", index: stateLocal });

  if (n === 0) {
    // `Promise.all([])` / `Promise.allSettled([])` fulfill immediately with an
    // empty array. `Promise.any([])` rejects immediately with an AggregateError
    // whose `.errors` is empty (§27.2.4.3 step 4 via the remaining-count
    // reaching zero with no fulfillment). `Promise.race([])` stays pending
    // forever (spec) — emit nothing.
    if (method === "all" || method === "allSettled") {
      fctx.body.push({ op: "local.get", index: resultLocal });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "struct.new", typeIdx: ids.vecTypeIdx });
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "call", funcIdx: rt.fulfillFuncIdx });
      fctx.body.push({ op: "drop" });
    } else if (method === "any") {
      fctx.body.push({ op: "local.get", index: resultLocal });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.get", index: arrLocal });
      fctx.body.push({ op: "struct.new", typeIdx: ids.vecTypeIdx });
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "call", funcIdx: ids.aggErrNewFuncIdx! });
      fctx.body.push({ op: "call", funcIdx: rt.rejectFuncIdx });
      fctx.body.push({ op: "drop" });
    }
  } else {
    for (let i = 0; i < n; i++) {
      for (const instr of elementInstrs[i]!) fctx.body.push(instr);
      fctx.body.push({ op: "local.get", index: stateLocal });
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "i32.const", value: i });
      fctx.body.push({ op: "ref.func", funcIdx: reaction.fulfillIdx });
      fctx.body.push({ op: "ref.func", funcIdx: reaction.rejectIdx });
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
  // (#3137) Lazily registers the allSettled/any wrappers; must precede all
  // emission below (registration-before-bake, same contract as the literal arm).
  const reaction = combinatorReactionFns(ctx, ids, method);

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
  fctx.body.push({ op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: nLocal });

  // Pending result promise.
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push(closureBagInitInstr());
  fctx.body.push({ op: "struct.new", typeIdx: ids.promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Backing results array sized n (only meaningful for `all`; `race` ignores it).
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: ids.arrTypeIdx });
  fctx.body.push({ op: "local.set", index: arrLocal });

  // $CombinatorState{ resultPromise, resultsArr, length=n, remaining=n }.
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.get", index: arrLocal });
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "local.get", index: nLocal });
  fctx.body.push({ op: "struct.new", typeIdx: ids.stateTypeIdx });
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
    });
  }

  // `Promise.all(<empty>)` / `Promise.allSettled(<empty>)` fulfill immediately
  // with the empty results vec; `Promise.any(<empty>)` rejects immediately with
  // an empty-`.errors` AggregateError (one-shot settle keeps the opts
  // not-iterable TypeError reject above authoritative when both fire);
  // `Promise.race(<empty>)` stays pending forever (spec). The subscribe loop
  // below runs zero iterations either way.
  if (method === "all" || method === "allSettled") {
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resultLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: arrLocal },
        { op: "struct.new", typeIdx: ids.vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: rt.fulfillFuncIdx },
        { op: "drop" },
      ],
    });
  } else if (method === "any") {
    fctx.body.push({ op: "local.get", index: nLocal });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: resultLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: arrLocal },
        { op: "struct.new", typeIdx: ids.vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "call", funcIdx: ids.aggErrNewFuncIdx! },
        { op: "call", funcIdx: rt.rejectFuncIdx },
        { op: "drop" },
      ],
    });
  }

  // for (i = 0; i < n; i++) __combinator_subscribe(argVec.data[i], state, i,
  //                                                fulfillFn, rejectFn)
  // Subscribe never settles synchronously (already-settled inputs only ENQUEUE),
  // so `remaining` stays == n through the whole loop — no mid-loop settle race.
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
          { op: "struct.get", typeIdx: argVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: iLocal },
          { op: "array.get", typeIdx: argArrTypeIdx },
          { op: "local.get", index: stateLocal },
          { op: "extern.convert_any" },
          { op: "local.get", index: iLocal },
          { op: "ref.func", funcIdx: reaction.fulfillIdx },
          { op: "ref.func", funcIdx: reaction.rejectIdx },
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
  });

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
// (#2867 string-combinator slice) String-arm locals — present only when the
// native-string arm is emitted (`toVecStringArmAvailable`).
const TOVEC_SFLAT = 9;
const TOVEC_SI = 10;
const TOVEC_SCH = 11;

/**
 * (#2867 string-combinator slice) The string arm exists only under native
 * strings — the same predicate gates the `isDynamicCombinatorArgEligible`
 * string admission in calls.ts, so the compile-time gate and the runtime arm
 * can never disagree.
 */
function toVecStringArmAvailable(ctx: CodegenContext): boolean {
  return ctx.nativeStrings === true;
}

/** Idempotently register `__combinator_to_vec` with the vec-only eager body. */
export function ensureCombinatorToVec(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__combinator_to_vec")) return;
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrRefNull: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const stringArm = toVecStringArmAvailable(ctx);
  // The string arm calls __str_flatten / __str_charAt_cp — register them
  // BEFORE minting our funcIdx so their stable handles exist at body build.
  if (stringArm) ensureNativeStringHelpers(ctx);
  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx); // (#1916 S3) stable handle
  pushDefinedFunc(ctx, funcIdx, {
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
      ...(stringArm
        ? [
            { name: "$sflat", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } as ValType },
            { name: "$si", type: { kind: "i32" } as ValType },
            { name: "$sch", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } as ValType },
          ]
        : []),
    ],
    body: buildToVecCommonHead(ctx, vecTypeIdx).concat([{ op: "ref.null.extern" }]),
    exported: false,
  });
  ctx.funcMap.set("__combinator_to_vec", funcIdx);
}

/**
 * The head shared by both bodies: null → return null (not iterable);
 * canonical `$Vec` → return the input unchanged; native string → a fresh
 * `$Vec` of its code-point substrings (§22.1.5 String iteration — the
 * (#2867 string-combinator) arm, present only under native strings).
 * Falls through otherwise.
 * Built FRESH per call — never alias one Instr[] into two bodies (#2169b:
 * a shared instruction object is double-remapped by DCE's type-index pass).
 */
function buildToVecCommonHead(ctx: CodegenContext, vecTypeIdx: number): Instr[] {
  return [
    { op: "local.get", index: TOVEC_X },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "return" }],
    },
    { op: "local.get", index: TOVEC_X },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: vecTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: TOVEC_X }, { op: "return" }],
    },
    ...buildToVecStringArm(ctx, vecTypeIdx),
  ];
}

/**
 * (#2867 string-combinator slice) Strings ARE iterable per §22.1.5: the String
 * iterator yields code POINTS (a well-formed surrogate pair is one 2-code-unit
 * element). Flatten once, then walk with `__str_charAt_cp` (the same helper
 * the for-of / spread string lowerings use), advancing the cursor by the
 * returned element's `.len`. The result vec is sized at the code-UNIT count —
 * an upper bound on code points; `$Vec.len` carries the true element count, so
 * the tail slack is never read. Empty string → `$Vec{0}` (fulfils `all` with
 * `[]`, leaves `race` pending — spec behaviour for an empty iterable).
 */
function buildToVecStringArm(ctx: CodegenContext, vecTypeIdx: number): Instr[] {
  if (!toVecStringArmAvailable(ctx) || ctx.anyStrTypeIdx < 0 || ctx.nativeStrTypeIdx < 0) return [];
  const flattenIdx = nativeStrHelperHandle(ctx, "__str_flatten");
  const charAtCpIdx = nativeStrHelperHandle(ctx, "__str_charAt_cp");
  if (flattenIdx === undefined || charAtCpIdx === undefined) return [];
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  return [
    { op: "local.get", index: TOVEC_X },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // sflat = __str_flatten(x)
        { op: "local.get", index: TOVEC_X },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
        { op: "call", funcIdx: flattenIdx },
        { op: "local.set", index: TOVEC_SFLAT },
        // cap = sflat.len (code units — upper bound on code points)
        { op: "local.get", index: TOVEC_SFLAT },
        { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: TOVEC_CAP },
        // data = new arr[cap]; len = 0; si = 0
        { op: "local.get", index: TOVEC_CAP },
        { op: "array.new_default", typeIdx: arrTypeIdx },
        { op: "local.set", index: TOVEC_DATA },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: TOVEC_LEN },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: TOVEC_SI },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: TOVEC_SI },
                { op: "local.get", index: TOVEC_CAP },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // sch = __str_charAt_cp(sflat, si) — 1 unit, or 2 for a pair
                { op: "local.get", index: TOVEC_SFLAT },
                { op: "ref.as_non_null" },
                { op: "local.get", index: TOVEC_SI },
                { op: "call", funcIdx: charAtCpIdx },
                { op: "ref.cast", typeIdx: ctx.nativeStrTypeIdx },
                { op: "local.set", index: TOVEC_SCH },
                // data[len] = sch; len++
                { op: "local.get", index: TOVEC_DATA },
                { op: "local.get", index: TOVEC_LEN },
                { op: "local.get", index: TOVEC_SCH },
                { op: "extern.convert_any" },
                { op: "array.set", typeIdx: arrTypeIdx },
                { op: "local.get", index: TOVEC_LEN },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: TOVEC_LEN },
                // si += sch.len (skips the low surrogate of a pair)
                { op: "local.get", index: TOVEC_SI },
                { op: "local.get", index: TOVEC_SCH },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 },
                { op: "i32.add" },
                { op: "local.set", index: TOVEC_SI },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // return $Vec{len, data}
        { op: "local.get", index: TOVEC_LEN },
        { op: "local.get", index: TOVEC_DATA },
        { op: "ref.as_non_null" },
        { op: "struct.new", typeIdx: vecTypeIdx },
        { op: "extern.convert_any" },
        { op: "return" },
      ],
    },
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

  // A Deno SafePromise helper hands the result of `Array.prototype.values()`
  // straight to an inherited combinator. That carrier has a native `next()`
  // method but does not make the module register an `@@iterator` dispatcher:
  // the iterator was already obtained by the caller. Do not leave the eager
  // vec-only body in place merely because `__call_@@iterator` is absent. The
  // bare-next fallback below is sufficient to use the object itself as the
  // iterator. A genuine custom iterable still needs the iterator dispatcher.
  if (
    (callIteratorIdx === undefined && nextStructTypeIdxs.length === 0) ||
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

  // Grow: cap *= 2; grow = new arr[cap]; copy data[0..len] → grow; data = grow.
  const growInstrs: Instr[] = [
    { op: "local.get", index: TOVEC_CAP },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    { op: "local.set", index: TOVEC_CAP },
    { op: "local.get", index: TOVEC_CAP },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: TOVEC_GROW },
    { op: "local.get", index: TOVEC_GROW },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: TOVEC_DATA },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: TOVEC_LEN },
    { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
    { op: "local.get", index: TOVEC_GROW },
    { op: "local.set", index: TOVEC_DATA },
  ];

  // hasNext = OR over `ref.test` of every bare-`next` struct.
  const hasNextChain: Instr[] = [{ op: "i32.const", value: 0 }];
  for (const tIdx of nextStructTypeIdxs) {
    hasNextChain.push({ op: "local.get", index: TOVEC_X });
    hasNextChain.push({ op: "any.convert_extern" });
    hasNextChain.push({ op: "ref.test", typeIdx: tIdx });
    hasNextChain.push({ op: "i32.or" });
  }

  const useBareNextOrReturnNull: Instr[] = [
    ...hasNextChain,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: TOVEC_X },
        { op: "local.set", index: TOVEC_IT },
      ],
      else: [{ op: "ref.null.extern" }, { op: "return" }],
    },
  ];

  const acquireIterator: Instr[] =
    callIteratorIdx === undefined
      ? useBareNextOrReturnNull
      : [
          // it = __call_@@iterator(x)  (null when x has no @@iterator method)
          { op: "local.get", index: TOVEC_X },
          { op: "call", funcIdx: callIteratorIdx },
          { op: "local.set", index: TOVEC_IT },
          { op: "local.get", index: TOVEC_IT },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: useBareNextOrReturnNull,
          },
        ];

  fn.body = [
    ...buildToVecCommonHead(ctx, vecTypeIdx),
    ...acquireIterator,

    // cap = 4; data = new arr[4]; len = 0
    { op: "i32.const", value: 4 },
    { op: "local.set", index: TOVEC_CAP },
    { op: "local.get", index: TOVEC_CAP },
    { op: "array.new_default", typeIdx: arrTypeIdx },
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
            { op: "if", blockType: { kind: "empty" }, then: growInstrs, else: [] },
            // data[len] = value; len++
            { op: "local.get", index: TOVEC_DATA },
            { op: "local.get", index: TOVEC_LEN },
            { op: "local.get", index: TOVEC_VALUE },
            { op: "array.set", typeIdx: arrTypeIdx },
            { op: "local.get", index: TOVEC_LEN },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: TOVEC_LEN },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return $Vec{len, data} as externref
    { op: "local.get", index: TOVEC_LEN },
    { op: "local.get", index: TOVEC_DATA },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: vecTypeIdx },
    { op: "extern.convert_any" },
  ];
}
