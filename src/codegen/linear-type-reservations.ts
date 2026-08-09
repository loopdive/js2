// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// linear-type-reservations.ts — linear-memory / typed-array type-reservation
// plumbing (#3272, extracted verbatim from index.ts). These reserve WasmGC
// struct/array/subview func-types eagerly (before native-string helpers) so the
// shared `ctx.mod.types` prefix stays index-stable, plus the page-4 linear
// `Uint8Array` bump-allocator (`__lin_u8_alloc`). Semantically NOT WASI — kept
// out of wasi.ts so importers (object-runtime, new-super, fnctor-escape-gate,
// array-object-proto, linear-uint8-codegen) never transitively pull WASI IO.
// index.ts re-exports these for backward-compatible import paths.

import type { FieldDef, Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getOrRegisterSubviewType } from "./registry/types.js";
import { deriveFnctorFields } from "./fnctor-escape-gate.js";
import { coldTailHotFieldLimitFor, coldTailStructName } from "./fnctor-cold-tail.js";
import { fnctorLayoutPlanFor, reserveFnctorLayoutTypes } from "./fnctor-layout-emit.js"; // (#3927) per-type layouts
import { INSTANCE_BAG_FIELD, closureBagField } from "./closures/closure-header-layout.js"; // (#4241 step 1b)

/**
 * #1886 Slice B — start of the linear-backed `Uint8Array` arena (page 4,
 * 256 KiB). It sits above the page-2 write scratch with page 3 left as a guard,
 * so a proven-I/O-only buffer never aliases the iovec scratch, string-literal
 * data, the stdin buffer, or the write scratch. The arena grows on demand via
 * `memory.grow` in `__lin_u8_alloc`.
 */
export const LINEAR_U8_ARENA_START = 256 * 1024;

/**
 * #1886 Slice B — Ensure the `__lin_u8_alloc(len: i32) -> i32` bump allocator
 * exists and return its function index (lazy, emitted on first linear-backed
 * `new Uint8Array`). Allocates `align8(len)` bytes from the page-4 linear arena
 * pointed at by `$__lin_u8_arena_ptr`, growing memory on demand, and returns
 * the (8-byte-aligned) base pointer. Mirrors the #1856 align8 + page-grow idiom
 * from `codegen-linear/runtime.ts`; emitted here because the WasmGC front-end
 * owns its own memory/globals and cannot call the linear backend bootstrap.
 *
 * NOTE: the returned region is NOT explicitly zero-filled — `memory.grow`
 * zeroes fresh pages, and the arena today only ever grows (no reset yet, see
 * Slice D), so every byte handed out is freshly-grown zero memory, satisfying
 * the `new Uint8Array(n)` zero-fill contract. A future arena reset (Slice D)
 * that reuses slots must `memory.fill` callers' buffers.
 */
export function reserveLinearU8AllocType(ctx: CodegenContext): void {
  // #1886 Slice B — reserve the allocator's `(i32)->(i32)` func TYPE eagerly,
  // before any WasmGC struct/array type or native-string helper is registered,
  // so the shared `ctx.mod.types` prefix stays stable when those later types
  // (whose absolute indices their bodies bake) are added. Idempotent. The
  // allocator FUNCTION is emitted later in `ensureLinearU8AllocHelper`, in the
  // post-import-registration window, so its DEFINED-function index is final.
  if (ctx.linearU8AllocTypeIdx !== undefined) return;
  if (!ctx.wasi) return;
  ctx.linearU8AllocTypeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
}

/**
 * (#2357/#47) Reserve the standalone `$__subview_<elem>` struct types up-front so
 * their indices are deterministic across codegen passes (see the call site in
 * `generateModule`). Covers the element kinds standalone TypedArrays use for their
 * backing arrays: `i8_byte` (Int8/Uint8/Uint8Clamped), `i16_byte`
 * (Int16/Uint16), `i32_elem` (Int32/Uint32 element storage), and `f64` (the float
 * views). (#2593 added the i16/i32 byte views — before that only integer Uint8Array
 * was packed.) `getOrRegisterSubviewType` only forces the backing ARRAY type
 * (uniquely deduped per element kind) — it does NOT register or reorder the vec
 * struct, so plain typed-array resolution is unaffected. Idempotent.
 *
 * (#2835) Int32/Uint32 ELEMENT storage moved from the `i32_byte` key to a dedicated
 * `i32_elem` key (split from the ArrayBuffer/DataView byte buffer — see
 * `TYPED_ARRAY_PACKED_STORAGE`). So the Int32/Uint32 `subarray` subview is now keyed
 * `i32_elem` and reserved here; an `Int32Array.subarray()` (whose receiver vec is
 * `__vec_i32_elem`) resolves `getOrRegisterSubviewType(ctx, "i32_elem", …)` to this
 * PRE-RESERVED, idx-stable slot (hoist == emit), avoiding the #2357 body-time-index
 * desync. The byte buffer (`i32_byte`) has NO `subarray` view, so it is NOT reserved
 * here; the ArrayBuffer/DataView byte vec registers lazily at its use sites exactly
 * as before (it resolves directly to its vec — no subview substitution — so its
 * lazy registration is symmetric across the hoist/emit passes and needs no eager
 * slot). PR-2 will flip the `i32_byte` element type to i8 at its registration point.
 * (memory: project_type_index_shift_and_deadelim — only types whose lazy registration
 * could DESYNC across passes need an eager slot; the byte vec does not.)
 */
export function reserveTypedArraySubviewTypes(ctx: CodegenContext): void {
  getOrRegisterSubviewType(ctx, "i8_byte", { kind: "i8" });
  getOrRegisterSubviewType(ctx, "i16_byte", { kind: "i16" }); // (#2593) Int16/Uint16
  getOrRegisterSubviewType(ctx, "i32_elem", { kind: "i32" }); // (#2835) Int32/Uint32 element storage (split from i32_byte)
  getOrRegisterSubviewType(ctx, "f64", { kind: "f64" });
}

/**
 * (#2026 #53) Reserve the `$ObjVecArr` = `(array (mut externref))` type up-front,
 * at the deterministic type-init point, so the dynamic-`new` runtime-argv path
 * (`emitDynamicNewFallback`, for `new K(...someVar)`) can reference a STABLE type
 * index. Minting this type lazily mid-expression — via `ensureObjectRuntime` —
 * registered it after the deterministic type prefix had been baked, leaving an
 * unresolved `-1` heap-type ref at binary-emit (the #2043 / subview
 * type-idx-stability hazard). The type is self-contained (element `externref`,
 * no type deps), so reserving it alone is zero-helper, zero-import, additive.
 * `ensureObjectRuntime` adopts this slot (see object-runtime.ts) when present so
 * the two never collide. Gated to class-bearing sources only (the dynamic-new
 * fallback can't fire without a class).
 */
export function reserveObjVecArrType(ctx: CodegenContext): void {
  if (ctx.reservedObjVecArrTypeIdx !== undefined) return;
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$ObjVecArr",
    element: { kind: "externref" },
    mutable: true,
  });
  ctx.reservedObjVecArrTypeIdx = idx;
}

/**
 * (#4241 step 1b) Append the carrier-intrinsic `$bag` expando slot to an
 * ELIGIBLE fnctor's field list, so its own-property bag lives in the instance
 * instead of the global `$ClosurePropEntry` registry.
 *
 * ## Why this matters — it is a LEAK, not a speed knob
 * Nothing ever removes a registry entry, so every carrier that grows an expando
 * is pinned (with its `$Object` bag) for the module's lifetime. Measured on the
 * acorn self-parse: 75 expando writes per parse, all of them onto
 * `__fnctor_Parser`, producing exactly ONE new registry entry per parse,
 * forever. One Parser per parse leaks per parse. (Note the arithmetic: 75
 * WRITES, 1 entry — 74 of the writes hit the bag the first one created. An
 * earlier reading of this issue took the write count for the entry count and
 * overstated the growth 75-fold.)
 *
 * ## Why only these fnctors (the deliberately narrow arm)
 * Eligibility is "the layout passes will not touch this struct":
 *   - NO layout split (#3927): a split family rebuilds its siblings as
 *     `[...baseFields, ...moved]`, so a slot added here would have to be
 *     sequenced against that pass rather than merely appended.
 *   - NO cold tail (#3927): `appendColdPresenceWords` assigns `presenceBit =
 *     index` to EVERY field and sizes the presence words `ceil(n/32)`, so a
 *     `$bag` present at that moment would get presence-tracked and could push
 *     the word count up — a silent layout change for a field that is not a
 *     user property.
 * Class hierarchies are excluded for a different reason and are NOT handled
 * here at all: `extends` sets `superTypeIdx`, so appending to a parent INSERTS
 * into every child and shifts that child's own fields. That is the blocker for
 * the broad arm; see the issue file.
 *
 * Standalone-only (the expando-bag substrate does not exist in gc/host mode),
 * so a host build is byte-identical.
 *
 * ## Why appending is safe HERE, by construction
 * The single fnctor allocation site (`emitFnctorFieldInitializers`) ITERATES
 * the field list and emits a per-kind default — `externref` gets
 * `ref.null.extern` — so the `struct.new` operand count stays correct without
 * touching that site. This mirrors the `__proto__` slot in `class-bodies.ts`,
 * whose comment states the same invariant. It is also why `$bag` is read by
 * NAME everywhere and never by index: `property-access-dispatch.ts` can append
 * further fields to an already-registered struct, so `$bag` does not stay last.
 */
function appendInstanceBagSlot(ctx: CodegenContext, fnctorName: string, fields: FieldDef[]): void {
  if (!ctx.standalone) return;
  if (fnctorLayoutPlanFor(ctx, fnctorName) !== undefined) return; // split family — excluded
  // Cold-tailed fnctors ARE eligible. The presence-word hazard does not reach
  // the base struct: `applyColdTailSplit` moves the COLD subset out and calls
  // `appendColdPresenceWords(coldFields)` on THAT list, and `$bag` is never in
  // `coldNames` (it is not a user field), so it stays in the base and is not
  // presence-tracked. Verified by measurement, not by reading — see the pins.
  //   NOTE: an earlier draft excluded cold-tailed fnctors on a mis-read of this
  //   pass, which excluded `__fnctor_Parser` — i.e. the ONLY carrier that leaks
  //   on the measured corpus — and left registry population unchanged.
  if (fields.some((f) => f.name === INSTANCE_BAG_FIELD)) return; // idempotent
  fields.push(closureBagField());
}

/**
 * #2773 S1 (KEYSTONE) — reserve every reconstructed-fnctor `$__fnctor_<Name>`
 * struct type at the deterministic up-front type-init phase (the same stable
 * point as `reserveTypedArraySubviewTypes` / `reserveObjVecArrType`), so the type
 * index is IDENTICAL across the hoist pass and the emit pass.
 *
 * ROOT CAUSE this fixes: the on-demand registration at the `new F()` call site
 * (`compileNewFunctionDeclaration`, new-super.ts — `ctx.mod.types.length`) assigns
 * the index at a NON-deterministic mid-compile point that depends on which
 * function the compiler reached first. The two-pass type numbering then desyncs:
 * a typed-receiver `ref.test $__fnctor_<Name>` baked in the hoist pass misses the
 * emit-pass `struct.new` index, and a read site compiled before the `new` site is
 * excluded from `findAlternateStructsForField`'s candidate set. Reserving up-front
 * collapses BOTH facets — the index is pass-invariant AND the candidate set is
 * complete at every read site. This is the one thing the #2674 finalize
 * dispatcher cannot retroactively fix (it can't rewrite a baked typeIdx).
 *
 * Two sub-passes — the ORDER is load-bearing:
 *   (1) reserve ALL indices + names FIRST (placeholder struct, `structMap`,
 *       `typeIdxToStructName`, `fnctorReservedTypeIdx`), so a cross-fnctor ref
 *       field in sub-pass 2 (a `Parser` field typed `Scope` →
 *       `(ref null $__fnctor_Scope)`) resolves against an already-registered
 *       `structMap` entry. Do NOT collapse the two sub-passes.
 *   (2) FILL each placeholder's fields via the shared `deriveFnctorFields`
 *       (single source of truth — identical to the on-demand derivation) and
 *       record `structFields` for candidate-set completeness.
 *
 * Determinism: the name set is SORTED, and the call-site position is fixed, so the
 * reserved index is identical across the hoist pass and the emit pass (the entire
 * point of the slice). Gated on a non-empty approved set ⇒ fnctor-free modules are
 * byte-identical (a true no-op). Runs in BOTH host and standalone — the on-demand
 * struct path is target-independent. A reserved-but-never-constructed placeholder
 * is unreferenced ⇒ `dead-elimination` prunes + renumbers it cleanly.
 */
export function reserveFnctorStructTypes(ctx: CodegenContext): void {
  const gate = ctx.fnctorEscapeGate;
  if (!gate) return;
  // The set of fnctor names whose struct slot to reserve: the reconstruct-approved
  // names plus (S2b) the `new this()` reconstruct owners. `newThisOwnerNames` is
  // empty in S1, so this is exactly `approvedNames` today.
  const names = [...new Set([...gate.approvedNames, ...gate.newThisOwnerNames])].sort();
  if (names.length === 0) return; // no-op gate ⇒ byte-identical for fnctor-free code

  // SUB-PASS 1 — reserve every index + name FIRST (placeholder, empty fields) so
  // cross-fnctor ref fields in sub-pass 2 resolve against a registered structMap.
  for (const name of names) {
    const decl = gate.ctorDeclByName.get(name);
    if (!decl || !decl.body) continue; // unresolved / body-less ⇒ skip (legacy fallback handles it)
    const structName = `__fnctor_${name}`;
    if (ctx.structMap.has(structName)) continue; // idempotent within a pass
    const idx = ctx.mod.types.length;
    ctx.mod.types.push({ kind: "struct", name: structName, fields: [] });
    ctx.structMap.set(structName, idx);
    ctx.typeIdxToStructName.set(idx, structName);
    ctx.fnctorReservedTypeIdx.set(name, idx);
    // (#3927) Reserve the cold-tail slot in the SAME deterministic sub-pass, for
    // the same reason the main struct is reserved here: the `$cold` field's
    // `ref_null <coldTypeIdx>` is baked into the main struct's shape, so the
    // index has to be pass-invariant too. Reserved only under the flag, so an
    // unflagged build pushes no extra type and stays byte-identical.
    // (#3927 per-type layouts) A split-planned family reserves its sibling
    // layout structs + resid carrier + hint global instead of a cold tail —
    // the two techniques overlap rather than compose on one fnctor (where a
    // layout is proved, the tail has nothing left to move; issue §8.4).
    reserveFnctorLayoutTypes(ctx, name, idx); // declines itself unless split-planned + flagged
    if (fnctorLayoutPlanFor(ctx, name) !== undefined) {
      // layout family reserved above — no cold tail for this fnctor (overlap, not composition)
    } else if (coldTailHotFieldLimitFor(ctx) !== undefined) {
      const coldStructName = coldTailStructName(structName);
      const coldIdx = ctx.mod.types.length;
      ctx.mod.types.push({ kind: "struct", name: coldStructName, fields: [] });
      ctx.structMap.set(coldStructName, coldIdx);
      ctx.typeIdxToStructName.set(coldIdx, coldStructName);
      (ctx.fnctorColdTailTypeIdx ??= new Map()).set(name, coldIdx);
    }
  }

  // SUB-PASS 2 — fill fields now that ALL names + indices exist.
  for (const name of names) {
    const idx = ctx.fnctorReservedTypeIdx.get(name);
    if (idx === undefined) continue;
    const decl = gate.ctorDeclByName.get(name);
    if (!decl) continue;
    const fields = deriveFnctorFields(ctx, decl);
    appendInstanceBagSlot(ctx, name, fields); // (#4241 step 1b) carrier-intrinsic expando bag
    const ty = ctx.mod.types[idx];
    if (ty && ty.kind === "struct") ty.fields = fields; // FILL IN PLACE — index unchanged
    ctx.structFields.set(`__fnctor_${name}`, fields); // candidate-set completeness
  }
}

export function ensureLinearU8AllocHelper(ctx: CodegenContext): number {
  if (ctx.linearU8AllocFuncIdx !== undefined) return ctx.linearU8AllocFuncIdx;
  if (!ctx.wasi || ctx.linearU8ArenaGlobalIdx === undefined) return -1;

  const arenaGlobal = ctx.linearU8ArenaGlobalIdx;
  // param: len(0); locals: ret(1), next(2)
  const LEN = 0;
  const RET = 1;
  const NEXT = 2;
  const PAGE = 65536;

  // Reuse the eagerly-reserved func type when present (keeps the type-table
  // prefix stable for native-string helpers); fall back to registering it now
  // for any path that reaches the allocator without the early reservation.
  const funcTypeIdx = ctx.linearU8AllocTypeIdx ?? addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__lin_u8_alloc", funcIdx);

  const body: Instr[] = [
    // ret = arena_ptr
    { op: "global.get", index: arenaGlobal },
    { op: "local.set", index: RET },
    // next = align8(ret + len) = (ret + len + 7) & ~7
    { op: "local.get", index: RET },
    { op: "local.get", index: LEN },
    { op: "i32.add" },
    { op: "i32.const", value: 7 },
    { op: "i32.add" },
    { op: "i32.const", value: -8 },
    { op: "i32.and" },
    { op: "local.set", index: NEXT },
    // if (next > memory.size * PAGE) grow by ceil((next - cur)/PAGE)
    { op: "local.get", index: NEXT },
    { op: "memory.size" },
    { op: "i32.const", value: PAGE },
    { op: "i32.mul" },
    { op: "i32.gt_u" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: NEXT },
        { op: "memory.size" },
        { op: "i32.const", value: PAGE },
        { op: "i32.mul" },
        { op: "i32.sub" },
        { op: "i32.const", value: PAGE - 1 },
        { op: "i32.add" },
        { op: "i32.const", value: PAGE },
        { op: "i32.div_u" },
        { op: "memory.grow" },
        { op: "drop" },
      ],
    },
    // arena_ptr = next
    { op: "local.get", index: NEXT },
    { op: "global.set", index: arenaGlobal },
    // return ret
    { op: "local.get", index: RET },
  ];

  ctx.mod.functions.push({
    name: "__lin_u8_alloc",
    typeIdx: funcTypeIdx,
    locals: [
      { name: "ret", type: { kind: "i32" } },
      { name: "next", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  ctx.linearU8AllocFuncIdx = funcIdx;
  return funcIdx;
}
