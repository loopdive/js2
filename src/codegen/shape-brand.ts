// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2853) Shape branding — make structurally-colliding named object shapes
 * NOMINALLY distinct WasmGC types.
 *
 * ## The defect this fixes (bug A of #2853, root of the acorn `1 / 2` throw)
 *
 * WasmGC type identity is ISO-RECURSIVE and STRUCTURAL: the engine
 * canonicalizes two struct types with identical field layouts to the SAME
 * runtime type — field *names* exist only in WAT text, not in the binary. So
 * `__anon_0 (struct (field $startsExpr (mut i32)))` and
 * `__fnctor_TT (struct (field $beforeExpr (mut i32)))` are THE SAME TYPE at
 * runtime, and every `ref.test`-keyed property dispatch (the `__sget_<key>`
 * getter family, the inline member-get dispatch chains) matches the WRONG
 * shape and reads whatever field sits at the same OFFSET:
 *
 *   ({ startsExpr: true }).beforeExpr   →  true   (must be undefined)
 *
 * In acorn, `num.beforeExpr` (absent key; `num = new TokenType("num",
 * {startsExpr:true})`) therefore read `startsExpr`'s `true`, the tokenizer
 * believed a regex may start after a number token, and `1 / 2` was scanned as
 * a regex literal → validator trap.
 *
 * ## The fix — a trailing brand field forming a backward chain
 *
 * For every *dispatch-participating named shape* (`__anon_*` object-literal
 * shapes and `__fnctor_*` this-shapes) whose shallow layout collides with any
 * other struct type in the module, append ONE trailing immutable
 * `(ref null $target)` brand field, where `$target` is:
 *
 *   - the previously-branded shape (backward chain), or
 *   - `$__vec_base` for the first branded shape (the anchor).
 *
 * Distinctness proof: suppose branded B_i ≅ B_j (i < j). Canonical equality
 * of the brand fields forces target(B_i) ≅ target(B_j), i.e. B_{i-1} ≅
 * B_{j-1}; inducting down, __vec_base ≅ B_{j-i-1} — impossible, because
 * __vec_base is an OPEN (`sub`, non-final) struct and every branded shape is
 * a bare (final) struct, and openness/finality is part of canonical identity.
 * Hence all branded shapes are pairwise distinct, and each is distinct from
 * every unbranded struct with the original field count. `ref.test` dispatch
 * becomes exact.
 *
 * ## Why this design (vs. alternatives)
 *
 * - Per-shape rec-group brand types would need mid-table type insertion →
 *   a full type-index remap pass (the #2043 index-shift hazard class).
 *   The trailing field adds NO type table entries and NO index shifts.
 * - One whole-module rec group would nominalize the string/vec runtime
 *   boundary types, breaking the #2527 cross-module canonicalization ABI
 *   (`src/emit/canonical-recgroup.ts`), and would nominalize func types
 *   (call_ref / call_indirect hazards).
 * - The brand field is TRAILING, so every existing `struct.get`/`struct.set`
 *   field index stays valid, and the `struct.new` patch is purely local:
 *   insert `ref.null $target` immediately before the `struct.new` (the last
 *   operand is on top of the stack). `struct.new_default` needs no patch —
 *   a nullable ref is defaultable.
 *
 * ## Byte-inert where intended
 *
 * Shapes that collide with nothing are untouched, so modules without
 * heterogeneous same-layout shapes emit byte-identical binaries. The
 * collision key is a sound OVER-approximation of canonical equality
 * (ref targets ignored, compiler-only i32:boolean / i64:bigint brands
 * ignored — the binary erases them): canonical equality implies key
 * equality, so no real collision is missed; a few extra shapes may get
 * harmless brands.
 *
 * ## Scope / residual risk (documented, deliberate)
 *
 * - USER CLASS structs are NOT branded: subtyping requires the parent's
 *   fields to be a prefix of the child's, and appending a brand to a parent
 *   would break every child layout. Two sibling classes with identical
 *   layouts can still alias (pre-existing; the #2188 `userClassId` field is
 *   the same disease fixed by hand for Error subclasses).
 * - The pass runs BEFORE dead-type elimination, so the brand-chain refs are
 *   remapped (and kept alive) by the existing DCE machinery.
 */
import type { FieldDef, Instr, StructTypeDef, WasmModule } from "../ir/types.js";
import { walkChildren } from "./walk-instructions.js";

/** Field name of the appended brand ref. `$`-prefixed on purpose: the
 *  `__sget_*` getter emission skips `$`-prefixed field names, and the field is
 *  appended to a CLONED fields array so `ctx.structFields` (the dispatch
 *  metadata) never sees it. */
export const SHAPE_BRAND_FIELD = "$shapeBrand";

/** True for struct type names that participate in keyed dynamic-property
 *  dispatch AND are safe to brand (bare structs, no subtype relationships). */
function isBrandableShapeName(name: string | undefined): boolean {
  return !!name && (name.startsWith("__anon_") || name.startsWith("__fnctor_"));
}

/**
 * Shallow structural key — a sound over-approximation of WasmGC canonical
 * equality for struct types: if two struct types are canonically equal, their
 * keys are equal. Ref targets are deliberately ignored (over-approximates),
 * and compiler-only ValType brands (i32:boolean, i64:bigint, …) are ignored
 * because the emitted binary erases them.
 */
function shallowStructKey(t: StructTypeDef): string {
  const sup = t.superTypeIdx === undefined ? "bare" : t.superTypeIdx < 0 ? "open" : "sub";
  const fin = t.final ? "!" : "";
  const fields = t.fields.map((f: FieldDef) => `${f.mutable ? "m" : ""}${f.type.kind}`).join(",");
  return `${sup}${fin}(${fields})`;
}

/**
 * Brand structurally-colliding `__anon_*` / `__fnctor_*` shape types with a
 * trailing `(ref null <chain>)` field and patch every `struct.new` of a
 * branded type to supply the extra `ref.null` operand.
 *
 * Must run AFTER all instruction emission and BEFORE dead-type elimination
 * (`eliminateDeadImports`) so the chain refs get remapped/kept-alive by DCE.
 */
/**
 * (#2853 park fix) Record that two struct types are same-layout sibling shapes
 * for which a *trapping* guarded downcast was emitted (e.g. a `var` reassigned
 * across different-key object literals lowered `ref.test T … ref.null T ;
 * ref.as_non_null` between them). Both are added to `noBrand` so
 * `brandCollidingShapeTypes` skips them: branding would separate two
 * previously-canonically-equal runtime types, and the already-baked narrowing
 * cast would then fail the `ref.test` and trap on `ref.as_non_null`.
 *
 * SOUNDNESS: excluding a shape from branding reverts it to EXACT pre-brand
 * (baseline) behaviour, so this can never introduce a NEW test262 regression —
 * it only forgoes the nominal-distinctness fix for the specific sibling pair
 * that a downcast already treats as interchangeable (which the downcast proves
 * the source never relies on distinguishing). Acorn's colliding shapes are read
 * through keyed `__sget_*`/inline dispatch, NOT through sibling downcasts, so
 * they are NOT registered here and stay branded (Bug A fix preserved).
 */
export function markNoBrandSiblingShapes(
  types: readonly StructTypeDef[] | ReadonlyArray<{ kind: string; name?: string }>,
  noBrand: Set<number>,
  fromIdx: number,
  toIdx: number,
): void {
  if (fromIdx === toIdx) return;
  const a = types[fromIdx] as StructTypeDef | undefined;
  const b = types[toIdx] as StructTypeDef | undefined;
  if (!a || !b || a.kind !== "struct" || b.kind !== "struct") return;
  if (!isBrandableShapeName(a.name) || !isBrandableShapeName(b.name)) return;
  if (a.superTypeIdx !== undefined || b.superTypeIdx !== undefined) return;
  // Only same shallow layout collides under canonicalization; a genuinely
  // different-layout downcast (narrowing) is handled soundly elsewhere and its
  // types may still be branded.
  if (shallowStructKey(a) !== shallowStructKey(b)) return;
  noBrand.add(fromIdx);
  noBrand.add(toIdx);
}

export function brandCollidingShapeTypes(mod: WasmModule, noBrand?: ReadonlySet<number>): readonly number[] {
  const types = mod.types;

  // ── 1. Collision universe: shallow keys of every struct type ──
  const keyCount = new Map<string, number>();
  const structKeys: (string | undefined)[] = new Array(types.length);
  const isSuper = new Set<number>();
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if (t.kind === "struct") {
      const k = shallowStructKey(t);
      structKeys[i] = k;
      keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
      if (t.superTypeIdx !== undefined && t.superTypeIdx >= 0) isSuper.add(t.superTypeIdx);
    } else if (t.kind === "sub") {
      if (t.superType !== null && t.superType >= 0) isSuper.add(t.superType);
    }
    // "rec" wrappers are not produced by codegen (flat table); skip defensively.
  }

  // ── 2. Chain anchor: $__vec_base (open `sub` struct — canonically distinct
  //       from every bare shape struct). Pre-registered in every context
  //       (#2083), so it exists at a LOW index; bail out defensively if not. ──
  let anchorIdx = -1;
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if (t.kind === "struct" && t.name === "__vec_base") {
      anchorIdx = i;
      break;
    }
  }
  if (anchorIdx < 0) return [];

  // ── 3. Brand each colliding brandable shape (ascending index order keeps
  //       every chain ref BACKWARD → no new rec groups, no forward refs). ──
  const brandTarget = new Map<number, number>(); // branded typeIdx → chain target
  let prev = anchorIdx;
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if (t.kind !== "struct") continue;
    if (!isBrandableShapeName(t.name)) continue;
    if (t.superTypeIdx !== undefined) continue; // only bare structs
    if (isSuper.has(i)) continue; // never widen a supertype's field prefix
    if (i <= anchorIdx) continue; // chain refs must point backward
    if (noBrand?.has(i)) continue; // (#2853 park fix) a trapping sibling downcast targets this shape
    const key = structKeys[i]!;
    if ((keyCount.get(key) ?? 0) < 2) continue; // collides with nothing → byte-inert
    // Clone the fields array: ctx.structFields shares the original array and
    // must keep enumerating ONLY the real (dispatchable) fields.
    t.fields = [...t.fields, { name: SHAPE_BRAND_FIELD, type: { kind: "ref_null", typeIdx: prev }, mutable: false }];
    brandTarget.set(i, prev);
    prev = i;
  }
  if (brandTarget.size === 0) return [];

  // ── 4. Patch every `struct.new` of a branded type: the brand is the LAST
  //       field, so `ref.null <target>` goes immediately before the
  //       `struct.new`. Iterative walk (deep block nesting safe). ──
  const patch = (roots: Instr[]): void => {
    const stack: Instr[][] = [roots];
    while (stack.length > 0) {
      const arr = stack.pop()!;
      for (let i = 0; i < arr.length; i++) {
        const ins = arr[i]! as Instr & { op: string; typeIdx?: number };
        walkChildren(ins, (children) => stack.push(children));
        if (ins.op === "struct.new" && ins.typeIdx !== undefined) {
          const tgt = brandTarget.get(ins.typeIdx);
          if (tgt !== undefined) {
            arr.splice(i, 0, { op: "ref.null", typeIdx: tgt });
            i++; // skip past the struct.new we just patched
          }
        }
      }
    }
  };

  for (const fn of mod.functions) {
    if (fn.body && fn.body.length > 0) patch(fn.body);
  }
  for (const g of mod.globals) {
    if (g.init && g.init.length > 0) patch(g.init);
  }
  return [...brandTarget.keys()];
}
