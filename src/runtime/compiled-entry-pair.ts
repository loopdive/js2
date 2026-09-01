type StructPredicate = (value: unknown) => boolean;
type VecPredicate = (value: unknown, exports: Record<string, Function>) => boolean;
type HostWrapper = (value: unknown, exports: Record<string, Function>) => unknown;

/**
 * (#5205) Decode one compiled `[key, value]` pair for the engine's
 * AddEntriesFromIterable operation. The conversion is deliberately shallow so
 * the two values retain identity and live mutation behavior.
 */
export function decodeCompiledEntryPair(
  entry: any,
  exports: Record<string, Function> | undefined,
  isWasmStruct: StructPredicate,
  isWasmVec: VecPredicate,
  wrapForHost: HostWrapper,
): any {
  if (entry == null || typeof entry !== "object" || !isWasmStruct(entry) || !exports) return entry;
  const vecLen = exports.__vec_len;
  const vecGet = exports.__vec_get;
  if (typeof vecLen === "function" && typeof vecGet === "function" && isWasmVec(entry, exports)) {
    const len = vecLen(entry) as number;
    if (typeof len === "number" && len >= 0) {
      const out: any[] = new Array(len);
      for (let i = 0; i < len; i++) out[i] = vecGet(entry, i);
      return out;
    }
  }
  const fieldNames = exports.__struct_field_names;
  if (typeof fieldNames === "function") {
    const names = fieldNames(entry) as string | null;
    if (typeof names === "string" && names.length > 0) {
      const parts = names.split(",");
      if (parts.every((part) => /^_\d+$/.test(part))) {
        const out: any[] = new Array(parts.length);
        for (let i = 0; i < parts.length; i++) {
          const getter = exports[`__sget_${parts[i]}`];
          out[i] = typeof getter === "function" ? getter(entry) : undefined;
        }
        return out;
      }
    }
  }
  return wrapForHost(entry, exports);
}
