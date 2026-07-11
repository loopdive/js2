// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3141) Native PromiseCapability protocol for REFLECTIVE combinator calls —
// `Promise.{all,allSettled,any,race}.call(C, iterable)` with a CUSTOM
// capability constructor (§27.2.1.5 NewPromiseCapability + §25.6.4.1.1
// PerformPromiseAll family).
//
// The 69-file test262 cluster this serves is entirely USER-SPACE: `C` is a
// user function whose executor records resolve/reject, `C.resolve` is a user
// identity, and the elements are user thenables — NO real promise (native
// `$Promise` or host) is ever minted. The machinery therefore reduces to the
// pure capability/iteration protocol and composes existing substrate only:
//   - `__apply_closure` (object-runtime) — Construct(C, «executor»),
//     Call(C.resolve, C, «elem»), Call(capability.resolve/reject, …);
//   - `__call_m_then_vararg` (closed-method-dispatch) — Invoke(nextPromise,
//     "then", «onFulfilled, onRejected») on user thenables;
//   - the canonical funcref-wrapper SUBTYPE pattern (closures.ts /
//     `$__promise_settle_cap`) — the capability executor and the per-element
//     resolve functions are native closures the USER's code can call.
//
// Standalone/wasi only (`isStandalonePromiseActive` gate at the calls.ts
// detection site); gc/host and modules without the reflective shape are
// byte-identical. Phase A covers `all` + `race` semantics with the module-scan
// `C.resolve` binding (fnctor statics have no native runtime rep — see #2976 /
// the #3141 issue file); allSettled/any element wrappers are phase B.

import type { Instr, LocalDef, ValType } from "../ir/types.js";
import { ensurePromiseSettleFunctions } from "./async-scheduler.js";
import { reserveClosedMethodDispatchVararg } from "./closed-method-dispatch.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { ensureCombinatorToVec } from "./promise-combinators.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";

const EXTERNREF: ValType = { kind: "externref" };

/** The §27.2.1.5 "Promise resolve or reject function is not callable" message. */
const NOT_CALLABLE_MSG = "Promise resolve or reject function is not callable";
const NOT_ITERABLE_MSG = "argument is not iterable";

export type CapabilityCombinator = "all" | "race";

export interface PromiseCapabilityRuntime {
  /** `$__promise_capability { resolve mut externref, reject mut externref, promise mut externref }`. */
  capTypeIdx: number;
  /** Executor closure subtype of the canonical 2-arg wrapper: `{ func funcref, cap (ref $cap) }`. */
  executorCapTypeIdx: number;
  /** `$__pcap_all_state { values (ref $arr_ext), remaining mut i32, cap (ref $cap) }`. */
  allStateTypeIdx: number;
  /** All-element closure subtype of the canonical 1-arg wrapper: `{ func funcref, state (ref $state), index i32, called mut i32 }`. */
  allElemCapTypeIdx: number;
  /** externref vec struct typeIdx (values array wrapper). */
  vecTypeIdx: number;
  /** backing externref array typeIdx. */
  arrTypeIdx: number;
  /** Lifted executor body funcIdx (`(self, resolve, reject) -> externref`). */
  executorFuncIdx: number;
  /** Lifted all-element body funcIdx (`(self, value) -> externref`). */
  allElemFuncIdx: number;
  /** `__pcap_new(CVal) -> externref(cap)` — NewPromiseCapability(C). */
  pcapNewFuncIdx: number;
  /** `__pcap_reject_with(capExt, reason) -> void` — IfAbruptRejectPromise tail. */
  rejectWithFuncIdx: number;
  /**
   * `__pcap_call1(fn, a0) -> externref` — PLAIN 1-arg closure application.
   * RESERVED here (placeholder null body), FILLED at finalize by
   * {@link fillPromiseCapabilityCall1} delegating to the `__call_fn_1` plain
   * dispatcher (which only exists at finalize). `__apply_closure` is
   * method-ABI-only (`__call_fn_method_N` casts trap on plain closures —
   * measured "illegal cast in __call_fn_method_1"), so every this-less
   * application here (Construct(C, «executor»), C.resolve(elem),
   * capability.resolve(values), capability.reject(reason)) routes through
   * this bridge instead.
   */
  pcapCall1FuncIdx: number;
}

/**
 * All funcIdx fields of the capability runtime — read by later call sites, so
 * they need the #2918 late-import lockstep shift. The shift itself lives in
 * async-scheduler.ts `shiftAsyncSideChannelFuncIdxs` (key list mirrored there
 * to avoid an import cycle) — keep BOTH lists in sync.
 */
export const PCAP_FUNC_IDX_KEYS = [
  "executorFuncIdx",
  "allElemFuncIdx",
  "pcapNewFuncIdx",
  "rejectWithFuncIdx",
  "pcapCall1FuncIdx",
] as const;

type CtxWithPcap = CodegenContext & {
  __promiseCapability?: PromiseCapabilityRuntime;
};

function registerStruct(
  ctx: CodegenContext,
  name: string,
  fields: { name: string; type: ValType; mutable: boolean }[],
  superTypeIdx?: number,
): number {
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name,
    fields,
    ...(superTypeIdx !== undefined ? { superTypeIdx } : {}),
  });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(
    name,
    fields.map((f) => ({ name: f.name, type: f.type, mutable: f.mutable })),
  );
  return typeIdx;
}

/** Push a native TypeError instance (externref) and throw it via the module exn tag. */
function throwTypeErrorInstrs(ctx: CodegenContext, msg: string, exnTag: number, newTypeErrorIdx: number): Instr[] {
  return [
    ...(stringConstantExternrefInstrs(ctx, msg) as Instr[]),
    { op: "call", funcIdx: newTypeErrorIdx } as Instr,
    { op: "throw", tagIdx: exnTag } as Instr,
  ];
}

/**
 * Idempotently register the capability runtime: struct types + the four shared
 * helpers. Registration discipline mirrors promise-combinators: every
 * dependency (objvec builders, apply-closure reserve, then-vararg dispatcher,
 * TypeError ctor, string constants) is ensured BEFORE any funcIdx is baked
 * into a helper body, so no dependency append can shift a baked index
 * mid-build (#1677/#1809/#2918).
 */
export function ensurePromiseCapabilityRuntime(ctx: CodegenContext): PromiseCapabilityRuntime | null {
  const cached = (ctx as CtxWithPcap).__promiseCapability;
  if (cached) return cached;

  // ── dependencies first ──
  const { newIdx: objvecNewIdx, pushIdx: objvecPushIdx } = ensureObjVecBuilders(ctx);
  // The settle substrate provides `__promise_peel_value` — module-global /
  // any-typed iterable ELEMENTS arrive as `$AnyValue` boxes, and the vararg
  // then-dispatcher's arms (closed structs / $Object) test the RAW object, so
  // `next` must be peeled before Invoke(next, "then", …) (the exact discipline
  // the thenable job uses). Idempotent; capability modules are promise modules
  // anyway.
  ensurePromiseSettleFunctions(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  const varargThenIdx = reserveClosedMethodDispatchVararg(ctx, "then");
  ensureCombinatorToVec(ctx);
  const toVecIdx = ctx.funcMap.get("__combinator_to_vec");
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const newTypeErrorIdx = ctx.funcMap.get("__new_TypeError");
  const exnTag = ensureExnTag(ctx);
  addStringConstantGlobal(ctx, NOT_CALLABLE_MSG);
  addStringConstantGlobal(ctx, NOT_ITERABLE_MSG);
  if (toVecIdx === undefined || newTypeErrorIdx === undefined) return null;

  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", EXTERNREF);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  // Canonical wrappers the USER's dynamic call sites ref.test/ref.cast
  // against: the executor is invoked as `executor(resolve, reject)` (2 args),
  // an element function as `onFulfilled(value)` (1 arg). The dynamic-call
  // cascade dispatches on the VOID-result wrapper shapes (`(self, ext, ext) ->
  // ()` / `(self, ext) -> ()` — verified in the emitted cascade; the same
  // canonical `$__promise_settle_cap` subtypes), so the subtypes MUST parent
  // the []-result wrappers or every `ref.test` misses and the call no-ops.
  const wrapper2 = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF, EXTERNREF], []);
  const wrapper1 = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF], []);
  if (!wrapper2 || !wrapper1) return null;

  const capTypeIdx = registerStruct(ctx, "$__promise_capability", [
    { name: "resolve", type: EXTERNREF, mutable: true },
    { name: "reject", type: EXTERNREF, mutable: true },
    { name: "promise", type: EXTERNREF, mutable: true },
  ]);

  const executorCapTypeIdx = registerStruct(
    ctx,
    "$__pcap_executor",
    [
      { name: "func", type: { kind: "funcref" }, mutable: false },
      {
        name: "cap",
        type: { kind: "ref", typeIdx: capTypeIdx },
        mutable: false,
      },
    ],
    wrapper2.structTypeIdx,
  );

  const allStateTypeIdx = registerStruct(ctx, "$__pcap_all_state", [
    {
      name: "values",
      type: { kind: "ref", typeIdx: arrTypeIdx },
      mutable: false,
    },
    { name: "remaining", type: { kind: "i32" }, mutable: true },
    { name: "cap", type: { kind: "ref", typeIdx: capTypeIdx }, mutable: false },
  ]);

  const allElemCapTypeIdx = registerStruct(
    ctx,
    "$__pcap_all_elem",
    [
      { name: "func", type: { kind: "funcref" }, mutable: false },
      {
        name: "state",
        type: { kind: "ref", typeIdx: allStateTypeIdx },
        mutable: false,
      },
      { name: "index", type: { kind: "i32" }, mutable: false },
      { name: "called", type: { kind: "i32" }, mutable: true },
    ],
    wrapper1.structTypeIdx,
  );

  const executorFuncIdx = mintDefinedFunc(ctx);
  const allElemFuncIdx = mintDefinedFunc(ctx);
  const pcapNewFuncIdx = mintDefinedFunc(ctx);
  const rejectWithFuncIdx = mintDefinedFunc(ctx);
  const pcapCall1FuncIdx = mintDefinedFunc(ctx);

  const rt: PromiseCapabilityRuntime = {
    capTypeIdx,
    executorCapTypeIdx,
    allStateTypeIdx,
    allElemCapTypeIdx,
    vecTypeIdx,
    arrTypeIdx,
    executorFuncIdx,
    allElemFuncIdx,
    pcapNewFuncIdx,
    rejectWithFuncIdx,
    pcapCall1FuncIdx,
  };

  // __pcap_call1 — RESERVED with a safe placeholder; filled at finalize (see
  // fillPromiseCapabilityCall1). Registered FIRST so the helpers below can
  // bake its funcIdx.
  pushDefinedFunc(ctx, pcapCall1FuncIdx, {
    name: "__pcap_call1",
    typeIdx: addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF], "$__pcap_call1_type"),
    locals: [],
    body: [{ op: "ref.null.extern" } as Instr],
    exported: false,
  });
  ctx.funcMap.set("__pcap_call1", pcapCall1FuncIdx);

  // ── §27.2.1.5.1 GetCapabilitiesExecutor body ──
  // (self (ref null $wrap2), resolve externref, reject externref) -> ()
  // Steps 1-2: if either slot is already set → TypeError. Then store both.
  {
    const CAP = 3;
    pushDefinedFunc(ctx, executorFuncIdx, {
      name: "__pcap_executor",
      typeIdx: wrapper2.liftedFuncTypeIdx,
      locals: [{ name: "$cap", type: { kind: "ref", typeIdx: capTypeIdx } }],
      body: [
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: executorCapTypeIdx } as Instr,
        { op: "struct.get", typeIdx: executorCapTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.set", index: CAP },
        { op: "local.get", index: CAP },
        { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: 0 } as Instr,
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "local.get", index: CAP },
        { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: 1 } as Instr,
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: throwTypeErrorInstrs(ctx, NOT_CALLABLE_MSG, exnTag, newTypeErrorIdx),
        } as Instr,
        { op: "local.get", index: CAP },
        { op: "local.get", index: 1 },
        { op: "struct.set", typeIdx: capTypeIdx, fieldIdx: 0 } as Instr,
        { op: "local.get", index: CAP },
        { op: "local.get", index: 2 },
        { op: "struct.set", typeIdx: capTypeIdx, fieldIdx: 1 } as Instr,
      ],
      exported: false,
    });
    ctx.funcMap.set("__pcap_executor", executorFuncIdx);
  }

  // ── §25.6.4.1.2 Promise.all Resolve Element body ──
  // (self (ref null $wrap1), value externref) -> ()
  {
    const S = 2; // elem caps
    const ST = 3; // state
    const REASON = 4;
    const locals: LocalDef[] = [
      { name: "$elem", type: { kind: "ref", typeIdx: allElemCapTypeIdx } },
      { name: "$state", type: { kind: "ref", typeIdx: allStateTypeIdx } },
      { name: "$reason", type: EXTERNREF },
    ];
    const resolveCall: Instr[] = [
      // Call(cap.resolve, undefined, «valuesVec») via the plain 1-arg bridge
      { op: "local.get", index: ST },
      { op: "struct.get", typeIdx: allStateTypeIdx, fieldIdx: 2 } as Instr,
      { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: 0 } as Instr,
      { op: "local.get", index: ST },
      { op: "struct.get", typeIdx: allStateTypeIdx, fieldIdx: 0 } as Instr,
      { op: "array.len" } as Instr,
      { op: "local.get", index: ST },
      { op: "struct.get", typeIdx: allStateTypeIdx, fieldIdx: 0 } as Instr,
      { op: "struct.new", typeIdx: vecTypeIdx } as Instr,
      { op: "extern.convert_any" } as Instr,
      { op: "call", funcIdx: pcapCall1FuncIdx } as Instr,
      { op: "drop" },
    ];
    pushDefinedFunc(ctx, allElemFuncIdx, {
      name: "__pcap_all_elem",
      typeIdx: wrapper1.liftedFuncTypeIdx,
      locals,
      body: [
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: allElemCapTypeIdx } as Instr,
        { op: "local.set", index: S },
        // one-shot ([[AlreadyCalled]])
        { op: "local.get", index: S },
        { op: "struct.get", typeIdx: allElemCapTypeIdx, fieldIdx: 3 } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "return" } as Instr],
        } as Instr,
        { op: "local.get", index: S },
        { op: "i32.const", value: 1 },
        { op: "struct.set", typeIdx: allElemCapTypeIdx, fieldIdx: 3 } as Instr,
        { op: "local.get", index: S },
        { op: "struct.get", typeIdx: allElemCapTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.set", index: ST },
        // values[index] = value
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: allStateTypeIdx, fieldIdx: 0 } as Instr,
        { op: "local.get", index: S },
        { op: "struct.get", typeIdx: allElemCapTypeIdx, fieldIdx: 2 } as Instr,
        { op: "local.get", index: 1 },
        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
        // remaining -= 1; if 0 → Call(cap.resolve, undefined, «values»)
        { op: "local.get", index: ST },
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: allStateTypeIdx, fieldIdx: 1 } as Instr,
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "struct.set", typeIdx: allStateTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.get", index: ST },
        { op: "struct.get", typeIdx: allStateTypeIdx, fieldIdx: 1 } as Instr,
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // A throwing capability.resolve rejects the capability promise
            // (IfAbruptRejectPromise around step 2.d.iii.2).
            {
              op: "try",
              blockType: { kind: "empty" },
              body: resolveCall,
              catches: [
                {
                  tagIdx: exnTag,
                  body: [
                    { op: "local.set", index: REASON },
                    { op: "local.get", index: ST },
                    {
                      op: "struct.get",
                      typeIdx: allStateTypeIdx,
                      fieldIdx: 2,
                    } as Instr,
                    { op: "extern.convert_any" } as Instr,
                    { op: "local.get", index: REASON },
                    { op: "call", funcIdx: rejectWithFuncIdx } as Instr,
                  ],
                },
              ],
            } as Instr,
          ],
        } as Instr,
      ],
      exported: false,
    });
    ctx.funcMap.set("__pcap_all_elem", allElemFuncIdx);
  }

  // ── __pcap_new(CVal) -> externref (the capability struct) ──
  // §27.2.1.5 NewPromiseCapability: build the executor closure, Construct(C,
  // «executor») (≈ apply as a function — the cluster's constructors are
  // this-insensitive), store the result as capability.promise, then validate
  // the slots (null ⇒ the executor was never called / called with missing
  // args ⇒ the spec's IsCallable(undefined) TypeError).
  {
    const CAP = 1;
    const ARGV = 2;
    pushDefinedFunc(ctx, pcapNewFuncIdx, {
      name: "__pcap_new",
      typeIdx: addFuncType(ctx, [EXTERNREF], [EXTERNREF], "$__pcap_new_type"),
      locals: [
        { name: "$cap", type: { kind: "ref", typeIdx: capTypeIdx } },
        { name: "$argv", type: EXTERNREF },
      ],
      body: [
        // cap = { null, null, null }
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: capTypeIdx } as Instr,
        { op: "local.set", index: CAP },
        // capability.promise = Construct(C, «executor») — plain 1-arg bridge
        { op: "local.get", index: CAP },
        { op: "local.get", index: 0 },
        { op: "ref.func", funcIdx: executorFuncIdx } as Instr,
        { op: "local.get", index: CAP },
        { op: "struct.new", typeIdx: executorCapTypeIdx } as Instr,
        { op: "extern.convert_any" } as Instr,
        { op: "call", funcIdx: pcapCall1FuncIdx } as Instr,
        { op: "struct.set", typeIdx: capTypeIdx, fieldIdx: 2 } as Instr,
        // validation: both slots must be set (spec IsCallable; null ⇒ TypeError)
        { op: "local.get", index: CAP },
        { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: 0 } as Instr,
        { op: "ref.is_null" },
        { op: "local.get", index: CAP },
        { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: 1 } as Instr,
        { op: "ref.is_null" },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: throwTypeErrorInstrs(ctx, NOT_CALLABLE_MSG, exnTag, newTypeErrorIdx),
        } as Instr,
        { op: "local.get", index: CAP },
        { op: "extern.convert_any" } as Instr,
      ],
      exported: false,
    });
    ctx.funcMap.set("__pcap_new", pcapNewFuncIdx);
  }
  pushDefinedFunc(ctx, rejectWithFuncIdx, {
    name: "__pcap_reject_with",
    typeIdx: addFuncType(ctx, [EXTERNREF, EXTERNREF], [], "$__pcap_reject_type"),
    locals: [{ name: "$argv", type: EXTERNREF }],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "ref.cast", typeIdx: capTypeIdx } as Instr,
      { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: 1 } as Instr,
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: pcapCall1FuncIdx } as Instr,
      { op: "drop" },
    ],
    exported: false,
  });
  ctx.funcMap.set("__pcap_reject_with", rejectWithFuncIdx);

  // The vararg-then + apply + objvec + toVec + TypeError indices all live in
  // funcMap; the call-site emitter re-reads them there (they are stable
  // defined-func mints or reserve-fills, shifted by the body walkers).
  void varargThenIdx;
  void applyClosureIdx;
  void objvecNewIdx;
  void objvecPushIdx;
  (ctx as CtxWithPcap).__promiseCapability = rt;
  return rt;
}

/**
 * FINALIZE fill for the reserved `__pcap_call1` bridge — delegates to the
 * plain `__call_fn_1` closure dispatcher, which only exists once the
 * closure-call exports are emitted (mirrors `fillApplyClosure`). No-op when
 * the capability runtime was never registered; keeps the safe null-returning
 * placeholder when `__call_fn_1` is absent (a module with the reflective
 * shape but no arity-1 closures — the calls then no-op exactly like the
 * pre-#3141 refusal path).
 */
export function fillPromiseCapabilityCall1(ctx: CodegenContext): void {
  const rt = (ctx as CtxWithPcap).__promiseCapability;
  if (!rt) return;
  // `__call_fn_1` is pushed RAW at finalize (no funcMap entry — like the other
  // host-facing exports); locate it by name. Its raw index (numImportFuncs +
  // position) is final at this point — no import can be added after finalize.
  const pos = ctx.mod.functions.findIndex((f) => f.name === "__call_fn_1");
  if (pos < 0) return;
  const callFn1 = ctx.numImportFuncs + pos;
  const fn = definedFuncAt(ctx, rt.pcapCall1FuncIdx);
  if (!fn) return;
  fn.body = [
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "call", funcIdx: callFn1 } as Instr,
  ];
}

/**
 * Call-site emitter for `Promise.<all|race>.call(C, iterable)`. `cInstrs` /
 * `iterInstrs` / `resolveFnInstrs` are pre-compiled externref buffers (kept
 * live by the caller for the late-import shifter): the capability constructor
 * value, the iterable, and the C.resolve function value (module-scan bound —
 * see the #3141 issue file). Leaves capability.promise (externref) on the
 * stack.
 */
export function emitStandalonePromiseCapabilityCombinator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: CapabilityCombinator,
  cInstrs: Instr[],
  iterInstrs: Instr[],
  resolveFnInstrs: Instr[],
): void {
  const rt = ensurePromiseCapabilityRuntime(ctx);
  if (!rt) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    return;
  }
  const varargThenIdx = ctx.funcMap.get("__call_m_then_vararg") ?? reserveClosedMethodDispatchVararg(ctx, "then");
  const toVecIdx = ctx.funcMap.get("__combinator_to_vec")!;
  const objvecNewIdx = ctx.funcMap.get("__objvec_new")!;
  const objvecPushIdx = ctx.funcMap.get("__objvec_push")!;
  const newTypeErrorIdx = ctx.funcMap.get("__new_TypeError")!;
  const exnTag = ensureExnTag(ctx);

  const cLocal = allocLocal(fctx, `__pcap_c_${fctx.locals.length}`, EXTERNREF);
  const capLocal = allocLocal(fctx, `__pcap_cap_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: rt.capTypeIdx,
  });
  const resolveFnLocal = allocLocal(fctx, `__pcap_resolvefn_${fctx.locals.length}`, EXTERNREF);
  const vecLocal = allocLocal(fctx, `__pcap_vec_${fctx.locals.length}`, EXTERNREF);
  const stateLocal = allocLocal(fctx, `__pcap_state_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: rt.allStateTypeIdx,
  });
  const lenLocal = allocLocal(fctx, `__pcap_len_${fctx.locals.length}`, {
    kind: "i32",
  });
  const iLocal = allocLocal(fctx, `__pcap_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  const nextLocal = allocLocal(fctx, `__pcap_next_${fctx.locals.length}`, EXTERNREF);
  const argvLocal = allocLocal(fctx, `__pcap_argv_${fctx.locals.length}`, EXTERNREF);
  const reasonLocal = allocLocal(fctx, `__pcap_reason_${fctx.locals.length}`, EXTERNREF);

  // C, capability (NewPromiseCapability throws synchronously — NOT caught).
  for (const i of cInstrs) fctx.body.push(i);
  fctx.body.push({ op: "local.set", index: cLocal } as Instr);
  fctx.body.push({ op: "local.get", index: cLocal } as Instr);
  fctx.body.push({ op: "call", funcIdx: rt.pcapNewFuncIdx } as Instr);
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "ref.cast", typeIdx: rt.capTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: capLocal } as Instr);

  // C.resolve (module-scan bound closure value).
  for (const i of resolveFnInstrs) fctx.body.push(i);
  fctx.body.push({ op: "local.set", index: resolveFnLocal } as Instr);

  // Everything from GetIterator on is IfAbruptRejectPromise'd: an abrupt
  // completion rejects capability.promise instead of propagating.
  const tryBody: Instr[] = [];

  // vec = __combinator_to_vec(iterable); null → TypeError (rejects via catch).
  for (const i of iterInstrs) tryBody.push(i);
  tryBody.push(
    { op: "call", funcIdx: toVecIdx } as Instr,
    { op: "local.set", index: vecLocal } as Instr,
    { op: "local.get", index: vecLocal } as Instr,
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...(stringConstantExternrefInstrs(ctx, NOT_ITERABLE_MSG) as Instr[]),
        { op: "call", funcIdx: newTypeErrorIdx } as Instr,
        { op: "throw", tagIdx: exnTag } as Instr,
      ],
    } as Instr,
    // len = vec.length
    { op: "local.get", index: vecLocal } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: rt.vecTypeIdx } as Instr,
    { op: "struct.get", typeIdx: rt.vecTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: lenLocal } as Instr,
  );

  if (method === "all") {
    // state = { values: new arr(len), remaining: 1 (spec seed), cap }
    tryBody.push(
      { op: "local.get", index: lenLocal } as Instr,
      { op: "array.new_default", typeIdx: rt.arrTypeIdx } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.get", index: capLocal } as Instr,
      { op: "struct.new", typeIdx: rt.allStateTypeIdx } as Instr,
      { op: "local.set", index: stateLocal } as Instr,
    );
  }

  // for (i = 0; i < len; i++)
  const loopBody: Instr[] = [
    { op: "local.get", index: iLocal } as Instr,
    { op: "local.get", index: lenLocal } as Instr,
    { op: "i32.ge_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // next = Call(C.resolve, C, «elem») — plain 1-arg bridge
    { op: "local.get", index: resolveFnLocal } as Instr,
    { op: "local.get", index: vecLocal } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "ref.cast", typeIdx: rt.vecTypeIdx } as Instr,
    { op: "struct.get", typeIdx: rt.vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "array.get", typeIdx: rt.arrTypeIdx } as Instr,
    { op: "call", funcIdx: rt.pcapCall1FuncIdx } as Instr,
    { op: "local.set", index: nextLocal } as Instr,
  ];

  if (method === "all") {
    loopBody.push(
      // remaining += 1
      { op: "local.get", index: stateLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "local.get", index: stateLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: rt.allStateTypeIdx, fieldIdx: 1 } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.add" } as Instr,
      { op: "struct.set", typeIdx: rt.allStateTypeIdx, fieldIdx: 1 } as Instr,
      // argv2 = [ new elemFn(state, i), cap.reject ]   (__objvec_push is void)
      { op: "call", funcIdx: objvecNewIdx } as Instr,
      { op: "local.set", index: argvLocal } as Instr,
      { op: "local.get", index: argvLocal } as Instr,
      { op: "ref.func", funcIdx: rt.allElemFuncIdx } as Instr,
      { op: "local.get", index: stateLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "local.get", index: iLocal } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "struct.new", typeIdx: rt.allElemCapTypeIdx } as Instr,
      { op: "extern.convert_any" } as Instr,
      { op: "call", funcIdx: objvecPushIdx } as Instr,
      { op: "local.get", index: argvLocal } as Instr,
      { op: "local.get", index: capLocal } as Instr,
      { op: "struct.get", typeIdx: rt.capTypeIdx, fieldIdx: 1 } as Instr,
      { op: "call", funcIdx: objvecPushIdx } as Instr,
    );
  } else {
    // race: capability.resolve / capability.reject directly (§25.6.4.3.1 —
    // same-resolve-function.js asserts identity across elements).
    loopBody.push(
      { op: "call", funcIdx: objvecNewIdx } as Instr,
      { op: "local.set", index: argvLocal } as Instr,
      { op: "local.get", index: argvLocal } as Instr,
      { op: "local.get", index: capLocal } as Instr,
      { op: "struct.get", typeIdx: rt.capTypeIdx, fieldIdx: 0 } as Instr,
      { op: "call", funcIdx: objvecPushIdx } as Instr,
      { op: "local.get", index: argvLocal } as Instr,
      { op: "local.get", index: capLocal } as Instr,
      { op: "struct.get", typeIdx: rt.capTypeIdx, fieldIdx: 1 } as Instr,
      { op: "call", funcIdx: objvecPushIdx } as Instr,
    );
  }

  const peelIdx = ctx.funcMap.get("__promise_peel_value");
  loopBody.push(
    // Invoke(next, "then", argv2) — peel a $AnyValue-boxed next first (the
    // thenable-job discipline; module-global elements arrive boxed).
    { op: "local.get", index: nextLocal } as Instr,
    ...(peelIdx !== undefined ? [{ op: "call", funcIdx: peelIdx } as Instr] : []),
    { op: "local.get", index: argvLocal } as Instr,
    { op: "call", funcIdx: varargThenIdx } as Instr,
    { op: "drop" } as Instr,
    { op: "local.get", index: iLocal } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: iLocal } as Instr,
    { op: "br", depth: 0 } as Instr,
  );

  tryBody.push(
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: iLocal } as Instr,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
    } as Instr,
  );

  if (method === "all") {
    // post-loop: remaining -= 1; if 0 → Call(cap.resolve, undefined, «values»)
    tryBody.push(
      { op: "local.get", index: stateLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "local.get", index: stateLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: rt.allStateTypeIdx, fieldIdx: 1 } as Instr,
      { op: "i32.const", value: 1 } as Instr,
      { op: "i32.sub" } as Instr,
      { op: "struct.set", typeIdx: rt.allStateTypeIdx, fieldIdx: 1 } as Instr,
      { op: "local.get", index: stateLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: rt.allStateTypeIdx, fieldIdx: 1 } as Instr,
      { op: "i32.eqz" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: capLocal } as Instr,
          { op: "struct.get", typeIdx: rt.capTypeIdx, fieldIdx: 0 } as Instr,
          { op: "local.get", index: lenLocal } as Instr,
          { op: "local.get", index: stateLocal } as Instr,
          { op: "ref.as_non_null" } as Instr,
          {
            op: "struct.get",
            typeIdx: rt.allStateTypeIdx,
            fieldIdx: 0,
          } as Instr,
          { op: "struct.new", typeIdx: rt.vecTypeIdx } as Instr,
          { op: "extern.convert_any" } as Instr,
          { op: "call", funcIdx: rt.pcapCall1FuncIdx } as Instr,
          { op: "drop" } as Instr,
        ],
      } as Instr,
    );
  }

  fctx.body.push({
    op: "try",
    blockType: { kind: "empty" },
    body: tryBody,
    catches: [
      {
        tagIdx: exnTag,
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: capLocal },
          { op: "extern.convert_any" } as Instr,
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: rt.rejectWithFuncIdx } as Instr,
        ],
      },
    ],
  } as Instr);

  // Result: capability.promise
  fctx.body.push({ op: "local.get", index: capLocal } as Instr);
  fctx.body.push({
    op: "struct.get",
    typeIdx: rt.capTypeIdx,
    fieldIdx: 2,
  } as Instr);
}
