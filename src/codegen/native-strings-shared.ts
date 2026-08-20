// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Shared per-call state for the native-string helper builders (#3182 Wave B).
 *
 * `ensureNativeStringHelpers` in `native-strings.ts` used to build every native
 * string helper (`__str_indexOf`, `__str_toLowerCase`, `__str_split`, …) inline
 * in one ~4.8k-LOC function. That function is being decomposed into cohesive
 * sibling modules (`native-strings-methods.ts`, …). Every extracted builder
 * needs the same handful of derived values that the original function computed
 * once at the top:
 *
 *   - `strRef` / `flatStrRef` / `strDataRef` — the three `ValType`s used in
 *     every helper's function signature and body (`ref $AnyString`,
 *     `ref $NativeString`, `ref $__str_data`).
 *   - `getFlattenIdx()` — reads the `__str_flatten` funcIdx from
 *     `ctx.nativeStrHelpers` at call time (it is registered mid-sequence).
 *   - `wrapBodyWithFlatten(body, strParamIndices)` — inserts the flatten
 *     preambles + `ref.cast $NativeString` fixups. Pure function of
 *     `strTypeIdx` + `getFlattenIdx`.
 *
 * `makeNativeStrShared` bundles these into a `NativeStrShared` bag so each
 * extracted builder can accept a single param and destructure exactly what it
 * needs. The reconstruction is byte-identical to the original inline
 * definitions (mirrors the #679/#682/#3069 dual-backend extraction pattern):
 * relocating a pure builder does not change the emitted bytes.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Derived per-call state shared by every native-string helper builder. */
export interface NativeStrShared {
  ctx: CodegenContext;
  /** NativeString (FlatString) struct type index. */
  strTypeIdx: number;
  /** `$__str_data` (i16 backing array) type index. */
  strDataTypeIdx: number;
  /** `$AnyString` base (supertype) type index. */
  anyStrTypeIdx: number;
  /** `$ConsString` type index. */
  consStrTypeIdx: number;
  /** `ref $AnyString` — every string value is FlatString or ConsString. */
  strRef: ValType;
  /** `ref $NativeString`. */
  flatStrRef: ValType;
  /** `ref $__str_data`. */
  strDataRef: ValType;
  /** `__str_flatten` funcIdx (valid only after flatten is registered). */
  getFlattenIdx: () => number;
  /** Wrap a helper body with flatten preambles + `ref.cast` fixups. */
  wrapBodyWithFlatten: (body: Instr[], strParamIndices: number[]) => Instr[];
}

/**
 * Build the {@link NativeStrShared} bag from the four native-string type
 * indices. Byte-identical to the inline `strRef`/`flatStrRef`/`strDataRef`/
 * `getFlattenIdx`/`wrapBodyWithFlatten` definitions that lived at the top of
 * `ensureNativeStringHelpers`.
 */
export function makeNativeStrShared(
  ctx: CodegenContext,
  strTypeIdx: number,
  strDataTypeIdx: number,
  anyStrTypeIdx: number,
  consStrTypeIdx: number,
): NativeStrShared {
  // strRef = ref $AnyString — used in all helper function signatures (params and results).
  // All string values in the system can be either FlatString or ConsString.
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx }; // ref $NativeString
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // Helper: get the flatten function index (available after flatten is registered)
  const getFlattenIdx = () => ctx.nativeStrHelpers.get("__str_flatten")!;

  /**
   * Wrap a helper body with flatten preambles for string params.
   * For each string param index in `strParamIndices`, adds:
   *   local.get $param → call $__str_flatten → local.set $param
   * This ensures the param (typed ref $AnyString) actually holds a NativeString.
   * Also inserts ref.cast $NativeString before every struct.get $NativeString
   * to satisfy the wasm type checker.
   */
  function wrapBodyWithFlatten(body: Instr[], strParamIndices: number[]): Instr[] {
    // 1. Build flatten preamble. (#3673) The `__str_flatten` call is guarded by
    // an inline `ref.test $NativeString` — already-flat params (the
    // overwhelmingly common case once literals are interned) skip the call
    // entirely. These preambles run on EVERY string-helper invocation
    // (`__str_equals` alone is called per property probe), and the
    // unconditional call was 35% of a standalone compiled-acorn parse.
    const preamble: Instr[] = [];
    for (const idx of strParamIndices) {
      preamble.push(
        { op: "local.get", index: idx },
        { op: "ref.test", typeIdx: strTypeIdx },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: idx },
            { op: "call", funcIdx: getFlattenIdx() },
            // flatten returns ref $NativeString which is subtype of ref $AnyString — can store in param
            { op: "local.set", index: idx },
          ],
        },
      );
    }

    // 2. Insert ref.cast before every struct.get $NativeString
    const processed: Instr[] = [];
    for (const instr of body) {
      if (instr.op === "struct.get" && (instr as any).typeIdx === strTypeIdx) {
        processed.push({ op: "ref.cast", typeIdx: strTypeIdx });
      }
      // Recurse into if/block/loop bodies
      if (instr.op === "if") {
        const ifInstr = instr as any;
        const newIf: any = { ...ifInstr };
        if (ifInstr.then) newIf.then = wrapBodyWithFlatten(ifInstr.then, []).slice(0); // no preamble for sub-bodies
        if (ifInstr.else) newIf.else = wrapBodyWithFlatten(ifInstr.else, []).slice(0);
        processed.push(newIf);
        continue;
      }
      if (instr.op === "block" || instr.op === "loop" || instr.op === "try_table") {
        const blockInstr = instr as any;
        const newBlock: any = { ...blockInstr };
        if (blockInstr.body) newBlock.body = wrapBodyWithFlatten(blockInstr.body, []).slice(0);
        processed.push(newBlock);
        continue;
      }
      processed.push(instr);
    }

    return [...preamble, ...processed];
  }

  return {
    ctx,
    strTypeIdx,
    strDataTypeIdx,
    anyStrTypeIdx,
    consStrTypeIdx,
    strRef,
    flatStrRef,
    strDataRef,
    getFlattenIdx,
    wrapBodyWithFlatten,
  };
}
