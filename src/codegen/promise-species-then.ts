// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5197 r3 Step 1) §27.2.5.4 `Promise.prototype.then` steps 3-4 in standalone:
 *
 *   C = SpeciesConstructor(promise, %Promise%)        -- §7.3.22
 *   resultCapability = NewPromiseCapability(C)        -- §27.2.1.5
 *   return PerformPromiseThen(promise, onF, onR, resultCapability)
 *
 * The native `then` lowering (`emitStandalonePromiseThen`) always minted a fresh
 * `$Promise` as the derived promise, so a user-visible `constructor` / `@@species`
 * was never read and a species constructor was never invoked. This module emits
 * the SpeciesConstructor ladder and — when it names anything other than
 * `%Promise%` — constructs the capability through the one-argument native
 * construct driver (D3/D4's `__native_construct_1`, whose class arm runs a
 * Promise-rooted class's own `<C>_new`, and whose ordinary tail calls a plain
 * function constructor). The scheduler keeps its native reaction; the derived
 * promise is then settled THROUGH the capability's resolve/reject functions
 * (see {@link speciesForwardAndResultInstrs}).
 *
 * ## Gate (byte identity)
 *
 * {@link promiseSpeciesObservable}: standalone (not wasi), and either the #5145
 * pre-scan saw a `.species` / `constructor` write (`ctx.arraySpeciesDirty`) or
 * the module declares a Promise-rooted class. A module with neither emits the
 * exact bytes it did before — no `constructor` or `@@species` can differ from
 * the intrinsic answer there.
 *
 * ## Deliberate residuals
 *
 * - An inherited `Promise.prototype.constructor` that user code REASSIGNED is not
 *   consulted: a native `$Promise` carries no prototype link, so an absent own
 *   `constructor` is read as the intrinsic `%Promise%` (the spec default).
 * - For a non-default `C` whose capability promise is not the native carrier the
 *   reaction's result reaches `capability.[[Resolve]]` one microtask later than
 *   the spec (the native derived promise settles first, then forwards). No row
 *   observes that hop.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";
import { reserveBuiltinConstructorIdentityGlobal } from "./builtin-static-globals.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import {
  buildCustomCapabilityExecutorInstrs,
  customCapabilityTypeError,
  ensureCustomCapabilityRuntime,
  type CustomCapabilityRuntime,
} from "./promise-combinators.js";
import { reserveConstructDriver } from "./promise-class-receiver-drive.js";
import { markPromiseSubclassValueRead } from "./standalone-class-construct.js";
import { resolvePromiseSubclassName } from "./expressions/promise-subclass.js";
import { closureBagInitInstr } from "./closures/funcref-wrapper-types.js";
import { ensurePromiseExecutorClosures, getOrRegisterPromiseType } from "./async-scheduler.js";
import { PROMISE_STATE_PENDING } from "../runtime/wasmgc/promise/settlement-bodies.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
/** WasmGC `eq` abstract heap type — the only thing `ref.eq` accepts. */
const EQ_HEAP_TYPE = -19;
/** `@@species` — the well-known symbol id interned by the native `$Symbol` carrier. */
const SYMBOL_SPECIES_ID = 5;
/** `(externref C) -> externref` — `C` when it is a Promise-rooted class object, else null. */
const SPECIES_OF_CLASS = "__promise_species_of_class";

/** A module declaring `class … extends Promise` (directly or through a user class). */
function moduleHasPromiseRootedClass(ctx: CodegenContext): boolean {
  for (const parent of ctx.classBuiltinParentMap.values()) if (parent === "Promise") return true;
  return false;
}

/** The one gate: can this module observe a `then` species other than `%Promise%`? */
export function promiseSpeciesObservable(ctx: CodegenContext): boolean {
  if (ctx.standalone !== true || ctx.wasi === true) return false;
  return ctx.arraySpeciesDirty === true || moduleHasPromiseRootedClass(ctx);
}

export interface PromiseThenSpeciesDeps {
  capability: CustomCapabilityRuntime;
  /** `%Promise%`'s identity slot — null until some read reifies the carrier. */
  promiseCtorGlobal: number;
  /** `$__promise_settle_cap` (a native executor's resolve/reject) and its captured-promise field. */
  settleCapTypeIdx: number;
  settleCapPromiseFieldIdx: number;
  typeErrorTemplate: () => Instr[];
}

/**
 * Register every dependency of the ladder, in ONE batch, before any index is
 * baked (registration-before-bake, #2918/#2919). `undefined` when the module is
 * not gated in or a dependency is unavailable — the caller keeps its lowering.
 */
export function preparePromiseThenSpecies(
  ctx: CodegenContext,
  fctx: FunctionContext,
): PromiseThenSpeciesDeps | undefined {
  if (!promiseSpeciesObservable(ctx)) return undefined;
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  addStringConstantGlobal(ctx, "constructor");
  ensureReflectIsConstructor(ctx);
  const capability = ensureCustomCapabilityRuntime(ctx);
  const closures = ensurePromiseExecutorClosures(ctx);
  flushLateImportShifts(ctx, fctx);
  if (moduleHasPromiseRootedClass(ctx)) markPromiseSubclassValueRead(ctx);
  reserveConstructDriver(ctx, fctx);
  reserveSpeciesOfClass(ctx);
  const promiseCtorGlobal = reserveBuiltinConstructorIdentityGlobal(ctx, "Promise");
  customCapabilityTypeError(ctx); // registers `__new_TypeError` now, not mid-ladder
  flushLateImportShifts(ctx, fctx);
  const needed = [
    "__extern_get",
    "__extern_is_undefined",
    "__box_symbol",
    "__typeof_object",
    "__typeof_function",
    "__reflect_is_constructor",
    "__native_construct_1",
    "__promise_custom_capability_executor",
    SPECIES_OF_CLASS,
  ];
  if (!capability || !closures) return undefined;
  if (needed.some((name) => ctx.funcMap.get(name) === undefined)) return undefined;
  return {
    capability,
    promiseCtorGlobal,
    settleCapTypeIdx: closures.capTypeIdx,
    settleCapPromiseFieldIdx: closures.capPromiseFieldIdx,
    typeErrorTemplate: () => customCapabilityTypeError(ctx),
  };
}

export interface PromiseThenSpeciesLocals {
  /** i32 — 1 ⇒ `C` is `%Promise%` (or undefined): the native derived promise is the result. */
  useDefault: number;
  /** externref — `resultCapability.[[Promise]]` when `useDefault` is 0. */
  capPromise: number;
  /** `(ref null $__promise_custom_capability)` — the capability record. */
  cap: number;
}

/**
 * Emit SpeciesConstructor + NewPromiseCapability for the receiver in
 * `promiseLocal` (a `(ref $Promise)`). Abrupt completions (a throwing
 * `constructor` getter, a throwing `@@species` getter, a throwing constructor)
 * propagate out of `then` synchronously, as the spec requires.
 */
export function emitPromiseThenSpeciesCapability(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: PromiseThenSpeciesDeps,
  promiseLocal: number,
): PromiseThenSpeciesLocals {
  const fn = (name: string): number => ctx.funcMap.get(name)!;
  const local = (name: string, type: ValType): number => allocLocal(fctx, `__pst_${name}_${fctx.locals.length}`, type);
  const useDefault = local("dflt", I32);
  const ctorLocal = local("c", EXTERNREF);
  const speciesLocal = local("s", EXTERNREF);
  const capPromise = local("cp", EXTERNREF);
  const cap = local("cap", { kind: "ref_null", typeIdx: deps.capability.stateTypeIdx });
  const anyA = local("a", { kind: "anyref" });
  const anyB = local("b", { kind: "anyref" });
  const isUndefined = (l: number): Instr[] => [
    { op: "local.get", index: l },
    { op: "call", funcIdx: fn("__extern_is_undefined") },
  ];
  const isCallable = (slot: number): Instr[] => [
    { op: "local.get", index: cap },
    { op: "struct.get", typeIdx: deps.capability.stateTypeIdx, fieldIdx: slot },
    { op: "call", funcIdx: fn("__typeof_function") },
  ];
  // SameValue(S, %Promise%) over the identity slot (null until reified ⇒ false).
  const sameAsIntrinsic: Instr[] = [
    { op: "local.get", index: speciesLocal },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyA },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "global.get", index: deps.promiseCtorGlobal },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyB },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: anyA },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "local.get", index: anyB },
        { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
  const runtime = { ...deps.capability, executorFuncIdx: fn("__promise_custom_capability_executor") };
  // A null `C` is JS `null` only under the undefined-singleton regime; in the
  // legacy regime it is indistinguishable from an absent value (the default).
  const nullCtor: Instr[] = undefinedSingletonActive(ctx) ? deps.typeErrorTemplate() : [{ op: "br", depth: 1 }];
  const ladder: Instr[] = [
    // §7.3.22 step 2: C = Get(promise, "constructor") — runs an own getter.
    { op: "local.get", index: promiseLocal },
    { op: "extern.convert_any" },
    ...stringConstantExternrefInstrs(ctx, "constructor"),
    { op: "call", funcIdx: fn("__extern_get") },
    { op: "local.set", index: ctorLocal },
    // No own `constructor`: the inherited `%Promise.prototype%.constructor`, i.e.
    // `%Promise%` — whose identity slot is still null when nothing reified it
    // (then nothing can have redefined its `@@species` either ⇒ default).
    ...isUndefined(ctorLocal),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "global.get", index: deps.promiseCtorGlobal },
        { op: "local.tee", index: ctorLocal },
        { op: "ref.is_null" },
        { op: "br_if", depth: 1 },
      ],
    },
    // Step 4 (an own `constructor = undefined`) is the default; step 5 throws for a non-Object.
    ...isUndefined(ctorLocal),
    { op: "br_if", depth: 0 },
    { op: "local.get", index: ctorLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: nullCtor },
    { op: "local.get", index: ctorLocal },
    { op: "call", funcIdx: fn("__typeof_object") },
    { op: "local.get", index: ctorLocal },
    { op: "call", funcIdx: fn("__typeof_function") },
    { op: "i32.or" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: deps.typeErrorTemplate() },
    // Step 6: S = Get(C, @@species). A Promise-rooted class object inherits
    // `%Promise%[@@species]` (whose getter answers the receiver) but carries no
    // link to it, so an undefined read falls back to the class itself.
    { op: "local.get", index: ctorLocal },
    { op: "i32.const", value: SYMBOL_SPECIES_ID },
    { op: "call", funcIdx: fn("__box_symbol") },
    { op: "call", funcIdx: fn("__extern_get") },
    { op: "local.set", index: speciesLocal },
    ...isUndefined(speciesLocal),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: ctorLocal },
        { op: "call", funcIdx: fn(SPECIES_OF_CLASS) },
        { op: "local.set", index: speciesLocal },
      ],
    },
    // Step 8: undefined / null ⇒ default; `%Promise%` itself ⇒ default.
    { op: "local.get", index: speciesLocal },
    { op: "ref.is_null" },
    ...isUndefined(speciesLocal),
    { op: "i32.or" },
    { op: "br_if", depth: 0 },
    ...sameAsIntrinsic,
    { op: "br_if", depth: 0 },
    // Steps 9-10: IsConstructor(S) or TypeError.
    { op: "local.get", index: speciesLocal },
    { op: "call", funcIdx: fn("__reflect_is_constructor") },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: deps.typeErrorTemplate() },
    // §27.2.1.5 NewPromiseCapability(S): Construct(S, «executor»); both slots callable.
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: deps.capability.stateTypeIdx },
    { op: "local.set", index: cap },
    { op: "local.get", index: speciesLocal },
    { op: "ref.null.extern" },
    ...buildCustomCapabilityExecutorInstrs(runtime, cap),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: fn("__native_construct_1") },
    { op: "local.set", index: capPromise },
    ...isCallable(0),
    ...isCallable(1),
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: deps.typeErrorTemplate() },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: useDefault },
  ];
  fctx.body.push(
    { op: "i32.const", value: 1 },
    { op: "local.set", index: useDefault },
    { op: "block", blockType: { kind: "empty" }, body: ladder },
  );
  return { useDefault, capPromise, cap };
}

/**
 * The derived promise the native reaction settles. With a non-default `C` whose
 * capability promise IS a native carrier settled by the ordinary native
 * executor pair (a `super(executor)` Promise subclass) the reaction settles that
 * carrier directly — no extra hop, and `p.then() instanceof C` holds. Otherwise
 * `mintInstrs` (a fresh pending `$Promise`) runs. Leaves nothing on the stack;
 * sets `chainedLocal`.
 */
export function speciesChainedInstrs(
  ctx: CodegenContext,
  deps: PromiseThenSpeciesDeps,
  sp: PromiseThenSpeciesLocals,
  chainedLocal: number,
  mintInstrs: Instr[],
): Instr[] {
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const settleCap = deps.settleCapTypeIdx;
  const capResolve: Instr[] = [
    { op: "local.get", index: sp.cap },
    { op: "struct.get", typeIdx: deps.capability.stateTypeIdx, fieldIdx: 0 },
    { op: "any.convert_extern" },
  ];
  const directCarrier: Instr[] = [
    { op: "local.get", index: sp.capPromise },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        ...capResolve,
        { op: "ref.test", typeIdx: settleCap },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [
            ...capResolve,
            { op: "ref.cast", typeIdx: settleCap },
            { op: "struct.get", typeIdx: settleCap, fieldIdx: deps.settleCapPromiseFieldIdx },
            { op: "local.get", index: sp.capPromise },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: promiseTypeIdx },
            { op: "ref.eq" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
  return [
    { op: "local.get", index: sp.useDefault },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: directCarrier,
      else: [{ op: "i32.const", value: 0 }],
    },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: sp.capPromise },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: promiseTypeIdx },
        { op: "local.set", index: chainedLocal },
        // The carrier IS the result: nothing to forward.
        { op: "i32.const", value: 1 },
        { op: "local.set", index: sp.useDefault },
      ],
      else: mintInstrs,
    },
  ];
}

export interface SpeciesForwardTypes {
  callbackTypeIdx: number;
  capsTypeIdx: number;
  dynFulfillIdx: number;
  dynRejectIdx: number;
}

/**
 * After the native reaction is attached: when `C` is not the default, forward
 * the derived promise's settlement into `capability.[[Resolve]]` /
 * `capability.[[Reject]]` — `chained.then(cap.resolve, cap.reject)` through the
 * dynamic reaction wrappers (their own derived promise is a throwaway) — and
 * answer `capability.[[Promise]]`. Otherwise answer the derived promise.
 * Leaves the externref result on the stack.
 */
export function speciesForwardAndResultInstrs(
  ctx: CodegenContext,
  deps: PromiseThenSpeciesDeps,
  sp: PromiseThenSpeciesLocals,
  chainedLocal: number,
  types: SpeciesForwardTypes,
): Instr[] {
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const capsFor = (slot: number): Instr[] => [
    { op: "local.get", index: sp.cap },
    { op: "struct.get", typeIdx: deps.capability.stateTypeIdx, fieldIdx: slot },
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    closureBagInitInstr(),
    { op: "i32.const", value: 0 },
    { op: "struct.new", typeIdx: promiseTypeIdx },
    { op: "struct.new", typeIdx: types.capsTypeIdx },
    { op: "extern.convert_any" },
  ];
  return [
    { op: "local.get", index: sp.useDefault },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: chainedLocal }, { op: "extern.convert_any" }],
      else: [
        // `chained` is freshly minted and still pending: push the one node.
        { op: "local.get", index: chainedLocal },
        { op: "ref.func", funcIdx: types.dynFulfillIdx },
        ...capsFor(0),
        { op: "ref.func", funcIdx: types.dynRejectIdx },
        ...capsFor(1),
        { op: "local.get", index: chainedLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 },
        { op: "struct.new", typeIdx: types.callbackTypeIdx },
        { op: "extern.convert_any" },
        { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 },
        { op: "local.get", index: sp.capPromise },
      ],
    },
  ];
}

/**
 * (#5197 r3 Step 1e) §27.2.4.7.1 PromiseResolve step 1: a native promise `x` is
 * returned as is only when `SameValue(Get(x, "constructor"), %Promise%)`. The
 * instructions leave that i32 on the stack for the value in `valueLocal` (the
 * caller has already established it is a `$Promise`). An absent own
 * `constructor` reads the inherited `%Promise%` ⇒ 1. `undefined` when the
 * module is not gated in — the caller keeps its unconditional pass-through.
 * Registration happens here, before the caller bakes anything.
 */
export function promiseResolvePassThroughInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  valueLocal: number,
): Instr[] | undefined {
  if (!promiseSpeciesObservable(ctx)) return undefined;
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  addStringConstantGlobal(ctx, "constructor");
  flushLateImportShifts(ctx, fctx);
  const externGet = ctx.funcMap.get("__extern_get");
  const isUndefined = ctx.funcMap.get("__extern_is_undefined");
  if (externGet === undefined || isUndefined === undefined) return undefined;
  const slot = reserveBuiltinConstructorIdentityGlobal(ctx, "Promise");
  const ctorLocal = allocLocal(fctx, `__prc_c_${fctx.locals.length}`, EXTERNREF);
  const anyA = allocLocal(fctx, `__prc_a_${fctx.locals.length}`, { kind: "anyref" });
  const anyB = allocLocal(fctx, `__prc_b_${fctx.locals.length}`, { kind: "anyref" });
  return [
    { op: "local.get", index: valueLocal },
    ...stringConstantExternrefInstrs(ctx, "constructor"),
    { op: "call", funcIdx: externGet },
    { op: "local.tee", index: ctorLocal },
    { op: "call", funcIdx: isUndefined },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: ctorLocal },
        { op: "any.convert_extern" },
        { op: "local.tee", index: anyA },
        { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
        { op: "global.get", index: slot },
        { op: "any.convert_extern" },
        { op: "local.tee", index: anyB },
        { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [
            { op: "local.get", index: anyA },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "local.get", index: anyB },
            { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
            { op: "ref.eq" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
    },
  ];
}

/**
 * (#5197 r3 Step 3) Can this module observe `Get(array, "then")` on an Array it
 * resolves a promise with — i.e. may it install `Array.prototype.then`? The
 * pre-scan's named-member set sees an assignment; any Object/Array-prototype
 * define sets `protoIndexDirty`. Standalone only; every other module keeps the
 * direct fulfil of a combinator aggregate and a vec-free thenable ladder.
 */
export function arrayThenObservable(ctx: CodegenContext): boolean {
  return ctx.standalone === true && (ctx.protoIndexDirty || ctx.protoNamedWrittenMembers.has("then"));
}

/**
 * §27.2.4.1.1 step 6.d.iii.2 settles the `all` / `allSettled` aggregate through
 * `resultCapability.[[Resolve]]` — a Resolve, so `Get(valuesArray, "then")` runs
 * (and a poisoned getter rejects). Under {@link arrayThenObservable} that is
 * `__promise_resolve_value`; otherwise the direct fulfil it always was.
 */
export function aggregateSettleFuncIdx(ctx: CodegenContext, fulfillFuncIdx: number): number {
  const resolveValue = ctx.funcMap.get("__promise_resolve_value");
  return arrayThenObservable(ctx) && resolveValue !== undefined ? resolveValue : fulfillFuncIdx;
}

/**
 * (#5197 r3 Step 7) Is `handler` a `.then` / `.catch` callback on a syntactic
 * `Promise.{all,allSettled,any}(<not an array literal>)`? Such an aggregate is the
 * combinator's externref `$Vec` — a drained iterable (a string, an `any`) is never
 * the element-typed vec TS infers for the handler's parameter (`string[]`), so a
 * typed parameter would `ref.cast`-trap in the reaction wrapper. The caller compiles
 * the handler with array/vec parameters widened to externref (the existing
 * `forceExternrefCallbackParams` hook), read through the dynamic vec reader.
 */
export function isDrainedCombinatorResultHandler(ctx: CodegenContext, handler: ts.Expression): boolean {
  if (ctx.standalone !== true) return false;
  const call = handler.parent;
  if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  const receiver = call.expression.expression;
  if (!ts.isCallExpression(receiver) || !ts.isPropertyAccessExpression(receiver.expression)) return false;
  const ns = receiver.expression.expression;
  const method = receiver.expression.name.text;
  if (!ts.isIdentifier(ns) || ns.text !== "Promise") return false;
  if (method !== "all" && method !== "allSettled" && method !== "any") return false;
  const iterable = receiver.arguments[0];
  return iterable !== undefined && !ts.isArrayLiteralExpression(iterable);
}

/** Reserve `__promise_species_of_class` (placeholder: "not a class" = null); filled at finalize. */
function reserveSpeciesOfClass(ctx: CodegenContext): void {
  if (ctx.funcMap.get(SPECIES_OF_CLASS) !== undefined) return;
  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF], `$${SPECIES_OF_CLASS}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: SPECIES_OF_CLASS,
    typeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body: [{ op: "ref.null.extern" }],
    exported: false,
  });
  ctx.funcMap.set(SPECIES_OF_CLASS, funcIdx);
}

/**
 * Finalize: `ref.eq` identity arms over every Promise-rooted class-object
 * singleton (never `ref.test` — a class value and an instance share a struct
 * type), answering the class itself: §27.2.4.4 `get [Symbol.species]` returns
 * `this`, and a Promise-rooted class object's [[Prototype]] chain reaches
 * `%Promise%`. Everything else answers null. No-op unless reserved.
 */
export function fillPromiseSpeciesOfClass(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get(SPECIES_OF_CLASS);
  const fn = funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
  if (!fn) return;
  const globals = [...ctx.classObjectGlobals.entries()]
    .filter(([name]) => resolvePromiseSubclassName(ctx, name) !== undefined)
    .map(([, globalIdx]) => globalIdx)
    .sort((a, b) => a - b);
  const arms: Instr[] = [];
  for (const globalIdx of globals) {
    arms.push(
      { op: "global.get", index: globalIdx },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "global.get", index: globalIdx },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
          { op: "ref.eq" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 0 }, { op: "return" }] },
        ],
      },
    );
  }
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
    { op: "if", blockType: { kind: "empty" }, then: arms },
    { op: "ref.null.extern" },
  ];
}
