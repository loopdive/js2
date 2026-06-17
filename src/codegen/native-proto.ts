// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2175) Standalone builtin-prototype object representation + native-method
 * closure dispatch — the host-free replacement for the `__register_prototype`
 * host Proxy that `nativeStrings`/standalone mode skips.
 *
 * This module is the **shared core** (S0): it owns
 *   1. the single `$NativeProto` struct heap type (`ctx.nativeProtoTypeIdx`),
 *   2. the builtin-brand table (`ctx.builtinBrandMap`, a reserved i32 band
 *      disjoint from `classTagMap` so a `$NativeProto.$brand` value is a single
 *      namespace shared with class tags),
 *   3. `emitLazyNativeProtoGet` — the lazy proto-object materializer (pure Wasm,
 *      `struct.new` + native-string member CSV + a module global), mirroring
 *      `emitLazyProtoGet` (extern.ts) but with NO host import, and
 *   4. `ensureStandaloneNativeMethodClosure(brand, member, kind)` — the
 *      brand-keyed native-method-closure factory generalized from the existing
 *      `ensureStandaloneBuiltinStaticMethodClosure`. `kind: "static"` keeps the
 *      existing receiver-less behaviour BYTE-IDENTICAL; `kind: "method"` /
 *      `"getter"` prepend an `externref this` user param and emit a
 *      brand-recovery prologue.
 *
 * Per-builtin glue (the brand-recovery prologue + member bodies) lives with the
 * builtin (e.g. RegExp glue in `regexp-standalone.ts`) and is consumed here via
 * a small registry, so this core carries no RegExp/TypedArray specifics. S0
 * registers the core inert; S1 wires RegExp; S2/S3 (class/TypedArray) follow.
 *
 * Compose with #2101's `$ClassMeta`: for a *class* proto the `$NativeProto` is a
 * thin façade backed by the class's existing `__proto_<Name>` singleton +
 * `$ClassMeta` — this core does NOT allocate a second class proto and does NOT
 * touch class-bodies population (out of S0/S1 scope; #2158 owns S2).
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";

// ── Brand space (shared with #2101 — MUST stay coherent) ──────────────────────
//
// Classes use `classTagMap` values (small non-negative i32s, unique &
// canonicalization-immune). Builtins draw from a reserved HIGH-NEGATIVE band so
// a `$NativeProto.$brand` value can never collide with a user-class tag, keeping
// the i32 namespace single (#2009 / #2101 §"Brand space"). The negative band
// also makes the disjointness invariant trivially checkable: class tags are >= 0.
const BUILTIN_BRAND_BASE = -0x4000_0000; // far from any plausible classTag count

/**
 * The fixed builtin-brand table. Each builtin that gets a `$NativeProto` reserves
 * one stable id here. Add entries as stages land (S1: RegExp; S3:
 * %TypedArray%/Int8Array/…). Keep the offsets stable across runs — the value is
 * baked into emitted code as `$NativeProto.$brand`.
 */
const BUILTIN_BRAND_TABLE: Readonly<Record<string, number>> = {
  RegExp: BUILTIN_BRAND_BASE + 1,
  // S3 (reserved, not yet wired):
  //   "%TypedArray%": BUILTIN_BRAND_BASE + 2,
  //   Int8Array: BUILTIN_BRAND_BASE + 3, ...
};

/**
 * Resolve (and lazily seed) the builtin brand id for `name`. Asserts the brand
 * band stays disjoint from every registered class tag — a collision would
 * silently mis-dispatch (#2175 Risk 2). Returns `undefined` for an unbranded
 * name (caller falls through to the refusal).
 */
export function getBuiltinBrand(ctx: CodegenContext, name: string): number | undefined {
  const brand = BUILTIN_BRAND_TABLE[name];
  if (brand === undefined) return undefined;
  if (!ctx.builtinBrandMap) ctx.builtinBrandMap = new Map<string, number>();
  if (!ctx.builtinBrandMap.has(name)) {
    // Disjointness invariant: no class tag may fall in the builtin band.
    for (const classTag of ctx.classTagMap.values()) {
      if (classTag <= BUILTIN_BRAND_BASE) {
        throw new Error(
          `#2175: class tag ${classTag} collides with the reserved builtin brand band (<= ${BUILTIN_BRAND_BASE}). ` +
            `Brand space must stay disjoint — see native-proto.ts.`,
        );
      }
    }
    ctx.builtinBrandMap.set(name, brand);
  }
  return brand;
}

// ── The single shared `$NativeProto` struct heap type ─────────────────────────
//
// Field order is the reader-visible contract; keep it stable.
//   0 $brand     (mut i32)       which builtin/class this proto belongs to
//   1 $isClass   (mut i32)       1 = user-class proto, 0 = builtin proto
//   2 $ctor      (mut externref) .constructor link
//   3 $parent    (mut externref) [[Prototype]] → parent's $NativeProto, or null
//   4 $memberCsv (mut externref) own member-name CSV (native string)
//   5 $name      (mut externref) the proto's brand/[[class]] name string
const NATIVE_PROTO_STRUCT_NAME = "__NativeProto";
export const NATIVE_PROTO_FIELD_BRAND = 0;
export const NATIVE_PROTO_FIELD_IS_CLASS = 1;
export const NATIVE_PROTO_FIELD_CTOR = 2;
export const NATIVE_PROTO_FIELD_PARENT = 3;
export const NATIVE_PROTO_FIELD_MEMBER_CSV = 4;
export const NATIVE_PROTO_FIELD_NAME = 5;

/**
 * Register the single `$NativeProto` struct type once and stash its idx on
 * `ctx.nativeProtoTypeIdx`. Mirrors the lazy one-time registration of
 * `ensureStandaloneRegExpStruct`. There is exactly one `$NativeProto` heap type,
 * so iso-recursive canonicalization is a non-issue for the metadata itself —
 * identity rides the `$brand` *value*, not the type.
 */
export function registerNativeProtoType(ctx: CodegenContext): number {
  if (ctx.nativeProtoTypeIdx !== undefined) return ctx.nativeProtoTypeIdx;
  const existing = ctx.structMap.get(NATIVE_PROTO_STRUCT_NAME);
  if (existing !== undefined) {
    ctx.nativeProtoTypeIdx = existing;
    return existing;
  }
  const fields = [
    { name: "brand", type: { kind: "i32" } as ValType, mutable: true },
    { name: "isClass", type: { kind: "i32" } as ValType, mutable: true },
    { name: "ctor", type: { kind: "externref" } as ValType, mutable: true },
    { name: "parent", type: { kind: "externref" } as ValType, mutable: true },
    { name: "memberCsv", type: { kind: "externref" } as ValType, mutable: true },
    { name: "name", type: { kind: "externref" } as ValType, mutable: true },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: NATIVE_PROTO_STRUCT_NAME, fields });
  ctx.structMap.set(NATIVE_PROTO_STRUCT_NAME, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, NATIVE_PROTO_STRUCT_NAME);
  ctx.structFields.set(NATIVE_PROTO_STRUCT_NAME, fields);
  ctx.nativeProtoTypeIdx = typeIdx;
  return typeIdx;
}

/**
 * The per-builtin contract consumed by the shared core. A builtin registers one
 * descriptor; the core uses it to populate the `$NativeProto` and to drive
 * method/getter closure bodies. Registered lazily (the builtin calls
 * `registerNativeProtoBuiltin` from its own module on first reflective demand)
 * so the core has no import dependency on any specific builtin.
 */
export interface NativeProtoBuiltinGlue {
  /** Stable brand id (from BUILTIN_BRAND_TABLE). */
  brand: number;
  /** The proto's [[class]]/brand name (for `$name`, e.g. "RegExp"). */
  name: string;
  /** Own member-name CSV for the proto object (string-named members; `@@<id>`
   *  sentinels for well-known-symbol members — see spec §"Symbol cell"). */
  memberCsv: string;
  /** Which members are accessor getters (`kind:"getter"`) vs data methods
   *  (`kind:"method"`). `@@<id>` symbol members are always `"method"`. */
  memberKind: (member: string) => "getter" | "method";
  /** Static arity advertised by a member's closure value (`fn.length`). */
  memberLength: (member: string) => number;
  /**
   * Emit a method/getter closure BODY into `fctx`, given the externref `this`
   * already bound to closure-param index 1 and any further args at indices
   * 2.. . The implementation runs the brand-recovery prologue (externref `this`
   * → backing struct, or a catchable TypeError on a wrong `this`) and then the
   * member body. Returns the closure's result ValType, or `null` on a refusal.
   */
  emitMemberBody: (
    ctx: CodegenContext,
    fctx: FunctionContext,
    member: string,
    kind: "getter" | "method",
  ) => ValType | null;
}

function builtinGlueRegistry(ctx: CodegenContext): Map<number, NativeProtoBuiltinGlue> {
  const slot = ctx as unknown as { __nativeProtoGlue?: Map<number, NativeProtoBuiltinGlue> };
  if (!slot.__nativeProtoGlue) slot.__nativeProtoGlue = new Map();
  return slot.__nativeProtoGlue;
}

/** A builtin registers its glue once (idempotent). */
export function registerNativeProtoBuiltin(ctx: CodegenContext, glue: NativeProtoBuiltinGlue): void {
  builtinGlueRegistry(ctx).set(glue.brand, glue);
}

/** Look up a registered builtin's glue by brand. */
export function getNativeProtoBuiltinGlue(ctx: CodegenContext, brand: number): NativeProtoBuiltinGlue | undefined {
  return builtinGlueRegistry(ctx).get(brand);
}

// ── Lazy `$NativeProto` materializer ──────────────────────────────────────────

function nativeProtoGlobalName(brand: number): string {
  return `__native_proto_${brand}`;
}

/**
 * Emit a lazy-initialized `$NativeProto` object read for a *builtin* brand. On
 * first access, builds the struct (brand, isClass=0, ctor=null, parent=null,
 * memberCsv=<native string>, name=<native string>), boxes it via
 * `extern.convert_any`, and stashes it in a module global; subsequent reads
 * return the same externref (reference identity for `RegExp.prototype ===
 * RegExp.prototype`). Pure Wasm — NO host import (the contrast with
 * `emitLazyProtoGet`, which calls `__register_prototype`). Leaves an externref
 * on the stack. Returns `false` if the brand has no registered glue.
 */
export function emitLazyNativeProtoGet(ctx: CodegenContext, fctx: FunctionContext, brand: number): boolean {
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return false;
  const structTypeIdx = registerNativeProtoType(ctx);

  // One mutable null-init externref global per builtin proto.
  const globalName = nativeProtoGlobalName(brand);
  const protoGlobals = nativeProtoGlobalMap(ctx);
  let globalIdx = protoGlobals.get(brand);
  if (globalIdx === undefined) {
    globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: globalName,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" } as Instr],
    });
    protoGlobals.set(brand, globalIdx);
  }

  // member CSV + name as native-string constant globals (pure Wasm).
  addStringConstantGlobal(ctx, glue.memberCsv);
  addStringConstantGlobal(ctx, glue.name);

  const initBody: Instr[] = [];
  initBody.push({ op: "i32.const", value: glue.brand }); // $brand
  initBody.push({ op: "i32.const", value: 0 }); // $isClass = 0 (builtin)
  initBody.push({ op: "ref.null.extern" }); // $ctor (S1: not yet linked)
  initBody.push({ op: "ref.null.extern" }); // $parent (S1: chain walk deferred)
  // $memberCsv — native string → externref
  for (const instr of stringConstantExternrefInstrs(ctx, glue.memberCsv)) initBody.push(instr);
  pushNativeStringToExternref(initBody);
  // $name
  for (const instr of stringConstantExternrefInstrs(ctx, glue.name)) initBody.push(instr);
  pushNativeStringToExternref(initBody);
  initBody.push({ op: "struct.new", typeIdx: structTypeIdx } as Instr);
  initBody.push({ op: "extern.convert_any" } as Instr);
  initBody.push({ op: "global.set", index: globalIdx } as Instr);

  fctx.body.push({ op: "global.get", index: globalIdx } as Instr);
  fctx.body.push({ op: "ref.is_null" } as Instr);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: initBody, else: [] } as Instr);
  fctx.body.push({ op: "global.get", index: globalIdx } as Instr);
  return true;
}

/**
 * `stringConstantExternrefInstrs` already yields an externref for native-string
 * constants in standalone mode, so the `$NativeProto` string fields take the
 * value as-is. This guard normalizes the (rare) case where a backend hands back
 * a non-extern native-string ref by leaving it on the stack untouched — the
 * struct field is externref and `struct.new` coerces a ref via the surrounding
 * extern boxing. In practice the constant instrs are already extern; this is a
 * no-op placeholder kept for clarity / future class-CSV reuse.
 */
function pushNativeStringToExternref(_body: Instr[]): void {
  // No-op: stringConstantExternrefInstrs already produces an externref under
  // standalone. Centralized here so a future ref→extern adjustment is one edit.
}

function nativeProtoGlobalMap(ctx: CodegenContext): Map<number, number> {
  const slot = ctx as unknown as { __nativeProtoGlobals?: Map<number, number> };
  if (!slot.__nativeProtoGlobals) slot.__nativeProtoGlobals = new Map();
  return slot.__nativeProtoGlobals;
}

// ── Brand-keyed native-method-closure factory ─────────────────────────────────

/**
 * Build a `FunctionContext` for a native closure body. `userParams` are the
 * lifted user params AFTER the implicit `(ref $wrap)` self param — i.e. param
 * index 0 is the closure struct, index 1 is the first user param. For `method`
 * / `getter` the first user param is the externref `this`.
 */
function makeNativeClosureFctx(
  name: string,
  selfType: ValType,
  userParams: ValType[],
  returnType: ValType | null,
): FunctionContext {
  const fctx: FunctionContext = {
    name,
    params: [{ name: "__self", type: selfType }, ...userParams.map((type, i) => ({ name: `arg${i}`, type }))],
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  for (let i = 0; i < fctx.params.length; i++) {
    fctx.localMap.set(fctx.params[i]!.name, i);
  }
  return fctx;
}

/**
 * (#2175) Brand-keyed native-method-closure factory. `kind`:
 *   - `"method"`  — `(ref $wrap, externref this, ...externref args) -> result`;
 *                   first emits the brand-recovery prologue then the member body.
 *   - `"getter"`  — `(ref $wrap, externref this) -> result` accessor getter,
 *                   returned as a descriptor's `.get`.
 *
 * The closure is a `__fn_wrap`-style struct produced by
 * `getOrCreateFuncRefWrapperTypes`, so it is `call_ref`-dispatchable through the
 * existing closure call path. Keyed in `ctx.funcMap` as
 * `__proto_method_<brand>_<member>` / `__proto_method_<brand>_get_<member>`.
 * Tags the funcIdx with `{name,length}` in `ctx.nativeClosureMeta` so the
 * existing `.length`/`.name`-on-function reads resolve the closure's arity/name.
 *
 * Returns the `{ type, funcIdx }` for `ref.func` + `struct.new`, or `null` if
 * the brand has no glue / the member body refuses.
 */
export function ensureStandaloneNativeMethodClosure(
  ctx: CodegenContext,
  brand: number,
  member: string,
  kind: "method" | "getter",
): { type: { kind: "ref"; typeIdx: number }; funcIdx: number } | null {
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return null;

  // Lifted user params: externref `this`, plus (for methods) externref args.
  // S1 RegExp closures take at most one string arg; over-declaring args is
  // harmless (the call path pads/truncates), but we size to the advertised
  // arity to keep the signature honest for `.length`.
  const arity = kind === "getter" ? 0 : glue.memberLength(member);
  const userParams: ValType[] = [{ kind: "externref" }];
  for (let i = 0; i < arity; i++) userParams.push({ kind: "externref" });

  // Probe the member body to learn its result type by emitting into a throwaway
  // fctx, then keep that body (it's the real body — no double emission).
  const wrapperProbe = getOrCreateFuncRefWrapperTypes(ctx, userParams, []);
  if (!wrapperProbe) return null;
  const selfType: ValType = { kind: "ref", typeIdx: wrapperProbe.structTypeIdx };
  const bodyFctx = makeNativeClosureFctx(`__probe_${brand}_${member}`, selfType, userParams, null);
  const resultType = glue.emitMemberBody(ctx, bodyFctx, member, kind);
  if (resultType === null) return null;

  const resultTypes = [resultType];
  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, resultTypes);
  if (!wrapperTypes) return null;

  const funcName = kind === "getter" ? `__proto_method_${brand}_get_${member}` : `__proto_method_${brand}_${member}`;
  let funcIdx = ctx.funcMap.get(funcName);
  if (funcIdx === undefined) {
    // Re-emit the body against the final (result-typed) wrapper self param so the
    // funcIdx-bearing function carries the right lifted type. (The probe above
    // only computed the result type; this is the committed emission.)
    const finalSelf: ValType = { kind: "ref", typeIdx: wrapperTypes.structTypeIdx };
    const closureFctx = makeNativeClosureFctx(funcName, finalSelf, userParams, resultType);
    const committedResult = glue.emitMemberBody(ctx, closureFctx, member, kind);
    if (committedResult === null) return null;

    funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.mod.functions.push({
      name: funcName,
      typeIdx: wrapperTypes.liftedFuncTypeIdx,
      locals: closureFctx.locals,
      body: closureFctx.body,
      exported: false,
    });
    ctx.funcMap.set(funcName, funcIdx);

    if (!ctx.nativeClosureMeta) ctx.nativeClosureMeta = new Map();
    ctx.nativeClosureMeta.set(funcIdx, { name: member, length: arity });
  }

  return { type: { kind: "ref", typeIdx: wrapperTypes.structTypeIdx }, funcIdx };
}

/**
 * Emit the catchable-TypeError throw used by a brand-recovery prologue on a
 * wrong `this`. Shared so per-builtin glue can reuse the exact shape (a real
 * TypeError instance via the in-module `__new_TypeError`, then `throw $exc`),
 * never a `ref.cast` trap (#2100 M2 / §22.2.6.4.1 step 2).
 */
export function emitBrandCheckTypeError(ctx: CodegenContext, body: Instr[], message: string): void {
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  addStringConstantGlobal(ctx, message);
  for (const instr of stringConstantExternrefInstrs(ctx, message)) body.push(instr);
  const newTypeErrorIdx = ctx.funcMap.get("__new_TypeError");
  if (newTypeErrorIdx !== undefined) {
    body.push({ op: "call", funcIdx: newTypeErrorIdx } as Instr);
  }
  body.push({ op: "throw", tagIdx: ensureExnTag(ctx) } as Instr);
}
