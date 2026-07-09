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
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures.js";
import { ensureBuiltinFnMetaType } from "./builtin-fn-meta.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { allocLocal } from "./context/locals.js";

// ── Brand space (shared with #2101 — MUST stay coherent) ──────────────────────
//
// Classes use `classTagMap` values (small non-negative i32s, unique &
// canonicalization-immune). Builtins draw from a reserved HIGH-NEGATIVE band so
// a `$NativeProto.$brand` value can never collide with a user-class tag, keeping
// the i32 namespace single (#2009 / #2101 §"Brand space"). The negative band
// also makes the disjointness invariant trivially checkable: class tags are >= 0.
const BUILTIN_BRAND_BASE = -0x4000_0000; // far from any plausible classTag count

/**
 * The fixed builtin-brand table. Each builtin that gets (or will get) a
 * `$NativeProto` reserves one stable id here. The value is baked into emitted
 * code as `$NativeProto.$brand`, so **offsets are an append-only stable
 * contract — never renumber or reuse a slot** (a changed brand silently
 * mis-dispatches every program that baked the old value).
 *
 * (#2175 PREP) All builtin-constructor families that the native-proto glue
 * wave (#1616/#2158 slices 1-4) will register are reserved up front so each
 * glue slice only has to wire its prologue + member bodies against an
 * already-stable id — no slice has to touch this table or risk colliding with
 * a sibling slice landed in parallel. Reserving a brand is inert on its own:
 * `getBuiltinBrand` returns the id, but with no registered glue the
 * `.prototype`-as-value read still falls through to the refusal (the brand only
 * becomes load-bearing once a slice registers a prologue for it). The grouping
 * mirrors the architect's slice order; the numeric offsets do not have to be
 * contiguous per group, only stable.
 *
 * Brand assignment is fixed by `BUILTIN_CTOR_NAMES` (property-access.ts) plus
 * the `%TypedArray%` abstract intrinsic; keep this list in sync when a new
 * builtin constructor is added there.
 */
const BUILTIN_BRAND_TABLE: Readonly<Record<string, number>> = {
  // ── S1: RegExp (wired) ──────────────────────────────────────────────────
  RegExp: BUILTIN_BRAND_BASE + 1,

  // ── S1: Array / TypedArray family + buffers (reserved, not yet wired) ────
  Array: BUILTIN_BRAND_BASE + 2,
  // The abstract %TypedArray% intrinsic prototype (parent of every concrete
  // TypedArray proto). Bracketed name keeps it distinct from any user ident.
  "%TypedArray%": BUILTIN_BRAND_BASE + 3,
  Int8Array: BUILTIN_BRAND_BASE + 4,
  Uint8Array: BUILTIN_BRAND_BASE + 5,
  Uint8ClampedArray: BUILTIN_BRAND_BASE + 6,
  Int16Array: BUILTIN_BRAND_BASE + 7,
  Uint16Array: BUILTIN_BRAND_BASE + 8,
  Int32Array: BUILTIN_BRAND_BASE + 9,
  Uint32Array: BUILTIN_BRAND_BASE + 10,
  Float32Array: BUILTIN_BRAND_BASE + 11,
  Float64Array: BUILTIN_BRAND_BASE + 12,
  BigInt64Array: BUILTIN_BRAND_BASE + 13,
  BigUint64Array: BUILTIN_BRAND_BASE + 14,
  ArrayBuffer: BUILTIN_BRAND_BASE + 15,
  SharedArrayBuffer: BUILTIN_BRAND_BASE + 16,
  DataView: BUILTIN_BRAND_BASE + 17,

  // ── S2: Object / Function (reserved, not yet wired) ──────────────────────
  Object: BUILTIN_BRAND_BASE + 18,
  Function: BUILTIN_BRAND_BASE + 19,

  // ── S4: String / Number / Boolean / BigInt / Symbol (reserved) ───────────
  String: BUILTIN_BRAND_BASE + 20,
  Number: BUILTIN_BRAND_BASE + 21,
  Boolean: BUILTIN_BRAND_BASE + 22,
  BigInt: BUILTIN_BRAND_BASE + 23,
  Symbol: BUILTIN_BRAND_BASE + 24,

  // ── Collections / misc builtins (reserved for later slices) ──────────────
  Map: BUILTIN_BRAND_BASE + 25,
  Set: BUILTIN_BRAND_BASE + 26,
  WeakMap: BUILTIN_BRAND_BASE + 27,
  WeakSet: BUILTIN_BRAND_BASE + 28,
  WeakRef: BUILTIN_BRAND_BASE + 29,
  Promise: BUILTIN_BRAND_BASE + 30,
  Date: BUILTIN_BRAND_BASE + 31,
  Iterator: BUILTIN_BRAND_BASE + 32,

  // ── Error family (reserved) ──────────────────────────────────────────────
  Error: BUILTIN_BRAND_BASE + 33,
  TypeError: BUILTIN_BRAND_BASE + 34,
  RangeError: BUILTIN_BRAND_BASE + 35,
  SyntaxError: BUILTIN_BRAND_BASE + 36,
  URIError: BUILTIN_BRAND_BASE + 37,
  EvalError: BUILTIN_BRAND_BASE + 38,
  ReferenceError: BUILTIN_BRAND_BASE + 39,

  // ── Resource-management / weak builtins ──────────────────────────────────
  FinalizationRegistry: BUILTIN_BRAND_BASE + 40,
  // (#2861) TC39 Explicit Resource Management stacks — `<Stack>.prototype`
  // value reads (use/adopt/defer/move/dispose[Async]/disposed getter). The
  // resource list lives on the INSTANCE, never the proto, so the proto value
  // object is pure (member CSV only).
  DisposableStack: BUILTIN_BRAND_BASE + 41,
  AsyncDisposableStack: BUILTIN_BRAND_BASE + 42,
  // (#2861) SuppressedError (ES2026 error aggregation) — an Error subclass, so
  // its `.prototype` value read reuses the shared NativeError glue shape
  // (`toString` member; constructor/name/message data props via the meta-fold).
  SuppressedError: BUILTIN_BRAND_BASE + 43,

  // Next free slot: BUILTIN_BRAND_BASE + 44 (append only).
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
   * (#2875 slice 3) ABI param-slot count for members whose trailing OPTIONAL
   * args are not counted by `fn.length` — e.g. `String.prototype.indexOf(
   * searchString, position)` is spec length 1 but needs TWO arg slots. The
   * closure's lifted func type declares `max(memberLength, memberParamSlots)`
   * user-arg params; every call surface pads missing args with
   * `ref.null.extern` (undefined), and `.length` reads stay honest via
   * `nativeClosureMeta`, which records the SPEC arity. Absent / not larger
   * than `memberLength` → no effect (slot count falls back to the spec
   * arity), so families that don't define it emit byte-identical modules.
   */
  memberParamSlots?: (member: string) => number;
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
  // (#2875 slice 3) …except for members with UNCOUNTED optional trailing args
  // (`indexOf(searchString, position)` — length 1, two slots): those size to
  // `memberParamSlots` so the optional arg has a real param index. `.length`
  // stays honest regardless — it reads `nativeClosureMeta` (set below from the
  // spec arity), never the func type.
  const arity = kind === "getter" ? 0 : glue.memberLength(member);
  const paramSlots = kind === "getter" ? 0 : Math.max(arity, glue.memberParamSlots?.(member) ?? 0);
  const userParams: ValType[] = [{ kind: "externref" }];
  for (let i = 0; i < paramSlots; i++) userParams.push({ kind: "externref" });

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

    funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: funcName,
      typeIdx: wrapperTypes.liftedFuncTypeIdx,
      locals: closureFctx.locals,
      body: closureFctx.body,
      exported: false,
    });
    ctx.funcMap.set(funcName, funcIdx);

    if (!ctx.nativeClosureMeta) ctx.nativeClosureMeta = new Map();
    // (#2885) §10.2.9 — accessor functions are named `"get <key>"` (resp.
    // `"set <key>"`). The reflective `desc.get.name` read resolves the closure's
    // name from `nativeClosureMeta`, so getter closures must carry the accessor
    // spelling, not the bare member. Methods keep the bare member name.
    const accessorName = kind === "getter" ? `get ${member}` : member;
    ctx.nativeClosureMeta.set(funcIdx, { name: accessorName, length: arity });
  }

  // (#2896) The value struct is the UNIQUE per-(brand, member) metadata subtype
  // of the signature wrapper, so the reflective runtime natives
  // (`__getOwnPropertyDescriptor` / `__extern_get` / `__hasOwnProperty` /
  // `__getOwnPropertyNames`) can `ref.test` the value and answer its spec
  // `name`/`length` own properties at RUNTIME (test262 propertyHelper reads
  // them through runtime params — a compile-time fold cannot satisfy it). All
  // call paths are unaffected: the meta type subtypes the wrapper the lifted
  // func expects. Getters carry the §10.2.9 accessor spelling ("get <key>").
  const metaName = kind === "getter" ? `get ${member}` : member;
  const metaTypeIdx = ensureBuiltinFnMetaType(
    ctx,
    wrapperTypes.structTypeIdx,
    wrapperTypes.closureInfo,
    `proto:${brand}:${kind}:${member}`,
    metaName,
    arity,
  );

  // (#2193 PR-B) A `"method"` closure's first user param is the receiver
  // (`this`); record its struct type so a reflective `m.call(thisArg, …args)`
  // threads `thisArg` into param 1 instead of dropping it (the plain-function
  // `.call` default). Getters carry no user-visible receiver-arg semantics here.
  // Both the base wrapper AND the meta subtype are recorded — call sites key
  // this set by the ClosureInfo's structTypeIdx, which is the meta type for
  // values produced by this factory.
  if (kind === "method") {
    if (!ctx.nativeProtoReceiverClosureStructTypes) ctx.nativeProtoReceiverClosureStructTypes = new Set();
    ctx.nativeProtoReceiverClosureStructTypes.add(wrapperTypes.structTypeIdx);
    ctx.nativeProtoReceiverClosureStructTypes.add(metaTypeIdx);
  }

  return { type: { kind: "ref", typeIdx: metaTypeIdx }, funcIdx };
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

/** The `eq` abstract heap type, signed-LEB128 -19 (= 0x6d). `ref.test`/`ref.cast`
 *  against it narrow an `anyref` to an `eqref` so `ref.eq` (which requires eqref
 *  operands) can run. Mirrors the constant in `binary-ops.ts`. */
const EQ_HEAP_TYPE = -19;

/**
 * (#2885 Site 1) Emit the spec's "SameValue(thisValue, %Proto%) → return
 * undefined" identity arm for a builtin-proto accessor getter. Per §22.2.6 (and
 * the analogous String/TypedArray accessor steps), reading an intrinsic getter
 * with `this === <Builtin>.prototype` returns `undefined` rather than throwing
 * the brand-check TypeError — so the getter closure must short-circuit BEFORE the
 * brand-recovery prologue throws.
 *
 * Appends to `fctx.body`: force-materialize the `$NativeProto` global for `brand`,
 * compare it by reference identity (`ref.eq`) against the closure's externref
 * `this` (param `thisParamIdx`), and on a match emit `undefinedResult` followed by
 * `return`. A non-eqref / non-matching `this` falls through unchanged so the
 * caller's brand check still runs.
 *
 * The getter closure result type is unified to `externref` (callers box i32/f64
 * field results), so `undefinedResult` is the `ref.null.extern` form.
 */
export function emitNativeProtoIdentityReturnUndefined(
  ctx: CodegenContext,
  fctx: FunctionContext,
  brand: number,
  thisParamIdx: number,
  undefinedResult: Instr[],
): void {
  // Force-materialize the proto object and stash its anyref view.
  const protoAny = allocLocal(fctx, `__proto_id_proto_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  emitLazyNativeProtoGet(ctx, fctx, brand); // leaves the proto externref on the stack
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "local.set", index: protoAny } as Instr);

  // `this` (externref) → anyref; only an eqref can be `ref.eq`-compared.
  const thisAny = allocLocal(fctx, `__proto_id_this_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.get", index: thisParamIdx } as Instr);
  fctx.body.push({ op: "any.convert_extern" } as Instr);
  fctx.body.push({ op: "local.tee", index: thisAny } as Instr);
  fctx.body.push({ op: "ref.test", typeIdx: EQ_HEAP_TYPE } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: thisAny } as Instr,
      { op: "ref.cast", typeIdx: EQ_HEAP_TYPE } as Instr,
      { op: "local.get", index: protoAny } as Instr,
      { op: "ref.cast", typeIdx: EQ_HEAP_TYPE } as Instr,
      { op: "ref.eq" } as Instr,
    ],
    else: [{ op: "i32.const", value: 0 } as Instr],
  } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [...undefinedResult, { op: "return" } as Instr],
    else: [],
  } as Instr);
}
