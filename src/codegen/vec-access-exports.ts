// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// vec-access-exports.ts — the `__vec_get` / `__vec_set` / `__vec_push` /
// `__vec_pop` / `__vec_len` / `__vec_set_byte` / `__new_vec_f64` / `__dv_byte_*`
// host-dispatch export subsystem (#3272, extracted verbatim from index.ts).
// These emit ref.test/ref.cast shape-dispatch exports so a JS host can iterate
// WasmGC vec structs coerced to externref. index.ts imports these back for the
// finalize passes and re-exports `reserveVecMethodHelper` for its compile-time
// callers (calls.ts, property-access.ts, closed-method-dispatch.ts).

import type { FuncHandle, Instr, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { undefinedExternInstrs } from "./any-helpers.js"; // (#3315)
import { ensureHoleType } from "./array-holes.js";
import type { CodegenContext } from "./context/types.js";
import { exportFunc } from "./emit-helpers.js";
import { ensureGetUndefined } from "./expressions/late-imports.js";
import { definedFuncAt, definedFuncHandleOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-planning.js";
import { addUnionImports } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { flushLateImportShifts } from "./shared.js";
import { UNDEF_F64_BITS } from "./value-tags.js"; // (#3315)
import { emitVecDefineWritebackExports } from "./vec-define-writeback.js";
import { guardVecElementRead } from "./vec-oob-read.js";

export const VEC_HOST_BRIDGE_ROLE = "vec-host-bridge";

export type VecHostBridgeKind = "len" | "get" | "is-vec" | "mut-supported" | "push" | "pop";

interface VecHostBridgeDefinition {
  readonly kind: VecHostBridgeKind;
  readonly name: string;
  readonly ordinal: number;
  readonly params: readonly ValType[];
  readonly results: readonly ValType[];
  readonly placeholder: readonly Instr[];
}

interface VecHostBridgeAllocation {
  readonly definition: VecHostBridgeDefinition;
  readonly func: WasmFunction;
}

const VEC_HOST_BRIDGE_DEFINITIONS: readonly VecHostBridgeDefinition[] = Object.freeze([
  Object.freeze({
    kind: "len",
    name: "__vec_len",
    ordinal: 0,
    params: Object.freeze([{ kind: "externref" } as ValType]),
    results: Object.freeze([{ kind: "i32" } as ValType]),
    placeholder: Object.freeze([{ op: "i32.const", value: 0 } as Instr]),
  }),
  Object.freeze({
    kind: "get",
    name: "__vec_get",
    ordinal: 1,
    params: Object.freeze([{ kind: "externref" } as ValType, { kind: "i32" } as ValType]),
    results: Object.freeze([{ kind: "externref" } as ValType]),
    placeholder: Object.freeze([{ op: "ref.null.extern" } as Instr]),
  }),
  Object.freeze({
    kind: "is-vec",
    name: "__is_vec",
    ordinal: 2,
    params: Object.freeze([{ kind: "externref" } as ValType]),
    results: Object.freeze([{ kind: "i32" } as ValType]),
    placeholder: Object.freeze([{ op: "i32.const", value: 0 } as Instr]),
  }),
  Object.freeze({
    kind: "mut-supported",
    name: "__vec_mut_supported",
    ordinal: 3,
    params: Object.freeze([{ kind: "externref" } as ValType]),
    results: Object.freeze([{ kind: "i32" } as ValType]),
    placeholder: Object.freeze([{ op: "i32.const", value: 0 } as Instr]),
  }),
  Object.freeze({
    kind: "push",
    name: "__vec_push",
    ordinal: 4,
    params: Object.freeze([{ kind: "externref" } as ValType, { kind: "externref" } as ValType]),
    results: Object.freeze([{ kind: "i32" } as ValType]),
    placeholder: Object.freeze([{ op: "i32.const", value: 0 } as Instr]),
  }),
  Object.freeze({
    kind: "pop",
    name: "__vec_pop",
    ordinal: 5,
    params: Object.freeze([{ kind: "externref" } as ValType]),
    results: Object.freeze([{ kind: "externref" } as ValType]),
    placeholder: Object.freeze([{ op: "ref.null.extern" } as Instr]),
  }),
]);

export type VecHostBridgeMaterializerElementKind = "f64" | "i32" | "externref";

const VEC_HOST_BRIDGE_MATERIALIZER_ORDINALS: Readonly<Record<VecHostBridgeMaterializerElementKind, number>> = (() => {
  for (const [index, definition] of VEC_HOST_BRIDGE_DEFINITIONS.entries()) {
    if (definition.ordinal !== index) {
      throw new Error(`vec host bridge ${definition.kind} has non-contiguous ordinal ${definition.ordinal}`);
    }
  }
  const firstMaterializerOrdinal = VEC_HOST_BRIDGE_DEFINITIONS.length;
  if (firstMaterializerOrdinal !== 6) {
    throw new Error(`vec host bridge materializer ABI must start at ordinal 6, got ${firstMaterializerOrdinal}`);
  }
  return Object.freeze({
    f64: firstMaterializerOrdinal,
    i32: firstMaterializerOrdinal + 1,
    externref: firstMaterializerOrdinal + 2,
  });
})();

/** Program ABI derived ordinal for the host-to-vec materializer family. */
export function vecHostBridgeMaterializerOrdinal(kind: VecHostBridgeMaterializerElementKind): number {
  return VEC_HOST_BRIDGE_MATERIALIZER_ORDINALS[kind];
}

const vecHostBridgeAllocations = new WeakMap<CodegenContext, ReadonlyMap<VecHostBridgeKind, VecHostBridgeAllocation>>();

function vecHostBridgeDefinition(kind: VecHostBridgeKind): VecHostBridgeDefinition {
  const definition = VEC_HOST_BRIDGE_DEFINITIONS.find((candidate) => candidate.kind === kind);
  if (!definition) throw new Error(`unknown vec host bridge kind ${kind}`);
  return definition;
}

/** Reserved physical export namespace consumed by the JS runtime adapter. */
export function vecHostBridgePhysicalExportBase(kind: VecHostBridgeKind): string {
  return `$v${vecHostBridgeDefinition(kind).ordinal}`;
}

/**
 * Reserve all six core vec host bridges as one exact allocator-owned family.
 *
 * The family is allocated in fixed ordinal order and only then published to
 * the Program ABI registry. Export publication is delayed until every source
 * export is known. `funcMap` remains a best-effort compatibility alias: an
 * existing same-labelled source callable is never overwritten.
 */
function ensureVecHostBridgeAllocations(ctx: CodegenContext): ReadonlyMap<VecHostBridgeKind, VecHostBridgeAllocation> {
  const existing = vecHostBridgeAllocations.get(ctx);
  if (existing) return existing;

  const allocations = new Map<VecHostBridgeKind, VecHostBridgeAllocation>();
  const observations: {
    role: string;
    roleOrdinal: number;
    derivedOrdinal: number;
    displayName: string;
    funcIdx: FuncHandle;
  }[] = [];
  for (const definition of VEC_HOST_BRIDGE_DEFINITIONS) {
    const typeIdx = addFuncType(ctx, [...definition.params], [...definition.results], `$${definition.name}_type`);
    // Keep the bridge target layout-independent from the moment it is
    // allocated. These helpers are reserved while function bodies are still
    // compiling, and later imports can change the absolute function prefix.
    // A live `numImportFuncs + functions.length` index can therefore land on
    // the preceding dispatcher (for example `__set_member_createContext`)
    // after the final import set is known. Stable handles resolve against the
    // allocator-owned function object at emit time instead.
    const funcIdx = mintDefinedFunc(ctx);
    const func = {
      name: definition.name,
      typeIdx,
      locals: [],
      body: [...definition.placeholder],
      exported: false,
    } as WasmFunction;
    pushDefinedFunc(ctx, funcIdx, func);
    if (!ctx.funcMap.has(definition.name)) ctx.funcMap.set(definition.name, funcIdx);
    allocations.set(definition.kind, Object.freeze({ definition, func }));
    observations.push({
      role: VEC_HOST_BRIDGE_ROLE,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.vecHostBridge,
      derivedOrdinal: definition.ordinal,
      displayName: definition.name,
      funcIdx,
    });
  }

  ctx.programAbiCallables?.observeEntrySourceSupports(observations);
  const published = new Map(allocations);
  vecHostBridgeAllocations.set(ctx, published);
  return published;
}

/**
 * Publish collision-safe physical exports after every user export is known.
 *
 * The historical logical name is the zero-overhead fast path. Physical aliases
 * are emitted only when a user owns that logical name or already occupies the
 * exact short family, so ordinary modules retain the pre-migration export
 * section byte-for-byte.
 */
function publishVecHostBridgeExports(ctx: CodegenContext): void {
  const allocations = ensureVecHostBridgeAllocations(ctx);
  const occupied = new Set(ctx.mod.exports.map((entry) => entry.name));
  for (const definition of VEC_HOST_BRIDGE_DEFINITIONS) {
    const allocation = allocations.get(definition.kind);
    const funcIdx = allocation ? definedFuncHandleOf(ctx, allocation.func) : undefined;
    if (!allocation || funcIdx === undefined) {
      throw new Error(`cannot publish vec host bridge ${definition.kind} without its exact allocator object`);
    }
    const physicalBase = vecHostBridgePhysicalExportBase(definition.kind);
    let maxOccupiedSuffix = -1;
    for (const name of occupied) {
      if (!name.startsWith(physicalBase)) continue;
      const suffix = name.slice(physicalBase.length);
      if (/^\$*$/.test(suffix)) maxOccupiedSuffix = Math.max(maxOccupiedSuffix, suffix.length);
    }
    const logicalNameOccupied = occupied.has(definition.name);
    if (!logicalNameOccupied) {
      exportFunc(ctx.mod, definition.name, funcIdx);
      occupied.add(definition.name);
    }
    if (logicalNameOccupied || maxOccupiedSuffix >= 0) {
      // Fill every free gap through one slot beyond the last occupied suffix.
      // This preserves colliding user exports while leaving a contiguous run
      // whose final function is always the structural helper. The runtime can
      // therefore recover the exact helper without a name side table.
      for (let suffixLength = 0; suffixLength <= maxOccupiedSuffix + 1; suffixLength++) {
        const physicalName = `${physicalBase}${"$".repeat(suffixLength)}`;
        if (occupied.has(physicalName)) continue;
        exportFunc(ctx.mod, physicalName, funcIdx);
        occupied.add(physicalName);
      }
    }
    allocation.func.exported = true;
  }
}

/**
 * Rebase the public vec bridge exports after dead-layout elimination and the
 * final import batch. The bridge functions are allocated early with live
 * indices, while later compatibility imports can move the defined-function
 * suffix. Most emitters are repaired by the late-import shifter, but exports
 * published before the last batch have no function-body traversal to repair
 * them. Resolve by the allocator-owned function object at the freeze point.
 */
export function finalizeVecHostBridgeExports(ctx: CodegenContext): void {
  const allocations = vecHostBridgeAllocations.get(ctx);
  if (!allocations) return;
  // Dead-import elimination can remove speculative imports without updating
  // the context's cached `numImportFuncs`. Public export descriptors are raw
  // Wasm indices at this point, so derive the live prefix from the module.
  const numImportFuncs = ctx.mod.imports.filter((entry) => entry.desc.kind === "func").length;
  const occupied = new Map<string, VecHostBridgeDefinition>();
  for (const definition of VEC_HOST_BRIDGE_DEFINITIONS) {
    occupied.set(definition.name, definition);
    const physicalBase = vecHostBridgePhysicalExportBase(definition.kind);
    for (const entry of ctx.mod.exports) {
      if (entry.name.startsWith(physicalBase) && /^\$*$/.test(entry.name.slice(physicalBase.length))) {
        occupied.set(entry.name, definition);
      }
    }
  }
  for (const entry of ctx.mod.exports) {
    if (entry.desc.kind !== "func") continue;
    const definition = occupied.get(entry.name);
    if (!definition) continue;
    const allocation = allocations.get(definition.kind);
    if (!allocation) continue;
    const position = ctx.mod.functions.indexOf(allocation.func);
    if (position < 0) continue;
    entry.desc.index = numImportFuncs + position;
  }
}

/** Resolve a core vec bridge from its exact allocator object. */
export function resolveVecHostBridgeHelper(ctx: CodegenContext, kind: VecHostBridgeKind): FuncHandle | undefined {
  const definition = vecHostBridgeDefinition(kind);
  const programAbiHandle = ctx.programAbiCallables?.handleForEntrySourceSupport(
    VEC_HOST_BRIDGE_ROLE,
    definition.ordinal,
  );
  if (programAbiHandle !== undefined) return programAbiHandle;
  const allocation = vecHostBridgeAllocations.get(ctx)?.get(kind);
  return allocation ? definedFuncHandleOf(ctx, allocation.func) : undefined;
}

function requireVecHostBridgeAllocation(ctx: CodegenContext, kind: VecHostBridgeKind): VecHostBridgeAllocation {
  const allocation = ensureVecHostBridgeAllocations(ctx).get(kind);
  if (!allocation) throw new Error(`missing vec host bridge allocation ${kind}`);
  return allocation;
}

function fillVecHostBridge(
  ctx: CodegenContext,
  kind: VecHostBridgeKind,
  locals: { name: string; type: ValType }[],
  body: Instr[],
): void {
  const allocation = requireVecHostBridgeAllocation(ctx, kind);
  allocation.func.locals = locals;
  allocation.func.body = body;
}

/**
 * (#3311) The native-string vec carrier. `string[]` under nativeStrings /
 * standalone lowers to a vec whose backing array element is `(ref null
 * $AnyString)` (keyed `ref_${anyStrTypeIdx}`; `$NativeString <: $AnyString`).
 * Returns that element ref typeIdx (`anyStrTypeIdx`, or `nativeStrTypeIdx` for a
 * concretely-native element) so `__vec_push` / `__vec_pop` can admit + cast this
 * carrier — otherwise they returned the `-1`/`null.extern` unsupported sentinel
 * and `(a as any).push("x")` on a `string[]` was a silent no-op standalone.
 * Returns `-1` for a non-string carrier.
 */
export function nativeStrVecElemTypeIdx(ctx: CodegenContext, vecTypeIdx: number): number {
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return -1;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return -1;
  const el = arrDef.element as ValType;
  if (el.kind !== "ref" && el.kind !== "ref_null") return -1;
  if (ctx.anyStrTypeIdx >= 0 && el.typeIdx === ctx.anyStrTypeIdx) return ctx.anyStrTypeIdx;
  if (ctx.nativeStrTypeIdx >= 0 && el.typeIdx === ctx.nativeStrTypeIdx) return ctx.nativeStrTypeIdx;
  return -1;
}

/**
 * Emit __vec_get(externref, i32) -> externref and __vec_len(externref) -> i32
 * exports so the runtime can iterate WasmGC vec structs that were coerced to
 * externref (e.g. arrays stored in `any`-typed variables).
 *
 * For each registered vec type, emits ref.test/ref.cast dispatch to extract
 * the length or the indexed element, boxing the result to externref.
 */
/**
 * (#2784 S3) Reserve a `__vec_push` / `__vec_pop` helper funcIdx UP FRONT so the
 * native-vec method dispatch (calls.ts) can bake the call at compile time — the
 * helper bodies are only built in the finalize `emitVecAccessExports` pass, which
 * runs AFTER the method-call site compiles. Pushes a valid placeholder body +
 * export + funcMap entry (shift-tracked); the finalize pass FILLS the body in
 * place (fill-or-build in `_emitVecAccessExportsInner`). Idempotent.
 */
export function reserveVecMethodHelper(ctx: CodegenContext, kind: "push" | "pop" | "get" | "len"): number {
  ensureVecHostBridgeAllocations(ctx);
  const idx = resolveVecHostBridgeHelper(ctx, kind);
  if (idx === undefined) throw new Error(`reserved vec host bridge ${kind} lost its exact allocator object`);
  // Mark that the finalize vec-export pass must run (so the placeholder gets filled
  // even in a module that otherwise wouldn't emit vec helpers).
  ctx.usesVecValue = true;
  return idx;
}

export function emitVecAccessExports(ctx: CodegenContext): void {
  // Emit vec access exports when the runtime may need to introspect WasmGC arrays:
  // - for-of iteration on non-array types (__iterator)
  // - JSON.stringify on arrays of structs (JSON_stringify)
  // - Promise combinators (Promise_all / Promise_race / Promise_allSettled /
  //   Promise_any) — runtime helper needs to materialise wasm vec iterables
  //   into JS arrays so the native engine's GetIterator can drive them per
  //   spec (#1465).
  // - #1504: wrapExports marshaling of compiled array returns to plain JS,
  //   which needs __vec_len / __vec_get unconditionally for any module that
  //   declares vec types.
  // - host-import paths that coerce a vec wrapper to externref and look up
  //   `.constructor` — the runtime extern_get handler uses `__vec_len` to
  //   identify vec wrappers and report `constructor === Array`
  //   (#1441, #1057, #779c). Without the export, `["a","b"].constructor ===
  //   Array` is silently false for split/map/filter/etc. results in modules
  //   that don't otherwise use for-of or JSON.stringify. When `__extern_get`
  //   is imported, the property-access lowering may need this discrimination
  //   for `vec.constructor` lookups: the constructor path calls `__vec_len`
  //   to positively distinguish vec wrappers from other null-prototype
  //   WasmGC structs.
  // (#2083) The final disjunct was `ctx.vecTypeMap.size === 0`, which could
  // NEVER be true: `createCodegenContext` pre-registers the `externref` + `f64`
  // vec struct types for type-index stability, so the map always has ≥ 2
  // entries. As a result these six host-glue vec exports leaked into EVERY
  // module — even arith-only / string-only programs with no arrays at all (the
  // exact case flagged in #2083). Gate on `ctx.usesVecValue` instead — set only
  // when a genuine array-usage site asks `getOrRegisterVecType` for a type (the
  // two prereg calls are excluded). The host runtime guards every
  // `exports.__vec_*` access with a `typeof === "function"` check, so a module
  // that never materialises an array is safe without them.
  if (
    !ctx.funcMap.has("__iterator") &&
    !ctx.funcMap.has("JSON_stringify") &&
    !ctx.funcMap.has("__make_iterable") &&
    !ctx.funcMap.has("Promise_all") &&
    !ctx.funcMap.has("Promise_race") &&
    !ctx.funcMap.has("Promise_allSettled") &&
    !ctx.funcMap.has("Promise_any") &&
    !ctx.funcMap.has("__crypto_get_random_values") && // (#1503)
    !ctx.funcMap.has("__extern_get") &&
    !ctx.usesVecValue
  ) {
    return;
  }
  // Structural observation and body filling are correctness-critical. A
  // failure must abort compilation; swallowing it would publish callable
  // placeholders whose signatures are valid but whose behavior is fabricated.
  ensureVecHostBridgeAllocations(ctx);
  _emitVecAccessExportsInner(ctx);
  publishVecHostBridgeExports(ctx);
}

/** Mutation-capable vec carriers, keyed by physical backing-array shape. */
function collectVecMutationEntries(
  ctx: CodegenContext,
  vecEntries: [string, number][],
  unboxNumIdx: number | undefined,
  boxNumIdx: number | undefined,
): [string, number][] {
  const byType = new Map<number, [string, number]>();
  for (const [elemKey, vecTypeIdx] of vecEntries) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const arrDef = arrTypeIdx >= 0 ? ctx.mod.types[arrTypeIdx] : undefined;
    // (#1712) A reference-keyed vec can still use an EXTERNREF backing array.
    // This is how JS-mode arrays whose inferred element is a compiled struct
    // stay heterogeneous at runtime. Treat the physical carrier as the source
    // of truth for mutation, just as __vec_get already does (#2669).
    const physicalExternref =
      arrDef?.kind === "array" && (arrDef.element.kind === "externref" || arrDef.element.kind === "ref_extern");
    const mutationKey = physicalExternref ? "externref" : elemKey;
    const supported =
      mutationKey === "externref" ||
      ((mutationKey === "f64" || mutationKey === "i32") && unboxNumIdx !== undefined && boxNumIdx !== undefined) ||
      // (#3311) native-string carrier (`string[]` standalone) — no numeric
      // unbox; recover the `$AnyString` ref at the store.
      nativeStrVecElemTypeIdx(ctx, vecTypeIdx) >= 0;
    if (supported && !byType.has(vecTypeIdx)) {
      byType.set(vecTypeIdx, [mutationKey, vecTypeIdx]);
    }
  }
  return [...byType.values()];
}

function _emitVecAccessExportsInner(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const vecEntries = Array.from(ctx.vecTypeMap.entries());
  if (vecEntries.length === 0) return;

  // Ensure __box_number is available for boxing f64/i32 elements in __vec_get (#854)
  addUnionImports(ctx);

  // (#2001 S1 regress) Pre-import `__get_undefined` BEFORE baking any funcIdx into
  // `__vec_len`/`__vec_get`, so the externref `$Hole → undefined` host-boundary map
  // below resolves it via funcMap and emits a real JS `undefined` (not the
  // `ref.null.extern` null fallback — null does NOT satisfy `__extern_is_undefined`,
  // so a marshaled hole would still suppress a destructuring default). Standalone /
  // native-strings returns undefined here (no host) and the map falls back to
  // `ref.null.extern`, which is the standalone undefined convention — and the host
  // marshaling path that leaks holes does not exist there anyway. Gated on
  // `usesArrayHoles` so hole-free modules add no import.
  if (ctx.usesArrayHoles) {
    ensureGetUndefined(ctx);
    flushLateImportShifts(ctx, null);
  }
  // __vec_len(externref) -> i32
  {
    // local 0 = externref param, local 1 = anyref converted
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" });
    body.push({ op: "local.set", index: 1 });

    // Chain of ref.test / ref.cast for each vec type
    let current: Instr[] = [
      // Default: return 0 if no vec type matches
      { op: "i32.const", value: 0 },
      { op: "return" },
    ];
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = vecEntries[i]!;
      const thenBranch: Instr[] = [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "return" },
      ];
      current = [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        },
      ];
    }
    body.push(...current);

    fillVecHostBridge(ctx, "len", [{ name: "__any", type: { kind: "anyref" } }], body);
  }

  // __vec_get(externref, i32) -> externref
  {
    // local 0 = externref param (vec), local 1 = i32 param (index), local 2 = anyref
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" });
    body.push({ op: "local.set", index: 2 });

    // Chain of ref.test / ref.cast for each vec type
    let current: Instr[] = [
      // Default: return null if no vec type matches
      { op: "ref.null.extern" },
      { op: "return" },
    ];
    // Pre-check if __box_number is available (don't add late imports)
    const boxNumIdx = ctx.funcMap.get("__box_number");
    // (#2001 S1 regress) `__vec_get` is the chokepoint the HOST reads a vec
    // element through (`__make_iterable`'s convertToJS, `__array_entries`,
    // `wrapExports`, etc.). An externref slot may hold the `$Hole` sentinel for an
    // `any[]` literal elision; per §ToObject/Get an absent index reads as
    // `undefined`, NOT the opaque sentinel struct. Without mapping it here a hole
    // crosses the host boundary as an opaque WasmGC struct → JS sees a
    // non-`undefined` value → a destructuring `[x = d]` default (or any host-side
    // hole read) never fires (the -39 regression in PR #1838 — `f([,])` where the
    // hole is marshaled through `__make_iterable`). Map `$Hole → undefined` for
    // externref elements only, gated on `usesArrayHoles`. Pre-resolve the funcIdx
    // for the host `__get_undefined` (already imported when the module uses it;
    // `funcMap` lookup only — no late import added here) and register `$Hole`.
    const holeMapInVecGet = ctx.usesArrayHoles;
    let holeTypeIdxForGet = -1;
    if (holeMapInVecGet) {
      ensureHoleType(ctx);
      holeTypeIdxForGet = ctx.holeTypeIdx;
    }
    const getUndefIdxForGet = holeMapInVecGet ? ctx.funcMap.get("__get_undefined") : undefined;
    // (#3315) UNDEF_F64-sentinel → undefined at the same host read boundary.
    // An f64 vec can carry the UNDEF_F64_BITS signaling-NaN sentinel for an
    // `undefined` element (`[7, undefined, ]` lowers to __vec_f64 — see the
    // #1024 note in literals.ts). `__vec_get` is the chokepoint the HOST reads
    // vec elements through (`__make_iterable` convertToJS etc.); boxing the
    // raw bits through `__box_number` degrades that `undefined` to a plain
    // NaN NUMBER on the JS side, so a destructured sibling binding read back
    // from the host array compares `=== undefined` false (the #3315
    // corruption). Map the sentinel to `undefined` before it leaves — same
    // discipline as the `$Hole` map above. funcMap lookup only (no late
    // import); when neither the host `__get_undefined` nor the standalone
    // singleton is available the arm falls back to the plain box (pre-fix
    // bytes).
    const f64SentinelUndefInstrs: Instr[] | undefined = (() => {
      const singleton = undefinedExternInstrs(ctx);
      if (singleton !== undefined) return singleton;
      const gu = ctx.funcMap.get("__get_undefined");
      return gu !== undefined ? [{ op: "call", funcIdx: gu } as Instr] : undefined;
    })();
    const f64ScratchIdx = holeMapInVecGet ? 4 : 3;
    let usedF64Scratch = false;
    const oobUndefinedInstrs = f64SentinelUndefInstrs?.map((instr) => ({ ...instr })) ?? [
      { op: "ref.null.extern" as const },
    ];
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = vecEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      // (#2669) The REAL backing-array element kind, not the `elemKey` string,
      // decides whether the read value needs converting to externref: a `ref_*`
      // keyed vec stores its (boxed) elements as externref already.
      const arrElemDef = ctx.mod.types[arrTypeIdx];
      const arrElemIsExternref =
        arrElemDef !== undefined &&
        arrElemDef.kind === "array" &&
        ((arrElemDef.element as ValType).kind === "externref" || (arrElemDef.element as ValType).kind === "ref_extern");
      // Skip numeric element types if __box_number is not available
      if (
        (elemKey === "f64" ||
          elemKey === "i32" ||
          elemKey === "i32_byte" ||
          elemKey === "i32_elem" || // (#2835) Int32/Uint32 element storage (split from i32_byte)
          elemKey === "i8_byte") &&
        boxNumIdx === undefined
      )
        continue;

      // Inline boxing: avoid calling addUnionImports late
      let boxInstrs: Instr[];
      if (elemKey === "externref") {
        // (#2001 S1 regress) Map a `$Hole` slot back to `undefined` before it
        // leaves to the host. `[externref] → [externref]`: tee the slot, test it
        // for `$Hole`; if it is the sentinel, substitute `undefined` (host
        // `__get_undefined` when imported, else `ref.null.extern` — the standalone
        // undefined convention), otherwise return the slot unchanged.
        if (holeMapInVecGet && holeTypeIdxForGet >= 0) {
          const undefInstrs: Instr[] =
            getUndefIdxForGet !== undefined
              ? [{ op: "call", funcIdx: getUndefIdxForGet }]
              : [{ op: "ref.null.extern" }];
          boxInstrs = [
            { op: "local.tee", index: 3 },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: holeTypeIdxForGet },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: undefInstrs,
              else: [{ op: "local.get", index: 3 }],
            },
          ];
        } else {
          boxInstrs = [];
        }
      } else if (elemKey === "f64" && boxNumIdx !== undefined) {
        // (#3315) Sentinel-aware f64 box — see f64SentinelUndefInstrs above.
        if (f64SentinelUndefInstrs !== undefined) {
          usedF64Scratch = true;
          boxInstrs = [
            { op: "local.tee", index: f64ScratchIdx },
            { op: "i64.reinterpret_f64" },
            { op: "i64.const", value: UNDEF_F64_BITS },
            { op: "i64.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: f64SentinelUndefInstrs.map((instr) => ({ ...instr })),
              else: [
                { op: "local.get", index: f64ScratchIdx },
                { op: "call", funcIdx: boxNumIdx },
              ],
            },
          ];
        } else {
          boxInstrs = [{ op: "call", funcIdx: boxNumIdx }];
        }
      } else if (elemKey === "i32" && boxNumIdx !== undefined) {
        boxInstrs = [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }];
      } else if (
        (elemKey === "i32_byte" ||
          elemKey === "i32_elem" || // (#2835) Int32/Uint32 element storage — same dynamic read as i32_byte pre-split
          elemKey === "i8_byte" ||
          elemKey === "i16_byte") &&
        boxNumIdx !== undefined
      ) {
        // ArrayBuffer/DataView/typed-array byte elements — convert unsigned then box.
        // (#2835) `i32_elem` (Int32/Uint32 element storage, split from `i32_byte`)
        // reads via the SAME generic arm i32_byte used before the split (plain
        // `array.get` below — it is NOT packed — then unsigned i32→f64 box), so the
        // dynamic-read behaviour is byte-for-byte preserved.
        // (#2593) i16_byte joins here: the GENERIC dynamic-read path (`__vec_get`,
        // for an `any`-typed read of a typed-array vec) reads the packed element
        // zero-extended; the per-VIEW signedness for the typed `a[i]` read site is
        // handled separately in property-access.ts (typedArrayViewSignedness).
        boxInstrs = [{ op: "f64.convert_i32_u" }, { op: "call", funcIdx: boxNumIdx }];
      } else if (elemKey === "i64") {
        // i64 (BigInt) is a value type, not a ref type — extern.convert_any expects anyref.
        // Convert i64 -> f64 (lossy for large values) then box, or drop and return null.
        if (boxNumIdx !== undefined) {
          boxInstrs = [{ op: "f64.convert_i64_s" }, { op: "call", funcIdx: boxNumIdx }];
        } else {
          boxInstrs = [{ op: "drop" }, { op: "ref.null.extern" }];
        }
      } else if (arrElemIsExternref) {
        // (#2669) A `ref_*` keyed vec (nested arrays/objects, e.g. `number[][]`)
        // lowers its backing store to `(array (mut externref))` — the elements
        // are already boxed to externref. `array.get` yields externref, so an
        // `extern.convert_any` (whose operand MUST be an anyref) is invalid Wasm.
        // Pass the externref slot through unchanged.
        boxInstrs = [];
      } else {
        boxInstrs = [{ op: "extern.convert_any" }];
      }
      const elementRead: Instr[] = [
        // ref.cast to vec type, struct.get data array, then array.get with index.
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 1 }, // index
        // Packed byte storage uses an unsigned read; ordinary elements use array.get.
        {
          op: elemKey === "i8_byte" || elemKey === "i16_byte" || elemKey === "i32_byte" ? "array.get_u" : "array.get",
          typeIdx: arrTypeIdx,
        },
        ...boxInstrs,
      ];
      const thenBranch = guardVecElementRead(vecTypeIdx, arrTypeIdx, elementRead, oobUndefinedInstrs);
      current = [
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        },
      ];
    }
    body.push(...current);

    // local 2 = __any (anyref). (#2001 S1 regress) When the module has holes,
    // local 3 = __hole_scratch (externref) backs the `$Hole → undefined`
    // read-boundary map (`local.tee 3` above). Declared ONLY then, so a
    // hole-free module's `__vec_get` is byte-identical to pre-fix.
    const getLocals = holeMapInVecGet
      ? [
          { name: "__any", type: { kind: "anyref" } as ValType },
          { name: "__hole_scratch", type: { kind: "externref" } as ValType },
        ]
      : [{ name: "__any", type: { kind: "anyref" } as ValType }];
    // (#3315) f64 scratch backing the UNDEF_F64-sentinel map (`local.tee`
    // above). Declared ONLY when the f64 arm emitted the check, so modules
    // without it keep byte-identical `__vec_get` bodies.
    if (usedF64Scratch) {
      getLocals.push({ name: "__f64_scratch", type: { kind: "f64" } as ValType });
    }
    fillVecHostBridge(ctx, "get", getLocals, body);
  }

  // (#1712) Generic host-side vec MUTATORS. Compiled acorn mutates instance
  // array fields through dynamic `this` dispatch (`this.scopeStack.push(
  // new Scope(flags))` in enterScope): the receiver reaches the host's
  // __extern_method_call as an opaque vec struct, and the host cannot grow a
  // WasmGC array itself. These exports mirror the __vec_len/__vec_get
  // per-vec-type ref.test dispatch and perform the mutation on the Wasm side
  // (same grow discipline as compileArrayPush: newCap = max((len+1)*2, 4),
  // array.new_default + array.copy + struct.set). Element-kind coverage is
  // externref always, f64/i32 when __unbox_number/__box_number are imported;
  // unsupported kinds return the -1 / 0 sentinel so the runtime falls
  // through to its fail-loud TypeError instead of silently no-oping.
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  const boxNumIdx2 = ctx.funcMap.get("__box_number");
  const mutEntries = collectVecMutationEntries(ctx, vecEntries, unboxNumIdx, boxNumIdx2);

  // __is_vec(externref) -> i32 — POSITIVE vec discriminator over ALL
  // registered vec types. `__vec_len` cannot serve this role (its not-a-vec
  // default of 0 is indistinguishable from an empty vec), and `__is_closure`
  // can FALSE-POSITIVE on a vec whose canonicalized layout collides with a
  // closure capture struct — the runtime's callable-wrapping paths consult
  // this export to veto bridging a vec into a JS function.
  {
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
    let current: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = vecEntries[i]!;
      current = [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 1 }, { op: "return" }],
          else: current,
        },
      ];
    }
    body.push(...current);
    fillVecHostBridge(ctx, "is-vec", [{ name: "__any", type: { kind: "anyref" } }], body);
  }

  // __vec_mut_supported(externref) -> i32 (1 = push/pop cover this vec's elem kind)
  {
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
    let current: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = mutEntries[i]!;
      current = [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 1 }, { op: "return" }],
          else: current,
        },
      ];
    }
    body.push(...current);
    fillVecHostBridge(ctx, "mut-supported", [{ name: "__any", type: { kind: "anyref" } }], body);
  }

  // __vec_push(externref vec, externref value) -> i32 (new length, or -1 unsupported)
  {
    // locals: 2 = anyref converted; per-arm typed locals appended below
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 2 }];
    let current: Instr[] = [{ op: "i32.const", value: -1 }, { op: "return" }];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = mutEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const base = 2 + locals.length; // 2 params + locals so far
      const vecL = base;
      const dataL = base + 1;
      const lenL = base + 2;
      const ncapL = base + 3;
      const ndataL = base + 4;
      locals.push(
        { name: `__vp_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
        { name: `__vp_data_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
        { name: `__vp_len_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vp_ncap_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vp_ndata_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      );
      // value unboxing per element kind (value param is local 1)
      const strElemIdx = nativeStrVecElemTypeIdx(ctx, vecTypeIdx);
      const valueInstrs: Instr[] =
        elemKey === "externref"
          ? [{ op: "local.get", index: 1 }]
          : elemKey === "f64"
            ? [
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: unboxNumIdx! },
              ]
            : elemKey === "i32"
              ? [{ op: "local.get", index: 1 }, { op: "call", funcIdx: unboxNumIdx! }, { op: "i32.trunc_sat_f64_s" }]
              : // (#3311) native-string carrier: the boxed externref value is a
                // `$NativeString` (<: `$AnyString`); recover the ref element for
                // `array.set` — no numeric unbox.
                [{ op: "local.get", index: 1 }, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: strElemIdx }];
      const thenBranch: Instr[] = [
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "local.set", index: vecL },
        // len
        { op: "local.get", index: vecL },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: lenL },
        // data + capacity check: cap < len+1 ?
        { op: "local.get", index: vecL },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.tee", index: dataL },
        { op: "array.len" },
        { op: "local.get", index: lenL },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // ncap = max((len+1)*2, 4)
            { op: "local.get", index: lenL },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "i32.const", value: 1 },
            { op: "i32.shl" },
            { op: "i32.const", value: 4 },
            { op: "local.get", index: lenL },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "i32.const", value: 1 },
            { op: "i32.shl" },
            { op: "i32.const", value: 4 },
            { op: "i32.gt_s" },
            { op: "select" },
            { op: "local.set", index: ncapL },
            // ndata = array.new_default(ncap); copy old; vec.data = ndata
            { op: "local.get", index: ncapL },
            { op: "array.new_default", typeIdx: arrTypeIdx },
            { op: "local.set", index: ndataL },
            { op: "local.get", index: ndataL },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: dataL },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: lenL },
            { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
            { op: "local.get", index: vecL },
            { op: "local.get", index: ndataL },
            { op: "ref.as_non_null" },
            { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: ndataL },
            { op: "local.set", index: dataL },
          ],
        },
        // data[len] = value
        { op: "local.get", index: dataL },
        { op: "local.get", index: lenL },
        ...valueInstrs,
        { op: "array.set", typeIdx: arrTypeIdx },
        // vec.length = len + 1
        { op: "local.get", index: vecL },
        { op: "local.get", index: lenL },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
        // return len + 1
        { op: "local.get", index: lenL },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "return" },
      ];
      current = [
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        },
      ];
    }
    body.push(...current);
    fillVecHostBridge(ctx, "push", locals, body);
  }

  // __vec_pop(externref) -> externref (boxed last element; null.extern when
  // empty or unsupported — callers gate on __vec_mut_supported to tell apart)
  {
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
    let current: Instr[] = [{ op: "ref.null.extern" }, { op: "return" }];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = mutEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const base = 1 + locals.length; // 1 param + locals so far
      const vecL = base;
      const lenL = base + 1;
      locals.push(
        { name: `__vpop_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
        { name: `__vpop_len_${vecTypeIdx}`, type: { kind: "i32" } },
      );
      // (#2593) Packed i8/i16 elements need array.get_u and unsigned→f64; plain
      // `array.get` is invalid Wasm on a packed array. Generic dynamic path reads
      // zero-extended (the per-view signedness is at the typed `a[i]` site).
      // (#2835) `i32_byte` (ArrayBuffer/DataView byte buffer) is now packed i8 too
      // — same unsigned read/box. `i32_elem` (Int32/Uint32 element storage) stays
      // full-width signed (plain `array.get`), preserving its pre-split behaviour.
      const isPackedByte = elemKey === "i8_byte" || elemKey === "i16_byte" || elemKey === "i32_byte";
      const isNativeStr = nativeStrVecElemTypeIdx(ctx, vecTypeIdx) >= 0;
      const boxInstrs: Instr[] =
        elemKey === "externref"
          ? []
          : // (#3311) native-string element (`ref null $AnyString`) → externref via
            // the plain anyref→externref box (no `__box_number`).
            isNativeStr
            ? [{ op: "extern.convert_any" }]
            : elemKey === "f64"
              ? [{ op: "call", funcIdx: boxNumIdx2! }]
              : isPackedByte
                ? [{ op: "f64.convert_i32_u" }, { op: "call", funcIdx: boxNumIdx2! }]
                : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx2! }];
      const thenBranch: Instr[] = [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "local.set", index: vecL },
        { op: "local.get", index: vecL },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: lenL },
        // empty → undefined
        { op: "local.get", index: lenL },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "ref.null.extern" }, { op: "return" }],
        },
        // value = data[len-1] (boxed)
        { op: "local.get", index: vecL },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: lenL },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: isPackedByte ? "array.get_u" : "array.get", typeIdx: arrTypeIdx },
        ...boxInstrs,
        // vec.length = len - 1 (value stays beneath on the stack)
        { op: "local.get", index: vecL },
        { op: "local.get", index: lenL },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "return" },
      ];
      current = [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        },
      ];
    }
    body.push(...current);
    fillVecHostBridge(ctx, "pop", locals, body);
  }

  // (#3116) __vec_set_elem / __vec_set_len — array-exotic [[DefineOwnProperty]]
  // write-back exports (values into the vec, attributes in the sidecar — see
  // src/codegen/vec-define-writeback.ts for the full rationale).
  //
  // (#1712) Dynamic `arr[index] = value` in JS-host mode also reaches the
  // runtime as `__extern_set{_strict}` over an opaque vec. Emit the same
  // element writer for that lane; otherwise the host accepts the write without
  // touching the Wasm backing array. Modules with neither property-definition
  // nor dynamic-set imports remain byte-identical.
  const wantsDefineWriteback =
    ctx.funcMap.has("__defineProperty_value") ||
    ctx.funcMap.has("__defineProperty_desc") ||
    ctx.funcMap.has("__defineProperty_accessor") ||
    ctx.funcMap.has("__defineProperties");
  const wantsDynamicWriteback =
    !ctx.standalone && !ctx.wasi && (ctx.funcMap.has("__extern_set") || ctx.funcMap.has("__extern_set_strict"));
  const wantsNativeBoundaryWriteback =
    ctx.targetProfile.semanticProviders === "native-first" &&
    ctx.emitHostBridge &&
    ctx.targetProfile.hostValueInterop !== "off";
  if (wantsDefineWriteback || wantsDynamicWriteback || wantsNativeBoundaryWriteback) {
    emitVecDefineWritebackExports(ctx, mutEntries, unboxNumIdx);
  }
}

/**
 * (#1503) Emit `__vec_set_byte(externref vec, i32 idx, i32 byte) -> ()` so
 * the JS runtime can write bytes back into a WasmGC vec struct from inside
 * `crypto.getRandomValues(...)`. Mirrors the dispatch pattern of
 * `__vec_get` / `__dv_byte_set`: ref.test against every registered vec
 * type, then ref.cast + struct.get the underlying array, then array.set the
 * element. The element-type conversion depends on the vec's element kind:
 *
 *   - "f64"      → f64.convert_i32_u then array.set       (TypedArrays — Uint8Array etc.)
 *   - "i32"      → array.set directly                     (plain JS arrays of numbers stored as i32 — rare)
 *   - "i32_byte" → array.set directly                     (ArrayBuffer / DataView backing)
 *   - other      → skipped (no safe coercion from a byte)
 *
 * Gated on `__crypto_get_random_values` being imported; otherwise we'd add
 * a dead export and bloat every module.
 */
export function emitVecSetByteExport(ctx: CodegenContext): void {
  // (#1503) Originally gated on `__crypto_get_random_values` so the export
  // only appeared when crypto.getRandomValues was reachable.
  // (#1700) Now also needed by the JS-host `wrapExports` to populate freshly
  // allocated f64 vecs with Uint8Array bytes. Emit when either consumer is
  // present.
  if (!ctx.funcMap.has("__crypto_get_random_values") && !hasExportedVecParam(ctx)) return;
  try {
    _emitVecSetByteExportInner(ctx);
  } catch {
    // Non-fatal — if dispatch emission fails the runtime call will throw
    // a descriptive TypeError when the export is missing.
  }
}

function _emitVecSetByteExportInner(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const vecEntries = Array.from(ctx.vecTypeMap.entries());
  if (vecEntries.length === 0) return;

  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    [],
    "$__vec_set_byte_type",
  );
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // local 0 = vec externref, local 1 = idx i32, local 2 = byte i32, local 3 = anyref
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 3 }];

  let current: Instr[] = [];
  for (let i = vecEntries.length - 1; i >= 0; i--) {
    const [elemKey, vecTypeIdx] = vecEntries[i]!;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    let writeInstrs: Instr[];
    if (elemKey === "f64") {
      writeInstrs = [
        { op: "local.get", index: 3 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 1 }, // idx
        { op: "local.get", index: 2 }, // byte (i32)
        { op: "f64.convert_i32_u" },
        { op: "array.set", typeIdx: arrTypeIdx },
      ];
    } else if (elemKey === "i32" || elemKey === "i32_byte" || elemKey === "i32_elem") {
      // (#2835) `i32_elem` (Int32/Uint32 element storage, split from `i32_byte`)
      // takes the same direct `array.set` byte-write i32_byte used before the split
      // (the i32 slot is wide enough for a byte) — preserves crypto.getRandomValues
      // / wrapExports byte population into Int32/Uint32 vecs unchanged.
      writeInstrs = [
        { op: "local.get", index: 3 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "array.set", typeIdx: arrTypeIdx },
      ];
    } else {
      // Element types we don't know how to write a byte to (externref,
      // i64, etc.) — skip silently. The runtime will TypeError if asked.
      continue;
    }
    current = [
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: vecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...writeInstrs, { op: "return" }],
        else: current,
      },
    ];
  }
  body.push(...current);

  mod.functions.push({
    name: "__vec_set_byte",
    typeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as any);
  exportFunc(mod, "__vec_set_byte", funcIdx);
}

/**
 * (#1700) Emit `__new_vec_f64(i32 len) -> externref` so the JS-host
 * `wrapExports` can allocate a fresh f64-element vec struct and populate it
 * with bytes from a JS `Uint8Array` argument. Without this export, callers
 * have no JS entry point to construct a `(ref null $Vec[f64])` and hit
 * "type incompatibility when transforming from/to JS" at the call boundary.
 *
 * The signature returns `externref` (not the typed vec ref) so the result
 * is opaque on the JS side — callers pass it straight back to a compiled
 * function param, which casts it to the right vec type internally.
 *
 * Gated: only emitted when (a) an `f64`-element vec is registered, AND
 * (b) at least one exported user function accepts a vec-shaped ref param.
 * Modules without TypedArray exports pay zero bytes.
 */
export function emitNewVecF64Export(ctx: CodegenContext): void {
  if (!ctx.vecTypeMap.has("f64")) return;
  if (!hasExportedVecParam(ctx)) return;
  try {
    _emitNewVecF64ExportInner(ctx);
  } catch {
    // Non-fatal — if dispatch emission fails the JS-side wrapper falls
    // back to passing the raw arg (which raises the original TypeError),
    // which is no worse than the pre-#1700 baseline.
  }
}

function hasExportedVecParam(ctx: CodegenContext): boolean {
  const mod = ctx.mod;
  const vecTypeIdxs = new Set<number>(ctx.vecTypeMap.values());
  for (const exp of mod.exports) {
    if (exp.desc.kind !== "func") continue;
    const fn = definedFuncAt(ctx, exp.desc.index);
    if (!fn) continue;
    const typeDef = mod.types[fn.typeIdx];
    if (!typeDef) continue;
    // Resolve sub-type wrappers (some FuncTypeDefs are nested under SubTypeDef).
    const ft = typeDef.kind === "sub" ? typeDef.type : typeDef;
    if (ft.kind !== "func") continue;
    for (const p of ft.params) {
      if ((p.kind === "ref" || p.kind === "ref_null") && vecTypeIdxs.has(p.typeIdx)) {
        return true;
      }
    }
  }
  return false;
}

function _emitNewVecF64ExportInner(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const vecTypeIdx = ctx.vecTypeMap.get("f64")!;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return;
  // Skip if the export is already emitted (defensive — multi-source paths
  // may invoke the emit pass more than once; emitVecSetByteExport doesn't
  // guard either but is gated by funcMap which prevents a second emit).
  if (mod.exports.some((e) => e.name === "__new_vec_f64")) return;

  // Return the typed vec ref directly (NOT externref). V8 and SpiderMonkey
  // both reject the JS↔Wasm round-trip if we return externref and try to
  // pass it back to a `(ref null $Vec)` param — the boundary will not
  // narrow externref → concrete WasmGC ref. By returning the real type,
  // JS sees an opaque WasmGC handle and the engine accepts it on the way
  // back in (same type identity).
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "i32" }],
    [{ kind: "ref_null", typeIdx: vecTypeIdx }],
    "$__new_vec_f64_type",
  );
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // local 0 = len (i32 param)
  // local 1 = $arr (ref null $arr_f64) — the zero-initialised data array
  const arrRefType: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const body: Instr[] = [
    // arr = array.new_default $arr_f64 (len)
    { op: "local.get", index: 0 },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "local.set", index: 1 },
    // struct.new $Vec[f64] { length: len, data: arr }
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "struct.new", typeIdx: vecTypeIdx },
  ];

  mod.functions.push({
    name: "__new_vec_f64",
    typeIdx,
    locals: [{ name: "__arr", type: arrRefType }],
    body,
    exported: true,
  } as any);
  exportFunc(mod, "__new_vec_f64", funcIdx);
}

/**
 * Emit DataView byte-access exports for i32_byte vec structs (#1056).
 *
 * Adds three exports that operate on ArrayBuffer/DataView backing stores:
 *   __dv_byte_len(externref) -> i32          — vec length, or -1 if not i32_byte
 *   __dv_byte_get(externref, i32) -> i32     — unsigned byte at index
 *   __dv_byte_set(externref, i32, i32) -> () — write byte at index
 *
 * The JS runtime uses these in __extern_method_call to implement
 * DataView.prototype.{get,set}{Uint,Int,Float}{8,16,32,64} and friends
 * by materializing a real DataView over a live byte array, invoking the
 * native method, and writing bytes back for setters.
 */
export function emitDataViewByteExports(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const byteVecTypeIdx = ctx.vecTypeMap.get("i32_byte");
  if (byteVecTypeIdx === undefined) return;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, byteVecTypeIdx);
  if (arrTypeIdx < 0) return;

  // __dv_byte_len(externref) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__dv_byte_len_type");
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: byteVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: byteVecTypeIdx },
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 0 },
          { op: "return" },
        ],
        else: [],
      },
      { op: "i32.const", value: -1 },
    ];
    mod.functions.push({
      name: "__dv_byte_len",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    exportFunc(mod, "__dv_byte_len", funcIdx);
  }

  // __dv_byte_get(externref, i32) -> i32
  {
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$__dv_byte_get_type",
    );
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: byteVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: byteVecTypeIdx },
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 1 },
          // (#2835) packed i8 backing → unsigned zero-extended byte read.
          { op: "array.get_u", typeIdx: arrTypeIdx },
          { op: "return" },
        ],
        else: [],
      },
      { op: "i32.const", value: 0 },
    ];
    mod.functions.push({
      name: "__dv_byte_get",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    exportFunc(mod, "__dv_byte_get", funcIdx);
  }

  // __dv_byte_set(externref, i32, i32) -> ()
  {
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
      [],
      "$__dv_byte_set_type",
    );
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: byteVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 },
          { op: "ref.cast", typeIdx: byteVecTypeIdx },
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "array.set", typeIdx: arrTypeIdx },
        ],
        else: [],
      },
    ];
    mod.functions.push({
      name: "__dv_byte_set",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    exportFunc(mod, "__dv_byte_set", funcIdx);
  }
}
