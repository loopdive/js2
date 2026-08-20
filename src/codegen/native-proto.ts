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
import { ensureBuiltinFnMetaType, pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { addFuncType } from "./registry/types.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { buildThrowJsErrorInstrs, emitThrowTypeError } from "./js-errors.js"; // (#2984) refusal-body fallback
import { allocLocal } from "./context/locals.js";

// ── Brand space (shared with #2101 — MUST stay coherent) ──────────────────────
//
// Classes use `classTagMap` values (small non-negative i32s, unique &
// canonicalization-immune). Builtins draw from a reserved HIGH-NEGATIVE band so
// a `$NativeProto.$brand` value can never collide with a user-class tag, keeping
// the i32 namespace single (#2009 / #2101 §"Brand space"). The negative band
// also makes the disjointness invariant trivially checkable: class tags are >= 0.
//
// (#4176) The table itself moved to builtin-brands.ts (dependency-free) so the
// scanForArrayHoles PRE-SCAN and proto-index-store can read it without pulling
// this module's codegen imports into an ESM cycle. Re-exported here so every
// existing importer keeps working; the append-only contract lives there now.
import { BUILTIN_BRAND_BASE, BUILTIN_BRAND_COUNT, BUILTIN_BRAND_TABLE } from "./builtin-brands.js";

export {
  BUILTIN_BRAND_BASE,
  BUILTIN_BRAND_COUNT,
  BUILTIN_BRAND_TABLE,
  builtinBrandOffsetOf,
  isBrandedBuiltinName,
} from "./builtin-brands.js";

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
   * (#4485) Member-IDENTITY alias. Some spec members are not merely equivalent
   * to another member, they ARE the same function object: §B.2.4.3 says "the
   * function object that is the initial value of `Date.prototype.toGMTString`
   * is the same function object that is the initial value of
   * `Date.prototype.toUTCString`" — `Date.prototype.toGMTString ===
   * Date.prototype.toUTCString` must hold. Returning the canonical member name
   * here routes the whole closure factory (func name, `nativeClosureMeta`, and
   * the per-(brand, member) meta struct type that gives the value its identity)
   * to the canonical member, so both reads resolve to ONE singleton.
   *
   * Only closure IDENTITY is aliased — the alias name stays its own entry in
   * `memberCsv`, so `hasOwnProperty` / `getOwnPropertyDescriptor` /
   * `getOwnPropertyNames` still see it as its own own-property of the proto.
   * A member with no alias (the default) is unaffected.
   */
  memberAliasOf?: (member: string) => string | undefined;
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
 * Build a lazy-initialized `$NativeProto` object read for a *builtin* brand. On
 * first access, builds the struct (brand, isClass=0, ctor=null, parent=null,
 * memberCsv=<native string>, name=<native string>), boxes it via
 * `extern.convert_any`, and stashes it in a module global; subsequent reads
 * return the same externref (reference identity for `RegExp.prototype ===
 * RegExp.prototype`). Pure Wasm — NO host import (the contrast with
 * `emitLazyProtoGet`, which calls `__register_prototype`). The returned
 * instruction list leaves an externref on the stack. Returns `null` if the
 * brand has no registered glue. Keeping the builder separate lets finalize-time
 * metadata arms embed the same identity-stable singleton read.
 */
export function buildLazyNativeProtoGetInstrs(ctx: CodegenContext, brand: number): Instr[] | null {
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return null;
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
      init: [{ op: "ref.null.extern" }],
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
  initBody.push({ op: "struct.new", typeIdx: structTypeIdx });
  initBody.push({ op: "extern.convert_any" });
  initBody.push({ op: "global.set", index: globalIdx });

  // (#2175 V2-S3b-1) This proto can now FLOW as a runtime value, so make its
  // own members visible to the dynamic reader by registering a seeder for the
  // brand's proto-index companion. Emits nothing into `initBody` — the seeder
  // is a separate function invoked from `__protoidx_companion` when that
  // companion is first minted — so the instruction sequence returned below is
  // byte-identical to before this slice. Self-gated (see its doc): a module
  // that is not `protoMemberDirty` gets `undefined` and pays nothing.
  ensureNativeProtoCompanionSeeder(ctx, brand);

  return [
    { op: "global.get", index: globalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: initBody, else: [] },
    { op: "global.get", index: globalIdx },
  ];
}

export function emitLazyNativeProtoGet(ctx: CodegenContext, fctx: FunctionContext, brand: number): boolean {
  const instrs = buildLazyNativeProtoGetInstrs(ctx, brand);
  if (!instrs) return false;
  fctx.body.push(...instrs);
  return true;
}

// ── (#2175 V2-S3b-1) Brand-companion seeding — the RUNTIME-visible own-member
// ── table for a builtin prototype object
//
// WHY THIS EXISTS. Everything above is compile-time SYNTACTIC: it answers
// `RegExp.prototype.exec` when the compiler can see both halves at the call
// site. The moment a proto object FLOWS as a runtime value the syntactic layer
// is blind, and the dynamic reader (`__extern_get`) gates on `ref.test $Object`
// and answers `undefined` for a `$NativeProto` receiver. That single read is
// the whole of #4444 row 3 — measured 2026-08-15 on HEAD 9e17d34f3:
// `harness/testTypedArray.js:64` does `var TypedArray = Object.getPrototypeOf(
// Int8Array)`, then `TypedArray.prototype.find` misses, and 121 ES2015
// reflection tests fail on that one `undefined`.
//
// WHY NOT the v2 spec's `$props` field + `__nativeproto_ensure_props` + a
// step-3 arm in each of 7 reader natives. Since that spec was written, #4160/
// #4176 landed `proto-index-store.ts`, which ALREADY provides the per-brand
// `$Object` COMPANION table, a `$NativeProto`-aware receiver-brand classifier
// (`__protoidx_brand_off`, generic over the whole brand band) and the
// receiver-aware consults spliced into `__extern_get`/`__extern_has`. Verified
// live before writing this: a write+read round-trip through a FLOWING
// `%TypedArray%.prototype` already works. The companion is simply minted
// EMPTY — nothing ever put the builtin's own members in it.
//
// So this is population, not a new MOP: one seeder function per brand that
// installs the glue's members into the brand companion the first time that
// companion is minted. `$NativeProto`'s layout is UNCHANGED (the v2 D2 `$props`
// field is not added), which keeps `buildLazyNativeProtoGetInstrs` — and hence
// every module that only reads a proto as a value — byte-identical.

/** brand → the name of its `__nativeproto_seed_<brand>` function in `ctx.funcMap`. */
function nativeProtoSeederRegistry(ctx: CodegenContext): Map<number, string> {
  const slot = ctx as unknown as { __nativeProtoSeeders?: Map<number, string> };
  if (!slot.__nativeProtoSeeders) slot.__nativeProtoSeeders = new Map();
  return slot.__nativeProtoSeeders;
}

/** Brands materialized before the object runtime existed — see the ordering note. */
function pendingNativeProtoSeeds(ctx: CodegenContext): Set<number> {
  const slot = ctx as unknown as { __nativeProtoPendingSeeds?: Set<number> };
  if (!slot.__nativeProtoPendingSeeds) slot.__nativeProtoPendingSeeds = new Set();
  return slot.__nativeProtoPendingSeeds;
}

/**
 * (#2175 V2-S3b-1) Build the seeders for every brand whose `$NativeProto` was
 * materialized before `__defineProperty_value` existed. Called once at the end
 * of `ensureObjectRuntime` — ordinary body-compilation time, so minting and
 * type registration stay in the normal regime. Idempotent and self-clearing.
 */
export function flushPendingNativeProtoSeeders(ctx: CodegenContext): void {
  const pending = pendingNativeProtoSeeds(ctx);
  if (pending.size === 0) return;
  const brands = [...pending];
  pending.clear();
  for (const brand of brands) ensureNativeProtoCompanionSeeder(ctx, brand);
}

/**
 * (#2175 V2-S3b-1) The registered seeders, keyed by brand OFFSET (the 0-based
 * slot in the builtin brand band, which is what `__protoidx_companion` indexes
 * by). Read at FINALIZE by `fillCompanionBody` to build its dispatch; every
 * entry resolves its funcIdx by NAME at that point, so a late-import shift
 * between minting and fill cannot stale it (#2043 class).
 */
export function nativeProtoSeedersByBrandOffset(ctx: CodegenContext): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  for (const [brand, name] of nativeProtoSeederRegistry(ctx)) out.set(brand - BUILTIN_BRAND_BASE, name);
  return out;
}

/**
 * Data-method keys whose builtin prototype companion is authoritative.
 *
 * A registered seeder installs these members as ordinary `$PropEntry` values,
 * so later assignment or deletion must be observed from that table rather than
 * from the immutable `$NativeProto.$memberCsv` / singleton-closure shortcuts.
 * Accessors are deliberately absent because the current seeder does not install
 * them; constructors have their own carrier and are not part of `memberCsv`.
 */
export function seededNativeProtoDataMembersByBrand(ctx: CodegenContext): ReadonlyMap<number, readonly string[]> {
  const out = new Map<number, readonly string[]>();
  for (const [brand, seederName] of nativeProtoSeederRegistry(ctx)) {
    if (ctx.funcMap.get(seederName) === undefined) continue;
    const glue = getNativeProtoBuiltinGlue(ctx, brand);
    if (!glue) continue;
    const members = glue.memberCsv
      .split(",")
      .map((member) => member.trim())
      .filter((member) => member.length > 0 && !member.startsWith("@@") && glue.memberKind(member) === "method");
    if (members.length > 0) out.set(brand, members);
  }
  return out;
}

/**
 * §17 attributes for a builtin prototype METHOD, in the
 * `__defineProperty_value` host flag encoding: `{writable: true, enumerable:
 * false, configurable: true}` — value bits `0b101` + all three "specified"
 * bits + hasValue. This is the exact constant `emitBuiltinNamespaceObject`
 * (builtin-static-globals.ts) uses for builtin statics; kept as one shared
 * spelling rather than re-derived, since the two tables describe the same
 * §17 rule.
 */
const PROTO_METHOD_DEFINE_FLAGS = 0xbd;

// (Deferred, for the accessor tier — see the `kind === "getter"` skip below for
// why it is not this slice.) When accessors are seeded they must use
// `__defineProperty_accessor`'s SEPARATE `computeRuntimeFlags` word, not the
// value encoding above: `(1<<4)|(1<<5)|(1<<2)` = enumerable/configurable
// SPECIFIED + configurable true, i.e. `{enumerable:false, configurable:true}`
// (§15.7.14 / §17). Same constant as `ACCESSOR_FLAGS` in class-proto-accessors.ts.

/**
 * (#2175 V2-S3b-1) Ensure a `__nativeproto_seed_<brand>(externref companion)`
 * function exists for `brand`, populating the brand's proto-index COMPANION
 * with the glue's own members. Returns its name, or `undefined` when the brand
 * has no glue, the module is not armed, or the object runtime is absent.
 *
 * Demand-gating, in two independent layers — both must hold, so a module that
 * does not reflect emits ZERO of this:
 *   1. `ctx.protoMemberDirty` — the pre-scan saw a builtin `.prototype` that
 *      can reach the dynamic reader as a value (or an `Object.getPrototypeOf`
 *      call). A polyfill-only module (`String.prototype.foo = …`) reserves the
 *      store but is NOT member-dirty, so it seeds nothing and keeps its bytes.
 *   2. the brand's `$NativeProto` is actually materialized — this is called
 *      from `buildLazyNativeProtoGetInstrs`, so a brand nobody reads never
 *      pays for its ~15-30 member closures.
 *
 * Symbol-keyed members (`@@<id>` CSV sentinels) are SKIPPED here: the store's
 * key normalizer (`__protoidx_norm_key`) deliberately refuses symbol keys so no
 * user `toString` runs twice, so a symbol entry in the companion would be
 * unreachable. They stay with the syntactic surface; V2-S5 owns the symbol
 * dispatch tier.
 *
 * A member whose glue body REFUSES is skipped rather than failing the seeder —
 * the companion is a best-effort own-member view, and a partially populated
 * table is strictly better than none (the missing member reads `undefined`,
 * exactly as today).
 */
export function ensureNativeProtoCompanionSeeder(ctx: CodegenContext, brand: number): string | undefined {
  if (!ctx.standalone || ctx.protoMemberDirty !== true) return undefined;
  const registry = nativeProtoSeederRegistry(ctx);
  const existing = registry.get(brand);
  if (existing !== undefined) return existing;

  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return undefined;

  // ORDERING (measured, not assumed). A proto can be materialized BEFORE the
  // object runtime exists, and then `__defineProperty_value` — which the seeder
  // body must call — is not in `funcMap` yet. Traced on
  // `var q = opaque(RegExp.prototype)`: RegExp (brand offset 1) materialized with
  // `__defineProperty_value === undefined`, while `Array` (offset 2), reached
  // later, saw it registered. Building the seeder eagerly therefore silently
  // skipped RegExp and left `q.exec` reading `undefined` — the exact defect this
  // slice exists to fix, reintroduced for a subset of brands.
  //
  // So: park the brand and build it at the end of `ensureObjectRuntime`
  // (`flushPendingNativeProtoSeeders`), which is still ordinary body-compilation
  // time — NOT finalize. That keeps all func minting and closure/meta TYPE
  // registration in the normal regime, rather than gambling on late type
  // additions being safe. A brand parked with no `ensureObjectRuntime` ever
  // running is correctly dropped: without the object runtime there is no dynamic
  // reader to serve.
  if (ctx.funcMap.get("__defineProperty_value") === undefined) {
    pendingNativeProtoSeeds(ctx).add(brand);
    return undefined;
  }
  // The brand must sit in the reserved band — `__protoidx_companion` indexes a
  // fixed-size array by `brand - BUILTIN_BRAND_BASE`, so an out-of-band brand
  // (a user-class tag) would be an OOB slot. Registered glue always is in-band;
  // this is the assertion, not a fallback.
  const brandOffset = brand - BUILTIN_BRAND_BASE;
  if (brandOffset < 0 || brandOffset >= BUILTIN_BRAND_COUNT) return undefined;

  const defineValueIdx = ctx.funcMap.get("__defineProperty_value");
  if (defineValueIdx === undefined) return undefined;

  const funcName = `__nativeproto_seed_${brand}`;
  // Mark BEFORE emitting: a member body may itself materialize this brand's
  // proto (the #2885 identity arm calls `emitLazyNativeProtoGet`), which would
  // re-enter here and recurse without this guard.
  registry.set(brand, funcName);

  const seedFctx = makeNativeClosureFctx(funcName, { kind: "externref" }, [], null);
  // `makeNativeClosureFctx` shapes params as [self, ...user]; here the single
  // param IS the companion `$Object` (as externref), at index 0.
  seedFctx.params = [{ name: "__companion", type: { kind: "externref" } }];
  seedFctx.localMap = new Map([["__companion", 0]]);

  let installed = 0;
  for (const rawMember of glue.memberCsv.split(",")) {
    const member = rawMember.trim();
    if (member.length === 0) continue;
    if (member.startsWith("@@")) continue; // symbol keys do not participate (see doc)
    const kind = glue.memberKind(member);
    // ACCESSORS ARE DELIBERATELY NOT SEEDED IN THIS SLICE.
    //
    // WHAT IS MEASURED. Seeding getters as accessor entries (via
    // `__defineProperty_accessor`, flags `(1<<4)|(1<<5)|(1<<2)` = §17
    // `{enumerable:false, configurable:true}`) flips `tests/issue-2885.test.ts`
    // "plain read RegExp.prototype.global is undefined (Site 3 invokes the
    // getter)" from pass to FAIL. That test passes on unmodified
    // `origin/main` @ 9e17d34f3, so this is a genuine regression, not a
    // pre-existing failure. §22.2.6 requires the legacy accessor read with
    // `SameValue(this, %RegExp.prototype%)` to answer `undefined`.
    //
    // WHAT IS NOT KNOWN — do not repeat my first guess. I initially wrote that
    // the cause was `__extern_get`'s accessor branch binding the wrong `this`,
    // and that is NOT established: with seeding ON, the same read bound through
    // a local (`const g: any = (RegExp.prototype as any).global; g === undefined`)
    // still answers `undefined` correctly, while the INLINE form the test uses
    // does not. So the divergence is between the inline and materialized read
    // paths — the same CLASS of defect as the #2984 path-dependent `typeof`
    // that V2-S1 fixed — but the mechanism is unidentified. Whoever takes the
    // accessor tier should start from that inline/bound split, not from a
    // receiver-binding theory.
    //
    // Data methods, which are the entire measured win here (121 TypedArray
    // reflection files, all `find`/`map`/`of`/… members), have no §22.2.6-style
    // identity rule and are unaffected.
    //
    // Gate for the accessor tier when it lands: the four
    // `%TypedArray%.prototype.{buffer,byteLength,byteOffset,length}/prop-desc.js`
    // files, which fail identically before and after this slice — so nothing is
    // lost by deferring.
    if (kind === "getter") continue;

    const closure = ensureStandaloneNativeMethodClosure(ctx, brand, member, kind, {
      // Reify un-wired members as throwing function VALUES (#2984 Phase 2 /
      // #3250). The companion is a REFLECTION surface: `typeof p.m ===
      // "function"`, `p.m.name`, `p.m.length` and `isConstructor(p.m) ===
      // false` are exactly what the length/name/not-a-constructor files read,
      // and they must answer for every own member — including ones whose
      // engine body does not exist yet. Invoking such a value throws a
      // catchable TypeError, which is also what `invoked-as-func.js` expects
      // for a receiver-less call.
      refusalBodyFallback: true,
    });
    if (!closure) continue;

    const body = seedFctx.body;
    body.push({ op: "local.get", index: 0 });
    addStringConstantGlobal(ctx, member);
    for (const instr of stringConstantExternrefInstrs(ctx, member)) body.push(instr);

    // [obj, key, value, flags] → §17 data entry.
    for (const instr of pushBuiltinFnSingletonValueInstrs(ctx, closure)) body.push(instr);
    body.push({ op: "extern.convert_any" });
    body.push({ op: "f64.const", value: PROTO_METHOD_DEFINE_FLAGS });
    body.push({ op: "call", funcIdx: defineValueIdx });
    body.push({ op: "drop" }); // the helper returns the target
    installed++;
  }

  if (installed === 0) {
    registry.delete(brand);
    return undefined;
  }

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [], `$${funcName}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: funcName,
    typeIdx,
    locals: seedFctx.locals,
    body: seedFctx.body,
    exported: false,
  });
  ctx.funcMap.set(funcName, funcIdx);
  return funcName;
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
  memberIn: string,
  kind: "method" | "getter",
  opts?: {
    /**
     * (#2984 Phase 2) When the glue's `emitMemberBody` REFUSES (returns null —
     * no native body wired yet), mint the closure anyway with a catchable-
     * TypeError body (the #2193/#2651 degrade-to-catchable pattern) instead of
     * returning null. This reifies the member as a first-class function VALUE
     * (correct `.name`/`.length` meta, identity-stable singleton) so gOPD
     * descriptor synthesis and plain `<Builtin>.prototype.<member>` value
     * reads resolve for un-wired members (Date/Object/Number/Boolean/Function/
     * Error proto methods, …); INVOKING the value throws the catchable error.
     *
     * STRICTLY opt-in, and applied to `"method"` kind only. Callers that
     * dispatch a real CALL through the closure body — most importantly
     * `emitReflectiveNativeProtoClosureCall`, the route behind
     * `Object.prototype.hasOwnProperty.call(o, k)` — must NOT set this: they
     * rely on the null return to fall through to their working legacy
     * lowering, and a throwing body would regress them (measured: the
     * hasOwnProperty.call / propertyIsEnumerable.call harness idioms pass
     * today via that fall-through). The refusal probe below runs BEFORE the
     * funcMap cache lookup, so a fallback-minted closure never leaks to a
     * caller that did not opt in.
     */
    refusalBodyFallback?: boolean;
  },
): { type: { kind: "ref"; typeIdx: number }; funcIdx: number } | null {
  const glue = getNativeProtoBuiltinGlue(ctx, brand);
  if (!glue) return null;

  // (#4485) Identity alias FIRST, before anything keys off the member name.
  // `Date.prototype.toGMTString` is not a copy of `toUTCString`, it is the same
  // function object (§B.2.4.3), so every downstream key — `funcName`,
  // `nativeClosureMeta`, and above all the `proto:<brand>:<kind>:<member>` meta
  // struct type that IS the value's identity — must be the canonical member's.
  // Rewriting here (rather than at each call site) makes the aliasing hold for
  // every route into the factory: plain value read, gOPD synthesis, reflective
  // call. `.name` correctly reports the canonical name for an aliased member.
  const member = glue.memberAliasOf?.(memberIn) ?? memberIn;

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
  const selfType: ValType = { kind: "ref", typeIdx: wrapperProbe.liftedSelfTypeIdx };
  const bodyFctx = makeNativeClosureFctx(`__probe_${brand}_${member}`, selfType, userParams, null);
  const probedResult = glue.emitMemberBody(ctx, bodyFctx, member, kind);
  // (#2984 Phase 2) Refusal + opted-in fallback (methods only): keep going with
  // a uniform externref result; the committed emission below swaps the refused
  // body for a catchable-TypeError throw. Every non-opted-in caller keeps the
  // exact null-return contract (this check precedes the funcMap lookup, so a
  // fallback-minted closure is never returned to a caller that didn't opt in).
  // (#3250) The fallback now applies to accessor GETTERS too, not just methods.
  // An un-wired builtin-proto getter (e.g. `ArrayBuffer.prototype.byteLength`,
  // `DataView.prototype.buffer`, `%TypedArray%.prototype.buffer`) previously
  // returned a null closure, so the #2885 Site-2 gOPD synthesis could not build
  // an accessor descriptor — `Object.getOwnPropertyDescriptor(<Ctor>.prototype,
  // "<getter>")` answered `undefined` and the test's `.get` deref then trapped
  // with our "Cannot access property on null or undefined" (~cluster #2). Minting
  // the getter with the catchable-TypeError body makes gOPD return a spec-shaped
  // accessor descriptor whose `.get` throws a real TypeError when invoked on a
  // non-branded `this` (§23.2.3 / §25.1.5 / §25.2.5 / §25.3.4 RequireInternalSlot).
  // This is spec-correct for these getters: unlike RegExp's §22.2.6 legacy accessor
  // (SameValue(this,%Proto%)→undefined, whose getters ARE wired), the buffer-family
  // getters have no proto-identity carve-out — reading them off the bare prototype
  // (or any non-view `this`) throws. Getters with a real wired body are unaffected
  // (their `emitMemberBody` returns non-null, so this fallback never fires).
  const useRefusalBody = probedResult === null && opts?.refusalBodyFallback === true;
  if (probedResult === null && !useRefusalBody) return null;
  const resultType: ValType = probedResult ?? { kind: "externref" };

  const resultTypes = [resultType];
  const wrapperTypes = getOrCreateFuncRefWrapperTypes(ctx, userParams, resultTypes);
  if (!wrapperTypes) return null;

  const funcName = kind === "getter" ? `__proto_method_${brand}_get_${member}` : `__proto_method_${brand}_${member}`;
  let funcIdx = ctx.funcMap.get(funcName);
  if (funcIdx === undefined) {
    // Re-emit the body against the final signature's canonical-root self param so the
    // funcIdx-bearing function carries the right lifted type. (The probe above
    // only computed the result type; this is the committed emission.)
    const finalSelf: ValType = { kind: "ref", typeIdx: wrapperTypes.liftedSelfTypeIdx };
    const closureFctx = makeNativeClosureFctx(funcName, finalSelf, userParams, resultType);
    if (useRefusalBody) {
      // (#2984 Phase 2) Degrade-to-catchable body: a real TypeError instance +
      // `throw` via emitThrowTypeError — the EXACT helper the wired glue
      // refusals use (`emitProtoMemberBodyRefusal`, `emitArrayProtoMemberBody`
      // non-slice arms), proven catchable through the closure-call path. The
      // body ends in `throw`, so it validates against the declared externref
      // result (unreachable tail).
      emitThrowTypeError(
        ctx,
        closureFctx,
        // (#3250) A getter reached here is invoked on a `this` that lacks the
        // internal slot (the wired-body getters short-circuit a valid `this`
        // before this fallback): that is a genuine spec RequireInternalSlot
        // throw, so word it as such. Methods keep the "not yet implemented"
        // spelling — their fallback stands in for an unwired native body.
        kind === "getter"
          ? `get ${glue.name}.prototype.${member} called on an incompatible receiver`
          : `${glue.name}.prototype.${member} is not yet implemented in --target standalone`,
      );
    } else {
      const committedResult = glue.emitMemberBody(ctx, closureFctx, member, kind);
      if (committedResult === null) return null;
    }

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
  // (#3191) Unified onto the shared builder. `forceInModuleCtor` reproduces the
  // former behavior EXACTLY — always emit the in-module `__new_TypeError` (via
  // `emitWasiErrorConstructor` + `funcMap`) regardless of `noJsHost`, so host-
  // mode codegen for these brand checks is unchanged. Sinks into the raw `body`.
  for (const instr of buildThrowJsErrorInstrs(ctx, "TypeError", message, { forceInModuleCtor: true })) {
    body.push(instr);
  }
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
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.set", index: protoAny });

  // `this` (externref) → anyref; only an eqref can be `ref.eq`-compared.
  const thisAny = allocLocal(fctx, `__proto_id_this_${fctx.locals.length}`, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.get", index: thisParamIdx });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "local.tee", index: thisAny });
  fctx.body.push({ op: "ref.test", typeIdx: EQ_HEAP_TYPE });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [
      { op: "local.get", index: thisAny },
      { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
      { op: "local.get", index: protoAny },
      { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
      { op: "ref.eq" },
    ],
    else: [{ op: "i32.const", value: 0 }],
  });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [...undefinedResult, { op: "return" }],
    else: [],
  });
}
