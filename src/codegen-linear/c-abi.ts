// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * C ABI calling conventions for the linear memory backend.
 *
 * Translates TypeScript-level types into C-compatible wasm signatures:
 *   - number (f64) → f64 parameter (direct)
 *   - number (i32, fast mode) → i32 parameter (direct)
 *   - boolean → i32 parameter (0 or 1)
 *   - string → (i32, i32) pair: (pointer to UTF-8 data, byte length)
 *   - T[] → (i32, i32) pair: (pointer to element data, element count)
 *   - structs/objects → i32 pointer to linear memory layout
 *   - void return → no return value
 *
 * Wrapper functions are emitted that marshal between the internal TS
 * calling convention (pointers for strings/arrays) and the C ABI
 * (pointer + length pairs).
 */

import type { FuncTypeDef, Instr, ValType, WasmModule } from "../ir/types.js";
import { absoluteFuncIndexCached } from "../emit/resolve-layout.js"; // (#1916 S3)
// `refcount/ownership.ts` imports `ExternCImportSpec` back from here, but only
// as a TYPE, so the cycle is erased by tsc and there is no runtime cycle.
import { type ArgOwnership, type ImportOwnership, resolveImportOwnership } from "./refcount/ownership.js";

// ── Linear-memory aggregate header layout (mirrors runtime.ts) ───────
//
// String: [header 8B][len:u32 @ +8][utf8 bytes @ +12...]
// Array:  [header 8B][len:u32 @ +8][cap:u32 @ +12][elements: 8B×cap @ +16...]
//
// #1938: array elements are 8-byte slots (f64 bit pattern). A number[] return
// payload is therefore 8-byte-strided (read it as a `double*` / Float64Array
// on the host); a reference/handle array stores the i32 in the low 4 bytes of
// each 8-byte slot.
//
// These constants MUST stay in sync with addStringRuntime / addArrayRuntime
// in src/codegen-linear/runtime.ts (#1835).
const AGG_LEN_OFFSET = 8; // length field for both strings and arrays
const STR_DATA_OFFSET = 12; // first UTF-8 byte of a string
const ARR_DATA_OFFSET = 16; // first element of an array

/** Locate a (defined or imported) function by name, returning its global func index. */
function findFuncIndexByName(mod: WasmModule, name: string): number {
  const numImportFuncs = mod.imports.filter((i) => i.desc.kind === "func").length;
  // Imports first occupy indices [0, numImportFuncs); match by import name.
  let importIdx = 0;
  for (const imp of mod.imports) {
    if (imp.desc.kind !== "func") continue;
    if (imp.name === name) return importIdx;
    importIdx++;
  }
  for (let i = 0; i < mod.functions.length; i++) {
    if (mod.functions[i].name === name) return numImportFuncs + i;
  }
  return -1;
}

// ── Types ────────────────────────────────────────────────────────────

/** Describes the TS-level semantic type of a parameter */
export type TsSemanticType = "number_i32" | "number_f64" | "boolean" | "string" | "array" | "object";

/** A parameter definition with TS semantic info */
export interface ParamDef {
  name: string;
  wasmType: ValType;
  semantic: TsSemanticType;
}

/** A C ABI parameter (may be one of a pair for strings/arrays) */
export interface CabiParam {
  name: string;
  wasmType: ValType;
  /** Which original param index this came from */
  sourceParamIdx: number;
  /** "ptr" | "len" for expanded params, "direct" for scalar */
  role: "direct" | "ptr" | "len";
  /**
   * For expanded (ptr/len) params, the underlying aggregate kind so the
   * wrapper can pick the right runtime constructor (`__str_from_data` for
   * strings, `__arr_from_data` for arrays). Undefined for scalar/direct.
   */
  aggregate?: "string" | "array";
}

/** C ABI return value descriptor */
export interface CabiResult {
  wasmTypes: ValType[];
  semantic: TsSemanticType | "void";
}

/** Information about an exported function for C header generation */
export interface CabiExportInfo {
  /** Original TS function name */
  tsName: string;
  /** C ABI export name (e.g. MyClass_bar) */
  cabiName: string;
  /** C ABI parameter list */
  params: CabiParam[];
  /** C ABI return type */
  result: CabiResult;
}

// ── Parameter mapping ────────────────────────────────────────────────

/**
 * Expand TS parameter definitions into C ABI parameters.
 * Strings and arrays become (ptr, len) pairs.
 */
export function mapParamsToCabi(params: ParamDef[]): CabiParam[] {
  const result: CabiParam[] = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    switch (p.semantic) {
      case "string":
      case "array":
        // Expand to (pointer, length) pair
        result.push({
          name: `${p.name}_ptr`,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "ptr",
          aggregate: p.semantic,
        });
        result.push({
          name: `${p.name}_len`,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "len",
          aggregate: p.semantic,
        });
        break;
      case "boolean":
        result.push({
          name: p.name,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "direct",
        });
        break;
      case "number_i32":
        result.push({
          name: p.name,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "direct",
        });
        break;
      case "number_f64":
        result.push({
          name: p.name,
          wasmType: { kind: "f64" },
          sourceParamIdx: i,
          role: "direct",
        });
        break;
      default:
        result.push({
          name: p.name,
          wasmType: { kind: "i32" },
          sourceParamIdx: i,
          role: "direct",
        });
        break;
    }
  }
  return result;
}

/**
 * Map a TS return type to a C ABI return descriptor.
 */
export function mapResultToCabi(result: ValType | null, semantic: TsSemanticType | "void"): CabiResult {
  if (result === null || semantic === "void") {
    return { wasmTypes: [], semantic: "void" };
  }
  switch (semantic) {
    case "string":
    case "array":
      // Return (ptr, len) pair — two i32 results
      return { wasmTypes: [{ kind: "i32" }, { kind: "i32" }], semantic };
    case "boolean":
      return { wasmTypes: [{ kind: "i32" }], semantic };
    case "number_i32":
      return { wasmTypes: [{ kind: "i32" }], semantic };
    case "number_f64":
      return { wasmTypes: [{ kind: "f64" }], semantic };
    default:
      return { wasmTypes: [{ kind: "i32" }], semantic };
  }
}

// ── Name mangling ────────────────────────────────────────────────────

/**
 * Mangle a function name for C ABI export.
 * Simple function names are unchanged; class methods use ClassName_method.
 */
export function mangleCabiName(name: string): string {
  // Already contains underscore from ClassName_method convention — keep as-is
  return name;
}

// ── Wrapper emission ─────────────────────────────────────────────────

/**
 * Emit C ABI wrapper functions for all exported functions in the module.
 *
 * For each exported function with string or array parameters, we generate
 * a `__cabi_<name>` wrapper with C-compatible signatures. The wrapper
 * marshals the (ptr, len) pairs by creating internal string/array
 * representations, calls the original function, and returns the result
 * in C ABI form.
 *
 * For functions that already have C-compatible signatures (all scalar
 * params/returns), the original export is simply renamed — no wrapper
 * is needed.
 *
 * Returns the list of CabiExportInfo describing the new C ABI exports.
 */
export function emitCabiWrappers(mod: WasmModule, exportInfos: CabiExportInfo[]): void {
  // Track which export indices to replace
  const exportReplacements = new Map<string, number>(); // old export name -> new func index

  for (const info of exportInfos) {
    const needsWrapper =
      info.params.some((p) => p.role === "ptr" || p.role === "len") ||
      info.result.semantic === "string" ||
      info.result.semantic === "array";

    if (!needsWrapper) {
      // No wrapper needed; just rename the export if needed
      if (info.tsName !== info.cabiName) {
        for (const exp of mod.exports) {
          if (exp.name === info.tsName && exp.desc.kind === "func") {
            exp.name = info.cabiName;
            break;
          }
        }
      }
      continue;
    }

    // Find the original function's export and its index
    let origFuncIdx = -1;
    for (const exp of mod.exports) {
      if (exp.name === info.tsName && exp.desc.kind === "func") {
        origFuncIdx = exp.desc.index;
        break;
      }
    }
    if (origFuncIdx === -1) continue;

    // Find the original function's type
    const numImportFuncs = mod.imports.filter((i) => i.desc.kind === "func").length;
    // (#1916 S3) normalize a possibly-stable handle to the absolute index.
    origFuncIdx = absoluteFuncIndexCached(mod, numImportFuncs, origFuncIdx);
    const origFunc = origFuncIdx >= numImportFuncs ? mod.functions[origFuncIdx - numImportFuncs] : null;
    if (!origFunc) continue;
    const origType = mod.types[origFunc.typeIdx] as FuncTypeDef;

    // Build the wrapper function type
    const wrapperParamTypes: ValType[] = info.params.map((p) => p.wasmType);
    const wrapperResultTypes: ValType[] = info.result.wasmTypes;

    const wrapperTypeIdx = mod.types.length;
    mod.types.push({
      kind: "func",
      name: `$type___cabi_${info.cabiName}`,
      params: wrapperParamTypes,
      results: wrapperResultTypes,
    });

    // Build wrapper body
    const body: Instr[] = [];

    // Resolve runtime constructors used to rehydrate string/array params from
    // the raw (ptr, len) the C caller provides. They are always present for
    // the linear target (addStringRuntime / addArrayRuntime run unconditionally).
    const strFromDataIdx = findFuncIndexByName(mod, "__str_from_data");
    const arrFromDataIdx = findFuncIndexByName(mod, "__arr_from_data");

    // For each original parameter, reconstruct the value from C ABI params.
    let cabiParamIdx = 0;
    for (let origIdx = 0; origIdx < (origType.params?.length ?? 0); origIdx++) {
      const cabiParam = info.params[cabiParamIdx];
      if (cabiParam && cabiParam.role === "ptr") {
        // String/array param: the C ABI passes a raw (data ptr, len) pair, but
        // the internal function expects a pointer to a linear-memory header
        // object. Reconstruct it by calling the matching runtime constructor.
        const ctorIdx = cabiParam.aggregate === "array" ? arrFromDataIdx : strFromDataIdx;
        if (ctorIdx >= 0) {
          // __{str,arr}_from_data(dataPtr, len) -> header ptr
          body.push({ op: "local.get", index: cabiParamIdx }); // ptr
          body.push({ op: "local.get", index: cabiParamIdx + 1 }); // len
          body.push({ op: "call", funcIdx: ctorIdx });
        } else {
          // Constructor missing (should not happen for linear target) — fall
          // back to forwarding the raw pointer to avoid emitting invalid Wasm.
          body.push({ op: "local.get", index: cabiParamIdx });
        }
        cabiParamIdx += 2; // consumed both ptr and len
      } else {
        body.push({ op: "local.get", index: cabiParamIdx });
        cabiParamIdx++;
      }
    }

    // Call the original function
    body.push({ op: "call", funcIdx: origFuncIdx });

    // Handle return value marshaling
    if (info.result.semantic === "string" || info.result.semantic === "array") {
      // The original function returns an i32 pointer to a string/array header:
      //   string: [header 8B][len:u32 @ +8][utf8 bytes @ +12...]
      //   array:  [header 8B][len:u32 @ +8][cap:u32 @ +12][elems @ +16...]
      // For the C ABI we return (data ptr, len) so the host reads the payload
      // directly without knowing the header layout (#1835).
      const dataOffset = info.result.semantic === "array" ? ARR_DATA_OFFSET : STR_DATA_OFFSET;
      const retLocal = wrapperParamTypes.length;
      const wrapperLocals = [{ name: "__ret_ptr", type: { kind: "i32" } as ValType }];

      // After the call, the header pointer is on the stack.
      // result[0] = data pointer = headerPtr + dataOffset
      body.push({ op: "local.tee", index: retLocal });
      body.push({ op: "i32.const", value: dataOffset });
      body.push({ op: "i32.add" });
      // result[1] = length = i32.load at headerPtr + AGG_LEN_OFFSET
      body.push({ op: "local.get", index: retLocal });
      body.push({ op: "i32.load", align: 2, offset: AGG_LEN_OFFSET });

      // Add the wrapper function with the extra local
      const wrapperFuncIdx = numImportFuncs + mod.functions.length;
      mod.functions.push({
        name: `__cabi_${info.cabiName}`,
        typeIdx: wrapperTypeIdx,
        locals: wrapperLocals,
        body,
        exported: true,
      });

      exportReplacements.set(info.tsName, wrapperFuncIdx);

      // Add export for wrapper
      mod.exports.push({
        name: info.cabiName,
        desc: { kind: "func", index: wrapperFuncIdx },
      });
    } else {
      // Simple return — just create the wrapper
      const wrapperFuncIdx = numImportFuncs + mod.functions.length;
      mod.functions.push({
        name: `__cabi_${info.cabiName}`,
        typeIdx: wrapperTypeIdx,
        locals: [],
        body,
        exported: true,
      });

      exportReplacements.set(info.tsName, wrapperFuncIdx);

      mod.exports.push({
        name: info.cabiName,
        desc: { kind: "func", index: wrapperFuncIdx },
      });
    }

    // Remove the original export (keep the function, just un-export it)
    const origExportIdx = mod.exports.findIndex((e) => e.name === info.tsName && e.desc.kind === "func");
    if (origExportIdx !== -1) {
      mod.exports.splice(origExportIdx, 1);
    }
  }
}

/**
 * Infer the TS semantic type from a ValType and TS type text.
 */
export function inferSemantic(wasmType: ValType, tsTypeText: string | undefined): TsSemanticType {
  if (!tsTypeText) {
    return wasmType.kind === "f64" ? "number_f64" : "number_i32";
  }
  const cleaned = tsTypeText.replace(/\s*\|\s*(undefined|null)/g, "").trim();
  if (cleaned === "string") return "string";
  if (cleaned === "boolean") return "boolean";
  if (cleaned === "number") {
    return wasmType.kind === "i32" ? "number_i32" : "number_f64";
  }
  if (cleaned.endsWith("[]") || cleaned.startsWith("Array<")) return "array";
  if (cleaned === "void") return "number_f64"; // shouldn't occur for params
  return "object";
}

// ── Import direction (#4539) ─────────────────────────────────────────
//
// Everything above marshals the EXPORT direction: TS functions surfaced to a C
// caller. This section is the inverse — declaring external C functions that the
// linear module CALLS, which is what linking against a C library (e.g. the
// pinned engine artifact of ADR-0020) requires.
//
// Ordering is load-bearing. A function's index is `numImportFuncs + position`,
// so every import must be declared BEFORE any defined function is added.
// Declaring one afterwards would shift every existing index — the failure mode
// the WasmGC lane works around with late `addUnionImports` shifting, which this
// backend deliberately does not replicate. `declareExternCImports` therefore
// REFUSES rather than silently corrupting indices.

// ── Address domain (#4554) ───────────────────────────────────────────
//
// Pointers, sizes and handles are `i32` because the TARGET is wasm32, not
// because they are inherently 32-bit; under memory64 they become `i64`. Naming
// the role instead of the width keeps that a one-line change here rather than
// a hunt through every declaration site.
//
// This is deliberately NOT an adoption of memory64, which is often slower on
// today's engines (64-bit bounds checks cannot use the 4 GiB guard-page trick)
// and costs cache through wider pointers. It only stops foreclosing it.

/** The role a scalar plays, when its width is a property of the target. */
export type AddressKind = "ptr" | "size" | "handle";

/** A param/result type: an exact Wasm type, or a role resolved per target. */
export type ExternCValType = ValType | { address: AddressKind };

/** Which Wasm type each address role lowers to on a given target. */
export interface LinearAddressModel {
  readonly pointer: ValType;
  readonly size: ValType;
  readonly handle: ValType;
}

/** wasm32: every address role is an `i32`. The status quo, stated once. */
export const WASM32_ADDRESS_MODEL: LinearAddressModel = {
  pointer: { kind: "i32" },
  size: { kind: "i32" },
  handle: { kind: "i32" },
};

/** Resolve a declared extern type against the target's address model. */
export function resolveExternCValType(t: ExternCValType, model: LinearAddressModel = WASM32_ADDRESS_MODEL): ValType {
  if (!("address" in t)) return t;
  switch (t.address) {
    case "ptr":
      return model.pointer;
    case "size":
      return model.size;
    case "handle":
      return model.handle;
  }
}

/** An external C function this module calls. */
export interface ExternCImportSpec {
  /** Wasm import module name, e.g. `"qjs"`. */
  module: string;
  /** Wasm import field name, e.g. `"qjs_eval"`. */
  name: string;
  /**
   * Parameter types. Prefer an {@link AddressKind} — `{ address: "handle" }` —
   * over a literal `i32` wherever the value is an address rather than a number
   * that happens to be 32 bits wide.
   */
  params: ExternCValType[];
  results: ExternCValType[];
  /**
   * Whether the callee takes ownership of handle-typed arguments.
   *
   * Declared here rather than inferred because the callee is foreign code the
   * analysis cannot see — it is a hand-written summary. The refcount /
   * handle-scope pass (#4542) consumes this; that issue requires every import
   * to carry one, so the field is intentionally not optional-with-a-default:
   * a wrong default is a leak or a double-free, and "unset" must stay
   * distinguishable from "borrows".
   *
   * #4542 widened the field to accept a full {@link ImportOwnership} record.
   * The `"borrows"` / `"consumes"` shorthand still means exactly what it did —
   * it is the argument axis — but it cannot describe an import that RETURNS a
   * handle, because the caller then also has to know whether that handle
   * arrives with a reference it owns. `resolveImportOwnership` REFUSES the
   * shorthand on a handle-returning import rather than picking one; see
   * `refcount/ownership.ts` for the three axes and which of them may be
   * derived (only the conservative safety ones).
   */
  ownership?: ArgOwnership | ImportOwnership;
  /**
   * This import is part of the dynamic-tier ENGINE surface (ADR-0020), so its
   * JSValue handles are the refcount pass's responsibility.
   *
   * It exists because `{ address: "handle" }` carries two meanings that happen
   * to coincide on wasm32 and are not the same idea:
   *   - #4554's meaning — "a pointer-width scalar whose ROLE is a handle",
   *     which is why `tests/issue-4539-c-link.test.ts` uses it on a plain
   *     `int c_double(int)` to prove the role emits the same bytes as the
   *     width; and
   *   - #4542's meaning — "a reference the engine counts".
   *
   * Only the second one obliges anybody. Inferring "engine import" from the
   * type role would make the first unusable, so it is DECLARED. With
   * `engine: true`, {@link declareExternCImports} refuses an import whose
   * ownership annotation is missing or incoherent — the "compile error, not a
   * default" rule, applied at the declaration rather than deep inside lowering.
   */
  engine?: boolean;
}

/** Count the function imports already declared on a module. */
export function countImportedFuncs(mod: WasmModule): number {
  let n = 0;
  for (const imp of mod.imports) if (imp.desc.kind === "func") n++;
  return n;
}

/** Find an existing structurally-identical func type, or append one. */
function internFuncType(mod: WasmModule, params: ValType[], results: ValType[]): number {
  const same = (a: ValType[], b: ValType[]): boolean =>
    a.length === b.length && a.every((t, i) => t.kind === b[i].kind);
  for (let i = 0; i < mod.types.length; i++) {
    const t = mod.types[i];
    if (t.kind === "func" && same(t.params, params) && same(t.results, results)) return i;
  }
  const typeIdx = mod.types.length;
  const def: FuncTypeDef = { kind: "func", params, results };
  mod.types.push(def);
  return typeIdx;
}

/**
 * Declare external C functions this module imports, in order.
 *
 * MUST run before any defined function exists on `mod`; throws otherwise, so
 * an index-shifting mistake is a loud failure at build time rather than a
 * miscompile. Returns `name → function index`; imports occupy `[0, n)`.
 *
 * Also VALIDATES ownership (#4542): every `engine: true` import, and every
 * import that declares an `ownership` at all, is resolved here. An engine
 * import missing its annotation fails at declaration — where the mistake was
 * made — rather than surfacing later as a leak or a double-free.
 */
export function declareExternCImports(
  mod: WasmModule,
  specs: readonly ExternCImportSpec[],
  model: LinearAddressModel = WASM32_ADDRESS_MODEL,
): Map<string, number> {
  const indices = new Map<string, number>();
  if (specs.length === 0) return indices;
  for (const spec of specs) {
    // A non-engine import that declares nothing is left alone: `{ address:
    // "handle" }` is also a plain width role (#4554), and demanding an
    // annotation there would break that meaning — see `ExternCImportSpec.engine`.
    if (spec.engine === true || spec.ownership !== undefined) resolveImportOwnership(spec);
  }
  if (mod.functions.length > 0) {
    throw new Error(
      `declareExternCImports: ${mod.functions.length} function(s) already defined. ` +
        "Imports must be declared before any function is added — adding one later shifts every " +
        "function index. Move the call earlier in generateLinearModule.",
    );
  }
  for (const spec of specs) {
    const existing = indices.get(`${spec.module}.${spec.name}`);
    if (existing !== undefined) continue;
    const typeIdx = internFuncType(
      mod,
      spec.params.map((t) => resolveExternCValType(t, model)),
      spec.results.map((t) => resolveExternCValType(t, model)),
    );
    const funcIdx = countImportedFuncs(mod);
    mod.imports.push({
      module: spec.module,
      name: spec.name,
      desc: { kind: "func", typeIdx },
    });
    indices.set(`${spec.module}.${spec.name}`, funcIdx);
    indices.set(spec.name, funcIdx);
  }
  return indices;
}

/**
 * Import the module's linear memory instead of defining it.
 *
 * Required when linking against an artifact that EXPORTS memory (the ADR-0020
 * topology): both sides must address one memory, and only one may own it.
 * `addRuntime` skips defining memory when an import is present.
 */
export function declareImportedMemory(
  mod: WasmModule,
  module: string,
  name: string,
  min: number,
  max?: number,
  indexType: "i32" | "i64" = "i32",
): void {
  if (mod.memories.length > 0) {
    throw new Error(
      "declareImportedMemory: this module already DEFINES a memory. A module may not both " +
        "define and import one; declare the import before the runtime is added.",
    );
  }
  // #4554 — the parameter exists so a memory64 caller has somewhere to say so,
  // and is REFUSED rather than accepted-and-ignored. Accepting it would emit
  // wasm32 limits for a 64-bit memory: a module that instantiates and then
  // addresses the wrong bytes. A loud refusal is the only honest answer until
  // the emitter can encode 64-bit limits.
  if (indexType === "i64") {
    throw new Error(
      "declareImportedMemory: memory64 (i64 index type) is not supported yet — the emitter " +
        "cannot encode 64-bit limits, and emitting 32-bit ones for a 64-bit memory would " +
        "silently address the wrong memory. See #4554.",
    );
  }
  if (hasImportedMemory(mod)) return;
  mod.imports.push({ module, name, desc: { kind: "memory", min, max } });
}

/** Whether the module imports its linear memory rather than defining one. */
export function hasImportedMemory(mod: WasmModule): boolean {
  return mod.imports.some((imp) => imp.desc.kind === "memory");
}

/**
 * Boundary marshalling for a call to an extern-C import (#4539).
 *
 * This backend compiles a TS `number` to **f64**, while a C signature is
 * whatever it declares — typically `i32` for handles and sizes. So each
 * argument is converted into the declared parameter type on the way in, and
 * the result back into the f64 domain on the way out.
 *
 * KNOWN LIMITATION, stated rather than hidden: the conversion assumes the
 * argument expression produced f64, which holds for ordinary `number`
 * expressions but NOT for values already in i32 form via native type
 * annotations (`type i32 = number`). Mixing those with extern calls is
 * therefore not yet supported; it needs the expression-level type tracking
 * the direct backend does not have. Emitting a wrong conversion silently is
 * the failure this comment exists to prevent someone from causing.
 */
export function emitExternCBoundaryArg(out: Instr[], declared: ValType): void {
  switch (declared.kind) {
    case "f64":
      return; // already the backend's domain
    case "i32":
      out.push({ op: "i32.trunc_f64_s" });
      return;
    case "i64":
      out.push({ op: "i64.trunc_f64_s" });
      return;
    case "f32":
      out.push({ op: "f32.demote_f64" });
      return;
    default:
      throw new Error(
        `extern-C import parameter type '${declared.kind}' is not supported yet. ` +
          "Supported: f64, i32, i64, f32 — the scalar C ABI. A reference type " +
          "cannot cross this boundary by value.",
      );
  }
}

/** Convert an extern-C result back into the backend's f64 value domain. */
export function emitExternCBoundaryResult(out: Instr[], declared: ValType): void {
  switch (declared.kind) {
    case "f64":
      return;
    case "i32":
      out.push({ op: "f64.convert_i32_s" });
      return;
    case "i64":
      out.push({ op: "f64.convert_i64_s" });
      return;
    case "f32":
      out.push({ op: "f64.promote_f32" });
      return;
    default:
      throw new Error(`extern-C import result type '${declared.kind}' is not supported yet.`);
  }
}
