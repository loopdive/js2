// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268 step 1) Annex B §B.2.2.1 — the `Object.prototype.__proto__` ACCESSOR
 * PAIR under `--target standalone`.
 *
 * ## What was missing
 *
 * `Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")` answered
 * `undefined`, so every test262 row that reaches the accessor reflectively
 * (`….get`, `….set`, then `.call(receiver)`) died dereferencing `undefined`.
 * The `$NativeProto` glue (`native-proto.ts`) models `memberKind:
 * "getter" | "method"` only — it has no set-half — which is exactly why #5148
 * left this member out. This module therefore synthesizes the descriptor
 * directly from two closures rather than widening that glue.
 *
 * ## Two natives, three callers
 *
 * `__object_proto_get` / `__object_proto_set` hold the semantics once; three
 * surfaces call them:
 *
 * 1. the reflective closures below (`get __proto__` / `set __proto__`), which
 *    are what the descriptor's `get`/`set` fields carry;
 * 2. the compile-time gOPD arm (`tryEmitObjectProtoProtoAccessorGopd`);
 * 3. the SYNTACTIC setter form `o.__proto__ = v`
 *    (`expressions/assignment.ts`), which must throw the §B.2.2.1 step-5
 *    TypeError on a refused `[[SetPrototypeOf]]` — the plain
 *    `__object_setPrototypeOf` writer it used before is deliberately a silent
 *    no-op there.
 *
 * ## Everything composes from natives that already exist
 *
 * | step | existing native |
 * | --- | --- |
 * | RequireObjectCoercible | `ref.is_null` ∨ `__extern_is_undefined` |
 * | Type(v) is Object | `__typeof_object` ∨ `__typeof_function`, minus null/undefined/`$Symbol` |
 * | `O.[[GetPrototypeOf]]` | `__getPrototypeOf` (carries the Proxy `gpo` guard) |
 * | the BOOLEAN `[[SetPrototypeOf]]` | `__object_setPrototypeOf_status` (#5148) |
 * | the WRITE | `__object_setPrototypeOf` (carries the Proxy `spo` guard) |
 *
 * The Proxy arm needs no code here: `__object_setPrototypeOf`'s front-guard
 * (`object-runtime-proxy.ts`) already routes a `$Proxy` receiver to
 * `__proxy_spo_dispatch`, so a throwing `setPrototypeOf` trap escapes through
 * the write call. `$Proxy` is not a subtype of `$Object`, so the status
 * predicate answers its permissive `1` for a proxy and never pre-empts the
 * trap.
 *
 * ## Deliberate residuals
 *
 * - `OBJECT_PROTOTYPE_OWN_NAMES` (`object-proto-name-in.ts`) is left alone for
 *   the reason recorded there: widening it changes the `in` answer for every
 *   ordinary receiver. The three `verifyProperty`-driven rows (`prop-desc`,
 *   `get-fn-name`, `set-fn-name`) need that plus a working `delete` on
 *   `Object.prototype`, which is a separate blast radius.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileExpression } from "./expressions.js";
import { coerceType } from "./type-coercion.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { ensureBuiltinFnMetaType, pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { buildLazyNativeProtoGetInstrs } from "./native-proto.js";
import { tryEnsureNativeProtoBrand } from "./builtin-value-read.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** `{[[Enumerable]]: false, [[Configurable]]: true}` in the descriptor flag word. */
const FLAG_CONFIGURABLE = 0x04;

/** `$NativeProto` field 0 — the brand id. Mirrors `object-proto-tostring.ts`. */
const NATIVE_PROTO_BRAND_FIELD = 0;

/** `$Object` field 4 — the integrity/classification flag word. */
const OBJ_FLAGS_FIELD = 4;
/** `object-runtime.ts` `OBJ_FLAG_NULL_PROTO` — an EXPLICIT null [[Prototype]]. */
const OBJ_FLAG_NULL_PROTO = 0x80;

interface ProtoAccessorDeps {
  isUndefined: number;
  typeofObject: number;
  typeofFunction: number;
  getPrototypeOf: number;
  setPrototypeOf: number;
  setPrototypeOfStatus: number;
}

/**
 * Resolve every funcidx both natives need, with all import-adding calls made
 * BEFORE any body is built and every index re-fetched BY NAME afterwards — the
 * #2039 shift discipline. `null` means "a piece is unavailable", and every
 * caller then keeps its pre-existing behaviour rather than emitting a
 * half-body.
 */
function resolveProtoAccessorDeps(ctx: CodegenContext): ProtoAccessorDeps | null {
  if (!ctx.standalone) return null;
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__getPrototypeOf", [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__object_setPrototypeOf", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__object_setPrototypeOf_status", [EXTERNREF, EXTERNREF], [I32]);
  flushLateImportShifts(ctx, null);
  const names = [
    "__extern_is_undefined",
    "__typeof_object",
    "__typeof_function",
    "__getPrototypeOf",
    "__object_setPrototypeOf",
    "__object_setPrototypeOf_status",
  ] as const;
  const idxs = names.map((name) => ctx.funcMap.get(name));
  if (idxs.some((idx) => idx === undefined)) return null;
  const [isUndefined, typeofObject, typeofFunction, getPrototypeOf, setPrototypeOf, setPrototypeOfStatus] =
    idxs as number[];
  return {
    isUndefined: isUndefined!,
    typeofObject: typeofObject!,
    typeofFunction: typeofFunction!,
    getPrototypeOf: getPrototypeOf!,
    setPrototypeOf: setPrototypeOf!,
    setPrototypeOfStatus: setPrototypeOfStatus!,
  };
}

/** `(externref) -> i32`: the value is `null` OR `undefined` (RequireObjectCoercible). */
function nullishInstrs(local: number, isUndefinedIdx: number): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    { op: "local.get", index: local },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.or" },
  ];
}

/**
 * `(externref) -> i32`: ECMAScript `Type(v) is Object`.
 *
 * `__typeof_object` deliberately answers 1 for `null` (JavaScript's
 * `typeof null === "object"`) and the standalone `$Symbol` carrier predates it,
 * so both exclusions are explicit — the same composition
 * `reflect-target-guard.ts` uses for Reflect's Type(V) precondition.
 */
function isObjectInstrs(ctx: CodegenContext, local: number, deps: ProtoAccessorDeps): Instr[] {
  const instrs: Instr[] = [
    { op: "local.get", index: local },
    { op: "call", funcIdx: deps.typeofObject },
    { op: "local.get", index: local },
    { op: "call", funcIdx: deps.typeofFunction },
    { op: "i32.or" },
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "i32.and" },
    { op: "local.get", index: local },
    { op: "call", funcIdx: deps.isUndefined },
    { op: "i32.eqz" },
    { op: "i32.and" },
  ];
  if (ctx.symbolTypeIdx >= 0) {
    instrs.push(
      { op: "local.get", index: local },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
      { op: "i32.eqz" },
      { op: "i32.and" },
    );
  }
  return instrs;
}

/**
 * Register (idempotently) `__object_proto_get(this) -> externref` — §B.2.2.1.1.
 * Returns the func handle, or -1 when a dependency is unavailable.
 */
export function ensureObjectProtoProtoGetNative(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__object_proto_get");
  if (cached !== undefined) return cached;
  const deps = resolveProtoAccessorDeps(ctx);
  if (!deps) return -1;

  // Built BEFORE the body so neither can register a late import mid-emission.
  const throwNotCoercible = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert undefined or null to object", {
    forceInModuleCtor: true,
  });
  const implicitTerminal = buildImplicitObjectPrototypeTerminal(ctx);

  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__object_proto_get", funcIdx);

  const body: Instr[] = [
    // 1. O = ToObject(this) — the only observable half for the rows in scope is
    //    its nullish TypeError; a primitive receiver's [[Prototype]] is read
    //    through the same helper below.
    ...nullishInstrs(0, deps.isUndefined),
    { op: "if", blockType: { kind: "empty" }, then: throwNotCoercible },
    // 2. Return O.[[GetPrototypeOf]]() — Proxy `getPrototypeOf` trap included.
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.getPrototypeOf },
    ...(implicitTerminal ?? []),
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__object_proto_get",
    typeIdx,
    locals: implicitTerminal ? [{ name: "proto", type: EXTERNREF }] : [],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * `$Object.$proto === null` has TWO encodings in the standalone runtime
 * (`object-runtime-prototype.ts` says so at the flag definition): an ordinary
 * object whose implicit `%Object.prototype%` terminal is simply omitted, and an
 * EXPLICITLY null-prototype object, which carries `OBJ_FLAG_NULL_PROTO`. The
 * compile-time `Object.getPrototypeOf` folds already answer
 * `Object.prototype` for the first case; the runtime `__getPrototypeOf` walk
 * answers `null` for both, so a REFLECTIVE read has to re-apply the
 * distinction.
 *
 * Consumes the `[[GetPrototypeOf]]` result on the stack and leaves the
 * corrected one. Returns `undefined` (caller emits nothing extra) when the
 * `%Object.prototype%` singleton cannot be materialized, so the answer stays
 * exactly what it was.
 *
 * The one local it needs is declared by the caller as index 1.
 */
function buildImplicitObjectPrototypeTerminal(ctx: CodegenContext): Instr[] | undefined {
  const runtime = ctx.objectRuntimeTypes;
  if (!runtime) return undefined;
  const brand = tryEnsureNativeProtoBrand(ctx, "Object");
  if (brand === undefined) return undefined;
  const protoInstrs = buildLazyNativeProtoGetInstrs(ctx, brand);
  if (!protoInstrs) return undefined;
  const PROTO = 1;
  return [
    { op: "local.tee", index: PROTO },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: runtime.objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: runtime.objectTypeIdx },
            { op: "struct.get", typeIdx: runtime.objectTypeIdx, fieldIdx: OBJ_FLAGS_FIELD },
            { op: "i32.const", value: OBJ_FLAG_NULL_PROTO },
            { op: "i32.and" },
            { op: "i32.eqz" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: [...protoInstrs, { op: "extern.convert_any" }],
          else: [{ op: "local.get", index: PROTO }],
        },
      ],
      else: [{ op: "local.get", index: PROTO }],
    },
  ];
}

/**
 * Register (idempotently) `__object_proto_set(this, proto) -> externref`
 * (always `undefined`) — §B.2.2.1.2. Returns the func handle, or -1 when a
 * dependency is unavailable.
 */
export function ensureObjectProtoProtoSetNative(ctx: CodegenContext): number {
  const cached = ctx.funcMap.get("__object_proto_set");
  if (cached !== undefined) return cached;
  const deps = resolveProtoAccessorDeps(ctx);
  if (!deps) return -1;

  const undefInstrs = canonicalUndefinedExternInstrs(ctx);
  const throwNotCoercible = buildThrowJsErrorInstrs(
    ctx,
    "TypeError",
    "Object.prototype.__proto__ called on null or undefined",
    { forceInModuleCtor: true },
  );
  const throwRefused = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot set prototype of this object", {
    forceInModuleCtor: true,
  });

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__object_proto_set", funcIdx);

  const THIS = 0;
  const PROTO = 1;

  const body: Instr[] = [
    // 1. RequireObjectCoercible(this).
    ...nullishInstrs(THIS, deps.isUndefined),
    { op: "if", blockType: { kind: "empty" }, then: throwNotCoercible },
    // 2. If Type(proto) is neither Object nor Null, return undefined. `null` is
    //    the ONLY nullish value that passes; `undefined` and every primitive
    //    fall out here without a throw and without a write.
    { op: "local.get", index: PROTO },
    { op: "ref.is_null" },
    ...isObjectInstrs(ctx, PROTO, deps),
    { op: "i32.or" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [...undefInstrs, { op: "return" }] },
    // 3. If Type(O) is not Object, return undefined.
    ...isObjectInstrs(ctx, THIS, deps),
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [...undefInstrs, { op: "return" }] },
    // 4/5. status = O.[[SetPrototypeOf]](proto); false → TypeError. The status
    //      predicate answers its permissive `1` for a `$Proxy` receiver, so the
    //      write below is what invokes the trap (and propagates its abrupt).
    { op: "local.get", index: THIS },
    { op: "local.get", index: PROTO },
    { op: "call", funcIdx: deps.setPrototypeOfStatus },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwRefused },
    { op: "local.get", index: THIS },
    { op: "local.get", index: PROTO },
    { op: "call", funcIdx: deps.setPrototypeOf },
    { op: "drop" },
    // 6. Return undefined.
    ...undefInstrs,
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__object_proto_set",
    typeIdx,
    locals: [],
    body,
    exported: false,
  } as WasmFunction);
  return funcIdx;
}

/**
 * The identity-stable reflective closure for one half of the accessor.
 *
 * Shaped exactly like `ensureStandaloneSpeciesGetterClosure`
 * (`builtin-fn-meta.ts`): the FIRST user parameter is the receiver, and
 * registering the meta subtype as receiver-aware is what keeps
 * `desc.set.call(subject, proto)` from dropping `subject`. §17 prepends
 * `"get "` / `"set "` to the property name, and the receiver slot is not
 * counted by `.length` — so `set __proto__` reports 1, `get __proto__` 0.
 */
export function ensureObjectProtoProtoAccessorClosure(
  ctx: CodegenContext,
  half: "get" | "set",
): { type: { kind: "ref"; typeIdx: number }; funcIdx: number } | null {
  const nativeIdx = half === "get" ? ensureObjectProtoProtoGetNative(ctx) : ensureObjectProtoProtoSetNative(ctx);
  if (nativeIdx < 0) return null;
  const resolvedIdx = ctx.funcMap.get(half === "get" ? "__object_proto_get" : "__object_proto_set");
  if (resolvedIdx === undefined) return null;

  const userParams: ValType[] = half === "get" ? [EXTERNREF] : [EXTERNREF, EXTERNREF];
  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, [EXTERNREF]);
  if (!wrapperTypes) return null;

  const specName = `${half} __proto__`;
  const funcName = `__object_proto_${half}_closure`;
  let funcIdx = ctx.funcMap.get(funcName);
  if (funcIdx === undefined) {
    const body: Instr[] = [{ op: "local.get", index: 1 }];
    if (half === "set") body.push({ op: "local.get", index: 2 });
    body.push({ op: "call", funcIdx: resolvedIdx });
    funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: funcName,
      typeIdx: wrapperTypes.liftedFuncTypeIdx,
      locals: [],
      body,
      exported: false,
    } as WasmFunction);
    ctx.funcMap.set(funcName, funcIdx);
    if (!ctx.nativeClosureMeta) ctx.nativeClosureMeta = new Map();
    ctx.nativeClosureMeta.set(funcIdx, { name: specName, length: half === "set" ? 1 : 0 });
  }

  const metaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrapperTypes.structTypeIdx,
    wrapperTypes.closureInfo,
    `objproto:__proto__:${half}`,
    specName,
    half === "set" ? 1 : 0,
  );
  (ctx.nativeProtoReceiverClosureStructTypes ??= new Set()).add(metaTypeIdx);
  return { type: { kind: "ref", typeIdx: metaTypeIdx }, funcIdx };
}

/**
 * `Object.getOwnPropertyDescriptor(Object.prototype, "__proto__")` — the
 * §B.2.2.1 accessor descriptor `{get, set, enumerable: false, configurable:
 * true}`.
 *
 * Leaves ONE externref on the stack and returns `true`, or returns `false`
 * with NOTHING pushed so the caller keeps its existing dispatch. Declines for
 * every non-standalone lane, every other receiver, and every other member.
 */
export function tryEmitObjectProtoProtoAccessorGopd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  protoBuiltinName: string | undefined,
  member: string | undefined,
): boolean {
  if (!ctx.standalone) return false;
  if (protoBuiltinName !== "Object" || member !== "__proto__") return false;
  const getter = ensureObjectProtoProtoAccessorClosure(ctx, "get");
  const setter = ensureObjectProtoProtoAccessorClosure(ctx, "set");
  if (!getter || !setter) return false;
  const createAccIdx = ensureLateImport(ctx, "__create_accessor_descriptor", [EXTERNREF, EXTERNREF, I32], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  if (createAccIdx === undefined) return false;
  const resolvedCreate = ctx.funcMap.get("__create_accessor_descriptor") ?? createAccIdx;
  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, getter));
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, setter));
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "i32.const", value: FLAG_CONFIGURABLE });
  fctx.body.push({ op: "call", funcIdx: resolvedCreate });
  return true;
}

/**
 * (#5268 step 1) `desc.get.call(receiver)` / `desc.set.call(receiver, proto)`
 * where `desc` traced back to `gOPD(Object.prototype, "__proto__")`.
 *
 * Called from the #2876 descriptor-accessor `.call` arm in `calls.ts`, which
 * has already done the data-flow trace. Both halves are ordinary natives — not
 * `$NativeProto` member closures — so the shared `call_ref` emitter cannot
 * reach them; a direct `call` with `thisArg → param 0` is observationally
 * identical to invoking the forwarding closure the descriptor carries.
 *
 * Returns the result ValType when handled, or `undefined` (nothing pushed) to
 * leave the caller's existing dispatch untouched. `.apply` declines: no row in
 * scope spells it, and declining costs nothing.
 */
export function tryCompileObjectProtoProtoAccessorReflectiveCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  accessorName: string,
  gopdInfo: { builtinName: string; member: string } | undefined,
  isCall: boolean,
): ValType | undefined {
  if (!ctx.standalone || !isCall) return undefined;
  if (gopdInfo?.builtinName !== "Object" || gopdInfo.member !== "__proto__") return undefined;
  if (accessorName !== "get" && accessorName !== "set") return undefined;
  if (expr.arguments.some((arg) => ts.isSpreadElement(arg))) return undefined;

  const nativeIdx =
    accessorName === "get" ? ensureObjectProtoProtoGetNative(ctx) : ensureObjectProtoProtoSetNative(ctx);
  if (nativeIdx < 0) return undefined;
  flushLateImportShifts(ctx, fctx);
  const resolvedIdx = ctx.funcMap.get(accessorName === "get" ? "__object_proto_get" : "__object_proto_set");
  if (resolvedIdx === undefined) return undefined;

  const pushArg = (node: ts.Expression | undefined): void => {
    if (node === undefined) {
      // An OMITTED argument is `undefined`, never `null` — the §B.2.2.1 step-2
      // "neither Object nor Null" test distinguishes the two.
      for (const instr of canonicalUndefinedExternInstrs(ctx)) fctx.body.push(instr);
      return;
    }
    const t = compileExpression(ctx, fctx, node, EXTERNREF);
    if (t === null) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  };

  pushArg(expr.arguments[0]); // thisArg
  if (accessorName === "set") pushArg(expr.arguments[1]);
  fctx.body.push({ op: "call", funcIdx: resolvedIdx });
  return EXTERNREF;
}

/**
 * (#5268 step 1, cluster B) §10.4.7 immutable-prototype exotic object.
 *
 * `%Object.prototype%` is the one such object this compiler materializes, and
 * it is a `$NativeProto` — not a `$Object` — so `__object_setPrototypeOf_status`
 * (which owns the ordinary §10.1.2.1 predicate) answers its permissive `1` for
 * it, and `Object.setPrototypeOf(Object.prototype, X)` silently succeeded.
 * §10.4.7.1 says the answer is `SameValue(V, current)` and `current` is `null`,
 * so ONLY a null `V` succeeds — including `Object.setPrototypeOf(ObjProto,
 * ObjProto)`, which the test262 row asserts throws.
 *
 * Returns the "receiver is `%Object.prototype%`" test as instructions reading
 * `objLocal`, or `undefined` when the module has no `$NativeProto` type at all
 * — in which case no receiver can be one and the caller keeps its existing
 * behaviour. Callers must emit this AFTER the receiver expression has been
 * compiled, so an `Object.prototype` argument has already registered the type.
 */
export function objectPrototypeIsImmutableInstrs(ctx: CodegenContext, objLocal: number): Instr[] | undefined {
  const nativeProtoTypeIdx = ctx.nativeProtoTypeIdx;
  if (nativeProtoTypeIdx === undefined) return undefined;
  const brand = BUILTIN_BRAND_TABLE["Object"];
  if (brand === undefined) return undefined;
  return [
    { op: "local.get", index: objLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: nativeProtoTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [
        { op: "local.get", index: objLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: nativeProtoTypeIdx },
        { op: "struct.get", typeIdx: nativeProtoTypeIdx, fieldIdx: NATIVE_PROTO_BRAND_FIELD },
        { op: "i32.const", value: brand },
        { op: "i32.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * The §10.4.7.1 correction folded onto an already-pushed ordinary status i32:
 * `status && (isImmutable ? proto is null : true)`. Consumes the i32 on the
 * stack and leaves the corrected i32. A no-op (nothing pushed, nothing
 * consumed) when the module has no `$NativeProto`.
 */
export function emitImmutablePrototypeStatusCorrection(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objLocal: number,
  protoLocal: number,
): void {
  const isImmutable = objectPrototypeIsImmutableInstrs(ctx, objLocal);
  if (!isImmutable) return;
  fctx.body.push(...isImmutable);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: I32 },
    then: [{ op: "local.get", index: protoLocal }, { op: "ref.is_null" }],
    else: [{ op: "i32.const", value: 1 }],
  });
  fctx.body.push({ op: "i32.and" });
}
