// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Dead import and type elimination pass.
 *
 * After codegen, the WasmModule may contain unused function imports and
 * type definitions that were speculatively registered (e.g. all wasm:js-string
 * ops are added when any string literal is present, even if only concat is used).
 *
 * This pass scans all function bodies, globals, exports, elements, and tags
 * to determine which function indices and type indices are actually referenced,
 * then removes the dead ones and remaps all surviving indices.
 */
import type { ArrayTypeDef, Instr, StructTypeDef, SubTypeDef, TypeDef, ValType, WasmModule } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { walkInstructionDag } from "./walk-instructions.js";

// --- Reference collection ---

function collectRefsFromBody(
  body: Instr[],
  usedFuncs: Set<number>,
  usedTypes: Set<number>,
  visited = new WeakSet<Instr[]>(),
): void {
  if (visited.has(body)) return;
  visited.add(body);
  for (const instr of body) {
    switch (instr.op) {
      case "call":
        usedFuncs.add(instr.funcIdx);
        break;
      case "ref.func":
        usedFuncs.add(instr.funcIdx);
        break;
      case "call_indirect":
        usedTypes.add(instr.typeIdx);
        break;
      case "call_ref":
        usedTypes.add(instr.typeIdx);
        break;
      case "struct.new":
      case "struct.get":
      case "struct.set":
        usedTypes.add(instr.typeIdx);
        break;
      case "array.new":
      case "array.new_fixed":
      case "array.new_default":
      case "array.get":
      case "array.get_s":
      case "array.get_u":
      case "array.set":
      case "array.fill":
        usedTypes.add(instr.typeIdx);
        break;
      case "array.copy":
        usedTypes.add(instr.dstTypeIdx);
        usedTypes.add(instr.srcTypeIdx);
        break;
      case "ref.null":
        if (typeof instr.typeIdx === "number") {
          usedTypes.add(instr.typeIdx);
        }
        break;
      case "ref.cast":
      case "ref.cast_null":
      case "ref.test":
        usedTypes.add(instr.typeIdx);
        break;
      case "block":
      case "loop":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.body, usedFuncs, usedTypes, visited);
        break;
      case "if":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.then, usedFuncs, usedTypes, visited);
        if (instr.else) collectRefsFromBody(instr.else, usedFuncs, usedTypes, visited);
        break;
      case "try":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.body, usedFuncs, usedTypes, visited);
        for (const c of instr.catches) collectRefsFromBody(c.body, usedFuncs, usedTypes, visited);
        if (instr.catchAll) collectRefsFromBody(instr.catchAll, usedFuncs, usedTypes, visited);
        break;
      case "try_table":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.body, usedFuncs, usedTypes, visited);
        break;
      default: {
        // Catch-all for instructions whose op carries type/func indices we may
        // not have enumerated above (defensive: keeps DCE conservative).
        const a = instr as any;
        if (typeof a.typeIdx === "number") usedTypes.add(a.typeIdx);
        if (typeof a.funcIdx === "number") usedFuncs.add(a.funcIdx);
        if (typeof a.dstTypeIdx === "number") usedTypes.add(a.dstTypeIdx);
        if (typeof a.srcTypeIdx === "number") usedTypes.add(a.srcTypeIdx);
        // Handle blockType on custom instructions
        if (a.blockType) collectBlockTypeRefs(a.blockType, usedTypes);
        break;
      }
    }
  }
}

function collectBlockTypeRefs(bt: { kind: string; typeIdx?: number; type?: ValType }, usedTypes: Set<number>): void {
  if (bt.kind === "type" && typeof bt.typeIdx === "number") {
    usedTypes.add(bt.typeIdx);
  }
  if (bt.kind === "val" && bt.type) {
    collectRefsFromValType(bt.type, usedTypes);
  }
}

function collectRefsFromValType(vt: ValType, used: Set<number>): void {
  if ((vt.kind === "ref" || vt.kind === "ref_null") && typeof (vt as any).typeIdx === "number") {
    used.add((vt as { typeIdx: number }).typeIdx);
  }
}

function collectRefsFromTypeDef(td: TypeDef, used: Set<number>): void {
  switch (td.kind) {
    case "func":
      for (const p of td.params) collectRefsFromValType(p, used);
      for (const r of td.results) collectRefsFromValType(r, used);
      break;
    case "struct":
      if (td.superTypeIdx !== undefined) used.add(td.superTypeIdx);
      for (const f of td.fields) collectRefsFromValType(f.type, used);
      break;
    case "array":
      collectRefsFromValType(td.element, used);
      break;
    case "rec":
      for (const inner of td.types) collectRefsFromTypeDef(inner, used);
      break;
    case "sub":
      if (td.superType !== null) used.add(td.superType);
      collectRefsFromTypeDef(td.type, used);
      break;
  }
}

// --- Remapping ---

// (#1302) Shared-array double-remap guard. `walkInstructions` visits every
// instruction once PER OCCURRENCE in the tree, so when the SAME `Instr` object
// is aliased into more than one position in a body (e.g. a `rangeThrow` /
// `capThrow` throw-template spliced into both an index-check and a bounds-check
// `if.then`, or a helper `Instr[]` const spread into several slots of a
// hand-built body), a mutate-in-place remapper applies the chained remap to it
// twice — `53→52` then `52→51` — landing the operand on the wrong index (the
// observed DataView `call __new_RangeError` → `__to_bigint`, an i64-returning
// callee, → `throw expected externref, found call of type i64`). Producers have
// historically worked around this by never sharing instruction objects
// (iterator-native `buildVecArm`, json-codec `cloneBody`); guarding the remap
// itself against re-visiting an object fixes the whole class at the sink, so an
// aliased template is remapped exactly once regardless of how many times the
// walker reaches it. A `WeakSet` keyed on the instruction object is the right
// scope: each `call`/`struct.new`/… is remapped at most once.
function remapLayoutInBodyShared(
  body: Instr[],
  funcRemap: ReadonlyMap<number, number>,
  typeRemap: ReadonlyMap<number, number>,
  seen: WeakSet<object>,
  visitedArrays: WeakSet<Instr[]>,
): void {
  walkInstructionDag(
    body,
    (instr) => {
      if (seen.has(instr)) return;
      const a = instr as any;
      let changed = false;
      if (typeof a.funcIdx === "number" && funcRemap.has(a.funcIdx)) {
        a.funcIdx = funcRemap.get(a.funcIdx)!;
        changed = true;
      }
      if (typeof a.typeIdx === "number" && typeRemap.has(a.typeIdx)) {
        a.typeIdx = typeRemap.get(a.typeIdx)!;
        changed = true;
      }
      if (typeof a.dstTypeIdx === "number" && typeRemap.has(a.dstTypeIdx)) {
        a.dstTypeIdx = typeRemap.get(a.dstTypeIdx)!;
        changed = true;
      }
      if (typeof a.srcTypeIdx === "number" && typeRemap.has(a.srcTypeIdx)) {
        a.srcTypeIdx = typeRemap.get(a.srcTypeIdx)!;
        changed = true;
      }
      // Remap blockType. (#2564) A `blockType` (and its `.type` ValType) can
      // be aliased across distinct instructions. Guard the block-type object
      // independently so a compaction chain is applied exactly once.
      if (a.blockType && !seen.has(a.blockType)) {
        let blockTypeChanged = false;
        if (a.blockType.kind === "type" && typeRemap.has(a.blockType.typeIdx)) {
          a.blockType.typeIdx = typeRemap.get(a.blockType.typeIdx)!;
          blockTypeChanged = true;
        }
        if (a.blockType.kind === "val" && a.blockType.type) {
          const remapped = remapVT(a.blockType.type, typeRemap);
          if (remapped !== a.blockType.type) {
            a.blockType.type = remapped;
            blockTypeChanged = true;
          }
        }
        if (blockTypeChanged) seen.add(a.blockType);
      }
      // Only mutated objects need the double-remap guard. Keeping every plain
      // instruction in this ephemeron table dominated memory on compiler-sized
      // accessor IR while providing no protection for objects with no index.
      if (changed) seen.add(instr);
    },
    visitedArrays,
  );
}

function remapVT(vt: ValType, remap: ReadonlyMap<number, number>): ValType {
  if ((vt.kind === "ref" || vt.kind === "ref_null") && typeof (vt as any).typeIdx === "number") {
    const old = (vt as any).typeIdx as number;
    if (remap.has(old)) {
      return { ...vt, typeIdx: remap.get(old)! } as ValType;
    }
  }
  return vt;
}

function remapTD(td: TypeDef, remap: Map<number, number>): TypeDef {
  switch (td.kind) {
    case "func":
      return {
        ...td,
        params: td.params.map((p) => remapVT(p, remap)),
        results: td.results.map((r) => remapVT(r, remap)),
      };
    case "struct": {
      const r: StructTypeDef = {
        ...td,
        fields: td.fields.map((f) => ({ ...f, type: remapVT(f.type, remap) })),
      };
      if (td.superTypeIdx !== undefined && remap.has(td.superTypeIdx)) {
        r.superTypeIdx = remap.get(td.superTypeIdx)!;
      }
      return r;
    }
    case "array":
      return { ...td, element: remapVT(td.element, remap) };
    case "rec":
      return {
        ...td,
        types: td.types.map((t) => remapTD(t, remap)) as TypeDef[],
      };
    case "sub": {
      const r: SubTypeDef = {
        ...td,
        type: remapTD(td.type, remap) as StructTypeDef | ArrayTypeDef,
      };
      if (td.superType !== null && remap.has(td.superType)) {
        r.superType = remap.get(td.superType)!;
      }
      return r;
    }
  }
}

// --- Main elimination pass ---

/**
 * Eliminate dead (unreferenced) function imports and type definitions
 * from a compiled WasmModule. Mutates the module in place.
 *
 * #1899 — funcIdx-authority contract. This pass REMOVES dead function imports
 * and remaps every funcIdx referenced from inside `mod` (bodies, exports,
 * elements, declaredFuncRefs, start) through the authoritative `fR` remap, so
 * the emitted module is internally consistent. Historically it touched ONLY
 * `mod` and left the codegen-context side-tables (`funcMap`, `nativeStrHelpers`,
 * …) stale by the removed-import delta. Any consumer that bakes a NEW `call`
 * from those maps AFTER this pass (e.g. the `__unbox_number` repair in
 * `fixups.ts`, which runs in `repairStructTypeMismatches` /
 * `fixupExternConvertAny` right after dead-elim) would then target the wrong
 * function — the recurring late-shift / index-desync class (#1677/#1809/#1839/
 * #1886/#329/#1461/#2043). Pass `ctx` so the SAME authoritative `fR` is applied
 * to the side-tables, keeping them in lockstep with the module exactly as the
 * add-shift passes (`shiftLateImportIndices` / `reconcileNativeStrFinalizeShift`)
 * already do for the import-ADD direction. The `ctx` arg is optional so non-codegen
 * callers (tests, the standalone module rewriter) need no context; when omitted,
 * only `mod` is remapped (the prior behaviour). The whole side-table remap is a
 * no-op when no dead imports were removed (`fR.size === 0`), which is the common
 * case mid-finalize.
 */
export function eliminateDeadImports(mod: WasmModule, ctx?: CodegenContext): void {
  const numImpF = mod.imports.filter((i) => i.desc.kind === "func").length;
  // #2527: group identity is an ABI property. A module using one member must
  // retain the complete frozen group, otherwise separately compiled provider
  // and consumer modules declare different recursive groups and GC values can
  // no longer cross the link boundary.
  const canonicalGroup = mod.canonicalRuntimeRecGroup;
  // Keep the large read-only DAG table inside a helper lifetime so V8 can
  // reclaim it before the mutation/remap walk allocates its own table.
  const { usedF, usedT } = (() => {
    const usedFuncs = new Set<number>();
    const usedTypes = new Set<number>();
    if (canonicalGroup) {
      for (let i = canonicalGroup.start; i <= canonicalGroup.end; i++) usedTypes.add(i);
    }
    // All local (non-import) functions are always reachable.
    for (let i = 0; i < mod.functions.length; i++) usedFuncs.add(numImpF + i);
    for (const func of mod.functions) {
      // Reference collection is read-only and the result sets are idempotent,
      // so cross-root aliases may be revisited safely. Scope the DAG table to
      // one root: compiler-sized modules contain millions of child arrays and
      // can exceed V8's maximum WeakSet table capacity with one module-wide
      // table, even when ample heap remains.
      collectRefsFromBody(func.body, usedFuncs, usedTypes);
      usedTypes.add(func.typeIdx);
      for (const l of func.locals) collectRefsFromValType(l.type, usedTypes);
    }
    for (const g of mod.globals) {
      collectRefsFromBody(g.init, usedFuncs, usedTypes);
      collectRefsFromValType(g.type, usedTypes);
    }
    for (const el of mod.elements) {
      for (const fi of el.funcIndices) usedFuncs.add(fi);
      collectRefsFromBody(el.offset, usedFuncs, usedTypes);
    }
    for (const ex of mod.exports) {
      if (ex.desc.kind === "func") usedFuncs.add(ex.desc.index);
    }
    for (const fi of mod.declaredFuncRefs) usedFuncs.add(fi);
    if (mod.startFuncIdx !== undefined) usedFuncs.add(mod.startFuncIdx);
    for (const tag of mod.tags) usedTypes.add(tag.typeIdx);
    for (const imp of mod.imports) {
      if (imp.desc.kind === "tag") usedTypes.add(imp.desc.typeIdx);
      if (imp.desc.kind === "global") collectRefsFromValType(imp.desc.type, usedTypes);
    }
    return { usedF: usedFuncs, usedT: usedTypes };
  })();

  // --- Phase 2: Determine dead function imports ---
  let fi2 = 0;
  const impFI: number[] = [];
  const deadF = new Set<number>();
  for (let i = 0; i < mod.imports.length; i++) {
    if (mod.imports[i]!.desc.kind === "func") {
      impFI.push(fi2);
      if (!usedF.has(fi2)) deadF.add(fi2);
      fi2++;
    } else {
      impFI.push(-1);
    }
  }

  // Mark type indices used by surviving func imports
  for (let i = 0; i < mod.imports.length; i++) {
    const imp = mod.imports[i]!;
    if (imp.desc.kind === "func" && !deadF.has(impFI[i]!)) {
      usedT.add(imp.desc.typeIdx);
    }
  }

  // --- Phase 3: Compute transitive type closure ---
  let chg = true;
  while (chg) {
    chg = false;
    for (const ti of [...usedT]) {
      const td = mod.types[ti];
      if (!td) continue;
      const b = usedT.size;
      collectRefsFromTypeDef(td, usedT);
      if (usedT.size > b) chg = true;
    }
  }

  // --- Phase 4: Build remap tables ---
  const fR = new Map<number, number>();
  if (deadF.size > 0) {
    let n = 0;
    for (let o = 0; o < numImpF + mod.functions.length; o++) {
      if (deadF.has(o)) continue;
      if (o !== n) fR.set(o, n);
      n++;
    }
  }

  const previousTypes = mod.types;
  const tR = new Map<number, number>();
  const surv: TypeDef[] = [];
  const targetsByOldIndex: (number | null)[] = new Array(previousTypes.length).fill(null);
  let rem = 0;
  {
    let n = 0;
    for (let o = 0; o < previousTypes.length; o++) {
      if (!usedT.has(o)) {
        rem++;
        continue;
      }
      if (o !== n) tR.set(o, n);
      targetsByOldIndex[o] = n;
      surv.push(previousTypes[o]!);
      n++;
    }
  }
  const nextTypes = rem > 0 ? surv.map((td) => (tR.size > 0 ? remapTD(td, tR) : td)) : previousTypes;

  if (fR.size === 0 && tR.size === 0 && deadF.size === 0 && rem === 0) {
    return;
  }

  // --- Phase 5: Apply remapping ---

  const remappedLayoutObjects = new WeakSet<object>();

  if (rem > 0) {
    // Validate and remap ABI sidecars before changing any module-owned array or
    // index. A rejected layout must not leave imports compacted while bodies,
    // exports, and the remaining index spaces still use the old layout.
    ctx?.programAbiSession?.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex,
    });
  }

  // Remove dead function imports
  if (deadF.size > 0) {
    let idx = 0;
    mod.imports = mod.imports.filter((imp) => {
      if (imp.desc.kind === "func") {
        const dead = deadF.has(idx);
        idx++;
        return !dead;
      }
      return true;
    });
  }

  // Replace types array
  if (rem > 0) {
    mod.types = nextTypes;
    if (canonicalGroup) {
      const start = targetsByOldIndex[canonicalGroup.start];
      const end = targetsByOldIndex[canonicalGroup.end];
      if (start === null || end === null) {
        throw new Error("canonical runtime rec-group was removed during type compaction (#2527)");
      }
      mod.canonicalRuntimeRecGroup = { ...canonicalGroup, start, end };
    }
  }

  // Remap function bodies
  for (const func of mod.functions) {
    if (fR.size > 0 || tR.size > 0) {
      remapLayoutInBodyShared(func.body, fR, tR, remappedLayoutObjects, new WeakSet<Instr[]>());
    }
    if (tR.has(func.typeIdx)) func.typeIdx = tR.get(func.typeIdx)!;
    if (tR.size > 0) {
      for (let i = 0; i < func.locals.length; i++) {
        func.locals[i] = {
          ...func.locals[i]!,
          type: remapVT(func.locals[i]!.type, tR),
        };
      }
    }
  }

  // Remap import descriptors
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func" && tR.has(imp.desc.typeIdx)) {
      imp.desc = {
        ...imp.desc,
        typeIdx: tR.get(imp.desc.typeIdx)!,
      };
    }
    if (imp.desc.kind === "tag" && tR.has(imp.desc.typeIdx)) {
      imp.desc = {
        ...imp.desc,
        typeIdx: tR.get(imp.desc.typeIdx)!,
      };
    }
    if (imp.desc.kind === "global" && tR.size > 0) {
      imp.desc = {
        ...imp.desc,
        type: remapVT(imp.desc.type, tR),
      };
    }
  }

  // Remap exports
  for (const ex of mod.exports) {
    if (ex.desc.kind === "func" && fR.has(ex.desc.index)) {
      ex.desc = {
        ...ex.desc,
        index: fR.get(ex.desc.index)!,
      };
    }
  }

  // Remap element segments
  for (const el of mod.elements) {
    el.funcIndices = el.funcIndices.map((f) => fR.get(f) ?? f);
    if (fR.size > 0 || tR.size > 0) {
      remapLayoutInBodyShared(el.offset, fR, tR, remappedLayoutObjects, new WeakSet<Instr[]>());
    }
  }

  // Remap declaredFuncRefs
  mod.declaredFuncRefs = mod.declaredFuncRefs.map((f) => fR.get(f) ?? f);

  // Remap start function index (#907)
  if (mod.startFuncIdx !== undefined && fR.has(mod.startFuncIdx)) {
    mod.startFuncIdx = fR.get(mod.startFuncIdx)!;
  }

  // Remap globals
  for (const g of mod.globals) {
    if (tR.size > 0) g.type = remapVT(g.type, tR);
    if (fR.size > 0 || tR.size > 0) {
      remapLayoutInBodyShared(g.init, fR, tR, remappedLayoutObjects, new WeakSet<Instr[]>());
    }
  }

  // Remap tags
  for (const tag of mod.tags) {
    if (tR.has(tag.typeIdx)) tag.typeIdx = tR.get(tag.typeIdx)!;
  }

  // #1899 — keep the codegen-context funcIdx side-tables in lockstep with the
  // `fR` remap just applied to `mod`. Without this, a post-dead-elim consumer
  // that bakes a `call` from one of these maps (fixups.ts `__unbox_number`
  // repair, etc.) targets the wrong, now-shifted function. This is the REMOVE
  // direction of the recurring late-shift class; the ADD direction is already
  // handled by shiftLateImportIndices / reconcileNativeStrFinalizeShift. No-op
  // when no dead func import was removed (`fR.size === 0`).
  if (ctx && fR.size > 0) {
    const remapMap = (m: Map<string, number>): void => {
      for (const [name, idx] of m) {
        const next = fR.get(idx);
        if (next !== undefined) m.set(name, next);
      }
    };
    remapMap(ctx.funcMap);
    remapMap(ctx.nativeStrHelpers);
    remapMap(ctx.nativeRegexHelpers);
    remapMap(ctx.mapHelpers);
    // Side-channel trampoline indices (plain numbers, not reachable via any
    // Instr walk) — mirror the lockstep shiftLateImportIndices already applies
    // on the ADD direction (#1525b).
    for (const t of ctx.pendingMethodTrampolines) {
      const m1 = fR.get(t.methodFuncIdx);
      if (m1 !== undefined) t.methodFuncIdx = m1;
      const t1 = fR.get(t.trampolineFuncIdx);
      if (t1 !== undefined) t.trampolineFuncIdx = t1;
    }
  }
}
