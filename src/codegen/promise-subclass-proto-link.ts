// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster D, slice D4 / #5197 G9) Prototype identity for a standalone
 * `class X extends Promise` instance.
 *
 * ## Representation
 *
 * A Promise-subclass instance is the native `$Promise` carrier itself — the
 * value `super(executor)` builds through the same executor bridge as
 * `new Promise(executor)` — so the settle / `then` / combinator machinery takes
 * it unchanged. What the carrier lacks is a [[Prototype]]: every `$Promise` is
 * "a Promise" and nothing more. This module adds the link WITHOUT touching the
 * `$Promise` struct (every promise allocation in every module stays byte-for-
 * byte what it was), exactly as #2917 did for the `extends Array` vec carrier:
 *
 *   - the carrier's intrinsic `$bag` (#4241) is an ordinary `$Object`, and every
 *     consumer of a bag reads it OWN-only (the #4563 `hasOwn` guard), so its
 *     `$proto` field is an unused slot;
 *   - construction stores `X.prototype` there, after the #5383 S2m install has
 *     put `constructor` in the same bag;
 *   - `v instanceof X` (a Promise-subclass RHS) walks that link and then the
 *     ordinary `$Object.$proto` chain with `ref.eq` — OrdinaryHasInstance over
 *     the only chain a `$Promise` can carry, so `Y extends X extends Promise`
 *     needs no per-class list.
 *
 * ## Byte-neutrality
 *
 * `--target standalone` only (the prototype `$Object` exists only there,
 * `standaloneClassProtoObjectApplies`), and only for a class whose builtin root
 * is `Promise`. A module with no such class emits nothing from here.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { standaloneClassProtoObjectApplies } from "./class-proto-object.js";
import { emitLazyProtoGet } from "./expressions/extern.js";
import { resolvePromiseSubclassIdentifier } from "./expressions/promise-subclass.js";
import { getOrRegisterPromiseType, isStandalonePromiseActive } from "./async-scheduler.js";
import { coerceType, compileExpression, flushLateImportShifts } from "./shared.js";
import { emitBuiltinConstructorIdentity } from "./builtin-static-globals.js";
import { ensureExternIsUndefinedImport } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";

const EXTERNREF: ValType = { kind: "externref" };
const BAG_ENSURE = "__closure_bag_ensure";
const INSTANCEOF_HELPER = "__promise_proto_instanceof";

/** The `$Promise` field holding the carrier's own-property bag. */
function promiseBagFieldIdx(ctx: CodegenContext, promiseTypeIdx: number): number | undefined {
  const def = ctx.mod.types[promiseTypeIdx];
  if (!def || def.kind !== "struct") return undefined;
  const idx = def.fields.findIndex((field) => field.name === "$bag");
  return idx < 0 ? undefined : idx;
}

/** A standalone class rooted at `Promise` whose prototype is a real `$Object`. */
function linkApplies(ctx: CodegenContext, className: string): boolean {
  return (
    ctx.standalone === true &&
    ctx.classBuiltinParentMap.get(className) === "Promise" &&
    standaloneClassProtoObjectApplies(ctx, className) &&
    ctx.objectRuntimeTypes !== undefined
  );
}

/**
 * The implicit constructor of `class X extends Promise {}` (no own constructor,
 * direct heritage `Promise`), standalone: `super(...args)` must build the real
 * carrier from `args[0]`. A class whose parent is a USER class keeps its own
 * path (that parent's constructor has to run).
 */
export function isStandalonePromiseSuperForwarder(ctx: CodegenContext, className: string, arity: number): boolean {
  if (ctx.standalone !== true || !isStandalonePromiseActive(ctx) || arity < 1) return false;
  const parent = ctx.classParentMap.get(className);
  if (parent !== undefined && ctx.classSet.has(parent)) return false;
  return ctx.classBuiltinParentMap.get(className) === "Promise";
}

/**
 * At construction, after `super(executor)` has left the `$Promise` in
 * `selfLocal`: `bag(self).$proto = X.prototype`. Guarded by a runtime
 * `ref.test $Promise`, so a carrier of any other kind is left alone. Emits
 * nothing unless {@link linkApplies}.
 */
export function emitPromiseSubclassProtoLink(
  ctx: CodegenContext,
  fctx: FunctionContext,
  selfLocal: number,
  className: string,
): void {
  if (!linkApplies(ctx, className) || !ctx.funcMap.has(BAG_ENSURE)) return;
  const objectTypeIdx = ctx.objectRuntimeTypes!.objectTypeIdx;
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  // The bag goes through a TYPED local (see vec-proto-link.ts: `fixups.ts`
  // re-casts a `local.get <externref>; call; cast` struct.set receiver).
  const bagLocal = allocLocal(fctx, `__promise_link_bag_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: objectTypeIdx,
  });
  const saved = pushBody(fctx);
  let protoInstrs: Instr[];
  let ok: boolean;
  try {
    ok = emitLazyProtoGet(ctx, fctx, className);
  } finally {
    protoInstrs = fctx.body;
    popBody(fctx, saved);
  }
  if (!ok) return;
  // The prototype builder can register late imports; the flush repairs every
  // live body, including the detached one still referenced below.
  ctx.liveBodies.add(protoInstrs);
  flushLateImportShifts(ctx, fctx);
  ctx.liveBodies.delete(protoInstrs);
  fctx.body.push(
    { op: "local.get", index: selfLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: selfLocal },
        { op: "call", funcIdx: ctx.funcMap.get(BAG_ENSURE)! },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "local.set", index: bagLocal },
        { op: "local.get", index: bagLocal },
        ...protoInstrs,
        { op: "any.convert_extern" },
        { op: "ref.cast_null", typeIdx: objectTypeIdx },
        { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 0 },
      ],
    },
  );
}

/**
 * `__promise_proto_instanceof(v, P) -> i32`: OrdinaryHasInstance steps 4-6 with
 * `P` = `C.prototype` — the `$Promise` bag link (or an `$Object`'s own
 * `$proto`), walked with `ref.eq` until null. Minted once, with its full body.
 */
function ensureInstanceofHelper(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(INSTANCEOF_HELPER);
  if (existing !== undefined) return existing;
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (objectTypeIdx === undefined) return undefined;
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const bagFieldIdx = promiseBagFieldIdx(ctx, promiseTypeIdx);
  if (bagFieldIdx === undefined) return undefined;
  const objRefNull: ValType = { kind: "ref_null", typeIdx: objectTypeIdx };
  const retFalse: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  // params: 0 = value, 1 = C.prototype. locals: 2 any, 3 bag (externref), 4 p, 5 target.
  const body: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 2 },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: retFalse },
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: objectTypeIdx },
    { op: "local.set", index: 5 },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 2 },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // A `$Promise`: its link is `bag.$proto`; no bag ⇒ no link ⇒ false.
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: promiseTypeIdx },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: bagFieldIdx },
        { op: "local.tee", index: 3 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: objectTypeIdx },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: retFalse },
        { op: "local.get", index: 3 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 4 },
      ],
      else: [
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: objectTypeIdx },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: retFalse },
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 4 },
      ],
    },
    // Walk the `$proto` chain (finite: `__object_setPrototypeOf` refuses cycles).
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: 4 },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: retFalse },
        { op: "local.get", index: 4 },
        { op: "local.get", index: 5 },
        { op: "ref.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 1 }, { op: "return" }],
        },
        { op: "local.get", index: 4 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: 4 },
        { op: "br", depth: 0 },
      ],
    },
    { op: "i32.const", value: 0 },
  ];
  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [{ kind: "i32" }], `$${INSTANCEOF_HELPER}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: INSTANCEOF_HELPER,
    typeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__bag", type: EXTERNREF },
      { name: "__p", type: objRefNull },
      { name: "__target", type: objRefNull },
    ],
    body,
    exported: false,
  });
  ctx.funcMap.set(INSTANCEOF_HELPER, funcIdx);
  return funcIdx;
}

/**
 * `v instanceof X` for a Promise-subclass identifier `X`, standalone:
 * `__promise_proto_instanceof(v, X.prototype)`. `null` — emitting nothing — when
 * not applicable (every other RHS, every other target).
 */
export function tryEmitPromiseSubclassInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): ValType | null {
  if (!ts.isIdentifier(expr.right)) return null;
  const className = resolvePromiseSubclassIdentifier(ctx, expr.right);
  if (className === undefined || !linkApplies(ctx, className)) return null;
  const helperIdx = ensureInstanceofHelper(ctx);
  if (helperIdx === undefined) return null;
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (leftType === null) fctx.body.push({ op: "ref.null.extern" });
  else if (leftType.kind !== "externref") coerceType(ctx, fctx, leftType, EXTERNREF);
  if (!emitLazyProtoGet(ctx, fctx, className)) fctx.body.push({ op: "ref.null.extern" });
  flushLateImportShifts(ctx, fctx);
  fctx.body.push({
    op: "call",
    funcIdx: ctx.funcMap.get(INSTANCEOF_HELPER) ?? helperIdx,
  });
  return { kind: "i32" };
}

/**
 * GetPromiseResolve(C) for a Promise-subclass class object `C`: `Get(C, "resolve")`
 * inherits from `%Promise%` (§15.7.14 step 5.b makes `Promise` the class object's
 * [[Prototype]]), but the standalone class object carries no link to it, so an
 * inherited read answers `undefined`. Returns the instructions that, when the
 * value already in `resolveLocal` is `undefined`, replace it with
 * `Get(%Promise%, "resolve")` — the live property, so a reassigned
 * `Promise.resolve` is honoured. Registration happens here, before any
 * emission; `null` when a dependency is unavailable (the caller keeps D3's read).
 */
export function promiseSubclassResolveFallbackInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  resolveLocal: number,
): Instr[] | null {
  const isUndefinedIdx = ensureExternIsUndefinedImport(ctx);
  flushLateImportShifts(ctx, fctx);
  if (isUndefinedIdx === undefined) return null;
  const getResolve = promiseIntrinsicGetInstrs(ctx, fctx, "resolve");
  if (getResolve === null) return null;
  return [
    { op: "local.get", index: resolveLocal },
    {
      op: "call",
      funcIdx: ctx.funcMap.get("__extern_is_undefined") ?? isUndefinedIdx,
    },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...getResolve, { op: "local.set", index: resolveLocal }],
    },
  ];
}

/**
 * `Get(%Promise%, key)` — the LIVE property of the intrinsic constructor carrier, so a
 * reassigned `Promise.<key>` is honoured. Requires `__extern_get` to be registered already;
 * `null` when it is not. Stack: `[] → [externref]`.
 */
export function promiseIntrinsicGetInstrs(ctx: CodegenContext, fctx: FunctionContext, key: string): Instr[] | null {
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) return null;
  const saved = pushBody(fctx);
  let promiseCtor: Instr[];
  try {
    const t = emitBuiltinConstructorIdentity(ctx, fctx, "Promise");
    if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  } finally {
    promiseCtor = fctx.body;
    popBody(fctx, saved);
  }
  ctx.liveBodies.add(promiseCtor);
  flushLateImportShifts(ctx, fctx);
  ctx.liveBodies.delete(promiseCtor);
  return [
    ...promiseCtor,
    ...stringConstantExternrefInstrs(ctx, key),
    { op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? externGetIdx },
  ];
}
