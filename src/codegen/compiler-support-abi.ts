// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// compiler-support-abi.ts — #3520 C35.
//
// The four compiler-authored callable families that were still falling through
// to the generic `retained-module-function` role after C30–C34:
//
//   * `__\0js2_call_fn_method_argc_<arity>` — the argc-seeding wrappers around
//     the closure method dispatchers (C31 deferred these explicitly);
//   * `__async_resume_f<name>` plus its two microtask step adapters
//     (`__cb_<id>` on the host backend, `__async_step_f<name>_fulfill` /
//     `_reject` on the native one);
//   * `__vec_from_extern_<vecTypeIdx>` — the per-vec-shape externref
//     materializers; and
//   * the self-hosted `Math_*` / `__math_reduce_trig` helpers that no intrinsic
//     provider claimed, because only a DEPENDENT intrinsic was requested.
//
// A fifth family, `__vec_set_elem` / `__vec_set_len`, was closed by #3520 W1-E
// and is listed in the table below for inventory completeness — but it is NOT
// planned from this file. It lives in `vec-define-writeback.ts`, which observes
// it into the `vec-host-bridge` role at emission time; see
// `vecHostBridgeWritebackOrdinal` in `vec-access-exports.ts`.
//
// The generic role's derived ordinal is the function's FINAL INDEX, so identity
// moves whenever an unrelated import or function is added or eliminated. That
// is a positional label, not an identity. Each family here gets one role whose
// ordinal is derived from something the module's function layout cannot move:
//
//   | family              | anchor       | ordinal                            |
//   | ------------------- | ------------ | ---------------------------------- |
//   | closure argc        | entry source | dispatcher arity                   |
//   | async frame         | async UNIT   | resume 0 / fulfill 1 / reject 2    |
//   | vec-from-extern     | entry source | position in the sorted PRE-elision |
//   |                     |              | list of vec STRUCT NAMES           |
//   | stdlib math helper  | entry source | index in a closed constant table   |
//   | vec write-back      | entry source | closed table 9 / 10 of the         |
//   | (#3520 W1-E, in     |              | `vec-host-bridge` role — owned by  |
//   |  vec-define-        |              | `vec-access-exports.ts`, observed  |
//   |  writeback.ts)      |              | at emission, not planned here      |
//
// Two of those are stronger than a sorted-survivor order and deliberately so
// (the R1a rule restated by the C34 follow-up: a retained support node keeps the
// ID it was assigned before a dead-binding pass ran). The async family is keyed
// by its own source unit, so a second async function cannot renumber the first;
// the math table is a compile-time constant, so nothing a program contains can
// move an entry at all. The vec family follows C34 exactly: the canonical order
// is computed over the PRE-elision record, so eliminating one materializer
// cannot renumber its neighbours.
//
// Display names stay labels. None participates in a binding key, so a source
// function spelled the same way cannot occupy a role.
//
// Recording is separate from planning on purpose, for the same reason C34 split
// them: several of these emitters sit under non-fatal `try`/`catch` or fallback
// paths, where a raised ABI invariant would be swallowed and the compile would
// silently return a module whose family had no owner. Recording cannot throw.
// `planCompilerSupportCallableAbi` runs from the finalization seam, after DCE
// has settled the layout and immediately before the generic fallback sweep, so
// an eliminated helper is simply absent rather than claiming a slot that is
// gone — and a helper some other registry already owns is left alone.

import type ts from "typescript";

import { irSupportFuncRef } from "../ir/callable-bindings.js";
import type { IrUnitId } from "../ir/identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { WasmFunction } from "../ir/types.js";
import {
  ACOS_BUILTIN,
  ASIN_BUILTIN,
  ATAN2_BUILTIN,
  ATAN_BUILTIN,
  COS_BUILTIN,
  EXP_BUILTIN,
  LOG10_BUILTIN,
  LOG2_BUILTIN,
  LOG_BUILTIN,
  POW_BUILTIN,
  REDUCE_TRIG_BUILTIN,
  SELF_HOSTED_MATH,
  SIN_BUILTIN,
  TAN_BUILTIN,
} from "../stdlib/math.js";
import type { CodegenContext } from "./context/types.js";
import {
  planProgramAbiEntrySourceSupportCallable,
  planProgramAbiSupportCallable,
  PROGRAM_ABI_CALLABLE_ROLE,
} from "./program-abi-planning.js";

export const CLOSURE_ARGC_DISPATCHER_ROLE = "closure-argc-dispatcher";
export const ASYNC_FRAME_MACHINERY_ROLE = "async-frame-machinery";
export const VEC_FROM_EXTERN_ROLE = "vec-from-extern-materializer";
export const STDLIB_MATH_HELPER_ROLE = "stdlib-math-helper";

/**
 * Async frame machinery parts in one closed table.
 *
 * The value is the derived ordinal beneath the async function's own unit, so it
 * must stay stable.
 */
export const ASYNC_FRAME_MACHINERY_PART = Object.freeze({
  resume: 0,
  stepFulfill: 1,
  stepReject: 2,
} as const);

export type AsyncFrameMachineryPart = keyof typeof ASYNC_FRAME_MACHINERY_PART;

/**
 * Every function name `emitInlineMathFunctions` can produce, as one closed,
 * canonically sorted constant.
 *
 * Derived from the stdlib builtin definitions rather than hand-listed, so a new
 * self-hosted Math core cannot silently fall off the table. Because the table is
 * a compile-time constant, an entry's ordinal does not depend on which helpers
 * a given module happens to emit — neither elision nor unrelated growth can move
 * one.
 */
export const STDLIB_MATH_ABI_NAMES: readonly string[] = Object.freeze(
  [
    ...new Set([
      // Hand-emitted (a WASI/host RNG import, not a self-hosted body).
      "Math_random",
      ACOS_BUILTIN.name,
      ASIN_BUILTIN.name,
      ATAN2_BUILTIN.name,
      ATAN_BUILTIN.name,
      COS_BUILTIN.name,
      EXP_BUILTIN.name,
      LOG10_BUILTIN.name,
      LOG2_BUILTIN.name,
      LOG_BUILTIN.name,
      POW_BUILTIN.name,
      REDUCE_TRIG_BUILTIN.name,
      SIN_BUILTIN.name,
      TAN_BUILTIN.name,
      ...[...SELF_HOSTED_MATH.values()].map((builtin) => builtin.name),
    ]),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
);

/** Ordinal of one stdlib Math helper, or `undefined` when it is off the table. */
export function stdlibMathHelperOrdinal(name: string): number | undefined {
  const position = STDLIB_MATH_ABI_NAMES.indexOf(name);
  return position < 0 ? undefined : position;
}

/**
 * Canonical order for the per-vec-shape materializer family.
 *
 * Sorted by the vec STRUCT NAME (`__vec_<elem>`), which is total over the
 * recorded shapes and independent of both emission order and the numeric type
 * index the materializer is spelled with.
 */
export function vecFromExternShapeOrder(shapeNames: Iterable<string>): readonly string[] {
  return [...new Set(shapeNames)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

interface RecordedEntrySourceSupport {
  readonly role: string;
  readonly roleOrdinal: number;
  /** Resolved at planning time for the vec family; fixed for the others. */
  readonly derivedOrdinal: number | undefined;
  readonly shapeName?: string;
  readonly func: WasmFunction;
}

interface RecordedUnitSupport {
  readonly declaration: ts.Node;
  readonly part: AsyncFrameMachineryPart;
  readonly func: WasmFunction;
}

const recordedEntrySourceSupports = new WeakMap<CodegenContext, RecordedEntrySourceSupport[]>();
const recordedAsyncFrameMachinery = new WeakMap<CodegenContext, RecordedUnitSupport[]>();
const plannedContexts = new WeakSet<CodegenContext>();

function pushEntrySourceRecord(ctx: CodegenContext, record: RecordedEntrySourceSupport): void {
  let recorded = recordedEntrySourceSupports.get(ctx);
  if (!recorded) {
    recorded = [];
    recordedEntrySourceSupports.set(ctx, recorded);
  }
  recorded.push(record);
}

/** Record one argc-seeding wrapper by its exact allocator object. */
export function recordClosureArgcDispatcher(ctx: CodegenContext, arity: number, func: WasmFunction): void {
  if (!Number.isSafeInteger(arity) || arity < 0) return;
  pushEntrySourceRecord(ctx, {
    role: CLOSURE_ARGC_DISPATCHER_ROLE,
    roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.closureArgcDispatcher,
    derivedOrdinal: arity,
    func,
  });
}

/** Record one per-vec-shape externref materializer by its exact allocator object. */
export function recordVecFromExternMaterializer(ctx: CodegenContext, shapeName: string, func: WasmFunction): void {
  if (shapeName.length === 0) return;
  pushEntrySourceRecord(ctx, {
    role: VEC_FROM_EXTERN_ROLE,
    roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.vecFromExternMaterializer,
    derivedOrdinal: undefined,
    shapeName,
    func,
  });
}

/** Record one self-hosted Math helper by its exact allocator object. */
export function recordStdlibMathHelper(ctx: CodegenContext, name: string, func: WasmFunction): void {
  const derivedOrdinal = stdlibMathHelperOrdinal(name);
  if (derivedOrdinal === undefined) return;
  pushEntrySourceRecord(ctx, {
    role: STDLIB_MATH_HELPER_ROLE,
    roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.stdlibMathHelper,
    derivedOrdinal,
    func,
  });
}

/**
 * Record one async frame machinery part against its own source declaration.
 *
 * The declaration is resolved to an exact `IrUnitId` at planning time, so a
 * prepared or synthetic async body with no inventoried unit is simply left on
 * the generic fallback rather than borrowing another owner's anchor.
 */
export function recordAsyncFrameMachinery(
  ctx: CodegenContext,
  declaration: ts.Node | undefined,
  part: AsyncFrameMachineryPart,
  func: WasmFunction,
): void {
  if (!declaration) return;
  let recorded = recordedAsyncFrameMachinery.get(ctx);
  if (!recorded) {
    recorded = [];
    recordedAsyncFrameMachinery.set(ctx, recorded);
  }
  recorded.push({ declaration, part, func });
}

function isLiveAndUnowned(ctx: CodegenContext, func: WasmFunction): boolean {
  if (!ctx.mod.functions.includes(func)) return false;
  // A helper another registry already claimed (a self-hosted Math core that an
  // intrinsic provider owns, say) keeps that owner. This is the same predicate
  // the generic sweep applies, evaluated at the same seam.
  return ctx.programAbiSession?.locatorBindingId(func) === undefined;
}

/**
 * Slots that exactly ONE live allocator object claims, and the object claiming
 * each — a pre-pass, so the decision cannot depend on which record came first.
 *
 * (#2980) A slot can legitimately be claimed TWICE. When the async host
 * fallback fires, the same declaration is lowered a second time and BOTH
 * lowerings' functions stay live in the module: measured on the #2980 guard
 * fixtures, one `async function* g()` produces two `__async_resume_fg` objects,
 * two `__async_step_fg_fulfill`, and two `__async_step_fg_reject`. The unit
 * anchor cannot name an owner there — the unit has two rival machineries, not
 * one — and C35's first cut treated that as an ownership contradiction and let
 * the session's plan-contract invariant abort the compile. That is strictly
 * worse than the behaviour it replaced: before this role existed both objects
 * simply took generic `retained-module-function` owners and the module built.
 *
 * So an ambiguous slot DECLINES the role and every claimant falls through to
 * the generic sweep, which still makes the function space total. Nothing is
 * hidden: the duplicate remains visible as two generic rows, exactly as it was
 * before C35. A slot re-recorded with the SAME object (an idempotent emitter
 * re-entry) is not ambiguous and keeps its owner.
 */
function unambiguousSlotClaims<T>(
  ctx: CodegenContext,
  records: readonly T[],
  slotOf: (record: T) => string | undefined,
  funcOf: (record: T) => WasmFunction,
): Map<string, WasmFunction> {
  const candidates = new Map<string, Set<WasmFunction>>();
  for (const record of records) {
    const slot = slotOf(record);
    if (slot === undefined) continue;
    const func = funcOf(record);
    if (!isLiveAndUnowned(ctx, func)) continue;
    const claimants = candidates.get(slot) ?? new Set<WasmFunction>();
    claimants.add(func);
    candidates.set(slot, claimants);
  }
  const resolved = new Map<string, WasmFunction>();
  for (const [slot, claimants] of candidates) {
    if (claimants.size === 1) resolved.set(slot, [...claimants][0]!);
  }
  return resolved;
}

function planEntrySourceFamilies(ctx: CodegenContext): void {
  const recorded = recordedEntrySourceSupports.get(ctx);
  if (!recorded || recorded.length === 0) return;
  // Pre-elision canonical order for the vec family (C34's rule: derive from the
  // record, not from the survivors).
  const vecOrder = vecFromExternShapeOrder(
    recorded.filter((entry) => entry.role === VEC_FROM_EXTERN_ROLE).map((entry) => entry.shapeName ?? ""),
  );
  const ordinalOf = (record: RecordedEntrySourceSupport): number =>
    record.derivedOrdinal ?? (record.shapeName === undefined ? -1 : vecOrder.indexOf(record.shapeName));
  const slotOf = (record: RecordedEntrySourceSupport): string | undefined => {
    const derivedOrdinal = ordinalOf(record);
    return derivedOrdinal < 0 ? undefined : `${record.role}:${derivedOrdinal}`;
  };
  const owners = unambiguousSlotClaims(ctx, recorded, slotOf, (record) => record.func);

  const planned: { readonly record: RecordedEntrySourceSupport; readonly derivedOrdinal: number }[] = [];
  const emitted = new Set<string>();
  for (const record of recorded) {
    const slot = slotOf(record);
    if (slot === undefined || emitted.has(slot)) continue;
    if (owners.get(slot) !== record.func) continue;
    emitted.add(slot);
    planned.push({ record, derivedOrdinal: ordinalOf(record) });
  }
  planned.sort(
    (left, right) => left.record.roleOrdinal - right.record.roleOrdinal || left.derivedOrdinal - right.derivedOrdinal,
  );
  for (const { record, derivedOrdinal } of planned) {
    planProgramAbiEntrySourceSupportCallable(ctx, {
      role: record.role,
      roleOrdinal: record.roleOrdinal,
      derivedOrdinal,
      displayName: record.func.name,
      func: record.func,
    });
  }
}

/**
 * Can this unit supply a deterministic whole-program order anchor?
 *
 * `hasKnownUnit` answers "the session knows this ID", which is NOT the same
 * question: an inventoried unit can still lack a declaration anchor, and
 * `structuralOrder.forUnit` raises `unknown-order-anchor` for it. Being
 * unorderable is a ROUTING fact — the family simply stays on the generic
 * fallback, exactly as it did before this role existed — so it must not turn a
 * previously working compile into a hard failure. Every other invariant code is
 * an ownership contradiction and is rethrown.
 */
function canOrderUnit(session: NonNullable<CodegenContext["programAbiSession"]>, unitId: IrUnitId): boolean {
  try {
    session.structuralOrder.forUnit(unitId, {
      domain: "callable",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.asyncFrameMachinery,
      derivedOrdinal: ASYNC_FRAME_MACHINERY_PART.resume,
    });
    return true;
  } catch (error) {
    if (error instanceof ProgramAbiInvariantError && error.code === "unknown-order-anchor") return false;
    throw error;
  }
}

function planAsyncFrameMachinery(ctx: CodegenContext): void {
  const recorded = recordedAsyncFrameMachinery.get(ctx);
  if (!recorded || recorded.length === 0) return;
  const session = ctx.programAbiSession;
  const unitIdByDeclaration = ctx.irPlanningIdentityContext?.unitIdByDeclaration;
  if (!session || !unitIdByDeclaration) return;

  const unitOf = (record: RecordedUnitSupport): IrUnitId | undefined => {
    const unitId = unitIdByDeclaration.get(record.declaration);
    if (unitId === undefined || !session.hasKnownUnit(unitId) || !canOrderUnit(session, unitId)) return undefined;
    return unitId;
  };
  const slotOf = (record: RecordedUnitSupport): string | undefined => {
    const unitId = unitOf(record);
    return unitId === undefined ? undefined : `${unitId}:${record.part}`;
  };
  const owners = unambiguousSlotClaims(ctx, recorded, slotOf, (record) => record.func);

  const planned: { readonly unitId: IrUnitId; readonly part: AsyncFrameMachineryPart; readonly func: WasmFunction }[] =
    [];
  const emitted = new Set<string>();
  for (const record of recorded) {
    const slot = slotOf(record);
    if (slot === undefined || emitted.has(slot)) continue;
    if (owners.get(slot) !== record.func) continue;
    emitted.add(slot);
    planned.push({ unitId: unitOf(record)!, part: record.part, func: record.func });
  }
  planned.sort(
    (left, right) =>
      (left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0) ||
      ASYNC_FRAME_MACHINERY_PART[left.part] - ASYNC_FRAME_MACHINERY_PART[right.part],
  );
  for (const { unitId, part, func } of planned) {
    const derivedOrdinal = ASYNC_FRAME_MACHINERY_PART[part];
    const ref = irSupportFuncRef(unitId, ASYNC_FRAME_MACHINERY_ROLE, func.name, derivedOrdinal);
    const signature = ctx.mod.types[func.typeIdx];
    if (!signature || signature.kind !== "func") {
      throw new ProgramAbiInvariantError(
        "type-remap-mismatch",
        `async frame machinery ${func.name} references non-function or missing type ${func.typeIdx}`,
      );
    }
    planProgramAbiSupportCallable(ctx, {
      ref,
      anchor: { kind: "unit", unitId },
      role: ASYNC_FRAME_MACHINERY_ROLE,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.asyncFrameMachinery,
      derivedOrdinal,
      signature,
      func,
    });
  }
}

/**
 * Hand every recorded compiler-support family to the Program ABI as one batch.
 *
 * Runs from the finalization seam after dead-import/function elimination has
 * settled the final layout and before the generic `retained-module-function`
 * sweep, so an eliminated helper is absent rather than claimed and a helper
 * another registry already owns keeps that owner.
 */
export function planCompilerSupportCallableAbi(ctx: CodegenContext): void {
  if (plannedContexts.has(ctx)) return;
  if (!ctx.programAbiSession) return;
  plannedContexts.add(ctx);
  planEntrySourceFamilies(ctx);
  planAsyncFrameMachinery(ctx);
}
