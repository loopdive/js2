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
import { walkInstructions } from "./walk-instructions.js";

// --- Reference collection ---

function collectRefsFromBody(body: Instr[], usedFuncs: Set<number>, usedTypes: Set<number>): void {
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
        collectRefsFromBody(instr.body, usedFuncs, usedTypes);
        break;
      case "if":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.then, usedFuncs, usedTypes);
        if (instr.else) collectRefsFromBody(instr.else, usedFuncs, usedTypes);
        break;
      case "try":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.body, usedFuncs, usedTypes);
        for (const c of instr.catches) collectRefsFromBody(c.body, usedFuncs, usedTypes);
        if (instr.catchAll) collectRefsFromBody(instr.catchAll, usedFuncs, usedTypes);
        break;
      case "try_table":
        collectBlockTypeRefs(instr.blockType, usedTypes);
        collectRefsFromBody(instr.body, usedFuncs, usedTypes);
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
function remapFuncIdxInBody(body: Instr[], remap: Map<number, number>): void {
  const seen = new WeakSet<object>();
  walkInstructions(body, (instr) => {
    if (seen.has(instr)) return;
    seen.add(instr);
    const a = instr as any;
    if (typeof a.funcIdx === "number" && remap.has(a.funcIdx)) {
      a.funcIdx = remap.get(a.funcIdx)!;
    }
  });
}

function remapTypeIdxInBody(body: Instr[], remap: Map<number, number>): void {
  // (#1302) Same shared-object double-remap guard as remapFuncIdxInBody — a
  // `typeIdx`/`dstTypeIdx`/`blockType` operand on an aliased instruction must be
  // chained-remapped exactly once.
  const seen = new WeakSet<object>();
  walkInstructions(body, (instr) => {
    if (seen.has(instr)) return;
    seen.add(instr);
    const a = instr as any;
    if (typeof a.typeIdx === "number" && remap.has(a.typeIdx)) {
      a.typeIdx = remap.get(a.typeIdx)!;
    }
    if (typeof a.dstTypeIdx === "number" && remap.has(a.dstTypeIdx)) {
      a.dstTypeIdx = remap.get(a.dstTypeIdx)!;
    }
    if (typeof a.srcTypeIdx === "number" && remap.has(a.srcTypeIdx)) {
      a.srcTypeIdx = remap.get(a.srcTypeIdx)!;
    }
    // Remap blockType. (#2564) The double-remap guard above keys on the
    // *instruction* object, but a `blockType` (and its `.type` ValType) can be
    // ALIASED across several distinct `if`/`block` instructions — e.g. a
    // tag-dispatch cascade that shares one `blockType` object across its nested
    // arms. Each aliasing instruction passes the `seen` check (different `instr`)
    // and would chain-remap the shared block-type a second time (20→16 then
    // 16→13 under a compaction map). Guard on the `blockType` object itself so a
    // shared block-type is remapped exactly once regardless of how many
    // instructions alias it.
    if (a.blockType && !seen.has(a.blockType)) {
      seen.add(a.blockType);
      if (a.blockType.kind === "type" && remap.has(a.blockType.typeIdx)) {
        a.blockType.typeIdx = remap.get(a.blockType.typeIdx)!;
      }
      if (a.blockType.kind === "val" && a.blockType.type) {
        a.blockType.type = remapVT(a.blockType.type, remap);
      }
    }
  });
}

function remapVT(vt: ValType, remap: Map<number, number>): ValType {
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
  const usedF = new Set<number>();
  const usedT = new Set<number>();

  // All local (non-import) functions are always reachable
  for (let i = 0; i < mod.functions.length; i++) {
    usedF.add(numImpF + i);
  }

  // Scan function bodies
  for (const func of mod.functions) {
    collectRefsFromBody(func.body, usedF, usedT);
    usedT.add(func.typeIdx);
    for (const l of func.locals) collectRefsFromValType(l.type, usedT);
  }

  // Scan global init expressions
  for (const g of mod.globals) {
    collectRefsFromBody(g.init, usedF, usedT);
    collectRefsFromValType(g.type, usedT);
  }

  // Scan element segments
  for (const el of mod.elements) {
    for (const fi of el.funcIndices) usedF.add(fi);
    collectRefsFromBody(el.offset, usedF, usedT);
  }

  // Scan exports
  for (const ex of mod.exports) {
    if (ex.desc.kind === "func") usedF.add(ex.desc.index);
  }

  // declaredFuncRefs
  for (const fi of mod.declaredFuncRefs) usedF.add(fi);

  // Start function (#907) — referenced by Wasm start section, not by export/element
  if (mod.startFuncIdx !== undefined) usedF.add(mod.startFuncIdx);

  // Tags reference types
  for (const tag of mod.tags) usedT.add(tag.typeIdx);

  // Non-func import descriptors reference types
  for (const imp of mod.imports) {
    if (imp.desc.kind === "tag") usedT.add(imp.desc.typeIdx);
    if (imp.desc.kind === "global") collectRefsFromValType(imp.desc.type, usedT);
  }

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
  }

  // Remap function bodies
  for (const func of mod.functions) {
    if (fR.size > 0) remapFuncIdxInBody(func.body, fR);
    if (tR.size > 0) remapTypeIdxInBody(func.body, tR);
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
    if (fR.size > 0) remapFuncIdxInBody(el.offset, fR);
    if (tR.size > 0) remapTypeIdxInBody(el.offset, tR);
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
    if (fR.size > 0) remapFuncIdxInBody(g.init, fR);
    if (tR.size > 0) remapTypeIdxInBody(g.init, tR);
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
