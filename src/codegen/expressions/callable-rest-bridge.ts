// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5334) Rest-parameter disambiguation for the typed callable-param dispatch
 * ladder in `compileIdentifierCall` (`call-identifier.ts`).
 *
 * ## The ambiguity
 * `function spy(...args)` and `function g(xs: any[])` lift to the SAME funcref
 * type `(self, ref null $__vec_externref) -> R`, and when both are captureless
 * declarations they share the same signature wrapper struct too. The ladder
 * discriminates its arms by funcref type, so any per-funcref "this is rest"
 * flag is wrong in one direction or the other: positional marshalling
 * `ref.cast`s call argument 0 (a string, in jest-watcher's
 * `onChange(this._value, opts)`) to the vec and traps `illegal cast`;
 * unconditional packing hands `g` a one-element vec wrapping its real array.
 * No compile-time metadata can separate the two readings of a shared
 * signature — the decision is made at RUNTIME, from what actually arrives.
 *
 * ## Two runtime discriminators, layered
 * 1. Closure IDENTITY, where it is structurally provable. WasmGC canonicalizes
 *    types by structure (measured 2026-09-05 with a hand-written module: two
 *    sibling subtypes of the wrapper root with identical fields `ref.test` as
 *    ONE type; one extra field makes them distinct). A `ref.test` against a
 *    closure struct therefore proves rest-ness only when that struct is
 *    structurally distinct from every non-rest allocation of the signature:
 *    #4616's `__rest_fn_wrap` marker subtype (an extra f64 field) and capture
 *    structs qualify; the shared signature wrapper itself never does. Every
 *    registered `hasRestParam` struct that qualifies becomes a GUARD: a hit
 *    is the REST reading — pack every argument from the vec slot on into a
 *    fresh vec — unconditionally. (`spy(["ab", "c"])` needs this: its one
 *    argument IS a vec, so no value test can tell it from `g(["ab", "c"])`.)
 * 2. The VALUE's shape, when identity is not provable (the rest closure's
 *    struct was minted after this call site compiled — jest's `vi.fn()` spy
 *    lives in the test module, compiled after the library — or belongs to
 *    another module): `ref.test` the erased argument against the vec carrier.
 *    A hit is the FIXED reading (pass it through; that is what a real `g(xs)`
 *    call site produces), a miss is the REST reading. A scalar or closed
 *    reference slot can never hold the vec and packs without a test; a call
 *    site with no argument for the slot packs an empty vec (`onCancel()`); a
 *    statically array-typed slot keeps its positional projection unless a
 *    guard proves rest.
 *
 * Residual, by construction: a rest closure whose struct is not registered
 * here and whose first surplus argument is itself a `$__vec_externref` reads
 * as the fixed reading (`spy([1, 2])` → `args = [1, 2]`). That is what the
 * parent produced for the cases it did not trap on; only a registered guard
 * improves it, which is why `registerRestDeclarationWrapperShapes` pre-registers
 * the marker subtype for every rest DECLARATION used as a value.
 *
 * Host lane only, like the rest of the ladder's bridge family: standalone keeps
 * the parent's flag-driven reading (a flagged candidate packs unconditionally).
 * Every instruction emitted here is pure Wasm (no call, no global), so an arm
 * that never runs cannot shift a function index (#2174 dead-arm discipline).
 */

import type { Instr, ValType } from "../../ir/types.js";
import { ts } from "../../ts-api.js";
import { allocLocal } from "../context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import {
  CLOSURE_CAPTURE_FIELD_BASE,
  getOrCreateFuncRefWrapperTypes,
  isSharedSignatureWrapperStruct,
} from "../closures/funcref-wrapper-types.js";
import { getOrRegisterVecType } from "../registry/types.js";
import { getVecInfo } from "../type-coercion.js";

/** The trailing `(ref null $__vec_externref)` formal of a candidate signature. */
interface TrailingExternVecSlot {
  /** Index of the vec formal — also the candidate's fixed formal count. */
  slot: number;
  vecTypeIdx: number;
  arrTypeIdx: number;
}

/**
 * The trailing formal of `paramTypes` when it is the canonical externref vec
 * (`...args` / `xs: any[]`), else null. Typed vecs (`...nums: number[]`) are
 * deliberately not recognised: their elements cannot be packed from externref
 * views, so those candidates keep the parent's treatment.
 */
function trailingExternVecSlot(ctx: CodegenContext, paramTypes: readonly ValType[]): TrailingExternVecSlot | null {
  const last = paramTypes[paramTypes.length - 1];
  if (last === undefined || (last.kind !== "ref" && last.kind !== "ref_null")) return null;
  const vec = getVecInfo(ctx, last.typeIdx);
  if (vec === null || vec.elemType.kind !== "externref") return null;
  return { slot: paramTypes.length - 1, vecTypeIdx: last.typeIdx, arrTypeIdx: vec.arrTypeIdx };
}

/**
 * How many leading formals of a candidate are POSITIONAL. On the host lane a
 * trailing externref vec is always the bridge's slot, whatever the record's
 * flag says; elsewhere only a flagged record loses its trailing formal (the
 * parent's rule).
 */
export function candidateFixedFormalCount(
  ctx: CodegenContext,
  info: { paramTypes: readonly ValType[]; hasRestParam?: boolean },
  hostLane: boolean,
): number {
  return info.hasRestParam === true || (hostLane && trailingExternVecSlot(ctx, info.paramTypes) !== null)
    ? Math.max(0, info.paramTypes.length - 1)
    : info.paramTypes.length;
}

/**
 * The callable-PROPERTY ladder's rest reading (`calls-closures.ts`): the fixed
 * formal count of a candidate whose trailing formal is the externref vec, or
 * null when the candidate is not read that way. Host lane only and flag-
 * independent — that ladder never packed anything before, so standalone keeps
 * its bytes.
 */
export function bridgedRestFixedCount(
  ctx: CodegenContext,
  paramTypes: readonly ValType[],
  hostLane: boolean,
): number | null {
  if (!hostLane) return null;
  const slot = trailingExternVecSlot(ctx, paramTypes);
  return slot === null ? null : slot.slot;
}

/**
 * Externref views of a property ladder's typed argument locals, emitted into
 * `fctx.body` BEFORE the dispatch chain so the pack can read them. Only pure
 * conversions or a call to a box helper that is ALREADY registered: a slot
 * that would need a new import (or a carrier with its own projection rules —
 * `$AnyValue`, the f64 undefined sentinel) answers undefined, and every arm
 * whose pack needs it is skipped rather than mis-marshalled.
 */
export function argumentExternViews(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argLocals: readonly number[],
  argTypes: readonly ValType[],
  argCount: number,
): (number | undefined)[] {
  const views: (number | undefined)[] = [];
  for (let i = 0; i < argCount; i++) {
    const type = argTypes[i];
    const local = argLocals[i];
    let convert: Instr[] | null = null;
    if (type === undefined || local === undefined) convert = null;
    else if (type.kind === "externref" || type.kind === "ref_extern") {
      views.push(local);
      continue;
    } else if ((type.kind === "ref" || type.kind === "ref_null") && type.typeIdx !== ctx.anyValueTypeIdx) {
      convert = [{ op: "extern.convert_any" }];
    } else if (type.kind === "f64" && type.undefSentinel !== true) {
      const box = ctx.funcMap.get("__box_number");
      if (box !== undefined) convert = [{ op: "call", funcIdx: box }];
    } else if (type.kind === "i32") {
      const box = ctx.funcMap.get(type.boolean === true ? "__box_boolean" : "__box_number");
      if (box !== undefined) {
        convert = type.boolean === true ? [] : [{ op: "f64.convert_i32_s" }];
        convert.push({ op: "call", funcIdx: box });
      }
    }
    if (convert === null) {
      views.push(undefined);
      continue;
    }
    const view = allocLocal(fctx, `__cprest_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.get", index: local! }, ...convert, { op: "local.set", index: view });
    views.push(view);
  }
  return views;
}

/** How one funcref type's arm decides between the fixed and the rest reading. */
export interface RestDispatchPlan {
  /**
   * Pack without asking: the shared signature wrapper's own record is flagged
   * (a captureless rest arrow / function expression replaced it, so its struct
   * discriminates nothing), or this is the standalone lane's flag-driven arm.
   */
  unconditional: boolean;
  /** Structurally distinct rest closure structs; a `ref.test` hit proves the rest reading. */
  guardStructTypeIdxs: number[];
}

/**
 * Per funcref type: every registered rest closure struct whose `ref.test` can
 * be trusted as a guard, plus whether the reading is unconditional.
 */
export function collectRestDispatchPlans(ctx: CodegenContext, hostLane: boolean): Map<number, RestDispatchPlan> {
  const plans = new Map<number, RestDispatchPlan>();
  for (const [structTypeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.hasRestParam !== true || trailingExternVecSlot(ctx, info.paramTypes) === null) continue;
    const plan = plans.get(info.funcTypeIdx) ?? { unconditional: false, guardStructTypeIdxs: [] };
    if (!hostLane || isSharedSignatureWrapperStruct(ctx, structTypeIdx)) plan.unconditional = true;
    else if (isDiscriminatingRestStruct(ctx, structTypeIdx)) plan.guardStructTypeIdxs.push(structTypeIdx);
    plans.set(info.funcTypeIdx, plan);
  }
  return plans;
}

/**
 * A guard struct must be structurally distinct from every non-rest allocation
 * of the same signature, or its `ref.test` matches those too (canonical
 * identity is structural). The bare header IS the shared wrapper; header plus
 * one immutable i32 IS the constructible wrapper (`__constructible`). Anything
 * with more — the `__rest_fn_wrap` f64 marker, captures — is distinct from
 * both. Two capture structs with identical layouts still canonicalize
 * together; that residual is documented in the module header.
 */
function isDiscriminatingRestStruct(ctx: CodegenContext, structTypeIdx: number): boolean {
  const def = ctx.mod.types[structTypeIdx];
  if (def?.kind !== "struct") return false;
  const extra = def.fields.slice(CLOSURE_CAPTURE_FIELD_BASE);
  if (extra.length === 0) return false;
  return !(extra.length === 1 && extra[0]!.type.kind === "i32" && !extra[0]!.mutable);
}

/** Everything one dispatch arm knows about its call site and candidate. */
export interface RestSlotSite {
  /** The candidate's formals; the last one is the vec slot. */
  paramTypes: readonly ValType[];
  plan: RestDispatchPlan | undefined;
  /** The root-typed closure value, for the identity guards. */
  closureLocal: number;
  /** The declared callable signature's lowered formals. */
  sigParamWasmTypes: readonly ValType[];
  /** Typed argument locals, one per declared formal (padded). */
  argLocals: readonly number[];
  /**
   * The externref view of each real call argument; `undefined` where the site
   * has none (a property ladder's scalar slot with no box helper registered).
   */
  argExternLocals: readonly (number | undefined)[];
  argCount: number;
  /** The ladder's static vec-to-vec projection, when the slot is an array type. */
  vecBridge: (from: ValType, to: ValType) => Instr[] | null;
}

/**
 * The instruction sequence that leaves the candidate's vec formal on the
 * stack, deciding the reading at runtime as described in the module header.
 * Null when the arm cannot be built: the candidate's trailing formal is not
 * the externref vec (a flagged typed-vec / tuple rest), or an argument the
 * pack would need has no externref view — skip that arm.
 */
export function restSlotMarshalInstrs(ctx: CodegenContext, site: RestSlotSite): Instr[] | null {
  const slot = trailingExternVecSlot(ctx, site.paramTypes);
  if (slot === null) return null;
  const packedViews = site.argExternLocals.slice(slot.slot, site.argCount);
  if (packedViews.some((view) => view === undefined)) return null;
  const packed = packedViews as number[];
  const pack = (): Instr[] => [
    { op: "i32.const", value: packed.length },
    ...packed.map((index): Instr => ({ op: "local.get", index })),
    { op: "array.new_fixed", typeIdx: slot.arrTypeIdx, length: packed.length },
    { op: "struct.new", typeIdx: slot.vecTypeIdx },
  ];
  if (site.plan?.unconditional === true) return pack();

  // What this call site can prove about the value in the slot decides how much
  // of the reading is left to runtime: nothing to test when the argument is
  // missing or statically not an array; a projection when it statically is.
  const k = slot.slot;
  const slotType = k < site.argCount ? (site.sigParamWasmTypes[k] ?? { kind: "externref" }) : undefined;
  const vecResult = { kind: "val", type: { kind: "ref_null", typeIdx: slot.vecTypeIdx } } as const;
  let fixed: Instr[] | null = null;
  if (slotType === undefined) {
    // No argument for the slot: only the rest reading (an empty vec) exists.
  } else if ((slotType.kind === "ref" || slotType.kind === "ref_null") && k < site.argLocals.length) {
    // Statically a GC carrier: an array projects positionally, anything else
    // can never be the callee's vec. (Ask the projection only here — the
    // property ladder's bridge would also cast an ERASED slot, which is
    // exactly the trap this module exists to avoid.)
    const projection = site.vecBridge(slotType, site.paramTypes[k]!);
    if (projection !== null) fixed = [{ op: "local.get", index: site.argLocals[k]! }, ...projection];
  } else if (slotType.kind === "externref" || slotType.kind === "ref_extern") {
    const externLocal = site.argExternLocals[k]!;
    fixed = [
      { op: "local.get", index: externLocal },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: slot.vecTypeIdx },
      {
        op: "if",
        blockType: vecResult,
        then: [
          { op: "local.get", index: externLocal },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: slot.vecTypeIdx },
        ],
        else: pack(),
      },
    ];
  }
  if (fixed === null) return pack();
  const guards = site.plan?.guardStructTypeIdxs ?? [];
  if (guards.length === 0) return fixed;
  const test: Instr[] = [];
  guards.forEach((structTypeIdx, i) => {
    test.push({ op: "local.get", index: site.closureLocal }, { op: "ref.test", typeIdx: structTypeIdx });
    if (i > 0) test.push({ op: "i32.or" });
  });
  return [...test, { op: "if", blockType: vecResult, then: pack(), else: fixed }];
}

/**
 * Does the program contain ANY source rest parameter? Cached per context (per
 * source file when the cross-module source set is unknown). This gates the
 * speculative pure-rest wrappers below: registering a `(vec) -> R` record in
 * a program that has no rest function gives it nothing to match, while it DOES
 * change other dispatchers' candidate sets — the dynamic call path in
 * `calls.ts` saw the ref-typed formal and pulled the `__unwrap_for_wasm` host
 * import into a numeric-only module (the #1941 optimize-differential program;
 * measured 2026-09-06 as a LinkError in the equivalence harness). A rest-free
 * program must compile byte-identically to the parent.
 */
function programHasRestParameter(ctx: CodegenContext, sourceFile: ts.SourceFile | undefined): boolean {
  const holder = ctx as unknown as { __restBridgeProgramHasRest?: Map<string, boolean> };
  const cache = (holder.__restBridgeProgramHasRest ??= new Map());
  const files = ctx.callableSourceFiles ?? (sourceFile === undefined ? [] : [sourceFile]);
  const key = ctx.callableSourceFiles !== undefined ? "*" : (sourceFile?.fileName ?? "");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isParameter(node) && node.dotDotDotToken !== undefined) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) {
    if (file.isDeclarationFile) continue;
    visit(file);
    if (found) break;
  }
  cache.set(key, found);
  return found;
}

/**
 * The pure-rest shape `(...args) -> R` gets a wrapper — and therefore an arm —
 * at this call site even when the rest closure is compiled LATER (the same
 * get-or-create family as the #4616 prefix wrappers, so the later closure
 * reuses the identical funcref type). Without it the jest `vi.fn()` spy,
 * compiled in the test module after the library's `onChange(...)`, matched no
 * arm at all and the call ended in the TypeError terminal. Empty when the
 * program has no rest parameter at all (see `programHasRestParameter`).
 */
export function restShapedWrapperCandidates(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile | undefined,
  resultVariants: readonly (readonly ValType[])[],
): ClosureInfo[] {
  if (!programHasRestParameter(ctx, sourceFile)) return [];
  const vecTypeIdx = ctx.vecTypeMap.get("externref") ?? getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const out: ClosureInfo[] = [];
  for (const results of resultVariants) {
    const alt = getOrCreateFuncRefWrapperTypes(
      ctx,
      [{ kind: "ref_null", typeIdx: vecTypeIdx }],
      [...results],
      "support",
    );
    if (alt) out.push(alt.closureInfo);
  }
  return out;
}
