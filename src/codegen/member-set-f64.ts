// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157 slice A) `__set_member_<name>__f64` — the WRITE-side twin of #3673's
 * `__get_member_<name>__f64`.
 *
 * The read side has been typed since #3673: a numeric-context read of a
 * dispatcher-resolved property collapses to one call with a bare `struct.get`.
 * The write side had NO typed twin at all, so a numeric write paid the full
 * uniform-externref ABI even when both ends were f64:
 *
 *   f64 → `__box_number` (i31-range test, ~20 instructions, or an allocation)
 *       → `__set_member_<name>(externref, externref)`
 *       → `__unbox_number` → `struct.set` into an f64 slot
 *
 * The value starts and ends as an f64; the box exists only to satisfy the
 * dispatcher's signature. Measured on the standalone acorn self-parse
 * (issue #4157 entry 30): 344,602 `__set_member_*` calls per parse.
 *
 *   __set_member_<name>__f64(recv: externref, v: f64)
 *     any = any.convert_extern(recv)
 *     if ref.test S1: ref.cast S1; local.get v; struct.set S1 <f64 slot>
 *     elif ref.test S2: <S2's slot is not f64> → delegate
 *     else: __box_number(v); __set_member_<name>(recv, boxed)
 *
 * ARM ORDER IS THE CORRECTNESS ARGUMENT. A receiver can pass more than one
 * `ref.test` (WasmGC canonicalizes structurally identical structs, and
 * subclasses match a parent test), so "keep only the f64 arms" would let a
 * later f64 candidate win a receiver that the generic dispatcher would have
 * given to an earlier non-f64 candidate. This walks the SAME candidate list in
 * the SAME order and, for a candidate whose slot is not directly storable,
 * emits the delegate INSIDE the matched arm — exactly the discipline
 * `fillTypedMemberGetF64Dispatch` uses. Everything past the plain candidates
 * (the #3927 cold-tail / per-type-layout / resid arms and the sidecar
 * terminal) is reached through that delegate, so this twin never has to
 * re-derive them.
 *
 * **Default ON** since the #4157 tuned-set flip (`src/perf-flags.ts`). With
 * `JS2WASM_SET_MEMBER_F64=0` no site reserves a twin and the emitted binary is
 * byte-identical to the pre-#4157 base.
 */
import type { Instr, ValType } from "../ir/types.js";
import { tunedFlagEnabled, tunedFlagExplicit } from "../perf-flags.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { presenceSetInstrs, presenceTestInstrs } from "./fnctor-presence-bits.js"; // (#3780) packed own-presence flags
import { isNativeGeneratorResultStruct } from "./generators-native.js";
import { reserveMemberSetDispatch } from "./member-set-dispatch.js";
import { findAlternateStructsForField } from "./property-access.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry, flushLateImportShifts } from "./shared.js";
import { allocLocal } from "./context/locals.js";
import { coercionInstrs } from "./type-coercion.js";
import { inheritedSetAffectsKey } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate

/** Flag gate. Default ON; `=0` ⇒ nothing below runs ⇒ byte-identical output. */
export function setMemberF64Enabled(): boolean {
  return tunedFlagEnabled(process.env.JS2WASM_SET_MEMBER_F64);
}

/** Patch-site counter — proof the mechanism fired, printed at finalize. */
let emittedSites = 0;
const declines = new Map<string, number>();

function typedF64Name(propName: string, strict: boolean): string {
  return strict ? `__set_member_${propName}__f64` : `__set_member_nonstrict_${propName}__f64`;
}

/**
 * Reserve (or fetch) the typed write twin with a placeholder body, filled by
 * {@link fillTypedMemberSetF64Dispatch} at finalize. Every fill dependency is
 * registered NOW (the generic dispatcher it delegates to, and the union box
 * helpers the delegate arm needs), so the fill only READS funcMap — the
 * reserve-then-fill discipline of #2664/#2674/#3673.
 */
export function reserveTypedMemberSetF64Dispatch(
  ctx: CodegenContext,
  propName: string,
  strict: boolean,
  fctx: FunctionContext,
): number | undefined {
  const name = typedF64Name(propName, strict);
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) {
    flushLateImportShifts(ctx, fctx);
    return existing;
  }
  // The delegate arm calls the GENERIC dispatcher — reserve it first (idempotent).
  if (reserveMemberSetDispatch(ctx, propName, strict, fctx) === undefined) return undefined;
  addUnionImportsViaRegistry(ctx); // __box_number, for the delegate arm's f64 → externref
  // Settle the staged index-space shift BEFORE minting, so the funcIdx below is
  // final and never re-shifted into the wrong function (#2681).
  flushLateImportShifts(ctx, fctx);

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [], "$member_set_f64_dispatch_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: [],
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * Emit a typed member WRITE when the value the caller just compiled is
 * statically f64 and the stack top holds it. Returns the value type left on the
 * stack (`f64` — the assignment's own result), or `undefined` when the site is
 * not eligible, in which case NOTHING has been emitted and the caller proceeds
 * byte-identically down the boxing path.
 *
 * Declines (each of them a case where the generic path is not merely slower):
 *   - flag off / value not statically f64;
 *   - a whole-program boolean property (its value must carry the #2785 boolean
 *     brand through the sidecar, which an f64 slot cannot);
 *   - the twin (or the generic dispatcher under it) cannot be reserved.
 */
export function tryEmitTypedF64MemberSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objLocal: number,
  valResult: ValType | null | undefined,
  propName: string,
  strict: boolean,
): ValType | undefined {
  if (!setMemberF64Enabled()) return undefined;
  if (process.env.JS2WASM_SET_MEMBER_F64_DEBUG === "1") {
    const k = `${propName}:${valResult ? valResult.kind : "null"}`;
    declines.set(k, (declines.get(k) ?? 0) + 1);
  }
  if (!valResult || valResult.kind !== "f64") return undefined;
  if (ctx.booleanPropertyNames.has(propName)) return undefined;
  // Nothing has been emitted yet, and the reserve below is the last way to
  // decline — so a decline can never strand a half-written sequence.
  const valLocal = allocLocal(fctx, `__setf64_val_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.set", index: valLocal });
  if (!tryEmitTypedF64MemberSetFromLocal(ctx, fctx, objLocal, valLocal, propName, strict)) {
    fctx.body.push({ op: "local.get", index: valLocal }); // restore the operand
    return undefined;
  }
  // `=` (and a compound write-back) evaluates to the assigned value; leaving it
  // as f64 is what keeps the box out of the common statement-position write.
  fctx.body.push({ op: "local.get", index: valLocal });
  return { kind: "f64" };
}

/**
 * The same write for a value already materialized in an f64 LOCAL — the shape
 * the compound (`obj.x += v`) and update (`obj.x++`) write-backs are in, where
 * the result local is live for the expression's own value. Returns false
 * without emitting anything when the site is not eligible.
 */
export function tryEmitTypedF64MemberSetFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  objLocal: number,
  valF64Local: number,
  propName: string,
  strict: boolean,
): boolean {
  if (!setMemberF64Enabled()) return false;
  if (ctx.booleanPropertyNames.has(propName)) return false;
  const dispIdx = reserveTypedMemberSetF64Dispatch(ctx, propName, strict, fctx);
  if (dispIdx === undefined) return false;
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "local.get", index: valF64Local });
  fctx.body.push({ op: "call", funcIdx: dispIdx });
  emittedSites++;
  return true;
}

/**
 * Fill every reserved twin at FINALIZE, when the full struct-type table is
 * known. READ-ONLY over funcMap.
 *
 * The work list is derived from funcMap rather than a dedicated ctx set: the
 * name alone is ambiguous (a property literally called `x__f64` yields the same
 * string), so each candidate is confirmed by its SIGNATURE — only this twin has
 * `(externref, f64) -> ()`.
 *
 * Body local layout mirrors the generic dispatcher: param 0 = recv, param 1 =
 * val (f64), local 2 = `__any`.
 */
export function fillTypedMemberSetF64Dispatch(ctx: CodegenContext): void {
  if (!setMemberF64Enabled()) return;
  let filled = 0;
  let directArms = 0;
  for (const [name, dispIdx] of ctx.funcMap) {
    const m = /^__set_member_(nonstrict_)?(.+)__f64$/.exec(name);
    if (!m) continue;
    const dispFn = definedFuncAt(ctx, dispIdx);
    if (!dispFn) continue;
    const sig = ctx.mod.types[dispFn.typeIdx];
    if (!sig || sig.kind !== "func" || sig.params.length !== 2 || sig.params[1]?.kind !== "f64") continue;
    const strict = m[1] === undefined;
    const propName = m[2]!;
    const genericIdx = ctx.funcMap.get(strict ? `__set_member_${propName}` : `__set_member_nonstrict_${propName}`);
    if (genericIdx === undefined) continue;

    // Delegate: box the f64 back up to the uniform externref ABI and hand the
    // write to the generic dispatcher, which re-tests from the top. That is a
    // strictly complete fallback — it owns the cold/layout/resid arms and the
    // sidecar terminal — at the cost of the box this twin exists to avoid.
    const delegate: Instr[] = [
      { op: "local.get", index: 0 }, // recv
      { op: "local.get", index: 1 }, // val (f64)
      ...coercionInstrs(ctx, { kind: "f64" }, { kind: "externref" }),
      { op: "call", funcIdx: genericIdx },
    ];
    const buildDelegate = (): Instr[] => structuredClone(delegate) as Instr[];

    // The SAME list, in the SAME order, as `fillMemberSetDispatch`.
    const candidates = findAlternateStructsForField(ctx, propName, -1).filter((c) => c.mutable);
    const buildChain = (idx: number): Instr[] => {
      if (idx >= candidates.length) return buildDelegate();
      const cand = candidates[idx]!;
      // Only a plain f64 slot can take the value as-is. A native-generator
      // IteratorResult `value` slot is excluded because its f64 carries the
      // UNDEF_F64 sentinel (#2979) — the generic arm is the one that knows it.
      const canStoreDirect = cand.fieldType.kind === "f64" && !isNativeGeneratorResultStruct(ctx, cand.structTypeIdx);
      const buildDirectStore = (): Instr[] => [
        { op: "local.get", index: 2 }, // __any
        { op: "ref.cast", typeIdx: cand.structTypeIdx },
        { op: "local.get", index: 1 }, // val (f64)
        { op: "struct.set", typeIdx: cand.structTypeIdx, fieldIdx: cand.fieldIdx },
        ...(cand.presenceSlot !== undefined
          ? presenceSetInstrs(cand.structTypeIdx, cand.presenceSlot, [
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: cand.structTypeIdx },
            ])
          : []),
      ];
      const direct: Instr[] = !canStoreDirect
        ? buildDelegate()
        : ctx.standalone && inheritedSetAffectsKey(ctx, propName) && cand.presenceSlot !== undefined
          ? [
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: cand.structTypeIdx },
              ...presenceTestInstrs(cand.structTypeIdx, cand.presenceSlot),
              {
                op: "if",
                blockType: { kind: "empty" },
                // A flow slot does not become an own property until its
                // presence bit is set. Delegate the absent case once to the
                // generic dispatcher, which reaches `__extern_set` and its
                // four-state inherited-descriptor decision.
                then: buildDirectStore(),
                else: buildDelegate(),
              },
            ]
          : buildDirectStore();
      if (canStoreDirect) directArms++;
      const next = buildChain(idx + 1);
      // Structurally canonicalized shapes share one heap type, so `ref.test`
      // alone can select the wrong logical shape — verify the `$shape` stamp
      // and keep dispatching on a mismatch, exactly as the generic arm does.
      const guarded: Instr[] =
        cand.shapeId !== undefined && cand.shapeFieldIdx !== undefined
          ? [
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx: cand.structTypeIdx },
              { op: "struct.get", typeIdx: cand.structTypeIdx, fieldIdx: cand.shapeFieldIdx },
              { op: "i32.const", value: cand.shapeId },
              { op: "i32.eq" },
              { op: "if", blockType: { kind: "empty" }, then: direct, else: next },
            ]
          : direct;
      return [
        { op: "local.get", index: 2 }, // __any
        { op: "ref.test", typeIdx: cand.structTypeIdx },
        { op: "if", blockType: { kind: "empty" }, then: guarded, else: next },
      ];
    };

    dispFn.locals = [{ name: "__any", type: { kind: "anyref" } }];
    dispFn.body = [
      { op: "local.get", index: 0 }, // recv (externref)
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 }, // __any
      ...buildChain(0),
    ];
    filled++;
  }
  // Evidence the twin fired, for someone experimenting with the flag; silent on
  // a default build, where it would print on every compile.
  if (!tunedFlagExplicit(process.env.JS2WASM_SET_MEMBER_F64) && process.env.JS2WASM_SET_MEMBER_F64_DEBUG !== "1") {
    return;
  }
  process.stderr.write(`[set-member-f64] sites=${emittedSites} dispatchers=${filled} directArms=${directArms}\n`);
  for (const [k, n] of [...declines].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    process.stderr.write(`[set-member-f64] site ${k} ×${n}\n`);
  }
}
