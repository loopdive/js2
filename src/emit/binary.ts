// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type {
  BlockType,
  FieldDef,
  GlobalDef,
  Import,
  Instr,
  SourcePos,
  TypeDef,
  ValType,
  WasmExport,
  WasmFunction,
  WasmModule,
} from "../ir/types.js";
import { WasmEncoder } from "./encoder.js";
import { GC, OP, SECTION, SIMD, TYPE } from "./opcodes.js";
import { resolveLayout, type ModuleLayout } from "./resolve-layout.js";

/** A source map entry: maps a wasm byte offset to a source position */
export interface SourceMapEntry {
  wasmOffset: number;
  sourcePos: SourcePos;
}

/** Result of binary emission with source map data */
export interface EmitResult {
  binary: Uint8Array;
  sourceMapEntries: SourceMapEntry[];
}

/**
 * Collect WASM type indices referenced by a value type.
 * Recursively descends into rec/sub wrappers via the caller (walkTypeDefRefs).
 */
function collectValTypeRefs(t: ValType, refs: Set<number>): void {
  if (t.kind === "ref" || t.kind === "ref_null") refs.add(t.typeIdx);
}

/** Collect all type indices that a TypeDef references (excluding itself). */
function collectTypeDefRefs(t: TypeDef, refs: Set<number>): void {
  switch (t.kind) {
    case "func":
      for (const p of t.params) collectValTypeRefs(p, refs);
      for (const r of t.results) collectValTypeRefs(r, refs);
      break;
    case "struct":
      if (t.superTypeIdx !== undefined && t.superTypeIdx >= 0) refs.add(t.superTypeIdx);
      for (const f of t.fields) collectValTypeRefs(f.type, refs);
      break;
    case "array":
      collectValTypeRefs(t.element, refs);
      break;
    case "rec":
      for (const inner of t.types) collectTypeDefRefs(inner, refs);
      break;
    case "sub":
      if (t.superType !== null) refs.add(t.superType);
      collectTypeDefRefs(t.type, refs);
      break;
  }
}

/**
 * Compute rec-group boundaries for the type section. Each returned [start, end]
 * (inclusive) tuple identifies a contiguous run of type definitions that must
 * be encoded inside a single WasmGC rec group so that forward references between
 * them validate. Singleton groups (start === end) are emitted without a rec
 * wrapper, preserving canonical type identity for non-recursive entries.
 */
export function computeRecGroups(types: TypeDef[]): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  let i = 0;
  while (i < types.length) {
    let end = i;
    let scan = i;
    while (scan <= end) {
      const refs = new Set<number>();
      collectTypeDefRefs(types[scan]!, refs);
      for (const r of refs) {
        if (r > end && r < types.length) end = r;
      }
      scan++;
    }
    groups.push([i, end]);
    i = end + 1;
  }
  return groups;
}

/**
 * #2043 — always-on emit-time index validation (the durable safety net for
 * the late-import index-shift class; instances #1809/#1839/#1602/#1886/
 * #1666/#1677/#2029).
 *
 * The failure mode: an index captured into a JS local before a deferred
 * `flushLateImportShifts`/`addUnionImports`/`addStringImports` shift goes
 * stale-low (off-by-`delta`), or a failed map lookup bakes `-1`/`undefined`
 * into an instruction. Stale-low used to surface as a silently-valid-but-
 * wrong index → `expected externref, found i32` deep inside wasmtime on a
 * random test262 shard; `-1` as the raw encoder's opaque
 * `u32 out of range: -1`. #2029 proved a separate funcref-only walker's
 * coverage was insufficient — its repro's poison was a `global.get -1`, a
 * space that walker never visited.
 *
 * Design: the checks live INLINE at the encoder sites that serialize each
 * index, not in a separate pre-walk. That gives (a) coverage by construction
 * — every ValType funnels through `encodeValType`, every instruction
 * immediate through `encodeInstr`, so a new emission site cannot dodge the
 * guard — and (b) near-zero cost: the encoder already dispatches per-op, so
 * each index pays only a null-check plus a range compare (a separate full
 * walk measured ~15% of emit time on the playground-examples corpus; inline
 * is <1%). `valCtx` is set only inside `emitBinaryWithSourceMap` (cleared in
 * a finally); the relocatable object emitter (`src/emit/object.ts`) reuses
 * the encode helpers with symbolic placeholder indices and intentionally
 * runs unchecked.
 *
 * Spaces covered: functions (call/return_call/ref.func, element segments,
 * declaredFuncRefs, start, exports), types (function/import/tag signatures,
 * call_indirect/call_ref/struct/array immediates, block types, supertypes,
 * ValType ref/ref_null in params/results/locals/fields/globals), heap-type
 * s33 positions (ref.null/ref.cast/ref.cast_null/ref.test — negative
 * abstract heap-type codes are legal there, but `-1` never is: 0x7f is not a
 * heap type, and a `-1` heap type is always a failed lookup, see #1338),
 * globals, locals (against params+locals), exception tags (throw/try-catch/
 * exports), tables, struct field indices, and memory exports.
 *
 * Pure read-only validation — when it does not throw, the emitted bytes are
 * identical to an unvalidated emit. Sound by construction: every in-range
 * index is accepted, so it cannot reject a module the encoder would have
 * serialized into a structurally valid binary. Always-on since #2043; set
 * JS2WASM_SKIP_INDEX_VALIDATION=1 to bypass (escape hatch only).
 */
interface EmitValidationCtx {
  numFuncs: number;
  numTypes: number;
  numGlobals: number;
  numTags: number;
  numTables: number;
  numMemories: number;
  /**
   * Flat type list for struct-field / signature resolution. Wasm type
   * indices equal `mod.types` array positions only while the array is flat
   * (no "rec" wrapper entries — codegen never pushes them today). If rec
   * wrappers appear, this is null and the resolution-dependent checks
   * (struct field bounds, local param counts) are skipped; the pure bound
   * checks stay valid because `numTypes` counts nested entries.
   */
  flatTypes: TypeDef[] | null;
  /** Human label for the structure currently being encoded. */
  where: string;
  /** params+locals of the function being encoded; -1 = unknown/const-expr context (skip local checks). */
  maxLocals: number;
}

let valCtx: EmitValidationCtx | null = null;

// ---------------------------------------------------------------------------
// #1916/#2710 — handle→final-index resolution seam.
//
// `layout` is armed per-emit in `emitBinaryWithSourceMap` (same lifecycle as
// `valCtx`) and dereferenced by `fIdx`/`gIdx` at every seam where a function or
// global reference becomes bytes: `call`, `return_call`, `ref.func`,
// `global.{get,set}`, export descriptors, element-segment function lists,
// `declaredFuncRefs`, and the start section. When unarmed (the relocatable
// object emitter and other direct callers of the exported encode helpers),
// handles pass through raw — identical to the historical behaviour.
//
// IDENTITY PHASE: `resolveLayout` is the identity map (handles == live
// indices), so this seam is byte-neutral (proven by
// `scripts/prove-emit-identity.mjs`). The flip to real permutation happens in
// `resolve-layout.ts` ONLY — see the preconditions documented there.
// ---------------------------------------------------------------------------
let layout: ModuleLayout | null = null;

/** Resolve a function handle to its final function-index-space position. */
function fIdx(h: number): number {
  return layout ? layout.func(h) : h;
}

/** Resolve a global handle to its final global-index-space position. */
function gIdx(h: number): number {
  return layout ? layout.global(h) : h;
}

function makeValidationCtx(mod: WasmModule): EmitValidationCtx {
  let numImportFuncs = 0;
  let numImportGlobals = 0;
  let numImportTags = 0;
  let numImportTables = 0;
  let numImportMemories = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind === "func") numImportFuncs++;
    else if (imp.desc.kind === "global") numImportGlobals++;
    else if (imp.desc.kind === "tag") numImportTags++;
    else if (imp.desc.kind === "table") numImportTables++;
    else if (imp.desc.kind === "memory") numImportMemories++;
  }
  let typesAreFlat = true;
  let numTypes = 0;
  for (const t of mod.types) {
    if (t.kind === "rec") {
      typesAreFlat = false;
      numTypes += t.types.length;
    } else {
      numTypes += 1;
    }
  }
  return {
    numFuncs: numImportFuncs + mod.functions.length,
    numTypes,
    numGlobals: numImportGlobals + mod.globals.length,
    numTags: numImportTags + mod.tags.length,
    numTables: numImportTables + mod.tables.length,
    numMemories: numImportMemories + (mod.memories ? mod.memories.length : 0),
    flatTypes: typesAreFlat ? mod.types : null,
    where: "module",
    maxLocals: -1,
  };
}

function failIndex(space: string, value: unknown, max: number): never {
  throw new RangeError(
    `Codegen error: ${space} index out of range — ${String(value)} ` +
      `(valid: [0, ${max})) at ${valCtx ? valCtx.where : "?"}. This is the late-import index-shift ` +
      `class (#2043): a captured index went stale across a deferred ` +
      `flushLateImportShifts/addUnionImports/addStringImports shift, or a map ` +
      `lookup failed and baked -1/undefined. Re-resolve the index by name ` +
      `AFTER the last shift, or make the producer refuse loudly.`,
  );
}

function vIdx(space: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= max) failIndex(space, value, max);
}

/**
 * s33 heap-type positions: non-negative values are concrete type indices;
 * negative values are abstract heap-type codes (eq=-19, any=-18, …), which
 * encode as a single signed-LEB byte, i.e. [-64, -2]. -1 is rejected even
 * though it is negative: 0x7f is not a heap type, and -1 is exactly the
 * failed-lookup poison value (#1338 "Unknown heap type -1").
 */
function vHeapType(value: number): void {
  const max = (valCtx as EmitValidationCtx).numTypes;
  if (!Number.isInteger(value) || value >= max || value < -64 || value === -1) {
    failIndex("heap type", value, max);
  }
}

/**
 * Resolve a type index to its definition, unwrapping sub wrappers. Returns
 * undefined when unresolvable — callers skip the check, never false-fire.
 */
function resolveTypeDefAt(typeIdx: number): TypeDef | undefined {
  const types = (valCtx as EmitValidationCtx).flatTypes;
  if (!types || typeIdx < 0 || typeIdx >= types.length) return undefined;
  let t: TypeDef | undefined = types[typeIdx];
  while (t && t.kind === "sub") t = t.type;
  return t;
}

/** Resolved param count of a function's signature, or -1 when unresolvable. */
function resolveParamCount(typeIdx: number): number {
  const sig = resolveTypeDefAt(typeIdx);
  return sig && sig.kind === "func" ? sig.params.length : -1;
}

/** struct.get/struct.set: type bound check + field bound check when the struct resolves. */
function vStructField(typeIdx: number, fieldIdx: number, op: string): void {
  vIdx("type", typeIdx, (valCtx as EmitValidationCtx).numTypes);
  const td = resolveTypeDefAt(typeIdx);
  if (td && td.kind === "struct" && (!Number.isInteger(fieldIdx) || fieldIdx < 0 || fieldIdx >= td.fields.length)) {
    const saved = (valCtx as EmitValidationCtx).where;
    (valCtx as EmitValidationCtx).where = `${saved} (${op} on type ${typeIdx})`;
    try {
      failIndex("struct field", fieldIdx, td.fields.length);
    } finally {
      (valCtx as EmitValidationCtx).where = saved;
    }
  }
}

/** Emit a complete Wasm binary from an IR module */
export function emitBinary(mod: WasmModule): Uint8Array {
  return emitBinaryWithSourceMap(mod).binary;
}

/**
 * Emit a Wasm binary and collect source map entries.
 *
 * Arms the #2043 always-on index validation (see `EmitValidationCtx` above)
 * for the duration of this emit and disarms it in a finally, so the encode
 * helpers run unchecked for other callers (the relocatable object emitter).
 * JS2WASM_SKIP_INDEX_VALIDATION=1 is an escape hatch only.
 */
export function emitBinaryWithSourceMap(mod: WasmModule): EmitResult {
  valCtx = process.env.JS2WASM_SKIP_INDEX_VALIDATION ? null : makeValidationCtx(mod);
  // #1916/#2710 — resolve the final index layout once, at serialization: the
  // single point that sees the fully-settled index space (post late imports,
  // post DCE). All func/global references below dereference through it.
  layout = resolveLayout(mod);
  try {
    return emitBinaryWithSourceMapUnguarded(mod);
  } finally {
    valCtx = null;
    layout = null;
  }
}

function emitBinaryWithSourceMapUnguarded(mod: WasmModule): EmitResult {
  const enc = new WasmEncoder();
  const sourceMapEntries: SourceMapEntry[] = [];

  // Magic + Version
  enc.bytes([0x00, 0x61, 0x73, 0x6d]); // \0asm
  enc.bytes([0x01, 0x00, 0x00, 0x00]); // version 1

  const numImportFuncs = mod.imports.filter((i) => i.desc.kind === "func").length;

  // Type section
  if (mod.types.length > 0) {
    // Compute rec-group boundaries: any type with a forward reference (typeIdx > self)
    // must share a rec group with the referenced types so that WasmGC validation
    // accepts the cross-type reference. Without this, a class struct registered
    // before its dependent (vec/array) field types — e.g. `class C { rows: string[][] }`
    // where the `__arr_ref_1`/`__vec_ref_1` types are appended after the class
    // placeholder — fails with "Type index N is out of bounds" because each
    // singleton type can only reference earlier types or itself. (#1293)
    const recGroups = computeRecGroups(mod.types);
    enc.section(SECTION.type, (s) => {
      s.u32(recGroups.length);
      for (const [start, end] of recGroups) {
        if (start === end) {
          if (valCtx) valCtx.where = `type definition #${start}`;
          encodeTypeDef(mod.types[start]!, s);
        } else {
          s.byte(TYPE.rec);
          s.u32(end - start + 1);
          for (let i = start; i <= end; i++) {
            if (valCtx) valCtx.where = `type definition #${i}`;
            encodeTypeDef(mod.types[i]!, s);
          }
        }
      }
    });
  }

  // Import section
  if (mod.imports.length > 0) {
    enc.section(SECTION.import, (s) => {
      s.vector(mod.imports, (imp, e) => {
        if (valCtx) valCtx.where = `import '${imp.module}.${imp.name}'`;
        encodeImport(imp, e);
      });
    });
  }

  // Function section (type indices for each function)
  if (mod.functions.length > 0) {
    enc.section(SECTION.function, (s) => {
      s.vector(mod.functions, (f, e) => {
        if (valCtx) {
          valCtx.where = `function '${f.name || "?"}' signature`;
          vIdx("type", f.typeIdx, valCtx.numTypes);
        }
        e.u32(f.typeIdx);
      });
    });
  }

  // Table section
  if (mod.tables.length > 0) {
    enc.section(SECTION.table, (s) => {
      s.vector(mod.tables, (t, e) => {
        e.byte(t.elementType === "funcref" ? TYPE.funcref : TYPE.externref);
        if (t.max !== undefined) {
          e.byte(0x01); // has max
          e.u32(t.min);
          e.u32(t.max);
        } else {
          e.byte(0x00);
          e.u32(t.min);
        }
      });
    });
  }

  // Memory section
  if (mod.memories && mod.memories.length > 0) {
    enc.section(SECTION.memory, (s) => {
      s.u32(mod.memories.length);
      for (const mem of mod.memories) {
        if (mem.max !== undefined) {
          s.byte(0x01);
          s.u32(mem.min);
          s.u32(mem.max);
        } else {
          s.byte(0x00);
          s.u32(mem.min);
        }
      }
    });
  }

  // Tag section (exception handling) — must come before Global section
  if (mod.tags.length > 0) {
    enc.section(SECTION.tag, (s) => {
      s.vector(mod.tags, (tag, e) => {
        if (valCtx) {
          valCtx.where = `tag '${tag.name}'`;
          vIdx("type", tag.typeIdx, valCtx.numTypes);
        }
        e.byte(0x00); // attribute: exception (0)
        e.u32(tag.typeIdx);
      });
    });
  }

  // Global section
  if (mod.globals.length > 0) {
    enc.section(SECTION.global, (s) => {
      s.vector(mod.globals, (g, e) => {
        if (valCtx) {
          valCtx.where = `global '${g.name || "?"}' init`;
          valCtx.maxLocals = -1; // const-expr context: no locals exist
        }
        encodeGlobal(g, e);
      });
    });
  }

  // Export section
  if (mod.exports.length > 0) {
    enc.section(SECTION.export, (s) => {
      s.vector(mod.exports, (exp, e) => {
        if (valCtx) valCtx.where = `export '${exp.name}'`;
        encodeExport(exp, e, numImportFuncs);
      });
    });
  }

  // Start section — auto-run function on instantiation (#907)
  if (mod.startFuncIdx !== undefined) {
    enc.section(SECTION.start, (s) => {
      const start = fIdx(mod.startFuncIdx!);
      if (valCtx) {
        valCtx.where = "start function";
        vIdx("function", start, valCtx.numFuncs);
      }
      s.u32(start);
    });
  }

  // Element section — active segments (tables) + declarative segments (ref.func)
  const hasActiveElems = mod.elements.length > 0;
  const hasDeclaredRefs = mod.declaredFuncRefs.length > 0;
  if (hasActiveElems || hasDeclaredRefs) {
    enc.section(SECTION.element, (s) => {
      const totalSegments = mod.elements.length + (hasDeclaredRefs ? 1 : 0);
      s.u32(totalSegments);
      // Active element segments (table initializers)
      for (const elem of mod.elements) {
        const explicitTable = elem.tableIdx !== 0;
        s.byte(explicitTable ? 0x02 : 0x00); // active funcref segment, implicit or explicit table
        if (explicitTable) {
          if (valCtx) {
            valCtx.where = "element-segment table";
            vIdx("table", elem.tableIdx, valCtx.numTables);
          }
          s.u32(elem.tableIdx);
        }
        if (valCtx) {
          valCtx.where = "element-segment offset";
          valCtx.maxLocals = -1; // const-expr context: no locals exist
        }
        for (const instr of elem.offset) encodeInstr(instr, s);
        s.byte(OP.end);
        if (explicitTable) s.byte(0x00); // elemkind = funcref
        s.u32(elem.funcIndices.length);
        if (valCtx) valCtx.where = "element-segment function list";
        for (const h of elem.funcIndices) {
          const resolved = fIdx(h);
          if (valCtx) vIdx("function", resolved, valCtx.numFuncs);
          s.u32(resolved);
        }
      }
      // Declarative element segment for ref.func targets
      if (hasDeclaredRefs) {
        s.byte(0x03); // declarative, elemkind
        s.byte(0x00); // elemkind = funcref
        s.u32(mod.declaredFuncRefs.length);
        if (valCtx) valCtx.where = "declared func ref";
        // (#1916 S3) Emit in RESOLVED-index order. The declarative segment is
        // order-independent, and its codegen-time determinism sort
        // (class-bodies.ts) sorts by RAW handle value — but a stable func handle's
        // raw magnitude (STABLE_FUNC_BASE + ordinal) differs from its final index,
        // so once ref.func'd functions flip to the stable regime the raw sort no
        // longer yields ascending FINAL indices. Resolving then sorting here keeps
        // the segment byte-identical regardless of which refs are stable handles.
        const resolvedDeclaredRefs = mod.declaredFuncRefs.map((h) => fIdx(h)).sort((a, b) => a - b);
        for (const resolved of resolvedDeclaredRefs) {
          if (valCtx) vIdx("function", resolved, valCtx.numFuncs);
          s.u32(resolved);
        }
      }
    });
  }

  // Data-count section (id 12) — REQUIRED before the code section as soon as a
  // body contains `memory.init` / `data.drop` (#4540). Validation is
  // single-pass: the validator reaches the code section before the data
  // section, so without this it cannot bound the segment index and rejects the
  // module outright ("data count section required"). Emitted ONLY when a
  // passive segment exists, so every module that predates bulk memory keeps
  // byte-identical output.
  if (mod.dataSegments?.some((seg) => seg.passive)) {
    enc.section(SECTION.dataCount, (s) => {
      s.u32(mod.dataSegments.length);
    });
  }

  // Code section — track byte offsets for source map
  if (mod.functions.length > 0) {
    // Build code section body to determine code section payload offset
    const codeSectionBody = new WasmEncoder();
    // Collect per-function relative offset entries
    const funcRelativeEntries: { bodyOffset: number; instrOffset: number; sourcePos: SourcePos }[] = [];

    codeSectionBody.u32(mod.functions.length); // vector count
    // (#4133) How many defined functions share each name. A local-index breach
    // is usually a body installed against another function's frame, and a
    // duplicated name is the strongest single hint that that is what happened —
    // so report it AT the failure instead of leaving the reader to guess from
    // the "#2043 late-import shift" boilerplate, which is a different cause.
    const definedNameCounts = new Map<string, number>();
    for (const f of mod.functions) definedNameCounts.set(f.name, (definedNameCounts.get(f.name) ?? 0) + 1);

    // (#4134) `JS2WASM_EMIT_DUMP=1` writes one line per defined function
    // (position, name, param+local frame size) to stderr before encoding. A
    // local-index breach is a mismatch between a body and its frame, so the
    // actionable question is "which function has a frame that index WOULD fit"
    // — answerable only against the whole table. Inert unless set.
    // (#4134) Do two defined functions SHARE one body array? Bodies are assigned
    // by reference from a FunctionContext, and a shared array is a documented
    // hazard in this codebase ("`body: []` in FunctionContext (NOT
    // `body: func.body`) — shared references break savedBody/swap"). A body that
    // is still being appended to by another context is one way a function ends
    // up referencing locals its own frame never declared.
    if (typeof process !== "undefined" && process.env?.JS2WASM_EMIT_DUMP) {
      const bodyOwners = new Map<Instr[], number[]>();
      for (const [position, f] of mod.functions.entries()) {
        bodyOwners.set(f.body, [...(bodyOwners.get(f.body) ?? []), position]);
      }
      for (const [, positions] of bodyOwners) {
        if (positions.length < 2) continue;
        const named = positions.map((p) => `${p}:${mod.functions[p]!.name}`).join(", ");
        process.stderr.write(`[js2:emit] SHARED BODY ARRAY across ${positions.length} functions: ${named}\n`);
      }
    }
    if (typeof process !== "undefined" && process.env?.JS2WASM_EMIT_DUMP) {
      const lines = mod.functions.map((f, position) => {
        const params = resolveParamCount(f.typeIdx);
        return `[js2:emit] ${position}\t${params >= 0 ? params + f.locals.length : "?"}\t${f.name}`;
      });
      process.stderr.write(`${lines.join("\n")}\n`);
    }

    for (const [functionPosition, f] of mod.functions.entries()) {
      if (valCtx) {
        // (#4030/#4133) Include the position and frame size. A bare name is not
        // enough to act on: the name can be synthesized or shared by several
        // declarations, and the whole point of a local-index breach is that the
        // body does not match the frame it was installed against.
        const sharing = definedNameCounts.get(f.name) ?? 1;
        valCtx.where =
          `function '${f.name || "?"}' (position ${functionPosition}, ` +
          `${f.locals.length} declared local${f.locals.length === 1 ? "" : "s"}` +
          (sharing > 1 ? `, NAME SHARED BY ${sharing} DEFINED FUNCTIONS` : "") +
          `)`;
        const params = resolveParamCount(f.typeIdx);
        valCtx.maxLocals = params >= 0 ? params + f.locals.length : -1;
      }
      const bodyStartInSection = codeSectionBody.length;
      encodeFunctionWithSourceMap(f, codeSectionBody, bodyStartInSection, funcRelativeEntries);
    }

    const codeSectionData = codeSectionBody.finish();

    // Write the code section: id byte + length + data
    // The absolute offset of the code section payload within the final binary:
    // current enc.length + 1 (section id byte) + sizeof(u32(codeSectionData.length))
    const sectionIdPos = enc.length;
    enc.byte(SECTION.code);
    const lengthBefore = enc.length;
    enc.u32(codeSectionData.length);
    const codeSectionPayloadStart = enc.length;
    enc.bytes(codeSectionData);

    // Convert relative entries to absolute wasm byte offsets
    for (const entry of funcRelativeEntries) {
      sourceMapEntries.push({
        wasmOffset: codeSectionPayloadStart + entry.instrOffset,
        sourcePos: entry.sourcePos,
      });
    }
  }

  // Data section (active and, since #4540, passive segments for linear memory)
  if (mod.dataSegments && mod.dataSegments.length > 0) {
    enc.section(SECTION.data, (s) => {
      s.u32(mod.dataSegments.length);
      for (const seg of mod.dataSegments) {
        if (seg.passive) {
          // Passive: no memory index, no offset expression. The module copies
          // it into a destination it owns via `memory.init`.
          s.byte(0x01);
        } else {
          // Active data segment for memory 0
          s.byte(0x00); // active, memory index 0
          // Offset expression: i32.const <offset>; end
          s.byte(OP.i32_const);
          s.i32(seg.offset);
          s.byte(OP.end);
        }
        // Data bytes
        s.u32(seg.bytes.length);
        s.bytes(seg.bytes);
      }
    });
  }

  // Custom "name" section — function names for debugging/treemap.
  // NOTE (#1916/#2710): this section is built POSITIONALLY (imports in
  // declaration order, then mod.functions in array order), which IS the final
  // layout order by construction — it reads no handles, so it needs no
  // resolution and stays correct after the handle flip.
  {
    const nameEntries: { index: number; name: string }[] = [];
    // Import functions
    let funcIdx = 0;
    for (const imp of mod.imports) {
      if (imp.desc.kind === "func") {
        nameEntries.push({ index: funcIdx, name: imp.name.replace(/_import$/, "") });
        funcIdx++;
      }
    }
    // Local functions
    for (const f of mod.functions) {
      if (f.name) {
        nameEntries.push({ index: funcIdx, name: f.name });
      }
      funcIdx++;
    }
    if (nameEntries.length > 0) {
      enc.section(SECTION.custom, (s) => {
        s.name("name");
        // Subsection 1: function names
        const sub = new WasmEncoder();
        sub.u32(nameEntries.length);
        for (const entry of nameEntries) {
          sub.u32(entry.index);
          sub.name(entry.name);
        }
        const subData = sub.finish();
        s.byte(1); // subsection id = 1 (function names)
        s.u32(subData.length);
        s.bytes(subData);
      });
    }
  }

  return { binary: enc.finish(), sourceMapEntries };
}

/** Encode a function body, tracking instruction offsets for source maps */
function encodeFunctionWithSourceMap(
  f: WasmFunction,
  enc: WasmEncoder,
  _bodyStartInSection: number,
  entries: { bodyOffset: number; instrOffset: number; sourcePos: SourcePos }[],
): void {
  const body = new WasmEncoder();

  // Locals: group consecutive same-type locals
  const localGroups = groupLocals(f.locals);
  body.vector(localGroups, (group, e) => {
    e.u32(group.count);
    encodeValType(group.type, e);
  });

  // Body instructions — track positions for instructions with sourcePos
  for (const instr of f.body) {
    encodeInstrWithSourceMap(instr, body, entries, _bodyStartInSection, enc);
  }
  body.byte(OP.end);

  const bodyBytes = body.finish();
  // The function body in the code section is: u32(bodyBytes.length) + bodyBytes
  // We need to account for the u32 prefix length when computing absolute offsets
  const u32PrefixSize = leb128UnsignedSize(bodyBytes.length);

  // Adjust all entries' instrOffset: add the position of the function body data within the section
  // entries that were just added have instrOffset relative to the body encoder
  // We need to adjust them to be relative to the section start
  for (const entry of entries) {
    if (entry.bodyOffset === _bodyStartInSection) {
      // This entry belongs to this function — adjust its instrOffset
      entry.instrOffset = _bodyStartInSection + u32PrefixSize + entry.instrOffset;
    }
  }

  enc.u32(bodyBytes.length);
  enc.bytes(bodyBytes);
}

/** Encode instruction and collect source positions */
function encodeInstrWithSourceMap(
  instr: Instr,
  enc: WasmEncoder,
  entries: { bodyOffset: number; instrOffset: number; sourcePos: SourcePos }[],
  bodyStartInSection: number,
  _sectionEnc: WasmEncoder,
): void {
  // Record source position before encoding the instruction
  if (instr.sourcePos) {
    entries.push({
      bodyOffset: bodyStartInSection,
      instrOffset: enc.length, // position within the body encoder
      sourcePos: instr.sourcePos,
    });
  }
  encodeInstr(instr, enc);
}

/** Calculate the byte size of an unsigned LEB128 encoding */
function leb128UnsignedSize(value: number): number {
  let size = 0;
  do {
    value >>>= 7;
    size++;
  } while (value !== 0);
  return size;
}

export function encodeTypeDef(t: TypeDef, enc: WasmEncoder): void {
  switch (t.kind) {
    case "func":
      enc.byte(TYPE.func);
      enc.vector(t.params, (p, e) => encodeValType(p, e));
      enc.vector(t.results, (r, e) => encodeValType(r, e));
      break;
    case "struct":
      if (t.superTypeIdx !== undefined) {
        // Wrap in sub-type encoding for class inheritance
        enc.byte(t.final ? TYPE.sub_final : TYPE.sub);
        if (t.superTypeIdx >= 0) {
          // superTypeIdx < 0 is the "root of hierarchy" sentinel — only a
          // concrete (non-negative) supertype reference is range-checked.
          if (valCtx) vIdx("supertype", t.superTypeIdx, valCtx.numTypes);
          enc.u32(1); // 1 supertype
          enc.u32(t.superTypeIdx);
        } else {
          enc.u32(0); // 0 supertypes (root of hierarchy, non-final)
        }
        enc.byte(TYPE.struct);
        enc.vector(t.fields, (f, e) => encodeFieldDef(f, e));
      } else {
        enc.byte(TYPE.struct);
        enc.vector(t.fields, (f, e) => encodeFieldDef(f, e));
      }
      break;
    case "array":
      enc.byte(TYPE.array);
      encodeStorageType(t.element, enc);
      enc.byte(t.mutable ? TYPE.mut_field : TYPE.const_field);
      break;
    case "rec":
      enc.byte(TYPE.rec);
      enc.u32(t.types.length);
      for (const sub of t.types) encodeTypeDef(sub, enc);
      break;
    case "sub":
      if (t.superType !== null) {
        if (valCtx) vIdx("supertype", t.superType, valCtx.numTypes);
        enc.byte(t.final ? TYPE.sub_final : TYPE.sub);
        enc.u32(1); // 1 supertype
        enc.u32(t.superType);
      } else if (!t.final) {
        enc.byte(TYPE.sub);
        enc.u32(0); // 0 supertypes
      }
      // else: final with no super → just encode inner type
      if (t.superType !== null || !t.final) {
        encodeTypeDef(t.type, enc);
      } else {
        encodeTypeDef(t.type, enc);
      }
      break;
  }
}

export function encodeFieldDef(f: FieldDef, enc: WasmEncoder): void {
  encodeStorageType(f.type, enc);
  enc.byte(f.mutable ? TYPE.mut_field : TYPE.const_field);
}

export function encodeStorageType(t: ValType, enc: WasmEncoder): void {
  // Packed storage types (i8, i16) are only valid in struct fields and array elements
  if (t.kind === "i8") {
    enc.byte(TYPE.i8);
    return;
  }
  if (t.kind === "i16") {
    enc.byte(TYPE.i16);
    return;
  }
  encodeValType(t, enc);
}

export function encodeValType(t: ValType, enc: WasmEncoder): void {
  switch (t.kind) {
    case "i32":
      enc.byte(TYPE.i32);
      break;
    case "i64":
      enc.byte(TYPE.i64);
      break;
    case "f32":
      enc.byte(TYPE.f32);
      break;
    case "f64":
      enc.byte(TYPE.f64);
      break;
    case "v128":
      enc.byte(TYPE.v128);
      break;
    case "funcref":
      enc.byte(TYPE.funcref);
      break;
    case "externref":
      enc.byte(TYPE.externref);
      break;
    case "ref_extern":
      enc.byte(TYPE.ref);
      enc.byte(TYPE.externref); // extern abstract heap type (-17 as s33)
      break;
    case "ref":
      if (valCtx) vHeapType(t.typeIdx);
      enc.byte(TYPE.ref);
      enc.i32(t.typeIdx);
      break;
    case "ref_null":
      if (valCtx) vHeapType(t.typeIdx);
      enc.byte(TYPE.ref_null);
      enc.i32(t.typeIdx);
      break;
    case "eqref":
      enc.byte(TYPE.ref_null);
      enc.byte(TYPE.eq);
      break;
    case "anyref":
      enc.byte(TYPE.ref_null);
      enc.byte(TYPE.any);
      break;
    case "i8":
    case "i16":
      // #1939 — i8/i16 are *packed storage* types, valid only inside struct
      // fields and array elements (encoded by the dedicated path at the top of
      // this function / the field encoder). Reaching them here means a packed
      // type leaked into a value position (param/result/local/global) where
      // Wasm has no such type; silently encoding it as i32 produced a binary
      // whose declared type disagreed with the values flowing through it — a
      // downstream validation error far from the leak. Fail loud instead.
      throw new Error(
        `encodeValType: packed storage type "${t.kind}" is not valid in a value position ` +
          `(only struct fields / array elements) — a packed type leaked into a param/result/local/global`,
      );
  }
}

export function encodeImport(imp: Import, enc: WasmEncoder): void {
  enc.name(imp.module);
  enc.name(imp.name);
  switch (imp.desc.kind) {
    case "func":
      if (valCtx) vIdx("type", imp.desc.typeIdx, valCtx.numTypes);
      enc.byte(0x00);
      enc.u32(imp.desc.typeIdx);
      break;
    case "table":
      enc.byte(0x01);
      enc.byte(imp.desc.elementType === "funcref" ? TYPE.funcref : TYPE.externref);
      if (imp.desc.max !== undefined) {
        enc.byte(0x01);
        enc.u32(imp.desc.min);
        enc.u32(imp.desc.max);
      } else {
        enc.byte(0x00);
        enc.u32(imp.desc.min);
      }
      break;
    case "memory":
      enc.byte(0x02); // import kind: memory
      // limits: flags byte (0x01 = has max) then min[, max]
      if (imp.desc.max !== undefined) {
        enc.byte(0x01);
        enc.u32(imp.desc.min);
        enc.u32(imp.desc.max);
      } else {
        enc.byte(0x00);
        enc.u32(imp.desc.min);
      }
      break;
    case "global":
      enc.byte(0x03);
      encodeValType(imp.desc.type, enc);
      enc.byte(imp.desc.mutable ? 0x01 : 0x00);
      break;
    case "tag":
      if (valCtx) vIdx("type", imp.desc.typeIdx, valCtx.numTypes);
      enc.byte(0x04); // import kind: tag
      enc.byte(0x00); // attribute: exception
      enc.u32(imp.desc.typeIdx);
      break;
  }
}

export function encodeGlobal(g: GlobalDef, enc: WasmEncoder): void {
  encodeValType(g.type, enc);
  enc.byte(g.mutable ? 0x01 : 0x00);
  for (const instr of g.init) encodeInstr(instr, enc);
  enc.byte(OP.end);
}

export function encodeExport(exp: WasmExport, enc: WasmEncoder, _numImportFuncs: number): void {
  // #1916/#2710 — func/global export descriptors carry handles; resolve to
  // final indices here. Table/memory/tag spaces never shift and stay raw.
  const k = exp.desc.kind;
  const resolved = k === "func" ? fIdx(exp.desc.index) : k === "global" ? gIdx(exp.desc.index) : exp.desc.index;
  if (valCtx) {
    if (k === "func") vIdx("function", resolved, valCtx.numFuncs);
    else if (k === "global") vIdx("global", resolved, valCtx.numGlobals);
    else if (k === "table") vIdx("table", resolved, valCtx.numTables);
    else if (k === "tag") vIdx("exception tag", resolved, valCtx.numTags);
    else vIdx("memory", resolved, valCtx.numMemories);
  }
  enc.name(exp.name);
  const kindByte =
    exp.desc.kind === "func"
      ? 0x00
      : exp.desc.kind === "table"
        ? 0x01
        : exp.desc.kind === "memory"
          ? 0x02
          : exp.desc.kind === "tag"
            ? 0x04
            : 0x03;
  enc.byte(kindByte);
  enc.u32(resolved);
}

export interface LocalGroup {
  count: number;
  type: ValType;
}

export function groupLocals(locals: { type: ValType }[]): LocalGroup[] {
  const groups: LocalGroup[] = [];
  for (const local of locals) {
    const last = groups[groups.length - 1];
    if (last && valTypeEq(last.type, local.type)) {
      last.count++;
    } else {
      groups.push({ count: 1, type: local.type });
    }
  }
  return groups;
}

function valTypeEq(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") && (b.kind === "ref" || b.kind === "ref_null")) {
    return a.typeIdx === b.typeIdx;
  }
  return true;
}

export function encodeBlockType(bt: BlockType, enc: WasmEncoder): void {
  switch (bt.kind) {
    case "empty":
      enc.byte(0x40);
      break;
    case "val":
      encodeValType(bt.type, enc);
      break;
    case "type":
      if (valCtx) vIdx("block type", bt.typeIdx, valCtx.numTypes);
      enc.i32(bt.typeIdx);
      break;
  }
}

export function encodeInstr(instr: Instr, enc: WasmEncoder): void {
  switch (instr.op) {
    case "unreachable":
      enc.byte(OP.unreachable);
      break;
    case "nop":
      enc.byte(OP.nop);
      break;
    case "block":
      enc.byte(OP.block);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.body) encodeInstr(i, enc);
      enc.byte(OP.end);
      break;
    case "loop":
      enc.byte(OP.loop);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.body) encodeInstr(i, enc);
      enc.byte(OP.end);
      break;
    case "if": {
      enc.byte(OP.if);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.then) encodeInstr(i, enc);
      const hasElse = instr.else && instr.else.length > 0;
      const needsElse = hasElse || instr.blockType.kind === "val";
      if (needsElse) {
        enc.byte(OP.else);
        if (hasElse) {
          for (const i of instr.else!) encodeInstr(i, enc);
        } else {
          // Valued if with no else — emit unreachable to satisfy validator
          enc.byte(OP.unreachable);
        }
      }
      enc.byte(OP.end);
      break;
    }
    case "br":
      enc.byte(OP.br);
      enc.u32(instr.depth);
      break;
    case "br_if":
      enc.byte(OP.br_if);
      enc.u32(instr.depth);
      break;
    case "return":
      enc.byte(OP.return);
      break;
    case "call": {
      const target = fIdx(instr.funcIdx);
      if (valCtx) vIdx("function", target, valCtx.numFuncs);
      enc.byte(OP.call);
      enc.u32(target);
      break;
    }
    case "return_call": {
      const target = fIdx(instr.funcIdx);
      if (valCtx) vIdx("function", target, valCtx.numFuncs);
      enc.byte(OP.return_call);
      enc.u32(target);
      break;
    }
    case "call_indirect":
      if (valCtx) {
        vIdx("type", instr.typeIdx, valCtx.numTypes);
        vIdx("table", instr.tableIdx, valCtx.numTables);
      }
      enc.byte(OP.call_indirect);
      enc.u32(instr.typeIdx);
      enc.u32(instr.tableIdx);
      break;
    case "drop":
      enc.byte(OP.drop);
      break;
    case "select":
      enc.byte(OP.select);
      break;
    case "local.get":
      // (#4134) name the opcode: a local breach needs the SITE, not just the frame.
      if (valCtx && valCtx.maxLocals >= 0) vIdx(`local (${instr.op})`, instr.index, valCtx.maxLocals);
      enc.byte(OP.local_get);
      enc.u32(instr.index);
      break;
    case "local.set":
      // (#4134) name the opcode: a local breach needs the SITE, not just the frame.
      if (valCtx && valCtx.maxLocals >= 0) vIdx(`local (${instr.op})`, instr.index, valCtx.maxLocals);
      enc.byte(OP.local_set);
      enc.u32(instr.index);
      break;
    case "local.tee":
      // (#4134) name the opcode: a local breach needs the SITE, not just the frame.
      if (valCtx && valCtx.maxLocals >= 0) vIdx(`local (${instr.op})`, instr.index, valCtx.maxLocals);
      enc.byte(OP.local_tee);
      enc.u32(instr.index);
      break;
    case "global.get": {
      const g = gIdx(instr.index);
      if (valCtx) vIdx("global", g, valCtx.numGlobals);
      enc.byte(OP.global_get);
      enc.u32(g);
      break;
    }
    case "global.set": {
      const g = gIdx(instr.index);
      if (valCtx) vIdx("global", g, valCtx.numGlobals);
      enc.byte(OP.global_set);
      enc.u32(g);
      break;
    }
    case "i32.const":
      enc.byte(OP.i32_const);
      enc.i32(instr.value);
      break;
    case "i64.const":
      enc.byte(OP.i64_const);
      enc.i64(instr.value);
      break;
    case "i64.add":
      enc.byte(OP.i64_add);
      break;
    case "i64.sub":
      enc.byte(OP.i64_sub);
      break;
    case "i64.mul":
      enc.byte(OP.i64_mul);
      break;
    case "i64.div_s":
      enc.byte(OP.i64_div_s);
      break;
    case "i64.div_u":
      enc.byte(OP.i64_div_u);
      break;
    case "i64.rem_s":
      enc.byte(OP.i64_rem_s);
      break;
    case "i64.rem_u":
      enc.byte(OP.i64_rem_u);
      break;
    case "i64.eq":
      enc.byte(OP.i64_eq);
      break;
    case "i64.ne":
      enc.byte(OP.i64_ne);
      break;
    case "i64.lt_s":
      enc.byte(OP.i64_lt_s);
      break;
    case "i64.lt_u":
      enc.byte(OP.i64_lt_u);
      break;
    case "i64.le_s":
      enc.byte(OP.i64_le_s);
      break;
    case "i64.le_u":
      enc.byte(OP.i64_le_u);
      break;
    case "i64.gt_s":
      enc.byte(OP.i64_gt_s);
      break;
    case "i64.gt_u":
      enc.byte(OP.i64_gt_u);
      break;
    case "i64.ge_s":
      enc.byte(OP.i64_ge_s);
      break;
    case "i64.ge_u":
      enc.byte(OP.i64_ge_u);
      break;
    case "i64.eqz":
      enc.byte(OP.i64_eqz);
      break;
    case "i64.and":
      enc.byte(OP.i64_and);
      break;
    case "i64.or":
      enc.byte(OP.i64_or);
      break;
    case "i64.xor":
      enc.byte(OP.i64_xor);
      break;
    case "i64.shl":
      enc.byte(OP.i64_shl);
      break;
    case "i64.shr_s":
      enc.byte(OP.i64_shr_s);
      break;
    case "i64.shr_u":
      enc.byte(OP.i64_shr_u);
      break;
    case "i64.extend_i32_s":
      enc.byte(OP.i64_extend_i32_s);
      break;
    case "i64.extend_i32_u":
      enc.byte(OP.i64_extend_i32_u);
      break;
    case "i64.trunc_f64_s":
      enc.byte(OP.i64_trunc_f64_s);
      break;
    case "f64.convert_i64_s":
      enc.byte(OP.f64_convert_i64_s);
      break;
    case "f64.convert_i64_u":
      enc.byte(OP.f64_convert_i64_u);
      break;
    case "i64.reinterpret_f64":
      enc.byte(OP.i64_reinterpret_f64);
      break;
    case "f64.reinterpret_i64":
      enc.byte(OP.f64_reinterpret_i64);
      break;
    case "i32.reinterpret_f32":
      enc.byte(OP.i32_reinterpret_f32);
      break;
    case "f32.reinterpret_i32":
      enc.byte(OP.f32_reinterpret_i32);
      break;
    case "f64.const":
      enc.byte(OP.f64_const);
      enc.f64(instr.value);
      break;
    case "f32.const":
      enc.byte(OP.f32_const);
      enc.f32(instr.value);
      break;
    case "i32.eqz":
      enc.byte(OP.i32_eqz);
      break;
    case "i32.eq":
      enc.byte(OP.i32_eq);
      break;
    case "i32.ne":
      enc.byte(OP.i32_ne);
      break;
    case "i32.lt_s":
      enc.byte(OP.i32_lt_s);
      break;
    case "i32.le_s":
      enc.byte(OP.i32_le_s);
      break;
    case "i32.gt_s":
      enc.byte(OP.i32_gt_s);
      break;
    case "i32.ge_s":
      enc.byte(OP.i32_ge_s);
      break;
    case "i32.ge_u":
      enc.byte(OP.i32_ge_u);
      break;
    case "i32.add":
      enc.byte(OP.i32_add);
      break;
    case "i32.sub":
      enc.byte(OP.i32_sub);
      break;
    case "i32.mul":
      enc.byte(OP.i32_mul);
      break;
    case "i32.and":
      enc.byte(OP.i32_and);
      break;
    case "i32.or":
      enc.byte(OP.i32_or);
      break;
    case "i32.xor":
      enc.byte(OP.i32_xor);
      break;
    case "i32.shl":
      enc.byte(OP.i32_shl);
      break;
    case "i32.shr_s":
      enc.byte(OP.i32_shr_s);
      break;
    case "i32.shr_u":
      enc.byte(OP.i32_shr_u);
      break;
    case "i32.clz":
      enc.byte(OP.i32_clz);
      break;
    case "i32.trunc_sat_f64_s":
      enc.byte(OP.misc_prefix);
      enc.byte(OP.i32_trunc_sat_f64_s);
      break;
    case "i32.trunc_sat_f64_u":
      enc.byte(OP.misc_prefix);
      enc.byte(OP.i32_trunc_sat_f64_u);
      break;
    case "i64.trunc_sat_f64_s":
      enc.byte(OP.misc_prefix);
      enc.byte(OP.i64_trunc_sat_f64_s);
      break;
    case "f64.eq":
      enc.byte(OP.f64_eq);
      break;
    case "f64.ne":
      enc.byte(OP.f64_ne);
      break;
    case "f64.lt":
      enc.byte(OP.f64_lt);
      break;
    case "f64.le":
      enc.byte(OP.f64_le);
      break;
    case "f64.gt":
      enc.byte(OP.f64_gt);
      break;
    case "f64.ge":
      enc.byte(OP.f64_ge);
      break;
    case "f64.abs":
      enc.byte(OP.f64_abs);
      break;
    case "f64.neg":
      enc.byte(OP.f64_neg);
      break;
    case "f64.ceil":
      enc.byte(OP.f64_ceil);
      break;
    case "f64.floor":
      enc.byte(OP.f64_floor);
      break;
    case "f64.trunc":
      enc.byte(OP.f64_trunc);
      break;
    case "f64.nearest":
      enc.byte(OP.f64_nearest);
      break;
    case "f64.sqrt":
      enc.byte(OP.f64_sqrt);
      break;
    case "f64.add":
      enc.byte(OP.f64_add);
      break;
    case "f64.sub":
      enc.byte(OP.f64_sub);
      break;
    case "f64.mul":
      enc.byte(OP.f64_mul);
      break;
    case "f64.div":
      enc.byte(OP.f64_div);
      break;
    case "f64.min":
      enc.byte(OP.f64_min);
      break;
    case "f64.max":
      enc.byte(OP.f64_max);
      break;
    case "f64.copysign":
      enc.byte(OP.f64_copysign);
      break;
    case "i32.wrap_i64":
      enc.byte(OP.i32_wrap_i64);
      break;
    case "i32.trunc_f64_s":
      enc.byte(OP.i32_trunc_f64_s);
      break;
    case "i32.trunc_f64_u":
      // #1939 — was a union member with no encoder case (silently dropped if
      // ever emitted). Unsigned f64→i32 truncation, opcode 0xab.
      enc.byte(OP.i32_trunc_f64_u);
      break;
    case "f64.convert_i32_s":
      enc.byte(OP.f64_convert_i32_s);
      break;
    case "f64.convert_i32_u":
      enc.byte(OP.f64_convert_i32_u);
      break;
    case "ref.null":
      if (valCtx) vHeapType(instr.typeIdx);
      enc.byte(OP.ref_null);
      enc.i32(instr.typeIdx);
      break;
    case "ref.null.extern":
      enc.byte(OP.ref_null);
      enc.byte(TYPE.externref);
      break;
    case "ref.null.eq":
      enc.byte(OP.ref_null);
      enc.byte(TYPE.eq);
      break;
    case "ref.null.func":
      enc.byte(OP.ref_null);
      enc.byte(TYPE.funcref);
      break;
    case "ref.is_null":
      enc.byte(OP.ref_is_null);
      break;
    case "ref.as_non_null":
      enc.byte(OP.ref_as_non_null);
      break;
    case "ref.eq":
      enc.byte(OP.ref_eq);
      break;
    case "ref.cast":
      if (valCtx) vHeapType(instr.typeIdx);
      enc.byte(GC.prefix);
      enc.byte(GC.ref_cast);
      enc.i32(instr.typeIdx);
      break;
    case "ref.cast_null":
      if (valCtx) vHeapType(instr.typeIdx);
      enc.byte(GC.prefix);
      enc.byte(GC.ref_cast_null);
      enc.i32(instr.typeIdx);
      break;
    case "any.convert_extern":
      enc.byte(GC.prefix);
      enc.byte(GC.any_convert_extern);
      break;
    case "ref.i31":
      enc.byte(GC.prefix);
      enc.byte(GC.ref_i31);
      break;
    case "i31.get_s":
      enc.byte(GC.prefix);
      enc.byte(GC.i31_get_s);
      break;
    case "extern.convert_any":
      enc.byte(GC.prefix);
      enc.byte(GC.extern_convert_any);
      break;
    case "ref.test":
      if (valCtx) vHeapType(instr.typeIdx);
      enc.byte(GC.prefix);
      enc.byte(GC.ref_test);
      enc.i32(instr.typeIdx);
      break;
    case "struct.new":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.struct_new);
      enc.u32(instr.typeIdx);
      break;
    case "struct.get":
      if (valCtx) vStructField(instr.typeIdx, instr.fieldIdx, "struct.get");
      enc.byte(GC.prefix);
      enc.byte(GC.struct_get);
      enc.u32(instr.typeIdx);
      enc.u32(instr.fieldIdx);
      break;
    case "struct.set":
      if (valCtx) vStructField(instr.typeIdx, instr.fieldIdx, "struct.set");
      enc.byte(GC.prefix);
      enc.byte(GC.struct_set);
      enc.u32(instr.typeIdx);
      enc.u32(instr.fieldIdx);
      break;
    case "array.new":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.array_new);
      enc.u32(instr.typeIdx);
      break;
    case "array.new_fixed":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.array_new_fixed);
      enc.u32(instr.typeIdx);
      enc.u32(instr.length);
      break;
    case "array.new_default":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.array_new_default);
      enc.u32(instr.typeIdx);
      break;
    case "array.get":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.array_get);
      enc.u32(instr.typeIdx);
      break;
    case "array.get_s":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.array_get_s);
      enc.u32(instr.typeIdx);
      break;
    case "array.get_u":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.array_get_u);
      enc.u32(instr.typeIdx);
      break;
    case "array.set":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.array_set);
      enc.u32(instr.typeIdx);
      break;
    case "array.len":
      enc.byte(GC.prefix);
      enc.byte(GC.array_len);
      break;
    case "array.copy":
      if (valCtx) {
        vIdx("type", instr.dstTypeIdx, valCtx.numTypes);
        vIdx("type", instr.srcTypeIdx, valCtx.numTypes);
      }
      enc.byte(GC.prefix);
      enc.byte(GC.array_copy);
      enc.u32(instr.dstTypeIdx);
      enc.u32(instr.srcTypeIdx);
      break;
    case "array.fill":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(GC.prefix);
      enc.byte(GC.array_fill);
      enc.u32(instr.typeIdx);
      break;
    case "ref.func": {
      const target = fIdx(instr.funcIdx);
      if (valCtx) vIdx("function", target, valCtx.numFuncs);
      enc.byte(OP.ref_func);
      enc.u32(target);
      break;
    }
    case "call_ref":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(OP.call_ref);
      enc.u32(instr.typeIdx);
      break;
    case "return_call_ref":
      if (valCtx) vIdx("type", instr.typeIdx, valCtx.numTypes);
      enc.byte(OP.return_call_ref);
      enc.u32(instr.typeIdx);
      break;
    case "memory.size":
      enc.byte(OP.memory_size);
      enc.byte(0x00);
      break;
    case "memory.grow":
      enc.byte(OP.memory_grow);
      enc.byte(0x00);
      break;
    // Bulk memory (#4540). Both are `0xFC <u32 subopcode> …`; the module MUST
    // also carry a data-count section (id 12) or a validator rejects
    // `memory.init` before it ever reads the data section — see emitBinary.
    case "memory.init":
      enc.byte(OP.misc_prefix);
      enc.u32(0x08);
      enc.u32(instr.dataIdx);
      enc.byte(0x00); // memory index
      break;
    case "data.drop":
      enc.byte(OP.misc_prefix);
      enc.u32(0x09);
      enc.u32(instr.dataIdx);
      break;
    // `memory.copy` carries TWO memory indices (dst then src) and `memory.fill`
    // one. Neither needs the data-count section — that requirement is specific
    // to the two opcodes above, which name a data segment.
    case "memory.copy":
      enc.byte(OP.misc_prefix);
      enc.u32(0x0a);
      enc.byte(0x00);
      enc.byte(0x00);
      break;
    case "memory.fill":
      enc.byte(OP.misc_prefix);
      enc.u32(0x0b);
      enc.byte(0x00);
      break;
    case "throw":
      if (valCtx) vIdx("exception tag", instr.tagIdx, valCtx.numTags);
      enc.byte(OP.throw);
      enc.u32(instr.tagIdx);
      break;
    case "rethrow":
      enc.byte(OP.rethrow);
      enc.u32(instr.depth);
      break;
    case "try_table": {
      enc.byte(OP.try_table);
      encodeBlockType(instr.blockType, enc);
      enc.u32(instr.catches.length);
      for (const clause of instr.catches) {
        switch (clause.kind) {
          case "catch":
            enc.byte(0x00);
            if (clause.tagIdx === undefined) throw new Error("try_table catch is missing a tag index");
            if (valCtx) vIdx("exception tag", clause.tagIdx, valCtx.numTags);
            enc.u32(clause.tagIdx);
            enc.u32(clause.depth);
            break;
          case "catch_ref":
            enc.byte(0x01);
            if (clause.tagIdx === undefined) throw new Error("try_table catch_ref is missing a tag index");
            if (valCtx) vIdx("exception tag", clause.tagIdx, valCtx.numTags);
            enc.u32(clause.tagIdx);
            enc.u32(clause.depth);
            break;
          case "catch_all":
            enc.byte(0x02);
            enc.u32(clause.depth);
            break;
          case "catch_all_ref":
            enc.byte(0x03);
            enc.u32(clause.depth);
            break;
        }
      }
      for (const i of instr.body) encodeInstr(i, enc);
      enc.byte(OP.end);
      break;
    }
    case "try": {
      enc.byte(OP.try);
      encodeBlockType(instr.blockType, enc);
      for (const i of instr.body) encodeInstr(i, enc);
      // Encode catch clauses (catch $tag)
      for (const c of instr.catches) {
        if (valCtx) vIdx("exception tag", c.tagIdx, valCtx.numTags);
        enc.byte(OP.catch);
        enc.u32(c.tagIdx);
        for (const i of c.body) encodeInstr(i, enc);
      }
      // Encode catch_all clause
      if (instr.catchAll) {
        enc.byte(OP.catch_all);
        for (const i of instr.catchAll) encodeInstr(i, enc);
      }
      enc.byte(OP.end);
      break;
    }
    // Memory load/store (linear memory)
    case "i32.load":
      enc.byte(OP.i32_load);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.load8_u":
      enc.byte(OP.i32_load8_u);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.load8_s":
      enc.byte(OP.i32_load8_s);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.load16_u":
      enc.byte(OP.i32_load16_u);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.store":
      enc.byte(OP.i32_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i64.store":
      enc.byte(OP.i64_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.store8":
      enc.byte(OP.i32_store8);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "i32.store16":
      enc.byte(OP.i32_store16);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    // Integer division and remainder
    case "i32.div_s":
      enc.byte(OP.i32_div_s);
      break;
    case "i32.div_u":
      enc.byte(OP.i32_div_u);
      break;
    case "i32.rem_s":
      enc.byte(OP.i32_rem_s);
      break;
    case "i32.rem_u":
      enc.byte(OP.i32_rem_u);
      break;
    // Unsigned comparisons
    case "i32.lt_u":
      enc.byte(OP.i32_lt_u);
      break;
    case "i32.le_u":
      enc.byte(OP.i32_le_u);
      break;
    case "i32.gt_u":
      enc.byte(OP.i32_gt_u);
      break;
    // f64 memory load/store
    case "f64.load":
      enc.byte(OP.f64_load);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "f64.store":
      enc.byte(OP.f64_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    // f32 memory load/store and conversion
    case "f32.load":
      enc.byte(OP.f32_load);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "f32.store":
      enc.byte(OP.f32_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "f32.demote_f64":
      enc.byte(OP.f32_demote_f64);
      break;
    case "f64.promote_f32":
      enc.byte(OP.f64_promote_f32);
      break;

    // ---- SIMD v128 instructions ----
    case "v128.const":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_const);
      enc.v128(instr.bytes);
      break;
    case "v128.load":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.store":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_store);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.not":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_not);
      break;
    case "v128.and":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_and);
      break;
    case "v128.andnot":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_andnot);
      break;
    case "v128.or":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_or);
      break;
    case "v128.xor":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_xor);
      break;
    case "v128.bitselect":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_bitselect);
      break;
    case "v128.any_true":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_any_true);
      break;

    // i8x16
    case "i8x16.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_splat);
      break;
    case "i8x16.extract_lane_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_extract_lane_s);
      enc.byte(instr.lane);
      break;
    case "i8x16.extract_lane_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_extract_lane_u);
      enc.byte(instr.lane);
      break;
    case "i8x16.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_replace_lane);
      enc.byte(instr.lane);
      break;
    case "i8x16.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_eq);
      break;
    case "i8x16.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_ne);
      break;
    case "i8x16.all_true":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_all_true);
      break;
    case "i8x16.bitmask":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_bitmask);
      break;
    case "i8x16.swizzle":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_swizzle);
      break;
    case "i8x16.shuffle":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_shuffle);
      for (const lane of instr.lanes) enc.byte(lane);
      break;
    case "i8x16.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_add);
      break;
    case "i8x16.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_sub);
      break;
    case "i8x16.min_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_min_u);
      break;
    case "i8x16.max_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i8x16_max_u);
      break;

    // i16x8
    case "i16x8.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_splat);
      break;
    case "i16x8.extract_lane_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_extract_lane_s);
      enc.byte(instr.lane);
      break;
    case "i16x8.extract_lane_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_extract_lane_u);
      enc.byte(instr.lane);
      break;
    case "i16x8.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_replace_lane);
      enc.byte(instr.lane);
      break;
    case "i16x8.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_eq);
      break;
    case "i16x8.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_ne);
      break;
    case "i16x8.lt_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_lt_s);
      break;
    case "i16x8.gt_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_gt_s);
      break;
    case "i16x8.all_true":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_all_true);
      break;
    case "i16x8.bitmask":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_bitmask);
      break;
    case "i16x8.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_add);
      break;
    case "i16x8.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_sub);
      break;
    case "i16x8.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_mul);
      break;
    case "i16x8.shl":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_shl);
      break;
    case "i16x8.shr_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i16x8_shr_u);
      break;

    // i32x4
    case "i32x4.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_splat);
      break;
    case "i32x4.extract_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_extract_lane);
      enc.byte(instr.lane);
      break;
    case "i32x4.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_replace_lane);
      enc.byte(instr.lane);
      break;
    case "i32x4.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_eq);
      break;
    case "i32x4.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_ne);
      break;
    case "i32x4.all_true":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_all_true);
      break;
    case "i32x4.bitmask":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_bitmask);
      break;
    case "i32x4.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_add);
      break;
    case "i32x4.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_sub);
      break;
    case "i32x4.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_mul);
      break;
    case "i32x4.shl":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_shl);
      break;
    case "i32x4.shr_s":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_shr_s);
      break;
    case "i32x4.shr_u":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i32x4_shr_u);
      break;

    // i64x2
    case "i64x2.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_splat);
      break;
    case "i64x2.extract_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_extract_lane);
      enc.byte(instr.lane);
      break;
    case "i64x2.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_replace_lane);
      enc.byte(instr.lane);
      break;
    case "i64x2.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_add);
      break;
    case "i64x2.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_sub);
      break;
    case "i64x2.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_mul);
      break;
    case "i64x2.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_eq);
      break;
    case "i64x2.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.i64x2_ne);
      break;

    // f32x4
    case "f32x4.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_splat);
      break;
    case "f32x4.extract_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_extract_lane);
      enc.byte(instr.lane);
      break;
    case "f32x4.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_replace_lane);
      enc.byte(instr.lane);
      break;
    case "f32x4.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_eq);
      break;
    case "f32x4.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_add);
      break;
    case "f32x4.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_sub);
      break;
    case "f32x4.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_mul);
      break;
    case "f32x4.div":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f32x4_div);
      break;

    // f64x2
    case "f64x2.splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_splat);
      break;
    case "f64x2.extract_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_extract_lane);
      enc.byte(instr.lane);
      break;
    case "f64x2.replace_lane":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_replace_lane);
      enc.byte(instr.lane);
      break;
    case "f64x2.eq":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_eq);
      break;
    case "f64x2.ne":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_ne);
      break;
    case "f64x2.add":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_add);
      break;
    case "f64x2.sub":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_sub);
      break;
    case "f64x2.mul":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_mul);
      break;
    case "f64x2.div":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.f64x2_div);
      break;

    // SIMD load splat variants
    case "v128.load8_splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load8_splat);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load16_splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load16_splat);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load32_splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load32_splat);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load64_splat":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load64_splat);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load32_zero":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load32_zero);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "v128.load64_zero":
      enc.byte(OP.simd_prefix);
      enc.u32(SIMD.v128_load64_zero);
      enc.u32(instr.align);
      enc.u32(instr.offset);
      break;
    case "end":
      // #1939 — the explicit structured-block terminator (0x0b). Block/loop/if
      // bodies normally emit their own trailing `end` in the structured
      // encoders, but a standalone `end` instr is a valid union member and was
      // previously a silent drop.
      enc.byte(OP.end);
      break;
    case "br_table":
      // #2952 slice 4 — 0x0e, vec(labelidx) targets + default labelidx.
      // (Was a payload-less stub that failed loud, #1939.)
      enc.byte(OP.br_table);
      enc.u32(instr.targets.length);
      for (const t of instr.targets) enc.u32(t);
      enc.u32(instr.defaultDepth);
      break;
    // #1939 — fail loud on an op with no encoding case. The `never` binding is
    // a compile-time exhaustiveness check over the real Instr union, so a new
    // union variant without a matching encoding case is a type error here rather
    // than a silent omission from the binary (the worst failure shape: it
    // surfaces far downstream as an opaque wasm validation error with no link to
    // the source op). The runtime throw is the belt-and-braces backstop for any
    // remaining `as Instr` assertion that injects an off-union op string. The
    // double-cast `as unknown as Instr` form (#1095) has been eliminated.
    default: {
      const unknown: never = instr;
      throw new Error(`encodeInstr: unknown op "${(unknown as { op?: string }).op ?? "<no op>"}"`);
    }
  }
}

/** Emit a sourceMappingURL custom section */
export function emitSourceMappingURLSection(enc: WasmEncoder, url: string): void {
  enc.section(SECTION.custom, (s) => {
    s.name("sourceMappingURL");
    s.name(url);
  });
}
