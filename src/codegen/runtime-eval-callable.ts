// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Cross-module AOT-callable carrier for the standalone runtime-eval provider.
 *
 * Ordinary closures use a module-local wrapper hierarchy whose root depends on
 * allocation order. A separately compiled provider cannot reliably classify
 * every typed AOT closure stored on the caller's global object. This carrier is
 * a closed three-type recursive shape shared structurally by both modules:
 *
 *   carrier { code: (ref codeType), get: (ref getType), target: externref,
 *             brandA: i32, brandB: i32 }
 *   code(carrier, receiver, argc, arg0, ..., arg7) -> externref
 *
 * The provider calls `code` before ordinary closure dispatch. It extracts the
 * values from its private argument vector and passes them explicitly. The code
 * lives in the caller module, rebuilds a caller-owned vector, and forwards
 * `target`, `receiver`, and those values through that module's own
 * `__apply_closure`. No module-private `$ObjVec` crosses the link boundary.
 */

import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { ensureObjectRuntime, ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { collectClosureBaseWrapperTypeIdxs } from "./closure-classifier.js";
import { ensureNativeStringHelpers, nativeStringLiteralInstrs } from "./native-strings.js";
import {
  ensureRuntimeEvalInterpretedCallbackType,
  ensureRuntimeEvalProviderActiveGlobal,
  RUNTIME_EVAL_AOT_CALLABLE_BRAND_A,
  RUNTIME_EVAL_AOT_CALLABLE_BRAND_B,
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A,
  RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B,
  RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION,
} from "./runtime-eval-boundary.js";

export interface RuntimeEvalAotCallableCarrier {
  structTypeIdx: number;
  funcTypeIdx: number;
  propertyGetFuncTypeIdx: number;
  trampolineFuncIdx?: number;
  propertyGetTrampolineFuncIdx?: number;
  interpretedTrampolineFuncIdx?: number;
  /** `(externref) -> externref` — see {@link ensureRuntimeEvalCallableWrapHelper}. */
  wrapHelperFuncIdx?: number;
}

export const RUNTIME_EVAL_WRAP_CALLABLE = "__runtime_eval_wrap_callable";
/** Private `moduleGlobals` key for the one-entry carrier memo (see below). */
const RUNTIME_EVAL_CARRIER_MEMO_GLOBAL = "\0runtime-eval-carrier-memo";

const RUNTIME_EVAL_PUSH_GLOBALS = "__runtime_eval_push_globals";
const RUNTIME_EVAL_PULL_GLOBALS = "__runtime_eval_pull_globals";

function syncedTrampolineBody(
  ctx: CodegenContext,
  carrier: RuntimeEvalAotCallableCarrier,
  applyIdx: number,
  direction: "aot" | "interpreted",
): { locals: { name: string; type: ValType }[]; body: Instr[] } {
  const { newIdx: objVecNewIdx, pushIdx: objVecPushIdx } = ensureObjVecBuilders(ctx);
  const beforeName = direction === "aot" ? RUNTIME_EVAL_PULL_GLOBALS : RUNTIME_EVAL_PUSH_GLOBALS;
  const afterName = direction === "aot" ? RUNTIME_EVAL_PUSH_GLOBALS : RUNTIME_EVAL_PULL_GLOBALS;
  const beforeIdx = ctx.funcMap.get(beforeName);
  const afterIdx = ctx.funcMap.get(afterName);
  const activeGlobalIdx = ctx.runtimeEvalProviderActiveGlobalIdx;
  // Params: 0=carrier, 1=receiver, 2=argc, 3..10=arg0..arg7.
  const argsLocal = 11;
  const buildArgs: Instr[] = [
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: argsLocal },
  ];
  for (let i = 0; i < 8; i++) {
    buildArgs.push(
      { op: "local.get", index: 2 },
      { op: "i32.const", value: i },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: argsLocal },
          { op: "local.get", index: 3 + i },
          { op: "call", funcIdx: objVecPushIdx },
        ],
      },
    );
  }
  const callBody: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 2 },
    { op: "local.get", index: 1 },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: applyIdx },
  ];
  const argsLocalDecl = { name: "args", type: { kind: "externref" } as ValType };
  if (beforeIdx === undefined || afterIdx === undefined || activeGlobalIdx === undefined) {
    return { locals: [argsLocalDecl], body: [...buildArgs, ...callBody] };
  }
  const resultLocal = 12;
  return {
    locals: [argsLocalDecl, { name: "result", type: { kind: "externref" } }],
    body: [
      ...buildArgs,
      { op: "global.get", index: activeGlobalIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "call", funcIdx: beforeIdx },
          ...callBody,
          { op: "local.set", index: resultLocal },
          { op: "call", funcIdx: afterIdx },
          { op: "local.get", index: resultLocal },
        ],
        else: callBody,
      },
    ],
  };
}

function syncedPropertyGetTrampolineBody(
  ctx: CodegenContext,
  carrier: RuntimeEvalAotCallableCarrier,
): { locals: { name: string; type: ValType }[]; body: Instr[] } {
  ensureObjectRuntime(ctx);
  ensureNativeStringHelpers(ctx);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) return { locals: [], body: [{ op: "ref.null.extern" }] };
  const closurePropGetIdx = ctx.funcMap.get("__closure_prop_get");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const callbackTypeIdx = ensureRuntimeEvalInterpretedCallbackType(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const resultLocal = 2;
  const anyLocal = 3;
  const markerLocal = 4;
  const keyAnyLocal = 5;
  const rawTargetGet = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 2 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: externGetIdx },
  ];
  const markerBrandsMatch = (): Instr[] => [
    { op: "local.get", index: markerLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 1 },
    { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A },
    { op: "i32.eq" },
    { op: "local.get", index: markerLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 2 },
    { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B },
    { op: "i32.eq" },
    { op: "i32.and" },
  ];
  const readMarkerMetadata = (): Instr[] => {
    if (flattenIdx === undefined || equalsIdx === undefined || boxNumberIdx === undefined || ctx.anyStrTypeIdx < 0) {
      return rawTargetGet();
    }
    const keyEquals = (name: string): Instr[] => [
      { op: "local.get", index: keyAnyLocal },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "call", funcIdx: flattenIdx },
      ...nativeStringLiteralInstrs(ctx, name),
      { op: "call", funcIdx: equalsIdx },
    ];
    return [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 2 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: callbackTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 2 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: callbackTypeIdx },
          { op: "local.set", index: markerLocal },
          ...markerBrandsMatch(),
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "local.tee", index: keyAnyLocal },
          { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              ...keyEquals("name"),
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } },
                then: [
                  { op: "local.get", index: markerLocal },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 4 },
                ],
                else: [
                  ...keyEquals("length"),
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "externref" } },
                    then: [
                      { op: "local.get", index: markerLocal },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 5 },
                      { op: "call", funcIdx: boxNumberIdx },
                    ],
                    else: [
                      ...keyEquals("constructor"),
                      {
                        op: "if",
                        blockType: { kind: "val", type: { kind: "externref" } },
                        then: [
                          { op: "local.get", index: markerLocal },
                          { op: "ref.as_non_null" },
                          { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 3 },
                          { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: { kind: "externref" } },
                            then: [
                              { op: "local.get", index: 0 },
                              { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 2 },
                            ],
                            else: [
                              { op: "local.get", index: markerLocal },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 6 },
                            ],
                          },
                        ],
                        else: rawTargetGet(),
                      },
                    ],
                  },
                ],
              },
            ],
            else: rawTargetGet(),
          },
        ],
        else: rawTargetGet(),
      },
    ];
  };
  const readTarget: Instr[] = [...readMarkerMetadata(), { op: "local.set", index: resultLocal }];
  const readBody: Instr[] =
    closurePropGetIdx !== undefined && isUndefinedIdx !== undefined
      ? [
          // Runtime-eval global seeding replaces an AOT closure with this
          // carrier. Later source-level writes such as `assert.throws = fn`
          // therefore land in the carrier's closure-own-property bag, not the
          // raw target closure's bag. Read that identity first. Calling the
          // universal __extern_get on the carrier would recurse through the
          // carrier front-guard, so use the private bag helper directly.
          { op: "local.get", index: 0 },
          { op: "extern.convert_any" },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: closurePropGetIdx },
          { op: "local.tee", index: resultLocal },
          { op: "call", funcIdx: isUndefinedIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            // Intrinsic function properties that were never assigned on the
            // carrier (`name`, `length`, `prototype`, …) remain target-owned.
            then: readTarget,
          },
          { op: "local.get", index: resultLocal },
          { op: "any.convert_extern" },
          { op: "local.set", index: anyLocal },
        ]
      : [
          ...readTarget,
          { op: "local.get", index: resultLocal },
          { op: "any.convert_extern" },
          { op: "local.set", index: anyLocal },
        ];
  if (carrier.trampolineFuncIdx !== undefined && carrier.propertyGetTrampolineFuncIdx !== undefined) {
    // The shared callable classifier intentionally includes this carrier so
    // `typeof`, apply, and ordinary dynamic calls all see it as a function.
    // A property that is already a carrier must cross this getter unchanged,
    // however: wrapping it again makes the outer trampoline feed the inner
    // carrier to the module-local closure dispatcher as though it were a raw
    // closure. Nested eval reaches this path when an AOT harness function is
    // read back from the shared global object more than once.
    for (const typeIdx of collectClosureBaseWrapperTypeIdxs(ctx)) {
      if (typeIdx === carrier.structTypeIdx) continue;
      readBody.push(
        { op: "local.get", index: anyLocal },
        { op: "ref.test", typeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "ref.func", funcIdx: carrier.trampolineFuncIdx },
            { op: "ref.func", funcIdx: carrier.propertyGetTrampolineFuncIdx },
            { op: "local.get", index: resultLocal },
            { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_A },
            { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_B },
            { op: "struct.new", typeIdx: carrier.structTypeIdx },
            { op: "extern.convert_any" },
            { op: "local.set", index: resultLocal },
          ],
        },
      );
    }
  }
  const beforeIdx = ctx.funcMap.get(RUNTIME_EVAL_PULL_GLOBALS);
  const afterIdx = ctx.funcMap.get(RUNTIME_EVAL_PUSH_GLOBALS);
  const activeGlobalIdx = ctx.runtimeEvalProviderActiveGlobalIdx;
  const locals = [
    { name: "result", type: { kind: "externref" } as ValType },
    { name: "any", type: { kind: "anyref" } as ValType },
    { name: "marker", type: { kind: "ref_null", typeIdx: callbackTypeIdx } as ValType },
    { name: "key_any", type: { kind: "anyref" } as ValType },
  ];
  if (beforeIdx === undefined || afterIdx === undefined || activeGlobalIdx === undefined) {
    return { locals, body: [...readBody, { op: "local.get", index: resultLocal }] };
  }
  return {
    locals,
    body: [
      { op: "global.get", index: activeGlobalIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "call", funcIdx: beforeIdx },
          ...readBody,
          { op: "call", funcIdx: afterIdx },
          { op: "local.get", index: resultLocal },
        ],
        else: [...readBody, { op: "local.get", index: resultLocal }],
      },
    ],
  };
}

/**
 * (#4307) Body of `__runtime_eval_wrap_callable`: replace a RAW module-local
 * closure with the canonical carrier, and pass everything else — primitives,
 * plain objects, and a value that is ALREADY a carrier — through byte-for-byte.
 *
 * Wrapping is idempotent by construction: the classifier's carrier arm is
 * skipped, so a second crossing of the same binding re-tests as "already a
 * carrier" and returns the identical reference. That is what keeps `f === f`
 * across two separate evaluations.
 *
 * IDENTITY across two DIFFERENT bindings of one closure (`var g = f`) needs
 * more than idempotence — each cell would otherwise mint its own carrier and
 * `f === g` would read false inside evaluated code, which it does not today.
 * A one-entry most-recent-target memo covers that: aliases are wrapped in the
 * same push loop, back to back, against the same target, so the second one
 * hits. Once a cell holds a carrier it is never re-wrapped, so the memo cannot
 * thrash across evaluations either. It is a cache, not a registry — a program
 * that interleaves N distinct closures per crossing keeps only the last, which
 * is a documented residual rather than a correctness hazard (the miss path
 * mints a fresh carrier, which is exactly today's behaviour).
 */
function callableWrapHelperBody(ctx: CodegenContext, carrier: RuntimeEvalAotCallableCarrier): Instr[] {
  const trampolineFuncIdx = carrier.trampolineFuncIdx;
  const propertyGetTrampolineFuncIdx = carrier.propertyGetTrampolineFuncIdx;
  if (trampolineFuncIdx === undefined || propertyGetTrampolineFuncIdx === undefined) {
    return [{ op: "local.get", index: 0 }];
  }
  const memoIdx = ctx.moduleGlobals.get(RUNTIME_EVAL_CARRIER_MEMO_GLOBAL);
  const memoTarget = (): Instr[] => [
    { op: "global.get", index: memoIdx! },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 2 },
    { op: "any.convert_extern" },
  ];
  // WasmGC `eq` abstract heap type — the same encoding `__extern_strict_eq`
  // uses for its object-identity fast path.
  const EQ_HEAP_TYPE = -19;
  const memoHit = (): Instr[] =>
    memoIdx === undefined
      ? []
      : [
          { op: "global.get", index: memoIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...memoTarget(),
              { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...memoTarget(),
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "local.get", index: 0 },
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                  { op: "ref.eq" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      { op: "global.get", index: memoIdx },
                      { op: "ref.as_non_null" },
                      { op: "extern.convert_any" },
                      { op: "return" },
                    ],
                  },
                ],
              },
            ],
          },
        ];
  // Fresh per arm: late-import index shifting rewrites `funcIdx` in place, and a
  // shared array would be shifted once per arm that references it.
  const mint = (): Instr[] => [
    { op: "ref.func", funcIdx: trampolineFuncIdx },
    { op: "ref.func", funcIdx: propertyGetTrampolineFuncIdx },
    { op: "local.get", index: 0 },
    { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_A },
    { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_B },
    { op: "struct.new", typeIdx: carrier.structTypeIdx },
    ...(memoIdx === undefined
      ? ([{ op: "extern.convert_any" }] satisfies Instr[])
      : ([
          { op: "global.set", index: memoIdx },
          { op: "global.get", index: memoIdx },
          { op: "ref.as_non_null" },
          { op: "extern.convert_any" },
        ] satisfies Instr[])),
    { op: "return" },
  ];
  const body: Instr[] = [];
  for (const typeIdx of collectClosureBaseWrapperTypeIdxs(ctx)) {
    if (typeIdx === carrier.structTypeIdx) continue;
    body.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx },
      { op: "if", blockType: { kind: "empty" }, then: [...memoHit(), ...mint()] },
    );
  }
  body.push({ op: "local.get", index: 0 });
  return body;
}

/**
 * (#4307) Reserve the caller-owned "carrier-wrap this value if it is a closure"
 * helper and return its function index.
 *
 * WHY A HELPER FUNCTION and not an inline sequence at each call site: the set of
 * closure base-wrapper types is not final until every closure in the module has
 * been emitted, so an inline `ref.test` ladder built while compiling an
 * expression would test against a PARTIAL hierarchy and silently miss the very
 * closures declared after it. Routing through one function whose body is rebuilt
 * by {@link refreshRuntimeEvalCallableTrampolines} at finalize time — the same
 * discipline the carrier trampolines already use — makes the ladder complete.
 */
export function ensureRuntimeEvalCallableWrapHelper(ctx: CodegenContext): number {
  const carrier = ensureRuntimeEvalAotCallableTrampoline(ctx);
  ensureRuntimeEvalAotCallablePropertyGetTrampoline(ctx);
  if (carrier.wrapHelperFuncIdx !== undefined) return carrier.wrapHelperFuncIdx;
  if (!ctx.moduleGlobals.has(RUNTIME_EVAL_CARRIER_MEMO_GLOBAL)) {
    // Registered in `moduleGlobals` under a private key so the established
    // late-import global fixup shifts it with every source-level module global;
    // the body builder re-reads the live index on every rebuild.
    const memoIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: "__runtime_eval_carrier_memo",
      type: { kind: "ref_null", typeIdx: carrier.structTypeIdx },
      mutable: true,
      init: [{ op: "ref.null", typeIdx: carrier.structTypeIdx }],
    });
    ctx.moduleGlobals.set(RUNTIME_EVAL_CARRIER_MEMO_GLOBAL, memoIdx);
  }
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: RUNTIME_EVAL_WRAP_CALLABLE,
    typeIdx,
    locals: [],
    body: callableWrapHelperBody(ctx, carrier),
    exported: false,
  });
  ctx.funcMap.set(RUNTIME_EVAL_WRAP_CALLABLE, funcIdx);
  carrier.wrapHelperFuncIdx = funcIdx;
  return funcIdx;
}

/**
 * (#4307) The INVERSE of {@link ensureRuntimeEvalCallableWrapHelper}, for the
 * AOT side: consume an `anyref` and leave the closure a carrier wraps, passing
 * every other value through unchanged.
 *
 * Needed because #4307 makes a direct-eval binding cell hold the carrier once
 * the binding has crossed the seam, and the STATIC closure-call fast path
 * (`compileClosureCall`) reaches the callee by guard-casting the cell's value
 * to the lifted self-carrier struct. A carrier fails that cast, the cast yields
 * null, and the call traps on a null funcref. Unwrapping to `target` — which is
 * the very closure the carrier was minted around — restores the fast path with
 * no dispatch, no argument vector, and no `this` bookkeeping.
 *
 * Emits nothing in a module that never minted a carrier, which is every module
 * that does not consume the runtime-eval provider.
 */
export function emitRuntimeEvalCarrierUnwrapAny(ctx: CodegenContext, fctx: FunctionContext): void {
  const carrier = ctx.runtimeEvalAotCallableCarrier;
  if (carrier === undefined) return;
  const anyLocal = allocLocal(fctx, `__runtime_eval_unwrap_any_${fctx.locals.length}`, { kind: "anyref" });
  fctx.body.push(
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: carrier.structTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "anyref" } },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: carrier.structTypeIdx },
        { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 2 },
        { op: "any.convert_extern" },
      ],
      else: [{ op: "local.get", index: anyLocal }],
    },
  );
}

/** Rebuild already-reserved carrier trampolines after global sync helpers appear. */
export function refreshRuntimeEvalCallableTrampolines(ctx: CodegenContext): void {
  const carrier = ctx.runtimeEvalAotCallableCarrier;
  if (!carrier) return;
  if (carrier.wrapHelperFuncIdx !== undefined) {
    const fn = definedFuncAt(ctx, carrier.wrapHelperFuncIdx);
    if (fn) fn.body = callableWrapHelperBody(ctx, carrier);
  }
  const applyIdx = ctx.funcMap.get("__apply_closure");
  if (applyIdx === undefined) return;
  if (carrier.trampolineFuncIdx !== undefined) {
    const fn = definedFuncAt(ctx, carrier.trampolineFuncIdx);
    if (fn) {
      const built = syncedTrampolineBody(ctx, carrier, applyIdx, "aot");
      fn.locals = built.locals;
      fn.body = built.body;
    }
  }
  if (carrier.interpretedTrampolineFuncIdx !== undefined) {
    const fn = definedFuncAt(ctx, carrier.interpretedTrampolineFuncIdx);
    if (fn) {
      const built = syncedTrampolineBody(ctx, carrier, applyIdx, "interpreted");
      fn.locals = built.locals;
      fn.body = built.body;
    }
  }
  if (carrier.propertyGetTrampolineFuncIdx !== undefined) {
    const fn = definedFuncAt(ctx, carrier.propertyGetTrampolineFuncIdx);
    if (fn) {
      const built = syncedPropertyGetTrampolineBody(ctx, carrier);
      fn.locals = built.locals;
      fn.body = built.body;
    }
  }
}

/** Register the canonical recursive carrier types without emitting a value. */
export function ensureRuntimeEvalAotCallableCarrierTypes(ctx: CodegenContext): RuntimeEvalAotCallableCarrier {
  const cached = ctx.runtimeEvalAotCallableCarrier;
  if (cached) return cached;
  ensureRuntimeEvalProviderActiveGlobal(ctx);

  const structTypeIdx = ctx.mod.types.length;
  const funcTypeIdx = structTypeIdx + 1;
  const propertyGetFuncTypeIdx = structTypeIdx + 2;
  ctx.mod.types.push(
    {
      kind: "struct",
      name: "$RuntimeEvalAotCallable",
      fields: [
        {
          name: "code",
          type: { kind: "ref", typeIdx: funcTypeIdx },
          mutable: false,
        },
        {
          name: "get",
          type: { kind: "ref", typeIdx: propertyGetFuncTypeIdx },
          mutable: false,
        },
        { name: "target", type: { kind: "externref" }, mutable: false },
        { name: "brandA", type: { kind: "i32" }, mutable: false },
        { name: "brandB", type: { kind: "i32" }, mutable: false },
      ],
      superTypeIdx: -1,
    },
    {
      kind: "func",
      name: "$RuntimeEvalAotCallableCode",
      params: [
        { kind: "ref", typeIdx: structTypeIdx },
        { kind: "externref" },
        { kind: "i32" },
        ...Array.from({ length: 8 }, () => ({ kind: "externref" }) as ValType),
      ],
      results: [{ kind: "externref" }],
    },
    {
      kind: "func",
      name: "$RuntimeEvalAotCallableGet",
      params: [{ kind: "ref", typeIdx: structTypeIdx }, { kind: "externref" }],
      results: [{ kind: "externref" }],
    },
  );

  const carrier: RuntimeEvalAotCallableCarrier = { structTypeIdx, funcTypeIdx, propertyGetFuncTypeIdx };
  ctx.runtimeEvalAotCallableCarrier = carrier;
  return carrier;
}

function ensureRuntimeEvalAotCallablePropertyGetTrampoline(
  ctx: CodegenContext,
): RuntimeEvalAotCallableCarrier & { propertyGetTrampolineFuncIdx: number } {
  const carrier = ensureRuntimeEvalAotCallableCarrierTypes(ctx);
  if (carrier.propertyGetTrampolineFuncIdx !== undefined) {
    return carrier as RuntimeEvalAotCallableCarrier & { propertyGetTrampolineFuncIdx: number };
  }
  const propertyGetTrampolineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, propertyGetTrampolineFuncIdx, {
    name: "__runtime_eval_get_aot_property",
    typeIdx: carrier.propertyGetFuncTypeIdx,
    locals: [],
    body: [{ op: "ref.null.extern" }],
    exported: false,
  });
  ctx.funcMap.set("__runtime_eval_get_aot_property", propertyGetTrampolineFuncIdx);
  carrier.propertyGetTrampolineFuncIdx = propertyGetTrampolineFuncIdx;
  if (!ctx.mod.declaredFuncRefs.includes(propertyGetTrampolineFuncIdx)) {
    ctx.mod.declaredFuncRefs.push(propertyGetTrampolineFuncIdx);
  }
  const built = syncedPropertyGetTrampolineBody(ctx, carrier);
  const fn = definedFuncAt(ctx, propertyGetTrampolineFuncIdx);
  if (fn) {
    fn.locals = built.locals;
    fn.body = built.body;
  }
  return carrier as RuntimeEvalAotCallableCarrier & { propertyGetTrampolineFuncIdx: number };
}

function ensureRuntimeEvalAotCallableTrampoline(
  ctx: CodegenContext,
): RuntimeEvalAotCallableCarrier & { trampolineFuncIdx: number } {
  const carrier = ensureRuntimeEvalAotCallableCarrierTypes(ctx);
  if (carrier.trampolineFuncIdx !== undefined) {
    return carrier as RuntimeEvalAotCallableCarrier & { trampolineFuncIdx: number };
  }

  ensureObjectRuntime(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const built = syncedTrampolineBody(ctx, carrier, applyIdx, "aot");
  const trampolineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, trampolineFuncIdx, {
    name: "__runtime_eval_call_aot",
    typeIdx: carrier.funcTypeIdx,
    locals: built.locals,
    body: built.body,
    exported: false,
  });
  ctx.funcMap.set("__runtime_eval_call_aot", trampolineFuncIdx);
  carrier.trampolineFuncIdx = trampolineFuncIdx;
  if (!ctx.mod.declaredFuncRefs.includes(trampolineFuncIdx)) {
    ctx.mod.declaredFuncRefs.push(trampolineFuncIdx);
  }
  return carrier as RuntimeEvalAotCallableCarrier & { trampolineFuncIdx: number };
}

function ensureRuntimeEvalInterpretedCallableTrampoline(
  ctx: CodegenContext,
): RuntimeEvalAotCallableCarrier & { interpretedTrampolineFuncIdx: number } {
  const carrier = ensureRuntimeEvalAotCallableCarrierTypes(ctx);
  if (carrier.interpretedTrampolineFuncIdx !== undefined) {
    return carrier as RuntimeEvalAotCallableCarrier & { interpretedTrampolineFuncIdx: number };
  }
  ensureObjectRuntime(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const built = syncedTrampolineBody(ctx, carrier, applyIdx, "interpreted");
  const interpretedTrampolineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, interpretedTrampolineFuncIdx, {
    name: "__runtime_eval_call_interpreted",
    typeIdx: carrier.funcTypeIdx,
    locals: built.locals,
    body: built.body,
    exported: false,
  });
  ctx.funcMap.set("__runtime_eval_call_interpreted", interpretedTrampolineFuncIdx);
  carrier.interpretedTrampolineFuncIdx = interpretedTrampolineFuncIdx;
  if (!ctx.mod.declaredFuncRefs.includes(interpretedTrampolineFuncIdx)) {
    ctx.mod.declaredFuncRefs.push(interpretedTrampolineFuncIdx);
  }
  return carrier as RuntimeEvalAotCallableCarrier & { interpretedTrampolineFuncIdx: number };
}

/**
 * Explicit value slots in the carrier's `code` signature — see the header
 * comment and `ensureRuntimeEvalAotCallableCarrierTypes`. A dispatcher wider
 * than this forwards only the first `RUNTIME_EVAL_AOT_CALLABLE_ARGS` values,
 * exactly as `__apply_closure`'s carrier arm does.
 */
const RUNTIME_EVAL_AOT_CALLABLE_ARGS = 8;

/**
 * (#4197) Carrier front-guard for the `__call_fn_method_<arity>` dispatchers.
 *
 * In runtime-eval CONSUMER mode every top-level function DECLARATION becomes a
 * live binding (`ctx.liveFuncBindingGlobals`), and `__module_init` seeds its
 * module global with the closure wrapped in this carrier
 * (`emitRuntimeEvalAotCallableAdapter`). Reading the name as a VALUE therefore
 * yields the CARRIER, not a closure struct.
 *
 * `__call_fn_method_<arity>` dispatches by `ref.test`ing the operand against
 * the closure wrapper root and the per-shape ladder (`buildFuncrefExtraction`).
 * The carrier has `superTypeIdx: -1` and a field 0 typed
 * `(ref $RuntimeEvalAotCallableCode)`, so it matches NOTHING and the dispatcher
 * falls through to `ref.null.extern`. Every consumer of that dispatcher then
 * reads `undefined`: `__call_accessor_get` / `__call_accessor_set` (so
 * `Object.defineProperty(o, k, { get: fnDecl })` answers null on a reference
 * receiver and 0 after a numeric unbox on a plain object, and a setter write is
 * dropped), plus the JSON reviver / `toJSON` / replacer drivers.
 *
 * `__apply_closure` already carries exactly this guard (`object-runtime.ts`,
 * #2928) — which is precisely why a DIRECT call of the same declaration works
 * while the accessor lane does not, and why a function EXPRESSION getter (never
 * carrier-wrapped) works in the very same module. This mirrors that guard for
 * the method-dispatch lane.
 *
 * Returns `null` when the module minted no carrier — i.e. every non-consumer
 * module, which therefore stays byte-identical.
 *
 * Emission contract: splice the result in AFTER the closure operand has been
 * stored into `closureAnyLocal` (anyref) and BEFORE `__current_this` is
 * saved/installed. The guard `return`s on a hit and the carrier's `code` routes
 * through `__apply_closure`, which installs the receiver itself — so taking the
 * early exit ahead of the save leaves no `__current_this` bookkeeping to unwind.
 */
export function buildRuntimeEvalCarrierMethodDispatch(
  ctx: CodegenContext,
  arity: number,
  closureAnyLocal: number,
  thisValLocal: number,
): Instr[] | null {
  const carrier = ctx.runtimeEvalAotCallableCarrier;
  if (carrier === undefined) return null;

  // `argc` is the dispatcher's declared arity: the same "caller supplied no
  // exact count" convention the ordinary entries fall back to when `__argc`
  // holds its -1 sentinel. Reading `__argc` here instead would be actively
  // wrong — nothing seeds it on the accessor path, so a stale 0 would drop a
  // setter's value argument.
  const forwarded = Math.min(arity, RUNTIME_EVAL_AOT_CALLABLE_ARGS);
  const castCarrier: Instr[] = [
    { op: "local.get", index: closureAnyLocal },
    { op: "ref.cast", typeIdx: carrier.structTypeIdx },
  ];
  const brandEq = (fieldIdx: number, brand: number): Instr[] => [
    ...castCarrier,
    { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx },
    { op: "i32.const", value: brand },
    { op: "i32.eq" },
  ];
  const args: Instr[] = [];
  for (let i = 0; i < RUNTIME_EVAL_AOT_CALLABLE_ARGS; i++) {
    // User args occupy locals [2 .. arity+1] in every `__call_fn_method_N`
    // body; slots past the dispatcher's arity are genuinely absent.
    args.push(i < forwarded ? { op: "local.get", index: i + 2 } : { op: "ref.null.extern" });
  }
  return [
    { op: "local.get", index: closureAnyLocal },
    { op: "ref.test", typeIdx: carrier.structTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...brandEq(3, RUNTIME_EVAL_AOT_CALLABLE_BRAND_A),
        ...brandEq(4, RUNTIME_EVAL_AOT_CALLABLE_BRAND_B),
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // code(self, receiver, argc, arg0, …, arg7)
            ...castCarrier,
            { op: "local.get", index: thisValLocal },
            { op: "i32.const", value: forwarded },
            ...args,
            ...castCarrier,
            { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 0 },
            { op: "call_ref", typeIdx: carrier.funcTypeIdx },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** Replace an externref callable on the stack with the canonical carrier. */
export function emitRuntimeEvalAotCallableAdapter(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const carrier = ensureRuntimeEvalAotCallableTrampoline(ctx);
  const propertyCarrier = ensureRuntimeEvalAotCallablePropertyGetTrampoline(ctx);
  const targetLocal = allocLocal(fctx, `__runtime_eval_aot_target_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push(
    { op: "local.set", index: targetLocal },
    { op: "ref.func", funcIdx: carrier.trampolineFuncIdx },
    { op: "ref.func", funcIdx: propertyCarrier.propertyGetTrampolineFuncIdx },
    { op: "local.get", index: targetLocal },
    { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_A },
    { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_B },
    { op: "struct.new", typeIdx: carrier.structTypeIdx },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" };
}

/**
 * Let the provider's universal dynamic getter delegate property reads on a
 * foreign AOT callable back to the module that owns the function object. The
 * carrier's call trampoline alone preserves invocation, but function objects
 * such as Test262's `assert` also own methods (`assert.throws`,
 * `assert.sameValue`) that cannot be inspected from a separately compiled
 * module's nominal struct table.
 */
export function fillRuntimeEvalCallablePropertyGetArm(ctx: CodegenContext): void {
  if (!ctx.standalone && !ctx.wasi) return;
  const carrier = ctx.runtimeEvalAotCallableCarrier;
  if (carrier === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!fn) return;
  // Rebuild the caller-owned getter trampoline now that the complete closure
  // hierarchy is known. Any callable property it reads is wrapped in the same
  // canonical carrier before it returns to the provider.
  refreshRuntimeEvalCallableTrampolines(ctx);
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: carrier.structTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: carrier.structTypeIdx },
        { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 3 },
        { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_A },
        { op: "i32.eq" },
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: carrier.structTypeIdx },
        { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 4 },
        { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_B },
        { op: "i32.eq" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: carrier.structTypeIdx },
            { op: "local.get", index: 1 },
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: carrier.structTypeIdx },
            { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 1 },
            { op: "call_ref", typeIdx: carrier.propertyGetFuncTypeIdx },
            { op: "return" },
          ],
        },
      ],
    },
  );

  // `name` and `length` are own data properties of every function object.
  // A cross-module carrier cannot ask its nominally-private target whether
  // those properties exist, so answer them from the same branded identity
  // whose getter above supplies their values. Do not include `prototype` here:
  // arrows and methods are callable carriers too but intentionally lack it.
  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined || ctx.anyStrTypeIdx < 0) return;

  // A first-class `%Function%` alias is intentionally kept as the provider's
  // stable raw marker so repeated reads remain reference-identical. Serve the
  // marker's scalar Function metadata directly in the universal getter; the
  // caller-owned carrier arm above handles dynamically-created functions.
  const callbackTypeIdx = ctx.runtimeEvalInterpretedCallbackTypeIdx;
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  if (callbackTypeIdx !== undefined && boxNumberIdx !== undefined) {
    const markerLocal = 2 + fn.locals.length;
    fn.locals.push({
      name: "__runtime_eval_marker",
      type: { kind: "ref_null", typeIdx: callbackTypeIdx },
    });
    const markerKeyAnyLocal = 2 + fn.locals.length;
    fn.locals.push({ name: "__runtime_eval_marker_key_any", type: { kind: "anyref" } });
    const markerKeyEquals = (key: string): Instr[] => [
      { op: "local.get", index: markerKeyAnyLocal },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "call", funcIdx: flattenIdx },
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "call", funcIdx: equalsIdx },
    ];
    const markerBrandsMatch: Instr[] = [
      { op: "local.get", index: markerLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 1 },
      { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A },
      { op: "i32.eq" },
      { op: "local.get", index: markerLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B },
      { op: "i32.eq" },
      { op: "i32.and" },
    ];
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: callbackTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: callbackTypeIdx },
          { op: "local.set", index: markerLocal },
          ...markerBrandsMatch,
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "local.tee", index: markerKeyAnyLocal },
          { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...markerKeyEquals("name"),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: markerLocal },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 4 },
                  { op: "return" },
                ],
              },
              ...markerKeyEquals("length"),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: markerLocal },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 5 },
                  { op: "call", funcIdx: boxNumberIdx },
                  { op: "return" },
                ],
              },
              ...markerKeyEquals("constructor"),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: markerLocal },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 3 },
                  { op: "i32.const", value: RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "externref" } },
                    then: [{ op: "local.get", index: 0 }],
                    else: [
                      { op: "local.get", index: markerLocal },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 6 },
                    ],
                  },
                  { op: "return" },
                ],
              },
            ],
          },
        ],
      },
    );
  }
  for (const name of ["__hasOwnProperty", "__object_hasOwn"]) {
    const hasOwn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (!hasOwn) continue;
    const carrierLocal = 2 + hasOwn.locals.length;
    hasOwn.locals.push({
      name: "__runtime_eval_carrier",
      type: { kind: "ref_null", typeIdx: carrier.structTypeIdx },
    });
    const keyAnyLocal = 2 + hasOwn.locals.length;
    hasOwn.locals.push({ name: "__runtime_eval_key_any", type: { kind: "anyref" } });
    const keyEquals = (key: string): Instr[] => [
      { op: "local.get", index: keyAnyLocal },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "call", funcIdx: flattenIdx },
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "call", funcIdx: equalsIdx },
    ];
    hasOwn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: carrier.structTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: carrier.structTypeIdx },
          { op: "local.set", index: carrierLocal },
          { op: "local.get", index: carrierLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 3 },
          { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_A },
          { op: "i32.eq" },
          { op: "local.get", index: carrierLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: carrier.structTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_B },
          { op: "i32.eq" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "local.tee", index: keyAnyLocal },
              { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...keyEquals("name"),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                  },
                  ...keyEquals("length"),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    );
  }
}

/** Replace an interpreted closure externref on the stack with a caller-owned
 * carrier whose trampoline synchronizes realm globals around every invocation. */
export function emitRuntimeEvalInterpretedCallableAdapter(ctx: CodegenContext, fctx: FunctionContext): ValType {
  const carrier = ensureRuntimeEvalInterpretedCallableTrampoline(ctx);
  const propertyCarrier = ensureRuntimeEvalAotCallablePropertyGetTrampoline(ctx);
  const targetLocal = allocLocal(fctx, `__runtime_eval_interpreted_target_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push(
    { op: "local.set", index: targetLocal },
    { op: "ref.func", funcIdx: carrier.interpretedTrampolineFuncIdx },
    { op: "ref.func", funcIdx: propertyCarrier.propertyGetTrampolineFuncIdx },
    { op: "local.get", index: targetLocal },
    { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_A },
    { op: "i32.const", value: RUNTIME_EVAL_AOT_CALLABLE_BRAND_B },
    { op: "struct.new", typeIdx: carrier.structTypeIdx },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" };
}

/** Wrap only the canonical interpreter closure shape, preserving ordinary
 * values and caller-owned AOT carriers byte-for-byte. */
export function emitRuntimeEvalInterpretedCallableAdapterIfCallable(
  ctx: CodegenContext,
  fctx: FunctionContext,
): ValType {
  const callableTypeIdx = ctx.runtimeEvalCallableTypeIdx;
  if (callableTypeIdx === undefined) return { kind: "externref" };
  const valueLocal = allocLocal(fctx, `__runtime_eval_maybe_callable_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: valueLocal });
  const savedBody = fctx.body;
  const thenBody: Instr[] = [{ op: "local.get", index: valueLocal }];
  fctx.body = thenBody;
  emitRuntimeEvalInterpretedCallableAdapter(ctx, fctx);
  fctx.body = savedBody;
  fctx.body.push(
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: callableTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: thenBody,
      else: [{ op: "local.get", index: valueLocal }],
    },
  );
  return { kind: "externref" };
}
