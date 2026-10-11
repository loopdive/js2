/**
 * (#6438) Fail-closed guard for the historical `wrapExports(rawExports)` overload.
 *
 * `wrapExports` accepts either a genuine `WebAssembly.Instance` (preferred) or
 * the raw exports record (the historical API). Only the instance may ESTABLISH
 * the #3520 data-struct authority: a bare record can carry genuine donor
 * functions, so its shape is not evidence of origin. Without an authority the
 * host-bridge export view masks the compiler's own `__struct_field_names` to
 * `undefined`, `_structFieldNamesRaw` answers `null`, and `_wasmToPlain` walks
 * the "neither named struct nor vec" arm and produces `{}`.
 *
 * `{}` is indistinguishable from a genuinely field-less object, so the caller
 * reads a wrong answer with nothing to look at. The contract this module pins
 * is therefore "refuse loudly, never decode from a raw record": consuming an
 * authority established by `__setInstance(instance)` or by a prior Instance
 * wrap keeps working unchanged, and only the undecodable case throws.
 *
 * Deliberately NOT "decode from the raw record anyway": that would make a
 * mutable binding table the decoder, which #3520 exists to prevent.
 */

/** Runtime predicates owned by `src/runtime.ts`, injected so this module stays free of its internals. */
export interface StructDecodeProbes {
  /** `_isWasmStruct` — true for any opaque WasmGC struct receiver. */
  isStruct: (value: any) => boolean;
  /** `_isWasmVec` — true for a compiler-minted vec. */
  isVec: (value: any, exports: Record<string, Function> | undefined) => boolean;
  /** `_structFieldNamesRaw` — decoded field names, or `null` when no decoder can answer. */
  fieldNames: (value: any, exports: Record<string, Function> | undefined) => readonly string[] | null;
  /** The module's `__is_closure`, when it positively exports one. */
  isClosure: ((value: any) => number) | undefined;
}

/** Vec nesting depth the element scan walks before giving up. Deeper nests fall back to the old silent behaviour. */
const MAX_VEC_SCAN_DEPTH = 4;

function isCompiledClosure(value: any, probes: StructDecodeProbes): boolean {
  if (typeof probes.isClosure !== "function") return false;
  try {
    return probes.isClosure(value) === 1;
  } catch {
    return false;
  }
}

/**
 * True when `value` (or, for a vec, some element of it) is a struct whose
 * fields no decoder can name — i.e. the value that would silently marshal to
 * `{}` / `[{}, …]`.
 */
function hasUndecodableStruct(
  value: any,
  exports: Record<string, Function> | undefined,
  probes: StructDecodeProbes,
  depth: number,
  seen: Set<any>,
): boolean {
  if (value == null || typeof value !== "object" || !probes.isStruct(value)) return false;
  if (probes.isVec(value, exports)) {
    if (depth >= MAX_VEC_SCAN_DEPTH || seen.has(value)) return false;
    seen.add(value);
    const vecLen = exports?.__vec_len as ((vec: any) => number) | undefined;
    const vecGet = exports?.__vec_get as ((vec: any, index: number) => any) | undefined;
    if (typeof vecLen !== "function" || typeof vecGet !== "function") return false;
    let length: number;
    try {
      length = Number(vecLen(value));
    } catch {
      return false;
    }
    if (!Number.isFinite(length)) return false;
    for (let index = 0; index < length; index++) {
      let element: any;
      try {
        element = vecGet(value, index);
      } catch {
        continue;
      }
      if (hasUndecodableStruct(element, exports, probes, depth + 1, seen)) return true;
    }
    return false;
  }
  if (isCompiledClosure(value, probes)) return false;
  // A genuinely field-less struct on an AUTHENTICATED view still answers a
  // (possibly empty) name list here, so `{}` stays reachable for it; only a
  // masked decoder answers `null`.
  return probes.fieldNames(value, exports) == null;
}

/**
 * Returns the error to throw when `result` cannot be decoded through a raw
 * exports record, or `undefined` when the result decodes (or is not a struct
 * at all). The caller only consults this on the masked-decoder path, so the
 * vec scan costs nothing on the documented Instance overload.
 */
export function rawExportsStructDecodeError(
  result: any,
  exports: Record<string, Function> | undefined,
  exportName: string,
  probes: StructDecodeProbes,
): TypeError | undefined {
  if (!hasUndecodableStruct(result, exports, probes, 0, new Set<any>())) return undefined;
  return new TypeError(
    `wrapExports: export "${exportName}" returned a struct that cannot be decoded from a raw exports record — ` +
      "no data-struct authority is established for this module. Pass the WebAssembly.Instance to wrapExports, " +
      "or call importObject.__setInstance(instance) first.",
  );
}
