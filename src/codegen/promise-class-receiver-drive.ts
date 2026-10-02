// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster D, slice D3 / #5197 G10) `Promise.{all,race,allSettled,any}.call(C, iterable)`
 * where `C` is a COMPILED CLASS — `class BadPromise { constructor(executor) {…} }` — natively,
 * in standalone, with no host import.
 *
 * ## Why this is its own module
 *
 * D1 (`promise-custom-combinator.ts`) admits an ordinary `function` constructor and invokes it
 * through `__apply_closure` — a [[Call]], which for a function declaration happens to run the
 * body with the executor. A class has no [[Call]] (§10.2.1 step 2 throws), so that bridge cannot
 * serve it: before this module every class receiver fell through to the unsatisfiable
 * `env::Promise_<method>` host import and the row did not compile at all. D2b
 * (`promise-combinator-drive.ts`) steps a DYNAMIC iterable in spec order, but only over the
 * intrinsic capability (`$Promise` + the async-drive settle functions); a custom `C` owns its
 * own capability, so the element pipeline has to call ITS resolve/reject slots.
 *
 * ## What this emits (§27.2.4.1 / .2 / .3 / .5, shared shape)
 *
 *   capability = NewPromiseCapability(C)     -- Construct(C, «executor») through the native
 *                                               construct driver, whose class arm runs the
 *                                               class's own `<C>_new` (#5383 S2g)
 *   promiseResolve = GetPromiseResolve(C)    -- abrupt / not callable ⇒ IfAbruptRejectPromise
 *   iteratorRecord = GetIterator(iterable)   -- abrupt ⇒ reject, nothing to close
 *   Repeat:
 *     next = IteratorStep(iteratorRecord)    -- abrupt: [[Done]] = true, reject
 *     if done: finish (all / allSettled / any drop the remaining-elements sentinel)
 *     nextPromise = Call(promiseResolve, C, «value»)
 *     Invoke(nextPromise, "then", «onFulfilled, onRejected»)
 *   abrupt element step with [[Done]] false:
 *     IteratorClose(iteratorRecord, completion)   -- the ORIGINAL throw wins (§7.4.11 step 5)
 *     IfAbruptRejectPromise
 *
 * The handler pair per method: `all` (resolve-element, C.[[Reject]]), `race`
 * (C.[[Resolve]], C.[[Reject]]), `allSettled` (fulfilled-element, rejected-element, sharing one
 * `[[AlreadyCalled]]` record — §27.2.4.2.2 step 9 / .3 step 9), `any` (C.[[Resolve]],
 * reject-element). Each element function is a real builtin function object (the
 * `ensureBuiltinFnMetaType` carrier D1 uses: `name` "", `length` 1, no [[Construct]]).
 *
 * The iterator is driven through `__iterator` / `__iterator_next` / `__iterator_return`, the same
 * substrate native `for…of`, G1's destructuring drive and D2b use. That is load-bearing: the
 * `resolve-throws-iterator-return-*` rows iterate an object whose `next()` NEVER reports done, so
 * any drain-first lowering (D1's `__combinator_to_vec`) hangs.
 *
 * ## Scope
 *
 * Standalone only, and only for a receiver that is an identifier bound to a compiled class
 * declaration / class expression that does NOT extend a builtin — a `class X extends Promise`
 * receiver is the separate #5197 G9 mechanism (it needs a standalone representation for a
 * Promise-subclass instance, which does not exist yet). Nothing here is reachable from a module
 * that did not previously fail to compile, so every other module is byte-identical.
 *
 * Deliberate residual shared with D1: an element whose `C.resolve` answers a NATIVE `$Promise`
 * has no readable `then` value today (#5197 R3-7), so it is exempt from the §7.3.20 TypeError and
 * its reactions are not subscribed.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureBuiltinFnMetaType } from "./builtin-fn-meta.js";
import {
  closureBagInitInstr,
  getFuncRefWrapperRootTypeIdx,
  getOrCreateFuncRefWrapperTypes,
} from "./closures/funcref-wrapper-types.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { coerceType, compileExpression } from "./shared.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";
import { ensureNativeIteratorRuntime } from "./iterator-native.js";
import {
  buildCustomCapabilityExecutorInstrs,
  customCapabilityTypeError,
  ensureCombinatorFunctions,
  ensureCustomCapabilityRuntime,
  ensureSettledAnyCombinators,
  type NativeCombinator,
} from "./promise-combinators.js";
import { reserveNativeConstructDriver } from "./native-construct.js";
import {
  markClassValueConstructSite,
  moduleHasF64TypedConstructFormal,
  moduleHasRefTypedConstructFormal,
} from "./standalone-class-construct.js";
import { armConstructIsConstructorGuard } from "./construct-is-constructor-guard.js";
import { armExternF64ArgTypeGuard, armExternRefArgTypeGuard } from "./extern-arg-marshal.js";
import { recordStandaloneRuntimeKeyClassMemberRead } from "./standalone-class-dyn-member.js";
import { resolvePromiseSubclassName } from "./expressions/promise-subclass.js"; // (#6651 D4)
import { noJsHost } from "./js-errors.js";
import { promiseSubclassResolveFallbackInstrs } from "./promise-subclass-proto-link.js";
import { shadowsGlobalValueName } from "./promise-class-receiver-settle.js";
import { demandPromiseDynamicMember } from "./promise-dynamic-member-read.js"; // (#6651 D5)

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** State field indices (`$__promise_class_drive_state`). */
const ST_RESOLVE = 0;
const ST_REJECT = 1;
const ST_VALS = 2;
const ST_LEN = 3;
const ST_REMAINING = 4;
const ST_SETTLED = 5;
/** 1 ⇒ the finish step rejects with an AggregateError over the list (`any`). */
const ST_AGGREGATE = 6;

/** How an element function stores what it receives. */
type ElemMode = "value" | "fulfilled" | "rejected";

const ELEM_FN: Record<ElemMode, string> = {
  value: "__promise_class_drive_elem_value",
  fulfilled: "__promise_class_drive_elem_fulfilled",
  rejected: "__promise_class_drive_elem_rejected",
};
const FINISH_FN = "__promise_class_drive_finish";

interface ClassDriveRuntime {
  stateTypeIdx: number;
  flagTypeIdx: number;
  elemTypeIdx: number;
  elemMetaTypeIdx: number;
  /** Index of the `state` field in the element struct (then `index`, then `flag`). */
  elemStateFieldIdx: number;
  arrTypeIdx: number;
}

const runtimeByCtx = new WeakMap<CodegenContext, ClassDriveRuntime>();

function registerStruct(
  ctx: CodegenContext,
  name: string,
  fields: { name: string; type: ValType; mutable: boolean }[],
  superTypeIdx?: number,
): number {
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push(
    superTypeIdx === undefined ? { kind: "struct", name, fields } : { kind: "struct", name, fields, superTypeIdx },
  );
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(
    name,
    fields.map((f) => ({ ...f })),
  );
  return typeIdx;
}

/** `__apply_closure(fn, undefined, «arg»)` with the argument pushed by `arg`; result dropped. */
function applyOneInstrs(ctx: CodegenContext, fn: Instr[], arg: Instr[], argsLocal: number): Instr[] {
  return [
    ...fn,
    { op: "ref.null.extern" },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: argsLocal },
    { op: "local.get", index: argsLocal },
    ...arg,
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
    { op: "drop" },
  ];
}

/**
 * `__promise_class_drive_finish(state)` — build the values/errors Array once and hand it (or an
 * AggregateError over it, for `any`) to the capability. An abrupt settle call is the spec's
 * IfAbruptRejectPromise around the post-loop `? Call(...)`: it rejects, never escapes (D1's rule,
 * `all/capability-resolve-throws-*`). params: 0 = state; locals: 1 arr, 2 i, 3 args, 4 err.
 */
function buildFinishBody(ctx: CodegenContext, rt: ClassDriveRuntime, aggErrIdx: number): Instr[] {
  const st = rt.stateTypeIdx;
  const S = (): Instr[] => [{ op: "local.get", index: 0 }];
  return [
    ...S(),
    { op: "struct.get", typeIdx: st, fieldIdx: ST_SETTLED },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    ...S(),
    { op: "i32.const", value: 1 },
    { op: "struct.set", typeIdx: st, fieldIdx: ST_SETTLED },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: 1 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 2 },
            ...S(),
            { op: "struct.get", typeIdx: st, fieldIdx: ST_LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 1 },
            ...S(),
            { op: "struct.get", typeIdx: st, fieldIdx: ST_VALS },
            { op: "local.get", index: 2 },
            { op: "array.get", typeIdx: rt.arrTypeIdx },
            { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
            { op: "local.get", index: 2 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 2 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    buildTargetTaggedTry(
      ctx,
      { kind: "empty" },
      [
        ...S(),
        { op: "struct.get", typeIdx: st, fieldIdx: ST_AGGREGATE },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: applyOneInstrs(
            ctx,
            [...S(), { op: "struct.get", typeIdx: st, fieldIdx: ST_REJECT }],
            [
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: aggErrIdx },
            ],
            3,
          ),
          else: applyOneInstrs(
            ctx,
            [...S(), { op: "struct.get", typeIdx: st, fieldIdx: ST_RESOLVE }],
            [{ op: "local.get", index: 1 }],
            3,
          ),
        },
      ],
      [
        {
          tagIdx: ensureExnTag(ctx),
          body: [
            { op: "local.set", index: 4 },
            ...applyOneInstrs(
              ctx,
              [...S(), { op: "struct.get", typeIdx: st, fieldIdx: ST_REJECT }],
              [{ op: "local.get", index: 4 }],
              3,
            ),
          ],
        },
      ],
    ),
  ];
}

/**
 * One element function body (§27.2.4.1.3 / §27.2.4.2.2 / .3 / §27.2.4.3.2): one-shot through the
 * shared flag, store what it received (raw, or as a `{status, value|reason}` record), count down,
 * finish at zero. params: 0 = self, 1 = x; locals: 2 elem, 3 state, 4 stored.
 */
function buildElemBody(ctx: CodegenContext, rt: ClassDriveRuntime, mode: ElemMode): Instr[] {
  const e = rt.elemTypeIdx;
  const st = rt.stateTypeIdx;
  const stateF = rt.elemStateFieldIdx;
  const stored: Instr[] =
    mode === "value"
      ? [{ op: "local.get", index: 1 }]
      : [
          { op: "call", funcIdx: ctx.funcMap.get("__new_plain_object")! },
          { op: "local.set", index: 4 },
          { op: "local.get", index: 4 },
          ...stringConstantExternrefInstrs(ctx, "status"),
          ...stringConstantExternrefInstrs(ctx, mode),
          { op: "call", funcIdx: ctx.funcMap.get("__extern_set")! },
          { op: "local.get", index: 4 },
          ...stringConstantExternrefInstrs(ctx, mode === "fulfilled" ? "value" : "reason"),
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: ctx.funcMap.get("__extern_set")! },
          { op: "local.get", index: 4 },
        ];
  return [
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: e },
    { op: "local.set", index: 2 },
    // [[AlreadyCalled]] (shared by an allSettled pair).
    { op: "local.get", index: 2 },
    { op: "struct.get", typeIdx: e, fieldIdx: stateF + 2 },
    { op: "struct.get", typeIdx: rt.flagTypeIdx, fieldIdx: 0 },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    { op: "local.get", index: 2 },
    { op: "struct.get", typeIdx: e, fieldIdx: stateF + 2 },
    { op: "i32.const", value: 1 },
    { op: "struct.set", typeIdx: rt.flagTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: 2 },
    { op: "struct.get", typeIdx: e, fieldIdx: stateF },
    { op: "local.set", index: 3 },
    // values[index] = stored — `vals` is read NOW: the drive may have grown it since.
    { op: "local.get", index: 3 },
    { op: "struct.get", typeIdx: st, fieldIdx: ST_VALS },
    { op: "local.get", index: 2 },
    { op: "struct.get", typeIdx: e, fieldIdx: stateF + 1 },
    ...stored,
    { op: "array.set", typeIdx: rt.arrTypeIdx },
    { op: "local.get", index: 3 },
    { op: "local.get", index: 3 },
    { op: "struct.get", typeIdx: st, fieldIdx: ST_REMAINING },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "struct.set", typeIdx: st, fieldIdx: ST_REMAINING },
    { op: "local.get", index: 3 },
    { op: "struct.get", typeIdx: st, fieldIdx: ST_REMAINING },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "call", funcIdx: ctx.funcMap.get(FINISH_FN)! },
      ],
    },
  ];
}

/**
 * Register the state / flag / element types and the four runtime functions once. Every
 * dependency (object runtime, objvec builders, apply bridge, the allSettled/any strings and the
 * AggregateError builder) is ensured BEFORE any body is built, so no append can land between a
 * bake and its use.
 */
function ensureClassDriveRuntime(ctx: CodegenContext): ClassDriveRuntime | undefined {
  const cached = runtimeByCtx.get(ctx);
  if (cached) return cached;
  const ids = ensureCombinatorFunctions(ctx);
  const settled = ensureSettledAnyCombinators(ctx);
  ensureObjectRuntime(ctx);
  ensureObjVecBuilders(ctx);
  reserveApplyClosure(ctx);
  for (const s of ["status", "fulfilled", "rejected", "value", "reason"]) addStringConstantGlobal(ctx, s);
  flushLateImportShifts(ctx, null);
  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [EXTERNREF], []);
  if (!wrapper) return undefined;
  for (const name of ["__objvec_new", "__objvec_push", "__apply_closure", "__new_plain_object", "__extern_set"]) {
    if (ctx.funcMap.get(name) === undefined) return undefined;
  }

  const arrTypeIdx = ids.arrTypeIdx;
  const stateTypeIdx = registerStruct(ctx, "$__promise_class_drive_state", [
    { name: "capResolve", type: EXTERNREF, mutable: false },
    { name: "capReject", type: EXTERNREF, mutable: false },
    { name: "vals", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: true },
    { name: "len", type: I32, mutable: true },
    { name: "remaining", type: I32, mutable: true },
    { name: "settled", type: I32, mutable: true },
    { name: "aggregate", type: I32, mutable: false },
  ]);
  const flagTypeIdx = registerStruct(ctx, "$__promise_class_drive_flag", [
    { name: "called", type: I32, mutable: true },
  ]);
  // Same builtin-function metadata family as D1's resolve-element functions.
  const elemMetaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrapper.structTypeIdx,
    wrapper.closureInfo,
    "promise:customelem",
    "",
    1,
  );
  const metaFields = (ctx.mod.types[elemMetaTypeIdx] as { fields: { name: string; type: ValType; mutable: boolean }[] })
    .fields;
  const elemStateFieldIdx = metaFields.length;
  const elemTypeIdx = registerStruct(
    ctx,
    "$__promise_class_drive_elem",
    [
      ...metaFields.map((f) => ({ ...f })),
      { name: "state", type: { kind: "ref", typeIdx: stateTypeIdx }, mutable: false },
      { name: "index", type: I32, mutable: false },
      { name: "flag", type: { kind: "ref", typeIdx: flagTypeIdx }, mutable: false },
    ],
    elemMetaTypeIdx,
  );
  const rt: ClassDriveRuntime = {
    stateTypeIdx,
    flagTypeIdx,
    elemTypeIdx,
    elemMetaTypeIdx,
    elemStateFieldIdx,
    arrTypeIdx,
  };

  // Mint every handle before any body is built (the element bodies bake `finish`).
  const finishIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(FINISH_FN, finishIdx);
  const elemIdxs = (["value", "fulfilled", "rejected"] as const).map((mode) => {
    const idx = mintDefinedFunc(ctx);
    ctx.funcMap.set(ELEM_FN[mode], idx);
    return [mode, idx] as const;
  });
  pushDefinedFunc(ctx, finishIdx, {
    name: FINISH_FN,
    typeIdx: addFuncType(ctx, [{ kind: "ref_null", typeIdx: stateTypeIdx }], []),
    locals: [
      { name: "arr", type: EXTERNREF },
      { name: "i", type: I32 },
      { name: "args", type: EXTERNREF },
      { name: "err", type: EXTERNREF },
    ],
    body: buildFinishBody(ctx, rt, settled.aggErrNewFuncIdx),
    exported: false,
  });
  for (const [mode, idx] of elemIdxs) {
    pushDefinedFunc(ctx, idx, {
      name: ELEM_FN[mode],
      typeIdx: wrapper.liftedFuncTypeIdx,
      locals: [
        { name: "e", type: { kind: "ref_null", typeIdx: elemTypeIdx } },
        { name: "st", type: { kind: "ref_null", typeIdx: stateTypeIdx } },
        { name: "stored", type: EXTERNREF },
      ],
      body: buildElemBody(ctx, rt, mode),
      exported: false,
    });
  }
  runtimeByCtx.set(ctx, rt);
  return rt;
}

/**
 * The class `C` names, when the receiver is an identifier bound to a compiled class that does
 * not extend a builtin — or (#6651 D4 / #5197 G9) extends `Promise`, whose `<C>_new` builds the
 * native `$Promise` carrier and so serves NewPromiseCapability(C) through the same construct call.
 */
export function resolveCompiledClassReceiver(ctx: CodegenContext, arg: ts.Expression): string | undefined {
  if (!ts.isIdentifier(arg)) return undefined;
  const decl = ctx.oracle.valueDeclarationOf(arg);
  let node: ts.Node | undefined = decl;
  if (decl !== undefined && ts.isVariableDeclaration(decl)) {
    node = decl.initializer;
    while (node !== undefined && ts.isParenthesizedExpression(node)) node = node.expression;
  }
  if (node === undefined || !(ts.isClassDeclaration(node) || ts.isClassExpression(node))) return undefined;
  const name =
    ctx.anonClassExprNames.get(node as ts.ClassLikeDeclaration) ??
    (node.name ? (ctx.classExprNameMap.get(node.name.text) ?? node.name.text) : undefined);
  if (name === undefined || !ctx.classSet.has(name)) return undefined;
  if (resolvePromiseSubclassName(ctx, name) !== undefined)
    return noJsHost(ctx) && !shadowsGlobalValueName(arg) ? name : undefined;
  // Transitively: a user class chain that reaches ANY other builtin keeps its own path.
  const seen = new Set<string>();
  for (let c: string | undefined = name; c !== undefined && !seen.has(c); c = ctx.classParentMap.get(c)) {
    seen.add(c);
    if (ctx.classBuiltinParentMap.has(c)) return undefined;
  }
  if (ctx.structMap.get(name) === undefined) return undefined;
  return name;
}

/**
 * (#5197 r3) D1's admission, shared: `arg` (parens / `as` / `!` peeled) is an ordinary function —
 * a function expression, or an identifier bound to a non-generator, non-async function declaration
 * or to a variable whose initializer is a non-generator function expression.
 */
export function isOrdinaryFunctionCtorArg(ctx: CodegenContext, arg: ts.Expression): boolean {
  const unwrap = (value: ts.Expression): ts.Expression => {
    let current = value;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const ctorArg = unwrap(arg);
  const ctorDecl: ts.Node | undefined = ts.isIdentifier(ctorArg) ? ctx.oracle.valueDeclarationOf(ctorArg) : ctorArg;
  const ctorInit = ctorDecl && ts.isVariableDeclaration(ctorDecl) ? ctorDecl.initializer : undefined;
  const ctorExpr = ctorInit ? unwrap(ctorInit) : ctorDecl;
  return (
    (ctorExpr !== undefined && ts.isFunctionExpression(ctorExpr) && ctorExpr.asteriskToken === undefined) ||
    (ctorDecl !== undefined &&
      ts.isFunctionDeclaration(ctorDecl) &&
      ctorDecl.asteriskToken === undefined &&
      !(ctorDecl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false))
  );
}

/** Arm and reserve the one-argument native construct driver (the `new <value>(x)` prelude). */
export function reserveConstructDriver(ctx: CodegenContext, fctx: FunctionContext): number {
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__object_create", [EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  addStringConstantGlobal(ctx, "prototype");
  markClassValueConstructSite(ctx);
  armConstructIsConstructorGuard(ctx, fctx);
  if (moduleHasRefTypedConstructFormal(ctx)) armExternRefArgTypeGuard(ctx, fctx);
  if (moduleHasF64TypedConstructFormal(ctx)) armExternF64ArgTypeGuard(ctx, fctx);
  return reserveNativeConstructDriver(ctx, 1, stringConstantExternrefInstrs(ctx, "prototype"));
}

interface DriveLocals {
  ctor: number;
  arg: number;
  cap: number;
  result: number;
  resolveFn: number;
  iter: number;
  done: number;
  value: number;
  index: number;
  state: number;
  aborted: number;
  exn: number;
  args: number;
  next: number;
  thenFn: number;
  grown: number;
  flag: number;
}

/**
 * Emit the drive. `L.ctor` / `L.arg` already hold `C` and the iterable. Leaves the capability's
 * promise (what `Construct(C, …)` returned) on the stack.
 */
function emitClassReceiverDrive(
  ctx: CodegenContext,
  fctx: FunctionContext,
  method: NativeCombinator,
  rt: ClassDriveRuntime,
  L: DriveLocals,
  promiseRooted: boolean,
): void {
  const capability = ensureCustomCapabilityRuntime(ctx)!;
  const wrapperRoot = getFuncRefWrapperRootTypeIdx(ctx)!;
  const ids = ensureCombinatorFunctions(ctx);
  const tagIdx = ensureExnTag(ctx);
  const fn = (name: string): number => ctx.funcMap.get(name)!;
  const capSlot = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: L.cap },
    { op: "struct.get", typeIdx: capability.stateTypeIdx, fieldIdx },
  ];
  const isCallable = (value: Instr[]): Instr[] => [
    ...value,
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: wrapperRoot },
  ];
  const typeError = (message: string): Instr[] => [
    ...stringConstantExternrefInstrs(ctx, message),
    { op: "call", funcIdx: fn("__new_TypeError") },
  ];
  // IfAbruptRejectPromise: `? Call(C.[[Reject]], undefined, «reason»)` — a throwing reject
  // propagates, exactly as the spec's `?` does.
  const rejectWith = (reason: Instr[]): Instr[] => [
    ...applyOneInstrs(ctx, capSlot(1), reason, L.args),
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L.aborted },
  ];
  const catchToReject = (): { tagIdx: number; body: Instr[] }[] => [
    { tagIdx, body: [{ op: "local.set", index: L.exn }, ...rejectWith([{ op: "local.get", index: L.exn }])] },
  ];

  // ── NewPromiseCapability(C): Construct(C, «executor»); both slots must be callable. ──
  const driverIdx = reserveConstructDriver(ctx, fctx);
  fctx.body.push(
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: capability.stateTypeIdx },
    { op: "local.set", index: L.cap },
    { op: "local.get", index: L.ctor },
    { op: "ref.null.extern" },
    ...buildCustomCapabilityExecutorInstrs(capability, L.cap),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: ctx.funcMap.get("__native_construct_1") ?? driverIdx },
    { op: "local.set", index: L.result },
    ...isCallable(capSlot(0)),
    ...isCallable(capSlot(1)),
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: [], else: customCapabilityTypeError(ctx) },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L.aborted },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L.done },
  );

  // ── GetPromiseResolve(C) — a throwing getter or a non-callable value rejects. ──
  // (#6651 D4) A Promise subclass inherits `resolve` from `%Promise%`. Built after every
  // registration above, so no later late-import shift can strand its baked indices.
  const resolveFallback = promiseRooted ? (promiseSubclassResolveFallbackInstrs(ctx, fctx, L.resolveFn) ?? []) : [];
  fctx.body.push(
    buildTargetTaggedTry(
      ctx,
      { kind: "empty" },
      [
        { op: "local.get", index: L.ctor },
        ...stringConstantExternrefInstrs(ctx, "resolve"),
        { op: "call", funcIdx: fn("__extern_get") },
        { op: "local.set", index: L.resolveFn },
        ...resolveFallback,
      ],
      catchToReject(),
    ),
    { op: "local.get", index: L.aborted },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...isCallable([{ op: "local.get", index: L.resolveFn }]),
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: rejectWith(typeError(`Promise.${method} resolve is not callable`)),
        },
      ],
    },
    // ── GetIterator — abrupt ⇒ reject; there is no iterator to close. ──
    { op: "local.get", index: L.aborted },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        buildTargetTaggedTry(
          ctx,
          { kind: "empty" },
          [
            { op: "local.get", index: L.arg },
            { op: "call", funcIdx: fn("__iterator") },
            { op: "local.set", index: L.iter },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: L.done },
          ],
          catchToReject(),
        ),
      ],
    },
    // The aggregate state: an empty list and the remaining-elements sentinel (1).
    ...capSlot(0),
    ...capSlot(1),
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: rt.arrTypeIdx },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: method === "any" ? 1 : 0 },
    { op: "struct.new", typeIdx: rt.stateTypeIdx },
    { op: "local.set", index: L.state },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L.index },
  );

  const saved = pushBody(fctx);
  let loopBody: Instr[];
  try {
    fctx.body.push(
      { op: "local.get", index: L.aborted },
      { op: "br_if", depth: 1 },
      { op: "local.get", index: L.done },
      { op: "br_if", depth: 1 },
      // IteratorStep + IteratorValue: [[Done]] is raised BEFORE the call, so an abrupt
      // `next()` / `done` / `value` leaves it true and suppresses the close (§7.4.6).
      { op: "i32.const", value: 1 },
      { op: "local.set", index: L.done },
      buildTargetTaggedTry(
        ctx,
        { kind: "empty" },
        [
          { op: "local.get", index: L.iter },
          { op: "call", funcIdx: fn("__iterator_next") },
          { op: "local.set", index: L.value },
          { op: "local.set", index: L.done },
        ],
        catchToReject(),
      ),
      { op: "local.get", index: L.aborted },
      { op: "br_if", depth: 1 },
      { op: "local.get", index: L.done },
      { op: "br_if", depth: 1 },
      buildTargetTaggedTry(
        ctx,
        { kind: "empty" },
        buildElementStep(ctx, method, rt, ids.arrTypeIdx, L, isCallable, typeError),
        [
          {
            tagIdx,
            body: [
              { op: "local.set", index: L.exn },
              { op: "i32.const", value: 1 },
              { op: "local.set", index: L.aborted },
            ],
          },
        ],
      ),
      // Abrupt element step with [[Done]] false: IteratorClose first (its own throw is
      // swallowed — the original completion wins), then IfAbruptRejectPromise.
      { op: "local.get", index: L.aborted },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          buildTargetTaggedTry(
            ctx,
            { kind: "empty" },
            [
              { op: "local.get", index: L.iter },
              { op: "call", funcIdx: fn("__iterator_return") },
            ],
            [{ tagIdx, body: [{ op: "drop" }] }],
          ),
          ...rejectWith([{ op: "local.get", index: L.exn }]),
        ],
      },
      { op: "local.get", index: L.index },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: L.index },
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

  // Iteration finished normally: drop the sentinel; at zero the list settles the capability.
  if (method !== "race") {
    fctx.body.push(
      { op: "local.get", index: L.aborted },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: L.state },
          { op: "local.get", index: L.state },
          { op: "struct.get", typeIdx: rt.stateTypeIdx, fieldIdx: ST_REMAINING },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          { op: "struct.set", typeIdx: rt.stateTypeIdx, fieldIdx: ST_REMAINING },
          { op: "local.get", index: L.state },
          { op: "struct.get", typeIdx: rt.stateTypeIdx, fieldIdx: ST_REMAINING },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L.state },
              { op: "call", funcIdx: fn(FINISH_FN) },
            ],
          },
        ],
      },
    );
  }
  fctx.body.push({ op: "local.get", index: L.result });
}

/** A fresh element function object over `mode`, sharing `L.flag`. */
function elemClosureInstrs(ctx: CodegenContext, rt: ClassDriveRuntime, mode: ElemMode, L: DriveLocals): Instr[] {
  return [
    { op: "ref.func", funcIdx: ctx.funcMap.get(ELEM_FN[mode])! },
    { op: "i32.const", value: 1 },
    closureBagInitInstr(),
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: rt.elemMetaTypeIdx },
    { op: "local.get", index: L.state },
    { op: "ref.as_non_null" },
    { op: "local.get", index: L.index },
    { op: "local.get", index: L.flag },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: rt.elemTypeIdx },
    { op: "extern.convert_any" },
  ];
}

/**
 * The per-element work, inside the element try: append a slot (list methods), `Call(resolve)`,
 * build the handler pair, count the element, `Invoke(next, "then", …)`.
 */
function buildElementStep(
  ctx: CodegenContext,
  method: NativeCombinator,
  rt: ClassDriveRuntime,
  arrTypeIdx: number,
  L: DriveLocals,
  isCallable: (value: Instr[]) => Instr[],
  typeError: (message: string) => Instr[],
): Instr[] {
  const st = rt.stateTypeIdx;
  const out: Instr[] = [];
  const listMethod = method !== "race";
  if (listMethod) {
    // values.append(undefined): grow geometrically; `len` is the logical length.
    out.push(
      { op: "local.get", index: L.index },
      { op: "local.get", index: L.state },
      { op: "struct.get", typeIdx: st, fieldIdx: ST_VALS },
      { op: "array.len" },
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: L.index },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "array.new_default", typeIdx: arrTypeIdx },
          { op: "local.set", index: L.grown },
          { op: "local.get", index: L.grown },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: L.state },
          { op: "struct.get", typeIdx: st, fieldIdx: ST_VALS },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: L.state },
          { op: "struct.get", typeIdx: st, fieldIdx: ST_VALS },
          { op: "array.len" },
          { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
          { op: "local.get", index: L.state },
          { op: "local.get", index: L.grown },
          { op: "ref.as_non_null" },
          { op: "struct.set", typeIdx: st, fieldIdx: ST_VALS },
        ],
      },
      { op: "local.get", index: L.state },
      { op: "local.get", index: L.index },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: st, fieldIdx: ST_LEN },
    );
  }
  // nextPromise = Call(promiseResolve, C, «value»)
  out.push(
    { op: "local.get", index: L.resolveFn },
    { op: "local.get", index: L.ctor },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: L.args },
    { op: "local.get", index: L.args },
    { op: "local.get", index: L.value },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
    { op: "local.get", index: L.args },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
    { op: "local.set", index: L.next },
  );
  const capSlot = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: L.state },
    { op: "struct.get", typeIdx: st, fieldIdx },
  ];
  let h1: Instr[];
  let h2: Instr[];
  if (listMethod) {
    out.push(
      { op: "i32.const", value: 0 },
      { op: "struct.new", typeIdx: rt.flagTypeIdx },
      { op: "local.set", index: L.flag },
    );
  }
  if (method === "all") {
    h1 = elemClosureInstrs(ctx, rt, "value", L);
    h2 = capSlot(ST_REJECT);
  } else if (method === "allSettled") {
    h1 = elemClosureInstrs(ctx, rt, "fulfilled", L);
    h2 = elemClosureInstrs(ctx, rt, "rejected", L);
  } else if (method === "any") {
    h1 = capSlot(ST_RESOLVE);
    h2 = elemClosureInstrs(ctx, rt, "value", L);
  } else {
    h1 = capSlot(ST_RESOLVE);
    h2 = capSlot(ST_REJECT);
  }
  if (listMethod) {
    out.push(
      { op: "local.get", index: L.state },
      { op: "local.get", index: L.state },
      { op: "struct.get", typeIdx: st, fieldIdx: ST_REMAINING },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: st, fieldIdx: ST_REMAINING },
    );
  }
  // Invoke(nextPromise, "then", «h1, h2») — §7.3.20; a non-callable `then` is a TypeError,
  // except on a native `$Promise` (no readable `then` value yet, #5197 R3-7 — D1's exemption).
  const promiseTypeIdx = ensureCombinatorFunctions(ctx).promiseTypeIdx;
  out.push(
    { op: "local.get", index: L.next },
    ...stringConstantExternrefInstrs(ctx, "then"),
    { op: "call", funcIdx: ctx.funcMap.get("__extern_get")! },
    { op: "local.set", index: L.thenFn },
    ...isCallable([{ op: "local.get", index: L.thenFn }]),
    { op: "i32.eqz" },
    { op: "local.get", index: L.next },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...typeError("Promise combinator element then is not a function"),
        { op: "throw", tagIdx: ensureExnTag(ctx) },
      ],
    },
    { op: "local.get", index: L.thenFn },
    { op: "local.get", index: L.next },
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_new")! },
    { op: "local.set", index: L.args },
    { op: "local.get", index: L.args },
    ...h1,
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
    { op: "local.get", index: L.args },
    ...h2,
    { op: "call", funcIdx: ctx.funcMap.get("__objvec_push")! },
    { op: "local.get", index: L.args },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure")! },
    { op: "drop" },
  );
  return out;
}

/**
 * `Promise.<method>.call(C, iterable)` for a compiled-class `C`. Returns the result type when it
 * emitted the lowering; `undefined` — with the function body rolled back — when it declined.
 */
export function tryEmitClassReceiverCombinatorCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  method: NativeCombinator,
): ValType | undefined {
  if (!isStandalonePromiseActive(ctx)) return undefined;
  const ctorArg = expr.arguments[0];
  if (ctorArg === undefined || expr.arguments.length > 2) return undefined;
  const className = resolveCompiledClassReceiver(ctx, ctorArg);
  // (#5197 r3 Step 5) …or an ordinary FUNCTION `C` over a non-literal iterable: D1 drains one
  // through `__combinator_to_vec`, which cannot step an iterator (an expando `@@iterator` reads
  // as "not iterable"); an array literal keeps D1. The drive constructs any `C` via the driver.
  const iterable = expr.arguments[1];
  const functionCtor =
    className === undefined &&
    (iterable === undefined || !ts.isArrayLiteralExpression(iterable)) &&
    isOrdinaryFunctionCtorArg(ctx, ctorArg) &&
    !shadowsGlobalValueName(ctorArg);
  if (className === undefined && !functionCtor) return undefined;

  const snap = snapshotSpeculative(ctx, fctx);
  // Registration strictly precedes emission.
  ensureNativeIteratorRuntime(ctx);
  const capability = ensureCustomCapabilityRuntime(ctx);
  const rt = ensureClassDriveRuntime(ctx);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  addStringConstantGlobal(ctx, "resolve");
  addStringConstantGlobal(ctx, "then");
  addStringConstantGlobal(ctx, `Promise.${method} resolve is not callable`);
  addStringConstantGlobal(ctx, "Promise combinator element then is not a function");
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const needed = ["__iterator", "__iterator_next", "__iterator_return", "__extern_get", "__new_TypeError"];
  if (
    !capability ||
    !rt ||
    getFuncRefWrapperRootTypeIdx(ctx) === undefined ||
    needed.some((name) => ctx.funcMap.get(name) === undefined)
  ) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }
  // `Get(C, "resolve")` is a runtime-key read of the class OBJECT: record the demand so the
  // class's static sidecar is materialised (#5383 S2i).
  if (className !== undefined) recordStandaloneRuntimeKeyClassMemberRead(ctx, ctx.structMap.get(className));
  // `Invoke(next, "then", …)` reads `then` off whatever `C.resolve` answers — a native promise
  // included (#6651 D5): demand `%Promise.prototype%.then` so that read finds it.
  demandPromiseDynamicMember(ctx, "then", fctx);

  const local = (name: string, type: ValType): number => allocLocal(fctx, `__pcd_${name}_${fctx.locals.length}`, type);
  const L: DriveLocals = {
    ctor: local("ctor", EXTERNREF),
    arg: local("arg", EXTERNREF),
    cap: local("cap", { kind: "ref_null", typeIdx: capability.stateTypeIdx }),
    result: local("result", EXTERNREF),
    resolveFn: local("resolve", EXTERNREF),
    iter: local("iter", EXTERNREF),
    done: local("done", I32),
    value: local("value", EXTERNREF),
    index: local("index", I32),
    state: local("state", { kind: "ref_null", typeIdx: rt.stateTypeIdx }),
    aborted: local("aborted", I32),
    exn: local("exn", EXTERNREF),
    args: local("args", EXTERNREF),
    next: local("next", EXTERNREF),
    thenFn: local("then", EXTERNREF),
    grown: local("grown", { kind: "ref_null", typeIdx: rt.arrTypeIdx }),
    flag: local("flag", { kind: "ref_null", typeIdx: rt.flagTypeIdx }),
  };
  // Argument evaluation (C, then the iterable) completes before the builtin runs.
  const pushExtern = (e: ts.Expression | undefined, into: number): void => {
    if (e === undefined) {
      fctx.body.push({ op: "ref.null.extern" });
    } else {
      const t = compileExpression(ctx, fctx, e, EXTERNREF);
      if (t === null) fctx.body.push({ op: "ref.null.extern" });
      else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
    }
    fctx.body.push({ op: "local.set", index: into });
  };
  pushExtern(ctorArg, L.ctor);
  pushExtern(expr.arguments[1], L.arg);
  const promiseRooted = className !== undefined && resolvePromiseSubclassName(ctx, className) !== undefined;
  emitClassReceiverDrive(ctx, fctx, method, rt, L, promiseRooted);
  return EXTERNREF;
}
