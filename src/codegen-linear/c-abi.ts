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
