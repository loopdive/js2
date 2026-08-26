// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 T11) The **presence** half of the f64 array-hole design — the twin of
 * the value half in `vec-f64-hole-gap.ts`.
 *
 * ## Why a second marker
 *
 * T8-A gave an f64 grow-gap the `UNDEF_F64_BITS` marker. That gets every VALUE
 * question right (`x[1] === undefined`, `join`/`toString` render `""`) and
 * leaves every PRESENCE question wrong, because `x[1] = undefined` writes the
 * *same bits* and must answer PRESENT. So absence gets its own payload,
 * {@link HOLE_F64_BITS}, and this module owns everything that reads it.
 *
 * ## The three consumers, and why they land together
 *
 * On `var x = []; x[0] = 0; x[3] = 3` the three presence paths disagreed with
 * each other BEFORE this slice (measured on `66c6a69afb`, `--target standalone`):
 *
 * | query                    | base        | correct |
 * | ------------------------ | ----------- | ------- |
 * | `1 in x`                 | true        | false   |
 * | `x.hasOwnProperty("1")`  | **false** ✓ | false   |
 * | `Object.keys(x)`         | `0,1,2,3`   | `0,3`   |
 *
 * `hasOwnProperty` was already right while `in` and `Object.keys` were not, so
 * fixing one alone swaps one inconsistency for another. All three consult
 * `__extern_has_idx` once {@link fillF64HoleHasIdxArms} teaches it about the
 * marker (`Object.keys` needs its presence gate widened — see
 * `fillDynamicForinVecArms`), which is why they are one slice.
 *
 * ## The read-boundary invariant
 *
 * `array-holes.ts` states it for `$Hole` and it applies verbatim here: **a hole
 * is never observed AS the marker.** Every value-producing read of a slot that
 * may hold it maps `HOLE → UNDEF_F64_BITS` at the boundary
 * ({@link f64HoleToUndefInstrs}), which is what lets the ~28 existing
 * `UNDEF_F64_BITS` observers stay untouched: they keep testing exactly one bit
 * pattern and never see the other.
 *
 * ## Demand gate
 *
 * {@link f64HolesActive} — `ctx.usesArrayHoles`, the same cheap pre-scan flag
 * `array-holes.ts` uses (set iff the module contains an array-literal elision).
 * A module without one produces no `HOLE_F64_BITS` anywhere, so it needs no
 * canonicalization and no presence arm: **its bytes are unchanged**, including
 * the dense-numeric kernel and the #1897 `struct.get` contract.
 *
 * Consequence, stated plainly: in a module with NO elision anywhere, an f64
 * grow-gap keeps the T8-A `UNDEF_F64_BITS` marker and presence stays as it was
 * (`1 in x` true). Widening the gate to grow-gaps alone would need a pre-scan
 * predicate that fires on `a[i] = v`, which is every numeric benchmark — the
 * price is paid in the dense kernel, so it is deliberately not taken here.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { protoIndexHasIdxInstrs } from "./proto-index-store.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { HOLE_F64_BITS, UNDEF_F64_BITS } from "./value-tags.js";
import { holeCompanionNoOwnDescriptor } from "./vec-hole-companion.js";

/**
 * The single demand gate for the whole presence half. See the module header:
 * clear ⇒ no marker is ever produced ⇒ every consumer below is a no-op and the
 * emitted bytes are identical to the pre-slice compiler.
 */
export function f64HolesActive(ctx: CodegenContext): boolean {
  return ctx.usesArrayHoles === true;
}

/**
 * `[f64] → [i32]` — 1 iff the f64 on the stack is exactly the absence marker.
 * Bit compare, not `f64.eq` (which is false for every NaN, marker included).
 */
export function f64HoleTestInstrs(): Instr[] {
  return [{ op: "i64.reinterpret_f64" }, { op: "i64.const", value: HOLE_F64_BITS }, { op: "i64.eq" }];
}

/**
 * `[f64] → [f64]` — the read-boundary canonicalization. A slot holding the
 * absence marker reads back as the *undefined* marker; every other bit pattern
 * (including a genuine computed NaN and an explicit `undefined` element) passes
 * through untouched.
 *
 * This is what preserves the "~28 existing observers need no change" property:
 * after this point in the instruction stream no `HOLE_F64_BITS` exists.
 */
export function f64HoleToUndefInstrs(fctx: FunctionContext): Instr[] {
  const tmp = allocTempLocal(fctx, { kind: "f64" });
  return [
    { op: "local.tee", index: tmp },
    ...f64HoleTestInstrs(),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "i64.const", value: UNDEF_F64_BITS }, { op: "f64.reinterpret_i64" }],
      else: [{ op: "local.get", index: tmp }],
    },
  ];
}

/**
 * Gated `fctx.body` form of {@link f64HoleToUndefInstrs}: emits nothing unless
 * the module can produce the marker AND the element being read is an f64.
 * This is the shape every `emitHoleToUndefined` call site pairs with.
 */
export function emitF64HoleToUndef(ctx: CodegenContext, fctx: FunctionContext, elemType: ValType): void {
  if (!f64HolesActive(ctx) || elemType.kind !== "f64") return;
  for (const instr of f64HoleToUndefInstrs(fctx)) fctx.body.push(instr);
}

/** Detached form of {@link emitF64HoleToUndef} for callers assembling an `Instr[]`. */
export function f64HoleToUndefFor(ctx: CodegenContext, fctx: FunctionContext, elemType: ValType): Instr[] {
  if (!f64HolesActive(ctx) || elemType.kind !== "f64") return [];
  return f64HoleToUndefInstrs(fctx);
}

/**
 * Prepend one `ref.test`-guarded arm per f64-element vec carrier to
 * `__extern_has_idx`, so an in-bounds slot holding the absence marker answers
 * **0**.
 *
 * Shape copied from {@link fillExternGetIdxVecArms} (`object-runtime.ts`) — walk
 * `ctx.vecTypeMap`, one arm per carrier — and from `fillHoleyArrayHasIdxArm`
 * (`holey-array-presence.ts`), which does exactly this for the #4222 nominal
 * `$__holey_array`. Every non-f64 carrier keeps today's `i < length` answer
 * because it gets no arm at all.
 *
 * Runs at FINALIZE, after every carrier type is registered. Splices at body[0];
 * the arms `return` only when the receiver IS an f64 vec and the index is in
 * bounds, so no other receiver's arm is shadowed.
 */
export function fillF64HoleHasIdxArms(ctx: CodegenContext): void {
  // FINALIZE-time, so it can use the NARROWER flag: a module whose elisions all
  // sit in `any[]` literals sets `usesArrayHoles` but never mints an f64
  // marker, and there is nothing for these arms to find.
  if (!ctx.standalone || ctx.f64HoleMarkerEmitted !== true) return;
  const funcIdx = ctx.funcMap.get("__extern_has_idx");
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn || fn.locals.some((local) => local.name === "__f64hole_has_any")) return;

  // One arm per DISTINCT f64-element carrier. `vecTypeMap` is keyed by element
  // kind, so dedup by typeIdx and sort for deterministic emission (same
  // discipline as `fillExternGetIdxVecArms`).
  const seen = new Set<number>();
  const carriers: { typeIdx: number; arrTypeIdx: number }[] = [];
  for (const vecTypeIdx of ctx.vecTypeMap.values()) {
    if (seen.has(vecTypeIdx)) continue;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") continue;
    if ((arrDef.element as ValType).kind !== "f64") continue;
    seen.add(vecTypeIdx);
    carriers.push({ typeIdx: vecTypeIdx, arrTypeIdx });
  }
  if (carriers.length === 0) return;
  carriers.sort((a, b) => a.typeIdx - b.typeIdx);

  // (#4491 T11) The marker means "no own property was ever WRITTEN into this
  // slot" — NOT "this index has no own property". `Object.defineProperty(arr,
  // "1", {set: …})` records an own ACCESSOR in the #3251 companion and writes
  // nothing to the slot, so the marker is still there while the index IS
  // present. Measured: without this guard it cost six rows — the "own or
  // inherited accessor without a get function" family,
  // reduce/reduceRight 15.4.4.2{1,2}-9-c-i-{18,20,22}.
  //
  // So the arm asks the companion first and DECLINES whenever an entry exists;
  // the overlay's own prologue and the dense tail then answer as they always
  // did. `__vec_overlay_lookup` returns null for a vec with no companion —
  // the common case, one call.
  const anyLocal = 2 + fn.locals.length;
  const indexLocal = anyLocal + 1;
  const compLocal = anyLocal + 2;
  const types = ctx.objectRuntimeTypes;
  const noOwnDescriptor = holeCompanionNoOwnDescriptor(ctx, anyLocal, compLocal);
  fn.locals.push(
    { name: "__f64hole_has_any", type: { kind: "anyref" } },
    { name: "__f64hole_has_i", type: { kind: "i32" } },
  );
  if (noOwnDescriptor !== undefined) {
    fn.locals.push({ name: "__f64hole_has_comp", type: { kind: "ref_null", typeIdx: types!.objectTypeIdx } });
  }

  // An own hole is NOT the end of HasProperty: §7.3.11 walks the prototype
  // chain, so `[0, , 2]` with `Array.prototype[1]` defined answers TRUE at
  // index 1. The #3251 overlay's DELETED-index arm answers exactly this way
  // (`vec-overlay.ts`, `deletedIndexMiss`), so reuse the same consult — a hole
  // and a deleted index are the same question. A module with no
  // prototype-index store has no consult and answers a flat 0.
  // Local 1 is the f64 index PARAM — the consult helper's own signature is
  // `(f64 idx, i32 firstOff) -> i32`, so it takes the unconverted param, not
  // the i32 the bounds tests use.
  const holeMiss = (): Instr[] => protoIndexHasIdxInstrs(ctx, 1, 1) ?? [{ op: "i32.const", value: 0 }];

  const arms: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocal },
  ];
  for (const { typeIdx, arrTypeIdx } of carriers) {
    // The arm returns **only** when it positively identifies a hole; every
    // other case falls through to the body already there (prototype-index
    // consult, #3251 overlay, `$Object`). So no existing answer changes — the
    // arm can only turn a `true` into a `false`, and only for a slot that
    // literally holds the marker.
    //
    // The physical-backing test is load-bearing: the `length` setter can leave
    // `length > array.len(data)` (vec-index-domain.ts §2), and `array.get` past
    // the backing TRAPS. Such a slot is absent, but proving that is #4434's
    // job, not this arm's — it declines and falls through.
    const inDomain: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.tee", index: indexLocal },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      { op: "local.get", index: indexLocal },
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx },
      { op: "struct.get", typeIdx, fieldIdx: 0 },
      { op: "i32.lt_s" },
      { op: "i32.and" },
      { op: "local.get", index: indexLocal },
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx },
      { op: "struct.get", typeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "i32.lt_s" },
      { op: "i32.and" },
    ];
    arms.push(
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...inDomain,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: anyLocal },
              { op: "ref.cast", typeIdx },
              { op: "struct.get", typeIdx, fieldIdx: 1 },
              { op: "local.get", index: indexLocal },
              { op: "array.get", typeIdx: arrTypeIdx },
              ...f64HoleTestInstrs(),
              ...(noOwnDescriptor ?? [{ op: "i32.const", value: 1 }]),
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...holeMiss(), { op: "return" }],
              },
            ],
          },
        ],
      },
    );
  }
  fn.body.splice(0, 0, ...arms);
}
