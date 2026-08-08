// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3927) EMISSION of per-type fnctor struct layouts — the consumer of the
 * `fnctor-alloc-labels.ts` plan. OFF unless `JS2WASM_FNCTOR_LAYOUT_EMIT` is
 * set; flag-off builds are byte-identical (nothing here runs).
 *
 * ## What it emits
 * For a fnctor whose plan verdict is `split`, the single widened
 * `$__fnctor_<Name>` union struct becomes a FAMILY:
 *
 * ```
 * base     $__fnctor_<Name>            (sub (struct ctor-fields, presence
 *                                       words sized for the FULL union,
 *                                       $constructor, $shape, $resid))
 * layouts  $__fnctor_<Name>__lay<k>    (sub final $base (struct base ++ that
 *                                       layout's flow-grown fields))
 * resid    $__fnctor_<Name>__resid     (struct: EVERY flow-grown field)
 * ```
 *
 * Layouts are SIBLINGS under the base, never a prefix chain (the chain was
 * evaluated in the issue and rejected: worse bytes, arm-order sensitivity).
 * `ref.test $__fnctor_<Name>` still matches every layout, so every existing
 * consumer of base fields is untouched. Ordinal 0 is always the FULL-UNION
 * layout — the safe default every unhinted or stale-hinted allocation takes,
 * so the fail direction is "fat, never narrow".
 *
 * ## Presence bits stay in the BASE at fixed indices (issue §6 constraint)
 * Every flow-grown union name keeps its packed presence bit in the base's
 * `$presence_<w>` words even though its VALUE slot lives in a layout or in the
 * resid tail. hasOwnProperty / `in` / enumeration / delete therefore stay
 * layout-INDEPENDENT: they read base words through {@link presenceByName} and
 * never consult a struct field list, which is exactly the name-list-source
 * rule §6 upgraded to a constraint after the getOwnPropertyNames builtin leak.
 *
 * ## Why dispatch is by STAMP, not by `ref.test` alone
 * WasmGC canonicalizes structurally identical types, and two sibling layouts
 * with the same field-kind vector (e.g. `{left,right}` vs `{object,property}`
 * — both base ++ 2×externref) are the SAME canonical type, so `ref.test`
 * cannot tell them apart and a bare test would read another field's slot —
 * the silent-wrong-answer class. Every layout therefore carries a hidden
 * immutable `$shape` i32 in the BASE (written once at `struct.new`), globally
 * unique per layout, CONTIGUOUS per family. Value arms test the stamp for
 * equality; family-level arms (resid, presence) test the RANGE — which also
 * defends against a whole-BASE canonical twin from another split fnctor of
 * identical shape (base twins ⇒ `ref.test $baseA` matches family-B instances;
 * globally-unique stamps do not).
 *
 * ## Allocation routing — the layout-hint global (issue §6 mechanism 3)
 * `startNode` is ONE function containing ONE `struct.new`, so per-label
 * layouts need the CALL SITE's identity at allocation time. A qualifying
 * (single-label, split-planned) factory call site emits
 * `i32.const <ordinal>; global.set $__fnctor_layout_hint_<Name>` before the
 * call; `__fnctor_<Name>_new` reads its family's hint, RESETS it to 0, and
 * branches to the matching layout's `struct.new`. Safe because the factory is
 * allocation-transparent (nothing between the set and the `struct.new` can
 * allocate the same fnctor), and every failure direction degrades to ordinal
 * 0 — the union layout: a nested labelled call consumes-and-resets the hint,
 * an exception leaves a stale hint that the next ctor consumes into a
 * wrong-but-resid-backed layout, an unhinted `new` reads 0. None of these can
 * produce a wrong VALUE, only a wider or resid-backed instance.
 *
 * ## The residual carrier
 * The analysis is a may-flow over-approximation: it can MISS a flow, and a
 * missed flow is a write to a field the instance's layout has no slot for.
 * `$resid` (lazily allocated via `__resid_ensure_<Struct>`, mirroring the
 * cold tail's `__cold_ensure`) carries EVERY flow-grown union field, so an
 * unproven write degrades to a tail allocation instead of a dropped property.
 * Like the cold tail, the resid struct is a PRIVATE payload, never a receiver:
 * it is hidden from `isSyntheticStructName`-guarded walks and from
 * `findAlternateStructsForField`, but its field kinds DO feed the Phase-3
 * narrowing vote (`finalizeStructAndDynamicMemberGet`) — hiding a carrier
 * from the ARMS is correct, hiding it from the VOTE is the #4217 `generator`
 * defect.
 */
import type { ts } from "../ts-api.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { FnctorLayoutPlan } from "./fnctor-alloc-labels.js";
import { type PresenceSlot, presenceSetInstrs, presenceTestInstrs, presenceWordName } from "./fnctor-presence-bits.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

/** Suffix + ordinal appended to the base struct name per emitted layout. */
const LAYOUT_STRUCT_INFIX = "__lay";
/** Suffix appended to the base struct name for the residual carrier. */
const RESID_STRUCT_SUFFIX = "__resid";
/** Field name of the residual-carrier slot on the base struct. */
const RESID_SLOT_FIELD = "$resid";
/**
 * Field name of the per-instance layout stamp on the base struct. Deliberately
 * the SAME name the #2009 anon-collision retro-stamp uses, so every
 * `fields.findIndex((f) => f.name === "$shape")` consumer resolves it — but
 * the stamp VALUES live in this module's own contiguous 1-based space, never
 * in `ctx.shapeNameCsvById` (layouts are hidden from the generic walks that
 * read that registry, and a base/anon canonical collision is impossible: the
 * base is a non-final hierarchy root, anon structs are final and super-less).
 */
const LAYOUT_STAMP_FIELD = "$shape";

/** Is `structName` one of this module's per-layout sibling structs? */
export function isFnctorLayoutStructName(structName: string): boolean {
  const at = structName.lastIndexOf(LAYOUT_STRUCT_INFIX);
  if (at < 0) return false;
  const tail = structName.slice(at + LAYOUT_STRUCT_INFIX.length);
  return tail.length > 0 && /^[0-9]+$/.test(tail);
}

/**
 * `JS2WASM_FNCTOR_LAYOUT_EMIT` — **default ON since 2026-08-08** (the #3927
 * default-ON flip; the flag shipped OFF on 2026-08-08 with PR #4230 and
 * flipped the same day once its three gates closed — the #4194 computed-write
 * routing, the flag-ON CI conformance pair (runs 31261617785 / 31262874434:
 * standalone net −3 of 48,619, every flip in the shard-timeout band, zero
 * semantic churn), and the struct-typed `in`/`hasOwnProperty` fold arm in
 * `closed-struct-presence.ts`).
 *
 * `0` / `off` / empty disable it (the cold-tail token convention); any other
 * value — including unset — is ON. Boolean-shaped on purpose: there is no
 * numeric knob, so a malformed value cannot half-enable anything, it merely
 * fails to disable. Setting it also implies the ANALYSIS flag
 * (`JS2WASM_FNCTOR_LAYOUTS`) — see the gate in `analyzeFnctorEscapeGate`.
 * The standalone-lane gate lives in {@link fnctorLayoutEmitFor}, not here.
 */
export function fnctorLayoutEmitEnabled(): boolean {
  const raw = process.env.JS2WASM_FNCTOR_LAYOUT_EMIT;
  if (raw === undefined) return true;
  const norm = raw.trim().toLowerCase();
  return norm !== "" && norm !== "0" && norm !== "off";
}

/**
 * The gate for THIS module: flag AND standalone. Explicit for the same reason
 * `coldTailHotFieldLimitFor` is — flow-grown fields only exist in the
 * standalone lane, but that is a property of another pass; a host build must
 * be byte-identical for every flag value by ITS OWN check, not by inheritance.
 */
export function fnctorLayoutEmitFor(ctx: CodegenContext): boolean {
  return ctx.standalone && fnctorLayoutEmitEnabled();
}

/** The split-verdict plan for `fnctorName`, or undefined when not splittable. */
export function fnctorLayoutPlanFor(ctx: CodegenContext, fnctorName: string): FnctorLayoutPlan | undefined {
  if (!fnctorLayoutEmitFor(ctx)) return undefined;
  const plan = ctx.fnctorEscapeGate?.allocLabels?.plans.get(fnctorName);
  return plan !== undefined && plan.verdict === "split" ? plan : undefined;
}

/** Reservation record — sub-pass-1 state, completed into {@link FnctorLayoutEmitInfo}. */
export interface FnctorLayoutReservation {
  readonly baseStructName: string;
  readonly baseTypeIdx: number;
  /** Ordinal-indexed; ordinal 0 is the full-union layout. */
  readonly layoutTypeIdxs: readonly number[];
  readonly residTypeIdx: number;
  readonly hintGlobalIdx: number;
  /** Layout ordinal k stamps as `stampLo + k`; contiguous per family (range guards). */
  readonly stampLo: number;
}

/** One emitted layout of a split family. */
export interface EmittedLayout {
  readonly structName: string;
  readonly typeIdx: number;
  readonly stamp: number;
  readonly ordinal: number;
  /** Flow-grown names this layout carries INLINE (subset of the union). */
  readonly fieldNames: ReadonlySet<string>;
}

/** Completed per-family emission info (populated at field derivation). */
export interface FnctorLayoutEmitInfo {
  readonly fnctorName: string;
  readonly baseStructName: string;
  readonly baseTypeIdx: number;
  readonly residStructName: string;
  readonly residTypeIdx: number;
  /** Index of `$resid` in the BASE field list. */
  readonly residSlotFieldIdx: number;
  /** Index of `$shape` in the BASE field list. */
  readonly shapeFieldIdx: number;
  readonly hintGlobalIdx: number;
  readonly stampLo: number;
  readonly stampCount: number;
  readonly layouts: readonly EmittedLayout[];
  /** Flow-grown union name → its packed presence slot in the BASE words. */
  readonly presenceByName: ReadonlyMap<string, PresenceSlot>;
  /** Flow-grown union names in resid-struct field order. */
  readonly residFieldNames: readonly string[];
}

/**
 * Reserve the family's type indices + hint global at the SAME deterministic
 * sub-pass that reserves the base struct (`reserveFnctorStructTypes` sub-pass
 * 1), for the same reason: the `$resid` field's `ref_null <residTypeIdx>` and
 * every arm's layout typeIdx are baked into shapes and bodies, so the indices
 * must be pass-invariant. Placeholder structs; fields are filled in
 * {@link applyFnctorLayoutSplit}. A reserved-but-never-split placeholder is
 * unreferenced and pruned by dead-elimination.
 */
export function reserveFnctorLayoutTypes(ctx: CodegenContext, fnctorName: string, baseTypeIdx: number): void {
  const plan = fnctorLayoutPlanFor(ctx, fnctorName);
  if (process.env.JS2WASM_FNCTOR_LAYOUT_DIAG === "1") {
    process.stderr.write(
      `[layout-emit] reserve ${fnctorName}: standalone=${String(ctx.standalone)} flag=${String(
        fnctorLayoutEmitEnabled(),
      )} plans=${String(ctx.fnctorEscapeGate?.allocLabels !== undefined)} verdict=${
        ctx.fnctorEscapeGate?.allocLabels?.plans.get(fnctorName)?.verdict ?? "-"
      }\n`,
    );
  }
  if (plan === undefined) return;
  const baseStructName = `__fnctor_${fnctorName}`;
  if (ctx.fnctorLayoutReserved?.has(fnctorName)) return;

  const layoutCount = plan.layouts.length + 1; // ordinal 0 = full union
  const layoutTypeIdxs: number[] = [];
  for (let ordinal = 0; ordinal < layoutCount; ordinal++) {
    const name = `${baseStructName}${LAYOUT_STRUCT_INFIX}${ordinal}`;
    const idx = ctx.mod.types.length;
    ctx.mod.types.push({ kind: "struct", name, fields: [] });
    ctx.structMap.set(name, idx);
    ctx.typeIdxToStructName.set(idx, name);
    layoutTypeIdxs.push(idx);
  }
  const residName = `${baseStructName}${RESID_STRUCT_SUFFIX}`;
  const residTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: residName, fields: [] });
  ctx.structMap.set(residName, residTypeIdx);
  ctx.typeIdxToStructName.set(residTypeIdx, residName);

  const hintGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: `__fnctor_layout_hint_${fnctorName}`,
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });

  // Stamps: globally unique, contiguous per family, 1-based so the base
  // type's default-initialized 0 (which no reachable path allocates) can
  // never satisfy a family range guard.
  const stampLo = ctx.fnctorLayoutNextStamp ?? 1;
  ctx.fnctorLayoutNextStamp = stampLo + layoutCount;

  (ctx.fnctorLayoutReserved ??= new Map()).set(fnctorName, {
    baseStructName,
    baseTypeIdx,
    layoutTypeIdxs,
    residTypeIdx,
    hintGlobalIdx,
    stampLo,
  });
}

/**
 * Split the derived base field list IN PLACE and fill the reserved family
 * types. Runs at the END of `deriveFnctorFields`, AFTER
 * `appendFnctorInternalFields` — the presence words are already sized for the
 * ctor-conditional fields PLUS every flow-grown name, and each flow-grown
 * FieldDef already carries its bit; removing the value slots afterwards keeps
 * those bits (and the word count) exactly as assigned, which is what pins
 * presence to the base at fixed indices.
 *
 * Eligibility for a MOVED field is the cold split's, verbatim: flow-grown,
 * `externref`, conditional-only, not `$`/`__`-prefixed, not accessor-backed.
 * Anything ineligible stays inline in the base and is untouched.
 */
export function applyFnctorLayoutSplit(
  ctx: CodegenContext,
  fnctorName: string,
  flowStructName: string,
  fields: FieldDef[],
  onlyConditional: Map<string, boolean>,
  flowGrownNames: ReadonlySet<string>,
): void {
  const diag = process.env.JS2WASM_FNCTOR_LAYOUT_DIAG === "1";
  const reservation = ctx.fnctorLayoutReserved?.get(fnctorName);
  const plan = fnctorLayoutPlanFor(ctx, fnctorName);
  if (reservation === undefined || plan === undefined) {
    if (diag && plan !== undefined) {
      process.stderr.write(`[layout-emit] ${fnctorName}: split-planned but NOT reserved — split skipped\n`);
    }
    return;
  }

  const eligible = new Set(
    fields
      .filter(
        (field) =>
          flowGrownNames.has(field.name) &&
          field.type.kind === "externref" &&
          onlyConditional.get(field.name) === true &&
          field.presenceTracked === true &&
          field.presenceBit !== undefined &&
          !field.name.startsWith("$") &&
          !field.name.startsWith("__") &&
          !ctx.classAccessorSet.has(`${flowStructName}_${field.name}`),
      )
      .map((field) => field.name),
  );
  if (eligible.size === 0) {
    if (diag) {
      process.stderr.write(
        `[layout-emit] ${fnctorName}: reserved but 0 eligible flow-grown fields (flow-grown: ${flowGrownNames.size}) — split skipped\n`,
      );
    }
    return;
  }

  // Move the eligible value slots out of the base (presence words stay).
  const movedDefs: FieldDef[] = [];
  for (let i = fields.length - 1; i >= 0; i--) {
    const field = fields[i]!;
    if (!eligible.has(field.name)) continue;
    movedDefs.unshift(field);
    fields.splice(i, 1);
  }

  // Base internals: the per-instance layout stamp and the residual slot.
  const shapeFieldIdx = fields.length;
  fields.push({ name: LAYOUT_STAMP_FIELD, type: { kind: "i32" }, mutable: false });
  const residSlotFieldIdx = fields.length;
  fields.push({ name: RESID_SLOT_FIELD, type: { kind: "ref_null", typeIdx: reservation.residTypeIdx }, mutable: true });

  // Presence side table: name → slot in the BASE words (fixed indices).
  const presenceByName = new Map<string, PresenceSlot>();
  for (const def of movedDefs) {
    const wordFieldIdx = fields.findIndex((f) => f.name === presenceWordName(def.presenceBit!));
    if (wordFieldIdx < 0) continue; // defensive; cannot happen (bit was assigned above)
    presenceByName.set(def.name, { wordFieldIdx, mask: (1 << (def.presenceBit! & 31)) | 0 });
  }

  // Fill the resid struct: every moved field, cloned WITHOUT presence flags
  // (presence lives in the base; a tracked flag here would make
  // `presenceSlotOf` hunt for words the resid does not have).
  const residFields: FieldDef[] = movedDefs.map((def) => ({ name: def.name, type: def.type, mutable: true }));
  const residType = ctx.mod.types[reservation.residTypeIdx];
  if (residType && residType.kind === "struct") residType.fields = residFields;
  ctx.structFields.set(`${reservation.baseStructName}${RESID_STRUCT_SUFFIX}`, residFields);

  // Fill the layout structs. Ordinal 0 = the full union; ordinals 1.. = the
  // plan's layouts intersected with the eligible set. Layout fields are
  // base-list PREFIX + clones of the moved defs (clones keep the presence
  // bit, whose word sits in the shared base prefix).
  const layouts: EmittedLayout[] = [];
  const layoutFieldSets: (readonly string[])[] = [movedDefs.map((d) => d.name)];
  for (const planLayout of plan.layouts) {
    layoutFieldSets.push(planLayout.fields.filter((name) => eligible.has(name)));
  }
  for (let ordinal = 0; ordinal < layoutFieldSets.length; ordinal++) {
    const typeIdx = reservation.layoutTypeIdxs[ordinal];
    if (typeIdx === undefined) break; // defensive: plan grew between passes
    const structName = `${reservation.baseStructName}${LAYOUT_STRUCT_INFIX}${ordinal}`;
    const own = new Set(layoutFieldSets[ordinal]!);
    const layoutFields: FieldDef[] = [
      ...fields,
      ...movedDefs.filter((def) => own.has(def.name)).map((def) => ({ ...def })),
    ];
    const layoutType = ctx.mod.types[typeIdx];
    if (layoutType && layoutType.kind === "struct") {
      layoutType.fields = layoutFields;
      layoutType.superTypeIdx = reservation.baseTypeIdx;
      layoutType.final = true;
    }
    ctx.structFields.set(structName, layoutFields);
    layouts.push({ structName, typeIdx, stamp: reservation.stampLo + ordinal, ordinal, fieldNames: own });
  }

  // The base becomes a non-final hierarchy root (the `$__vec_base` idiom).
  const baseType = ctx.mod.types[reservation.baseTypeIdx];
  if (baseType && baseType.kind === "struct") baseType.superTypeIdx = -1;

  const info: FnctorLayoutEmitInfo = {
    fnctorName,
    baseStructName: reservation.baseStructName,
    baseTypeIdx: reservation.baseTypeIdx,
    residStructName: `${reservation.baseStructName}${RESID_STRUCT_SUFFIX}`,
    residTypeIdx: reservation.residTypeIdx,
    residSlotFieldIdx,
    shapeFieldIdx,
    hintGlobalIdx: reservation.hintGlobalIdx,
    stampLo: reservation.stampLo,
    stampCount: layouts.length,
    layouts,
    presenceByName,
    residFieldNames: residFields.map((f) => f.name),
  };
  (ctx.fnctorLayoutInfo ??= new Map()).set(reservation.baseStructName, info);

  // Allocation-site hints: label site → the ordinal its layout was emitted
  // under. Only single-layout labels exist in the plan by construction.
  const hintBySite = (ctx.fnctorLayoutHintBySite ??= new Map());
  for (const label of plan.labels) {
    const layoutIdx = plan.layouts.findIndex((l) => l.labelIds.includes(label.id));
    if (layoutIdx < 0) continue;
    hintBySite.set(label.site, { hintGlobalIdx: reservation.hintGlobalIdx, ordinal: layoutIdx + 1 });
  }

  if (process.env.JS2WASM_FNCTOR_LAYOUT_DIAG === "1") {
    process.stderr.write(
      `[layout-emit] ${reservation.baseStructName}: ${layouts.length} layouts (stamps ${info.stampLo}..${
        info.stampLo + info.stampCount - 1
      }), ${movedDefs.length} union fields, base ${fields.length} fields, ${plan.labels.length} hinted labels\n`,
    );
    for (const l of layouts) {
      process.stderr.write(
        `[layout-emit]   ${l.structName} stamp=${l.stamp} (${[...l.fieldNames].sort().join(",")})\n`,
      );
    }
  }
}

/**
 * Emit the layout-hint `global.set` when `expr` is a recorded allocation
 * label site of a split family. Called at the TOP of the call / new
 * expression compilers — i.e. BEFORE the argument expressions. That is
 * deliberate: a labelled allocation nested in the arguments consumes and
 * resets the hint, so the outer allocation degrades to the union layout —
 * fat, never narrow — instead of inheriting a wrong hint. Net stack effect
 * is zero, so this is safe even on compiler paths that end up lowering the
 * expression to something other than a plain call.
 */
export function maybeEmitLayoutHint(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): void {
  const hint = ctx.fnctorLayoutHintBySite?.get(expr);
  if (hint === undefined) return;
  fctx.body.push({ op: "i32.const", value: hint.ordinal });
  fctx.body.push({ op: "global.set", index: hint.hintGlobalIdx });
}

/**
 * Ctor-prologue allocation: read this family's hint, reset it to 0, and
 * `struct.new` the matching layout. Replaces the single
 * `emitFnctorFieldInitializers + struct.new` pair in
 * `compileNewFunctionDeclaration`; leaves a `(ref $base)` on the stack.
 *
 * Every arm's initializer vector is the base default set with two
 * substitutions — `$constructor` ← the identity param, `$shape` ← that
 * layout's stamp — plus `ref.null.extern` for the layout's own flow-grown
 * slots. Pure constants and `local.get`s: no calls, so no late-import hazard
 * in the detached arm arrays.
 */
export function emitLayoutSelectingStructNew(
  ctx: CodegenContext,
  ctorFctx: FunctionContext,
  info: FnctorLayoutEmitInfo,
  constructorIdentityParamIdx: number,
): void {
  const defaultsFor = (structName: string, stamp: number): Instr[] => {
    const out: Instr[] = [];
    for (const field of ctx.structFields.get(structName) ?? []) {
      if (ctx.standalone && field.name === "$constructor") {
        out.push({ op: "local.get", index: constructorIdentityParamIdx });
      } else if (field.name === LAYOUT_STAMP_FIELD) {
        out.push({ op: "i32.const", value: stamp });
      } else if (field.type.kind === "f64") {
        out.push({ op: "f64.const", value: 0 });
      } else if (field.type.kind === "i32") {
        out.push({ op: "i32.const", value: 0 });
      } else if (field.type.kind === "i64") {
        out.push({ op: "i64.const", value: 0n });
      } else if (field.type.kind === "externref") {
        out.push({ op: "ref.null.extern" });
      } else if (field.type.kind === "ref_null" || field.type.kind === "ref") {
        out.push({ op: "ref.null", typeIdx: field.type.typeIdx });
      } else {
        out.push({ op: "i32.const", value: 0 });
      }
    }
    return out;
  };
  const armFor = (ordinal: number): Instr[] => {
    const layout = info.layouts[ordinal]!;
    return [...defaultsFor(layout.structName, layout.stamp), { op: "struct.new", typeIdx: layout.typeIdx }];
  };

  const hintLocal = allocLocal(ctorFctx, "__layout_hint", { kind: "i32" });
  ctorFctx.body.push({ op: "global.get", index: info.hintGlobalIdx });
  ctorFctx.body.push({ op: "local.set", index: hintLocal });
  ctorFctx.body.push({ op: "i32.const", value: 0 });
  ctorFctx.body.push({ op: "global.set", index: info.hintGlobalIdx });

  const resultType: ValType = { kind: "ref", typeIdx: info.baseTypeIdx };
  let chain: Instr[] = armFor(0);
  for (let ordinal = info.layouts.length - 1; ordinal >= 1; ordinal--) {
    chain = [
      { op: "local.get", index: hintLocal },
      { op: "i32.const", value: ordinal },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "val", type: resultType }, then: armFor(ordinal), else: chain },
    ];
  }
  ctorFctx.body.push(...chain);
}

/** One layout's inline location of a flow-grown field. */
export interface LayoutFieldLocation {
  readonly baseTypeIdx: number;
  readonly layoutTypeIdx: number;
  readonly fieldIdx: number;
  readonly fieldType: ValType;
  readonly mutable: boolean;
  /** `$shape` index in the layout's (== base's) field list. */
  readonly shapeFieldIdx: number;
  readonly stamp: number;
  /** Presence slot in the base words, resolved through the layout list. */
  readonly presenceSlot?: PresenceSlot;
}

/** One family's residual-carrier location of a flow-grown field. */
export interface ResidFieldLocation {
  readonly baseTypeIdx: number;
  readonly residSlotFieldIdx: number;
  readonly residTypeIdx: number;
  readonly residFieldIdx: number;
  readonly fieldType: ValType;
  readonly shapeFieldIdx: number;
  /** Family stamp range: `$shape - lo (u<) count` admits exactly this family. */
  readonly stampLo: number;
  readonly stampCount: number;
  readonly presenceSlot?: PresenceSlot;
  readonly baseStructName: string;
}

/**
 * Every layout carrying `propName` INLINE, across all split families. Arms
 * built from these come after the ordinary struct candidates and BEFORE the
 * resid arms (the resid arm's `ref.test $base` matches every family member,
 * so it must be the family's terminal).
 */
export function findFnctorLayoutStructsForField(ctx: CodegenContext, propName: string): LayoutFieldLocation[] {
  const out: LayoutFieldLocation[] = [];
  for (const info of ctx.fnctorLayoutInfo?.values() ?? []) {
    for (const layout of info.layouts) {
      if (!layout.fieldNames.has(propName)) continue;
      const layoutFields = ctx.structFields.get(layout.structName);
      if (!layoutFields) continue;
      const fieldIdx = layoutFields.findIndex((f) => f.name === propName);
      if (fieldIdx < 0) continue;
      const presenceSlot = info.presenceByName.get(propName);
      out.push({
        baseTypeIdx: info.baseTypeIdx,
        layoutTypeIdx: layout.typeIdx,
        fieldIdx,
        fieldType: layoutFields[fieldIdx]!.type,
        mutable: layoutFields[fieldIdx]!.mutable,
        shapeFieldIdx: info.shapeFieldIdx,
        stamp: layout.stamp,
        ...(presenceSlot ? { presenceSlot } : {}),
      });
    }
  }
  return out;
}

/** Every family whose flow-grown union contains `propName` — the resid arms. */
export function findFnctorResidStructsForField(ctx: CodegenContext, propName: string): ResidFieldLocation[] {
  const out: ResidFieldLocation[] = [];
  for (const info of ctx.fnctorLayoutInfo?.values() ?? []) {
    const residFieldIdx = info.residFieldNames.indexOf(propName);
    if (residFieldIdx < 0) continue;
    const residFields = ctx.structFields.get(info.residStructName);
    const fieldType = residFields?.[residFieldIdx]?.type ?? { kind: "externref" };
    const presenceSlot = info.presenceByName.get(propName);
    out.push({
      baseTypeIdx: info.baseTypeIdx,
      residSlotFieldIdx: info.residSlotFieldIdx,
      residTypeIdx: info.residTypeIdx,
      residFieldIdx,
      fieldType,
      shapeFieldIdx: info.shapeFieldIdx,
      stampLo: info.stampLo,
      stampCount: info.stampCount,
      ...(presenceSlot ? { presenceSlot } : {}),
      baseStructName: info.baseStructName,
    });
  }
  return out;
}

/**
 * `i32` on the stack: 1 when the receiver's `$shape` stamp is inside the
 * family range. `recv` must be a repeatable producer of the receiver as
 * `anyref`. The unsigned-compare trick makes it two instructions:
 * `(stamp - lo) u< count`.
 */
export function stampRangeTestInstrs(
  baseTypeIdx: number,
  shapeFieldIdx: number,
  stampLo: number,
  stampCount: number,
  recv: readonly Instr[],
): Instr[] {
  return [
    ...recv,
    { op: "ref.cast", typeIdx: baseTypeIdx },
    { op: "struct.get", typeIdx: baseTypeIdx, fieldIdx: shapeFieldIdx },
    { op: "i32.const", value: stampLo },
    { op: "i32.sub" },
    { op: "i32.const", value: stampCount },
    { op: "i32.lt_u" },
  ];
}

/**
 * `i32` on the stack: 1 iff the receiver (in `srcAnyLocal`, anyref) is this
 * layout AND carries this layout's stamp. The stamp equality is what makes
 * the test sound under WasmGC's structural canonicalization: two sibling
 * layouts with the same field-kind vector share ONE canonical type, so the
 * `ref.test` alone matches both.
 *
 * Emitted as a single combined i32 so a dispatcher arm embeds its `next`
 * chain exactly ONCE (`if matched then <body> else <next>`) — embedding the
 * same Instr tree twice is the #1302 double-remap hazard.
 */
export function layoutMatchTestInstrs(loc: LayoutFieldLocation, srcAnyLocal: number): Instr[] {
  return [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.test", typeIdx: loc.layoutTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: srcAnyLocal },
        { op: "ref.cast", typeIdx: loc.layoutTypeIdx },
        { op: "struct.get", typeIdx: loc.layoutTypeIdx, fieldIdx: loc.shapeFieldIdx },
        { op: "i32.const", value: loc.stamp },
        { op: "i32.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * `i32` on the stack: 1 iff the receiver is a member of this FAMILY (base
 * test + stamp-range check). The range check is the cross-family twin guard:
 * `ref.test $base` also matches instances of another split fnctor whose base
 * canonicalizes to the same type, and their stamps are globally unique.
 */
export function residMatchTestInstrs(loc: ResidFieldLocation, srcAnyLocal: number): Instr[] {
  return [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.test", typeIdx: loc.baseTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: stampRangeTestInstrs(loc.baseTypeIdx, loc.shapeFieldIdx, loc.stampLo, loc.stampCount, [
        { op: "local.get", index: srcAnyLocal },
      ]),
      else: [{ op: "i32.const", value: 0 }],
    },
  ];
}

/**
 * READ body for one inline layout location (for the `then` of a
 * `layoutMatchTestInstrs`-guarded arm): presence-check against the BASE words
 * (resolved through the layout list — the words sit in the shared prefix),
 * then read + coerce. `absent` may be embedded twice; callers pass
 * remap-inert instructions (global.get / ref.null / const), matching the
 * cold-tail idiom.
 */
export function layoutFieldReadInstrs(
  loc: LayoutFieldLocation,
  srcAnyLocal: number,
  resultType: ValType,
  absent: Instr[],
  coerce: Instr[],
): Instr[] {
  const readValue: Instr[] = [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.cast", typeIdx: loc.layoutTypeIdx },
    { op: "struct.get", typeIdx: loc.layoutTypeIdx, fieldIdx: loc.fieldIdx },
    ...coerce,
  ];
  if (loc.presenceSlot === undefined) return readValue;
  return [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.cast", typeIdx: loc.layoutTypeIdx },
    ...presenceTestInstrs(loc.layoutTypeIdx, loc.presenceSlot),
    { op: "if", blockType: { kind: "val", type: resultType }, then: readValue, else: absent },
  ];
}

/**
 * READ body for one resid location (for the `then` of a
 * `residMatchTestInstrs`-guarded arm): presence-check (base words), then hop
 * through `$resid`. A presence bit set with a null resid and no inline slot
 * cannot happen through this module's writers, but the null test keeps even
 * that corruption at `absent` rather than a trap.
 */
export function residFieldReadInstrs(
  loc: ResidFieldLocation,
  srcAnyLocal: number,
  scratchAnyLocal: number,
  resultType: ValType,
  absent: Instr[],
  coerce: Instr[],
): Instr[] {
  const readValue: Instr[] = [
    { op: "local.get", index: scratchAnyLocal },
    { op: "ref.cast", typeIdx: loc.residTypeIdx },
    { op: "struct.get", typeIdx: loc.residTypeIdx, fieldIdx: loc.residFieldIdx },
    ...coerce,
  ];
  const loadResid: Instr[] = [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.cast", typeIdx: loc.baseTypeIdx },
    { op: "struct.get", typeIdx: loc.baseTypeIdx, fieldIdx: loc.residSlotFieldIdx },
    { op: "local.set", index: scratchAnyLocal },
    { op: "local.get", index: scratchAnyLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "val", type: resultType }, then: absent, else: readValue },
  ];
  if (loc.presenceSlot === undefined) return loadResid;
  return [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.cast", typeIdx: loc.baseTypeIdx },
    ...presenceTestInstrs(loc.baseTypeIdx, loc.presenceSlot),
    { op: "if", blockType: { kind: "val", type: resultType }, then: loadResid, else: [...absent] },
  ];
}

/**
 * WRITE body for one inline layout location (value in `valLocal` as
 * externref; for the `then` of a `layoutMatchTestInstrs`-guarded arm). Sets
 * the value slot, then the BASE presence bit (through the layout cast — the
 * word sits in the shared prefix).
 */
export function layoutFieldWriteInstrs(
  loc: LayoutFieldLocation,
  srcAnyLocal: number,
  valLocal: number,
  coerce: Instr[],
): Instr[] {
  const out: Instr[] = [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.cast", typeIdx: loc.layoutTypeIdx },
    { op: "local.get", index: valLocal },
    ...coerce,
    { op: "struct.set", typeIdx: loc.layoutTypeIdx, fieldIdx: loc.fieldIdx },
  ];
  if (loc.presenceSlot !== undefined) {
    out.push(
      ...presenceSetInstrs(loc.layoutTypeIdx, loc.presenceSlot, [
        { op: "local.get", index: srcAnyLocal },
        { op: "ref.cast", typeIdx: loc.layoutTypeIdx },
      ]),
    );
  }
  return out;
}

/**
 * WRITE body for one resid location (for the `then` of a
 * `residMatchTestInstrs`-guarded arm): lazy-allocate the resid via
 * `__resid_ensure_<Struct>`, store, set the BASE presence bit.
 */
export function residFieldWriteInstrs(
  loc: ResidFieldLocation,
  srcAnyLocal: number,
  valLocal: number,
  scratchAnyLocal: number,
  ensureFuncIdx: number,
  coerce: Instr[],
): Instr[] {
  const out: Instr[] = [
    { op: "local.get", index: srcAnyLocal },
    { op: "ref.cast", typeIdx: loc.baseTypeIdx },
    { op: "call", funcIdx: ensureFuncIdx },
    { op: "local.set", index: scratchAnyLocal },
    { op: "local.get", index: scratchAnyLocal },
    { op: "ref.cast", typeIdx: loc.residTypeIdx },
    { op: "local.get", index: valLocal },
    ...coerce,
    { op: "struct.set", typeIdx: loc.residTypeIdx, fieldIdx: loc.residFieldIdx },
  ];
  if (loc.presenceSlot !== undefined) {
    out.push(
      ...presenceSetInstrs(loc.baseTypeIdx, loc.presenceSlot, [
        { op: "local.get", index: srcAnyLocal },
        { op: "ref.cast", typeIdx: loc.baseTypeIdx },
      ]),
    );
  }
  return out;
}

/**
 * The resid field's VALUE on the stack, LOCAL-FREE (the object-runtime arm
 * builders own no scratch locals — same tradeoff as `coldFieldValueInstrs`:
 * the resid slot is loaded twice, and a resid field is by definition not on
 * the hot path). `recv` must be a repeatable producer of the receiver as
 * `anyref`. Presence is NOT checked here — the object-runtime passes check
 * the base presence bit through their own entry machinery first.
 */
export function residFieldValueInstrs(
  loc: ResidFieldLocation,
  recv: readonly Instr[],
  resultType: ValType,
  absent: readonly Instr[],
  coerce: readonly Instr[],
): Instr[] {
  const loadSlot: Instr[] = [
    ...recv,
    { op: "ref.cast", typeIdx: loc.baseTypeIdx },
    { op: "struct.get", typeIdx: loc.baseTypeIdx, fieldIdx: loc.residSlotFieldIdx },
  ];
  return [
    ...loadSlot,
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [...absent],
      else: [
        ...loadSlot,
        { op: "ref.cast", typeIdx: loc.residTypeIdx },
        { op: "struct.get", typeIdx: loc.residTypeIdx, fieldIdx: loc.residFieldIdx },
        ...coerce,
      ],
    },
  ];
}

/** `__resid_ensure_<Struct>(base) -> (ref $resid)` allocator name. */
export function residEnsureAllocatorName(baseStructName: string): string {
  return `__resid_ensure_${baseStructName}`;
}

/**
 * FINALIZE sub-pass — mint one `__resid_ensure_<Struct>` per split family,
 * alongside `reserveColdTailAllocators` (same discipline: BEFORE the `fill*`
 * dispatcher passes, so those fills stay funcMap-read-only). A never-called
 * allocator is pruned by dead-elimination.
 */
export function reserveFnctorResidAllocators(ctx: CodegenContext): void {
  for (const info of ctx.fnctorLayoutInfo?.values() ?? []) {
    const name = residEnsureAllocatorName(info.baseStructName);
    if (ctx.funcMap.has(name)) continue;
    const residFields = ctx.structFields.get(info.residStructName) ?? [];

    const TAIL = 1; // param 0 = the base receiver, local 1 = the resid tail
    const defaults: Instr[] = residFields.map((field) =>
      field.type.kind === "i32" ? { op: "i32.const", value: 0 } : { op: "ref.null.extern" },
    );
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: info.baseTypeIdx, fieldIdx: info.residSlotFieldIdx },
      { op: "local.set", index: TAIL },
      { op: "local.get", index: TAIL },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...defaults,
          { op: "struct.new", typeIdx: info.residTypeIdx },
          { op: "local.set", index: TAIL },
          { op: "local.get", index: 0 },
          { op: "local.get", index: TAIL },
          { op: "struct.set", typeIdx: info.baseTypeIdx, fieldIdx: info.residSlotFieldIdx },
        ],
      },
      { op: "local.get", index: TAIL },
      { op: "ref.as_non_null" },
    ];
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "ref", typeIdx: info.baseTypeIdx }],
      [{ kind: "ref", typeIdx: info.residTypeIdx }],
      `${name}_type`,
    );
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [{ name: "__resid", type: { kind: "ref_null", typeIdx: info.residTypeIdx } }],
      body,
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
  }
}

/**
 * The flow-grown union names of a split BASE struct with their base-word
 * presence slots — the entries the presence-only reflective passes (hasOwn /
 * `in` / enumeration) append. These arms are layout-INDEPENDENT by
 * construction: presence lives in the base at fixed indices, so where the
 * VALUE ended up (inline or resid) never enters the answer.
 */
export function fnctorLayoutOwnFieldsFor(
  ctx: CodegenContext,
  baseStructName: string,
): { name: string; presenceSlot: PresenceSlot }[] {
  const info = ctx.fnctorLayoutInfo?.get(baseStructName);
  if (info === undefined) return [];
  const out: { name: string; presenceSlot: PresenceSlot }[] = [];
  for (const name of info.residFieldNames) {
    const presenceSlot = info.presenceByName.get(name);
    if (presenceSlot !== undefined) out.push({ name, presenceSlot });
  }
  return out;
}

/** Family stamp-range guard data for a split BASE struct's reflective arms. */
export function fnctorLayoutShapeRangeFor(
  ctx: CodegenContext,
  baseStructName: string,
): { shapeFieldIdx: number; stampLo: number; stampCount: number } | undefined {
  const info = ctx.fnctorLayoutInfo?.get(baseStructName);
  if (info === undefined) return undefined;
  return { shapeFieldIdx: info.shapeFieldIdx, stampLo: info.stampLo, stampCount: info.stampCount };
}
