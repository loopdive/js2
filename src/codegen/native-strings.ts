// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Native WasmGC string helpers — $AnyString, $FlatString, $ConsString types
 * and ensureNativeStringHelpers which emits the full string runtime.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { ensureAnyValueType } from "./any-helpers.js";
import { emitNativeCaseConversion } from "./case-convert-native.js";
import { emitNativeHtmlWrapperHelpers } from "./html-wrapper-native.js";
import { emitNativeWellFormedHelpers } from "./wellformed-native.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { addImport } from "./registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterErrorStructType,
  getOrRegisterVecType,
} from "./registry/types.js";

export function nativeStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * #1588 PR-B part 2: the cons-string flatten body — `__str_flatten`'s `else`
 * arm for a non-flat, non-Utf8String input (i.e. a ConsString rope). Extracted
 * so the Utf8String dispatch arm can wrap it. Operates on locals: s(0), len(1),
 * buf(2). Returns the rope flattened to a `NativeString`.
 */
function flattenConsBody(
  strDataTypeIdx: number,
  strTypeIdx: number,
  anyStrTypeIdx: number,
  copyTreeIdx: number,
): Instr[] {
  return [
    // len = s.len (field 0 of AnyString)
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: 1 },
    // buf = array.new_default(len)
    { op: "local.get", index: 1 },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: 2 },
    // copy_tree(s, buf, 0)
    { op: "local.get", index: 0 },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: copyTreeIdx },
    { op: "drop" },
    // return struct.new $NativeString(len, 0, buf)
    { op: "local.get", index: 1 },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 2 },
    { op: "struct.new", typeIdx: strTypeIdx },
  ];
}

/**
 * Build the inline instruction sequence that materializes a string literal as
 * a NativeString (FlatString) struct ref. Mirrors `compileNativeStringLiteral`
 * but returns an `Instr[]` for callers that build instruction streams without
 * a `FunctionContext` (e.g. throw-instr builders that return `Instr[]`).
 */
export function nativeStringLiteralInstrs(ctx: CodegenContext, value: string, encoding?: StringEncoding): Instr[] {
  // #1588 PR-B: when `--utf8-storage` is on and the literal is proven
  // `ascii`/`utf8-guaranteed`, materialize an i8-backed `Utf8String` instead
  // of the i16 `NativeString`. When off (or the literal is `wtf16`/unknown),
  // this is byte-identical to before.
  if (ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && (encoding === "ascii" || encoding === "utf8-guaranteed")) {
    return utf8StringLiteralInstrs(ctx, value);
  }

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const instrs: Instr[] = [];
  // len (i32), off (i32) = 0
  instrs.push({ op: "i32.const", value: value.length });
  instrs.push({ op: "i32.const", value: 0 });
  // code units, then array.new_fixed
  for (let i = 0; i < value.length; i++) {
    instrs.push({ op: "i32.const", value: value.charCodeAt(i) });
  }
  instrs.push({
    op: "array.new_fixed",
    typeIdx: strDataTypeIdx,
    length: value.length,
  });
  // struct.new $NativeString(len, off, data)
  instrs.push({ op: "struct.new", typeIdx: strTypeIdx });
  return instrs;
}

/** #1588 PR-B: encoding annotation values the lowering sites consume. Mirrors
 *  `Encoding` in `src/ir/analysis/encoding.ts` (kept as a local string-union to
 *  avoid a codegen→ir import cycle). */
export type StringEncoding = "ascii" | "utf8-guaranteed" | "wtf16";

/**
 * #1588 PR-B: materialize a string literal as an i8-backed `Utf8String`.
 * Precondition (asserted): `value` contains no lone surrogate — guaranteed by
 * the encoding classifier (a lone surrogate is always `wtf16`, never reaches
 * here). The assert is a defensive guard against a future classifier bug
 * emitting malformed UTF-8 bytes.
 */
function utf8StringLiteralInstrs(ctx: CodegenContext, value: string): Instr[] {
  const bytes = utf8Encode(value);
  const instrs: Instr[] = [];
  // len = code-unit (UTF-16) length, byteLen = UTF-8 byte length, off = 0.
  instrs.push({ op: "i32.const", value: value.length });
  instrs.push({ op: "i32.const", value: bytes.length });
  instrs.push({ op: "i32.const", value: 0 });
  for (const b of bytes) {
    instrs.push({ op: "i32.const", value: b });
  }
  instrs.push({
    op: "array.new_fixed",
    typeIdx: ctx.utf8StrDataTypeIdx,
    length: bytes.length,
  });
  // struct.new $Utf8String(len, byteLen, off, data)
  instrs.push({ op: "struct.new", typeIdx: ctx.utf8StrTypeIdx });
  return instrs;
}

/**
 * Encode a JS (WTF-16) string to UTF-8 bytes. Asserts no lone surrogate — the
 * caller only invokes this for `ascii`/`utf8-guaranteed` strings, which the
 * classifier guarantees are well-formed. Uses code points (handles
 * well-formed surrogate pairs for astral scalars).
 */
function utf8Encode(value: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let cp = value.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      } else {
        throw new Error(
          `#1588 utf8Encode: lone high surrogate in a string annotated utf8-guaranteed/ascii — classifier bug`,
        );
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      throw new Error(
        `#1588 utf8Encode: lone low surrogate in a string annotated utf8-guaranteed/ascii — classifier bug`,
      );
    }
    if (cp <= 0x7f) {
      out.push(cp);
    } else if (cp <= 0x7ff) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return out;
}

/**
 * Build inline instructions that push a string constant onto the stack as an
 * externref (the type expected by the throw tag and by host imports). In
 * nativeStrings mode, materializes the FlatString struct inline and converts
 * to externref. In legacy mode, emits a plain `global.get` of the
 * `string_constants` import. Both branches require the value to be present
 * in `ctx.stringGlobalMap` — call `addStringConstantGlobal(ctx, value)` first.
 */
export function stringConstantExternrefInstrs(ctx: CodegenContext, value: string): Instr[] {
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const instrs = nativeStringLiteralInstrs(ctx, value);
    // ref $NativeString -> externref
    instrs.push({ op: "extern.convert_any" } as Instr);
    return instrs;
  }
  const strIdx = ctx.stringGlobalMap.get(value);
  if (strIdx === undefined || strIdx < 0) {
    // Defensive: caller forgot to register, or sentinel. Push undefined.
    return [{ op: "ref.null.extern" } as Instr];
  }
  return [{ op: "global.get", index: strIdx } as Instr];
}

/**
 * Get the nullable ValType for a string reference (ref null $AnyString).
 */
export function nativeStringTypeNullable(ctx: CodegenContext): ValType {
  return { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
}

/**
 * Get the ValType for a flat string reference (ref $NativeString).
 */
export function flatStringType(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.nativeStrTypeIdx };
}

/**
 * Emit native string helper functions into the module.
 * Called lazily when string operations are first encountered in fast mode.
 *
 * IMPORTANT: All imports must be registered BEFORE any module functions,
 * because wasm function indices are: imports first, then module functions.
 */
export function ensureNativeStringHelpers(ctx: CodegenContext): void {
  if (ctx.nativeStrHelpersEmitted) return;
  ctx.nativeStrHelpersEmitted = true;
  // #2039: settle any deferred ensureLateImport batch before baking funcIdx
  // values. Registering these helpers mid-batch would bake post-batch indices
  // that the deferred flush then over-shifts by its delta. Same guard as
  // ensureObjectRuntime / addUnionImports.
  flushLateImportShifts(ctx, null);
  // #1677: snapshot the import-function count at the instant the helpers are
  // emitted. Imports added later during the same finalize phase shift these
  // helpers' true indices but NOT their baked-in sibling-call targets;
  // `reconcileNativeStrFinalizeShift` applies that delta at finalize end.
  if (ctx.nativeStrHelperImportBase < 0) {
    ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
  }

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx; // NativeString (FlatString) struct type index
  const anyStrTypeIdx = ctx.anyStrTypeIdx; // AnyString base type index
  const consStrTypeIdx = ctx.consStrTypeIdx; // ConsString type index
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
    // 1. Build flatten preamble
    const preamble: Instr[] = [];
    for (const idx of strParamIndices) {
      preamble.push(
        { op: "local.get", index: idx },
        { op: "call", funcIdx: getFlattenIdx() },
        // flatten returns ref $NativeString which is subtype of ref $AnyString — can store in param
        { op: "local.set", index: idx },
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
      if (instr.op === "block" || instr.op === "loop") {
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

  // ── Step 2: Now add all module functions ─────────────────────────

  // --- $__str_copy_tree(node: ref $AnyString, buf: ref $__str_data, pos: i32) -> i32 ---
  // Iteratively copies rope tree into a flat buffer. Returns next write position.
  //
  // Previously this used self-recursion to traverse the rope tree, which caused
  // a wasm `call stack exhausted` trap on left-leaning ropes built by `text +=
  // expr` patterns over many thousands of iterations (#1178). The deep
  // left-spine of `Cons(Cons(Cons(..., c2), c1), c0)` made one stack frame per
  // cons node.
  //
  // The iterative version uses an explicit worklist of right-children. We
  // descend the leftmost spine (pushing right-children onto the worklist),
  // copy each flat leaf, then pop and resume from the most recently pushed
  // right-child. Stack usage is now O(1); heap usage is O(node.len) for the
  // worklist (overestimate; depth ≤ leaves ≤ len since each leaf has ≥ 1 char).
  {
    // Register the worklist's array type: (array (mut (ref null $AnyString))).
    // Reuses the same registration as `__str_split` (keyed by `ref_<anyStr>`).
    const wlElemKey = `ref_${anyStrTypeIdx}`;
    const wlElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const wlArrTypeIdx = getOrRegisterArrayType(ctx, wlElemKey, wlElemType);
    const wlArrRefNull: ValType = { kind: "ref_null", typeIdx: wlArrTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strDataRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_copy_tree", funcIdx);

    // params: node(0), buf(1), pos(2)
    // locals:
    //   flat(3): ref_null $NativeString — current flat node being copied
    //   flatOff(4): i32
    //   flatLen(5): i32
    //   cur(6): ref_null $AnyString — current node in the descent
    //   worklist(7): ref_null $AnyString_arr — pending right-children
    //   wlTop(8): i32 — number of items currently on the worklist
    //   newWl(9): ref_null $AnyString_arr — scratch slot for grow-on-push reallocation (#1184)
    const FLAT = 3;
    const FLAT_OFF = 4;
    const FLAT_LEN = 5;
    const CUR = 6;
    const WL = 7;
    const WL_TOP = 8;
    const NEW_WL = 9;

    const body: Instr[] = [
      // Fast path: if node is already a FlatString, copy directly and return.
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
          { op: "local.set", index: FLAT },

          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.set", index: FLAT_OFF },

          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
          { op: "local.set", index: FLAT_LEN },

          // array.copy(buf, pos, flat.data, flatOff, flatLen)
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: FLAT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: FLAT_OFF },
          { op: "local.get", index: FLAT_LEN },
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // return pos + flatLen
          { op: "local.get", index: 2 },
          { op: "local.get", index: FLAT_LEN },
          { op: "i32.add" },
          { op: "return" },
        ],
      },

      // Slow path: rope traversal with an explicit worklist of right-children.
      //
      // #1184: pre-#1184, this allocated a worklist sized at `node.len` (a generous
      // upper bound on rope depth — depth ≤ leaves ≤ chars). For balanced ropes
      // (depth ~log N) on a long string, that's a huge over-allocation: a 1MB
      // ConsString with a balanced rope has depth ~20 but allocates 1M ref slots
      // (≈8MB on 64-bit WasmGC). Each `String.prototype.charAt` / `charCodeAt` /
      // `substring` etc. on a ConsString triggers a fresh flatten → copy_tree →
      // huge allocation, producing severe GC pressure on string-heavy workloads.
      //
      // Strategy: dynamic growth. Start with a small fixed initial capacity (16
      // slots — enough for any rope of depth ≤ 16, which covers virtually all
      // balanced ropes up to ~1MB). When the worklist would overflow on push,
      // double its capacity via array.copy. Final capacity is at most the rope
      // depth; geometric reallocation gives O(depth) total allocation.
      //
      // Worst-case (left-leaning rope of depth N): log2(N/16) reallocations,
      // total slots allocated = 2N (geometric series). Same order as the
      // pre-#1184 N-slot single-allocation, but spread across log N small
      // allocations. The common case (depth ≤ 16) does ONE 16-slot allocation
      // — orders of magnitude smaller than `node.len`.
      //
      // worklist = array.new_default<ref_null $AnyString>(16)
      { op: "i32.const", value: 16 },
      { op: "array.new_default", typeIdx: wlArrTypeIdx },
      { op: "local.set", index: WL },

      // wlTop = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: WL_TOP },

      // cur = node
      { op: "local.get", index: 0 },
      { op: "local.set", index: CUR },

      // Outer loop: descend left, copy a flat segment, pop next right-child.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // Inner loop: walk left while cur is a ConsString, pushing
              // right-children onto the worklist. Exits when cur is FlatString.
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      // if cur is FlatString: br to end of inner block (depth 1)
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.test", typeIdx: strTypeIdx },
                      { op: "br_if", depth: 1 },

                      // #1184: grow worklist if full (wlTop >= worklist.len).
                      // Doubling-grow: array.new_default(len * 2), array.copy old → new.
                      { op: "local.get", index: WL_TOP },
                      { op: "local.get", index: WL },
                      { op: "ref.as_non_null" },
                      { op: "array.len" },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          // newWl = array.new_default(worklist.len << 1)
                          { op: "local.get", index: WL } as Instr,
                          { op: "ref.as_non_null" } as Instr,
                          { op: "array.len" } as Instr,
                          { op: "i32.const", value: 1 } as Instr,
                          { op: "i32.shl" } as Instr,
                          {
                            op: "array.new_default",
                            typeIdx: wlArrTypeIdx,
                          } as Instr,
                          { op: "local.set", index: NEW_WL } as Instr,

                          // array.copy(newWl, 0, worklist, 0, wlTop)
                          { op: "local.get", index: NEW_WL } as Instr,
                          { op: "ref.as_non_null" } as Instr,
                          { op: "i32.const", value: 0 } as Instr,
                          { op: "local.get", index: WL } as Instr,
                          { op: "ref.as_non_null" } as Instr,
                          { op: "i32.const", value: 0 } as Instr,
                          { op: "local.get", index: WL_TOP } as Instr,
                          {
                            op: "array.copy",
                            dstTypeIdx: wlArrTypeIdx,
                            srcTypeIdx: wlArrTypeIdx,
                          } as Instr,

                          // worklist = newWl
                          { op: "local.get", index: NEW_WL } as Instr,
                          { op: "local.set", index: WL } as Instr,
                        ],
                      },

                      // worklist[wlTop] = (cur as ConsString).right
                      { op: "local.get", index: WL },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: WL_TOP },
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.cast", typeIdx: consStrTypeIdx },
                      {
                        op: "struct.get",
                        typeIdx: consStrTypeIdx,
                        fieldIdx: 2,
                      },
                      { op: "array.set", typeIdx: wlArrTypeIdx },

                      // wlTop++
                      { op: "local.get", index: WL_TOP },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: WL_TOP },

                      // cur = (cur as ConsString).left
                      { op: "local.get", index: CUR },
                      { op: "ref.as_non_null" },
                      { op: "ref.cast", typeIdx: consStrTypeIdx },
                      {
                        op: "struct.get",
                        typeIdx: consStrTypeIdx,
                        fieldIdx: 1,
                      },
                      { op: "local.set", index: CUR },

                      // continue inner loop
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },

              // cur is a FlatString — copy its contents into buf at pos.
              { op: "local.get", index: CUR },
              { op: "ref.as_non_null" },
              { op: "ref.cast", typeIdx: strTypeIdx },
              { op: "local.set", index: FLAT },

              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
              { op: "local.set", index: FLAT_OFF },

              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
              { op: "local.set", index: FLAT_LEN },

              // array.copy(buf, pos, flat.data, flatOff, flatLen)
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: FLAT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
              { op: "local.get", index: FLAT_OFF },
              { op: "local.get", index: FLAT_LEN },
              {
                op: "array.copy",
                dstTypeIdx: strDataTypeIdx,
                srcTypeIdx: strDataTypeIdx,
              },

              // pos += flatLen
              { op: "local.get", index: 2 },
              { op: "local.get", index: FLAT_LEN },
              { op: "i32.add" },
              { op: "local.set", index: 2 },

              // if wlTop == 0: br to end of outer block (depth 1) — done
              { op: "local.get", index: WL_TOP },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },

              // wlTop--
              { op: "local.get", index: WL_TOP },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: WL_TOP },

              // cur = worklist[wlTop]
              { op: "local.get", index: WL },
              { op: "ref.as_non_null" },
              { op: "local.get", index: WL_TOP },
              { op: "array.get", typeIdx: wlArrTypeIdx },
              { op: "local.set", index: CUR },

              // continue outer loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return pos
      { op: "local.get", index: 2 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_copy_tree",
      typeIdx,
      locals: [
        { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatOff", type: { kind: "i32" } },
        { name: "flatLen", type: { kind: "i32" } },
        { name: "cur", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "worklist", type: wlArrRefNull },
        { name: "wlTop", type: { kind: "i32" } },
        { name: "newWl", type: wlArrRefNull },
      ],
      body,
      exported: false,
    });
  }

  // #1588 PR-B part 2: $__str_utf8_to_flat(u: ref $Utf8String) -> ref $NativeString
  // Decode the i8 UTF-8 bytes back to i16 WTF-16 code units. Only emitted when
  // --utf8-storage is on (the Utf8String type exists). The output array is
  // pre-sized to `u.len` (the code-unit count stored at allocation time), so no
  // resize is needed. Well-formed UTF-8 is assumed (the encoder only produces it
  // for ascii/utf8-guaranteed strings; lone surrogates never reach i8 storage).
  if (ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0) {
    const u8StrRef: ValType = { kind: "ref", typeIdx: ctx.utf8StrTypeIdx };
    const typeIdx = addFuncType(ctx, [u8StrRef], [flatStrRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_utf8_to_flat", funcIdx);
    // params: u(0)
    // locals: len(1) code-unit count, byteLen(2), data(3) i8 array, out(4) i16 array,
    //         b(5) byte index, o(6) out index, c0(7) lead byte, cp(8) code point
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 0 }, // len
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 1 }, // byteLen
      { op: "local.set", index: 2 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.utf8StrTypeIdx, fieldIdx: 3 }, // data (ref $__str_data_u8)
      { op: "local.set", index: 3 },
      // out = array.new_default $__str_data(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 }, // b = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 6 }, // o = 0
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if b >= byteLen break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // c0 = data[b] & 0xFF (array.get_u zero-extends an i8 lane)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get_u", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.set", index: 7 },
              // dispatch on c0
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 0x80 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // 1-byte: cp = c0
                  { op: "local.get", index: 7 },
                  { op: "local.set", index: 8 },
                  { op: "local.get", index: 5 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 5 },
                ],
                else: [
                  { op: "local.get", index: 7 },
                  { op: "i32.const", value: 0xe0 },
                  { op: "i32.lt_u" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // 2-byte: cp = ((c0 & 0x1F)<<6) | (data[b+1] & 0x3F)
                      { op: "local.get", index: 7 },
                      { op: "i32.const", value: 0x1f },
                      { op: "i32.and" },
                      { op: "i32.const", value: 6 },
                      { op: "i32.shl" },
                      { op: "local.get", index: 3 },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: ctx.utf8StrDataTypeIdx },
                      { op: "i32.const", value: 0x3f },
                      { op: "i32.and" },
                      { op: "i32.or" },
                      { op: "local.set", index: 8 },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 2 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                    ],
                    else: [
                      { op: "local.get", index: 7 },
                      { op: "i32.const", value: 0xf0 },
                      { op: "i32.lt_u" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          // 3-byte: cp = ((c0&0x0F)<<12)|((b1&0x3F)<<6)|(b2&0x3F)
                          { op: "local.get", index: 7 },
                          { op: "i32.const", value: 0x0f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 12 },
                          { op: "i32.shl" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 6 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 2 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.or" },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 3 },
                          { op: "i32.add" },
                          { op: "local.set", index: 5 },
                        ],
                        else: [
                          // 4-byte: cp = ((c0&0x07)<<18)|((b1&0x3F)<<12)|((b2&0x3F)<<6)|(b3&0x3F)
                          { op: "local.get", index: 7 },
                          { op: "i32.const", value: 0x07 },
                          { op: "i32.and" },
                          { op: "i32.const", value: 18 },
                          { op: "i32.shl" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 12 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 2 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.const", value: 6 },
                          { op: "i32.shl" },
                          { op: "i32.or" },
                          { op: "local.get", index: 3 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 3 },
                          { op: "i32.add" },
                          {
                            op: "array.get_u",
                            typeIdx: ctx.utf8StrDataTypeIdx,
                          },
                          { op: "i32.const", value: 0x3f },
                          { op: "i32.and" },
                          { op: "i32.or" },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 5 },
                          { op: "i32.const", value: 4 },
                          { op: "i32.add" },
                          { op: "local.set", index: 5 },
                        ],
                      },
                    ],
                  },
                ],
              },
              // emit cp into out: BMP → one code unit; astral → surrogate pair
              { op: "local.get", index: 8 },
              { op: "i32.const", value: 0xffff },
              { op: "i32.gt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // cp -= 0x10000; high = 0xD800 | (cp>>10); low = 0xDC00 | (cp&0x3FF)
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 0x10000 },
                  { op: "i32.sub" },
                  { op: "local.set", index: 8 },
                  // out[o] = 0xD800 | (cp>>10)
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 0xd800 },
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 10 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                  // out[o] = 0xDC00 | (cp & 0x3FF)
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 0xdc00 },
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 0x3ff },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                ],
                else: [
                  // out[o] = cp
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 6 },
                  { op: "local.get", index: 8 },
                  { op: "array.set", typeIdx: strDataTypeIdx },
                  { op: "local.get", index: 6 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 6 },
                ],
              },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return struct.new $NativeString(len, 0, out)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 4 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];
    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_utf8_to_flat",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "byteLen", type: { kind: "i32" } },
        {
          name: "data",
          type: { kind: "ref", typeIdx: ctx.utf8StrDataTypeIdx },
        },
        { name: "out", type: strDataRef },
        { name: "b", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "c0", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_flatten(s: ref $AnyString) -> ref $NativeString ---
  // If s is already a FlatString, returns it. Otherwise flattens the rope tree.
  {
    const typeIdx = addFuncType(ctx, [strRef], [flatStrRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_flatten", funcIdx);
    // Also register in funcMap so the deferred late-import shift
    // (flushLateImportShifts walks ctx.funcMap) keeps __str_flatten's index
    // correct when imports are added after this registration. Internal callers
    // that emit a `call __str_flatten` between flatten's registration and a
    // late-import addition (notably ensureNativeStringExternBridge's
    // __str_to_extern, which adds 3 fd-bridge imports first) would otherwise
    // read a stale-low nativeStrHelpers index. funcMap is the authoritative,
    // shift-maintained map; no code looks up __str_flatten via funcMap so adding
    // it is side-effect-free. (#1618)
    ctx.funcMap.set("__str_flatten", funcIdx);

    const copyTreeIdx = ctx.nativeStrHelpers.get("__str_copy_tree")!;
    // #1588 PR-B part 2: present iff --utf8-storage is on.
    const utf8ToFlatIdx = ctx.nativeStrHelpers.get("__str_utf8_to_flat");

    // params: s(0)
    // locals: len(1), buf(2)
    const body: Instr[] = [
      // if s is already a FlatString, return it
      { op: "local.get", index: 0 },
      { op: "ref.test", typeIdx: strTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: flatStrRef },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: strTypeIdx },
        ],
        else:
          ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && utf8ToFlatIdx !== undefined
            ? [
                // #1588 PR-B part 2: if s is a Utf8String, decode it to a NativeString.
                { op: "local.get", index: 0 },
                { op: "ref.test", typeIdx: ctx.utf8StrTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: flatStrRef },
                  then: [
                    { op: "local.get", index: 0 },
                    { op: "ref.cast", typeIdx: ctx.utf8StrTypeIdx },
                    { op: "call", funcIdx: utf8ToFlatIdx },
                  ],
                  else: flattenConsBody(strDataTypeIdx, strTypeIdx, anyStrTypeIdx, copyTreeIdx),
                },
              ]
            : flattenConsBody(strDataTypeIdx, strTypeIdx, anyStrTypeIdx, copyTreeIdx),
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_flatten",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "buf", type: strDataRef },
      ],
      body,
      exported: false,
    });
  }

  // #1588 PR-C: $__str_to_utf8(s: ref $AnyString) -> ref $__str_data_u8
  //
  // Standalone (pure-Wasm, no JS host call) WTF-16 → UTF-8 transcoder. Takes any
  // string value (NativeString, ConsString, or Utf8String), flattens it to a
  // contiguous i16 buffer, then encodes the code units to a freshly-allocated i8
  // UTF-8 byte array. This is the missing primitive the Component-Model boundary
  // (Edge B, deferred — see ADR-0015) will eventually call instead of a host
  // `TextEncoder` import, satisfying the "JS host optional" architecture rule.
  //
  // Semantics: this is the *conservative* encoder. Unlike the compile-time
  // `utf8Encode` (which asserts well-formedness for ascii/utf8-guaranteed
  // literals), this runtime helper handles arbitrary WTF-16 input. A lone
  // surrogate is encoded with the WTF-8 generalization (3-byte form of the raw
  // code unit 0xD800–0xDFFF) so the function is total and never traps. The
  // Component-Model fast path is only ever selected for values the encoding
  // analysis proved `utf8-guaranteed`, so a lone surrogate never reaches the
  // boundary fast path; this helper's surrogate handling is a defensive
  // totality guarantee, not a correctness path.
  //
  // Two passes over the flattened i16 buffer: pass 1 sums the UTF-8 byte length
  // so the output array is allocated exactly once (no realloc); pass 2 writes
  // the bytes. Only emitted when `--utf8-storage` is on (the i8 backing array
  // type `__str_data_u8` is registered only then).
  if (ctx.utf8Storage && ctx.utf8StrDataTypeIdx >= 0) {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const u8DataRef: ValType = { kind: "ref", typeIdx: ctx.utf8StrDataTypeIdx };
    const typeIdx = addFuncType(ctx, [strRef], [u8DataRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_to_utf8", funcIdx);

    // params: s(0)
    // locals:
    //   flat(1): ref $NativeString — flattened input
    //   data(2): ref $__str_data — i16 code units
    //   off(3): i32 — flat.off
    //   len(4): i32 — flat.len (code-unit count)
    //   out(5): ref $__str_data_u8 — UTF-8 output array
    //   i(6): i32 — code-unit cursor (shared by both passes)
    //   o(7): i32 — output byte cursor
    //   byteLen(8): i32 — total UTF-8 byte length (pass 1 result)
    //   cu(9): i32 — current code unit
    //   cp(10): i32 — current code point (after surrogate-pair decode)
    //   lo(11): i32 — trailing low surrogate scratch
    const FLAT = 1;
    const DATA = 2;
    const OFF = 3;
    const LEN = 4;
    const OUT = 5;
    const I = 6;
    const O = 7;
    const BYTELEN = 8;
    const CU = 9;
    const CP = 10;
    const LO = 11;

    // Shared sub-sequence: read the code point starting at code-unit index I of
    // `data`+`off`, advancing I past the consumed unit(s). Leaves cp in CP.
    // Handles a well-formed high+low surrogate pair (astral scalar) and treats a
    // lone surrogate as its raw code-unit value (WTF-8). `bodyAfterCp` is emitted
    // after CP is set and I is advanced; it differs between the two passes.
    const decodeCp = (bodyAfterCp: Instr[]): Instr[] => [
      // cu = data[off + i]
      { op: "local.get", index: DATA },
      { op: "local.get", index: OFF },
      { op: "local.get", index: I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: CU },
      // cp = cu (default)
      { op: "local.get", index: CU },
      { op: "local.set", index: CP },
      // i++ (consume the lead unit)
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: I },
      // if cu is a high surrogate (0xD800..0xDBFF) and a low surrogate follows,
      // combine into an astral code point and consume the low unit too.
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xd800 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xdbff },
      { op: "i32.le_u" },
      { op: "i32.and" },
      // && i < len (a low unit exists)
      { op: "local.get", index: I },
      { op: "local.get", index: LEN },
      { op: "i32.lt_s" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // lo = data[off + i]
          { op: "local.get", index: DATA },
          { op: "local.get", index: OFF },
          { op: "local.get", index: I },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.set", index: LO },
          // if lo in 0xDC00..0xDFFF: cp = 0x10000 + ((cu-0xD800)<<10) + (lo-0xDC00); i++
          { op: "local.get", index: LO },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.ge_u" },
          { op: "local.get", index: LO },
          { op: "i32.const", value: 0xdfff },
          { op: "i32.le_u" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 0x10000 },
              { op: "local.get", index: CU },
              { op: "i32.const", value: 0xd800 },
              { op: "i32.sub" },
              { op: "i32.const", value: 10 },
              { op: "i32.shl" },
              { op: "i32.add" },
              { op: "local.get", index: LO },
              { op: "i32.const", value: 0xdc00 },
              { op: "i32.sub" },
              { op: "i32.add" },
              { op: "local.set", index: CP },
              // i++ (consume the low unit)
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: I },
            ],
          },
        ],
      },
      ...bodyAfterCp,
    ];

    // Byte-length contribution of cp (UTF-8 / WTF-8): 1/2/3/4 bytes.
    // <=0x7F → 1; <=0x7FF → 2; <=0xFFFF → 3 (incl. lone surrogates); else 4.
    const cpByteLen = (onResult: Instr[]): Instr[] => [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x80 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, ...onResult],
        else: [
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x800 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 2 }, ...onResult],
            else: [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x10000 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 3 }, ...onResult],
                else: [{ op: "i32.const", value: 4 }, ...onResult],
              },
            ],
          },
        ],
      },
    ];

    // Write cp as UTF-8 bytes into out[o..], advancing o.
    const writeBytes: Instr[] = [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x80 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // out[o] = cp; o += 1
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "local.get", index: CP },
          { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
          { op: "local.get", index: O },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: O },
        ],
        else: [
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x800 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // 2-byte: 0xC0|(cp>>6), 0x80|(cp&0x3F)
              { op: "local.get", index: OUT },
              { op: "local.get", index: O },
              { op: "i32.const", value: 0xc0 },
              { op: "local.get", index: CP },
              { op: "i32.const", value: 6 },
              { op: "i32.shr_u" },
              { op: "i32.or" },
              { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.get", index: OUT },
              { op: "local.get", index: O },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 0x80 },
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x3f },
              { op: "i32.and" },
              { op: "i32.or" },
              { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
              { op: "local.get", index: O },
              { op: "i32.const", value: 2 },
              { op: "i32.add" },
              { op: "local.set", index: O },
            ],
            else: [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x10000 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // 3-byte: 0xE0|(cp>>12), 0x80|((cp>>6)&0x3F), 0x80|(cp&0x3F)
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 0xe0 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 2 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 3 },
                  { op: "i32.add" },
                  { op: "local.set", index: O },
                ],
                else: [
                  // 4-byte: 0xF0|(cp>>18), 0x80|((cp>>12)&0x3F), 0x80|((cp>>6)&0x3F), 0x80|(cp&0x3F)
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 0xf0 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 18 },
                  { op: "i32.shr_u" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 2 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shr_u" },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: OUT },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 3 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x80 },
                  { op: "local.get", index: CP },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "array.set", typeIdx: ctx.utf8StrDataTypeIdx },
                  { op: "local.get", index: O },
                  { op: "i32.const", value: 4 },
                  { op: "i32.add" },
                  { op: "local.set", index: O },
                ],
              },
            ],
          },
        ],
      },
    ];

    const body: Instr[] = [
      // flat = __str_flatten(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT },
      // off = flat.off, len = flat.len, data = flat.data
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },

      // --- Pass 1: compute byteLen ---
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: BYTELEN },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len break
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // decode cp (advances i), then byteLen += cpByteLen(cp)
              ...decodeCp(
                cpByteLen([
                  { op: "local.get", index: BYTELEN },
                  { op: "i32.add" },
                  { op: "local.set", index: BYTELEN },
                ]),
              ),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // out = array.new_default $__str_data_u8(byteLen)
      { op: "local.get", index: BYTELEN },
      { op: "array.new_default", typeIdx: ctx.utf8StrDataTypeIdx },
      { op: "local.set", index: OUT },

      // --- Pass 2: write bytes ---
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: O },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...decodeCp(writeBytes),
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return out
      { op: "local.get", index: OUT },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_to_utf8",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "out", type: u8DataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "byteLen", type: { kind: "i32" } },
        { name: "cu", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
        { name: "lo", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_concat(a: ref $AnyString, b: ref $AnyString) -> ref $AnyString ---
  // For short strings (combined length < 64), copies into a flat string.
  // For longer strings, creates a ConsString node in O(1).
  {
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const typeIdx = addFuncType(ctx, [strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_concat", funcIdx);

    // params: a(0), b(1)
    // locals: lenA(2), lenB(3), newLen(4), newArr(5), flatA(6), flatB(7)
    const body: Instr[] = [
      // lenA = a.len (field 0 of AnyString)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // lenA

      // lenB = b.len (field 0 of AnyString)
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // lenB

      // newLen = lenA + lenB
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 4 }, // newLen

      // if newLen >= 64, create ConsString (O(1) rope node)
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 64 },
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // struct.new $ConsString(newLen, a, b)
          { op: "local.get", index: 4 }, // len = newLen
          { op: "local.get", index: 0 }, // left = a
          { op: "local.get", index: 1 }, // right = b
          { op: "struct.new", typeIdx: consStrTypeIdx },
        ],
        else: [
          // Short string: flatten both sides and copy
          // flatA = flatten(a)
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 6 },

          // flatB = flatten(b)
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: flattenIdx },
          { op: "local.set", index: 7 },

          // newArr = array.new_default(newLen)
          { op: "local.get", index: 4 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "local.set", index: 5 },

          // array.copy(newArr, 0, flatA.data, flatA.off, lenA)
          { op: "local.get", index: 5 }, // dst
          { op: "ref.as_non_null" },
          { op: "i32.const", value: 0 }, // dstOffset
          { op: "local.get", index: 6 }, // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatA.data
          { op: "local.get", index: 6 }, // flatA
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatA.off
          { op: "local.get", index: 2 }, // lenA
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // array.copy(newArr, lenA, flatB.data, flatB.off, lenB)
          { op: "local.get", index: 5 }, // dst
          { op: "ref.as_non_null" },
          { op: "local.get", index: 2 }, // dstOffset = lenA
          { op: "local.get", index: 7 }, // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // flatB.data
          { op: "local.get", index: 7 }, // flatB
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // flatB.off
          { op: "local.get", index: 3 }, // lenB
          {
            op: "array.copy",
            dstTypeIdx: strDataTypeIdx,
            srcTypeIdx: strDataTypeIdx,
          },

          // result = struct.new $NativeString(newLen, 0, newArr)
          { op: "local.get", index: 4 }, // len = newLen
          { op: "i32.const", value: 0 }, // off = 0
          { op: "local.get", index: 5 }, // data = newArr
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_concat",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
        { name: "flatA", type: { kind: "ref_null", typeIdx: strTypeIdx } },
        { name: "flatB", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  // --- $__str_buf_next_cap(curCap: i32, needed: i32) -> i32 ---
  // Returns a capacity at least as large as `needed`, doubling `curCap` until
  // the requirement is met. Used by the #1210 string-builder rewrite to size
  // the growable i16 buffer with O(log N) reallocations instead of O(N) per
  // `s += <expr>`. If `needed` exceeds INT32 doubling, returns `needed`
  // directly (caller traps on out-of-memory at the array.new_default site).
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_buf_next_cap", funcIdx);

    // params: curCap(0), needed(1)
    // Strategy: ensure at least 16 bytes, then double until >= needed.
    const body: Instr[] = [
      // if curCap < 16 then curCap = 16 (ensures starting size)
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 16 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 16 },
          { op: "local.set", index: 0 },
        ],
      },
      // while (curCap < needed) curCap = curCap * 2
      // block { loop { if (curCap >= needed) br outer; curCap *= 2; br inner } }
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if curCap >= needed: br outer (depth 1)
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // curCap *= 2
              { op: "local.get", index: 0 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.set", index: 0 },
              // restart loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return curCap
      { op: "local.get", index: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_buf_next_cap",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_equals(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_equals", funcIdx);

    // locals: len(2), i(3), aData(4), bData(5), aOff(6), bOff(7)
    const body: Instr[] = [
      // len = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 }, // len

      // if a.len != b.len return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ne" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 7 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 4 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      // loop: compare element by element
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break (strings are equal)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // if aData[aOff + i] != bData[bOff + i], return 0
              { op: "local.get", index: 4 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 3 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 5 },
              { op: "local.get", index: 7 },
              { op: "local.get", index: 3 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 0 }, { op: "return" }],
              },

              // i++
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return 1 (equal)
      { op: "i32.const", value: 1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_equals",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_compare(a: ref $NativeString, b: ref $NativeString) -> i32 ---
  // Lexicographic comparison: returns -1 (a < b), 0 (a == b), or 1 (a > b)
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_compare", funcIdx);

    // locals: lenA(2), lenB(3), minLen(4), i(5), aData(6), bData(7), aOff(8), bOff(9), ca(10), cb(11)
    const body: Instr[] = [
      // lenA = a.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // lenB = b.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // minLen = min(lenA, lenB)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      { op: "select" },
      { op: "local.set", index: 4 },

      // aOff = a.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },

      // bOff = b.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },

      // aData = a.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },

      // bData = b.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },

      // loop: compare element by element
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= minLen, break (common prefix is equal)
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ca = aData[aOff + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 8 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 10 },

              // cb = bData[bOff + i]
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 11 },

              // if ca < cb return -1
              { op: "local.get", index: 10 },
              { op: "local.get", index: 11 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: -1 }, { op: "return" }],
              },

              // if ca > cb return 1
              { op: "local.get", index: 10 },
              { op: "local.get", index: 11 },
              { op: "i32.gt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },

              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // Common prefix is equal; compare by length
      // if lenA < lenB return -1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },

      // if lenA > lenB return 1
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.gt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },

      // return 0 (equal)
      { op: "i32.const", value: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_compare",
      typeIdx,
      locals: [
        { name: "lenA", type: { kind: "i32" } },
        { name: "lenB", type: { kind: "i32" } },
        { name: "minLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "aData", type: strDataRef },
        { name: "bData", type: strDataRef },
        { name: "aOff", type: { kind: "i32" } },
        { name: "bOff", type: { kind: "i32" } },
        { name: "ca", type: { kind: "i32" } },
        { name: "cb", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_substring(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_substring", funcIdx);

    // O(1) substring: creates a view sharing the backing array.
    // locals: sOff(3), sLen(4)
    const body: Instr[] = [
      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 },

      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },

      // Clamp start: max(0, min(start, sLen))
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 1 }, // start = max(0, start)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 1 }, // start = min(start, sLen)

      // Clamp end: max(0, min(end, sLen))
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.tee", index: 2 }, // end = max(0, end)
      { op: "local.get", index: 4 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 }, // end = min(end, sLen)

      // Swap if start > end (JS substring semantics)
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "local.set", index: 2 },
          { op: "local.set", index: 1 },
        ],
      },

      // struct.new(len = end - start, off = sOff + start, s.data)
      { op: "local.get", index: 2 }, // end
      { op: "local.get", index: 1 }, // start
      { op: "i32.sub" }, // len = end - start
      { op: "local.get", index: 3 }, // sOff
      { op: "local.get", index: 1 }, // start
      { op: "i32.add" }, // off = sOff + start
      { op: "local.get", index: 0 }, // s
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // s.data
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_substring",
      typeIdx,
      locals: [
        { name: "sOff", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_charAt(s: ref $NativeString, idx: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_charAt", funcIdx);

    const body: Instr[] = [
      // Bounds check: if idx < 0 || idx >= s.len, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: off=0, len=0, empty array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // Single-char string: len=1, off=0, [char]
          { op: "i32.const", value: 1 }, // len
          { op: "i32.const", value: 0 }, // off
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
          { op: "local.get", index: 1 },
          { op: "i32.add" }, // off + idx
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          // Create single-element array
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_charAt",
      typeIdx,
      locals: [],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_charAt_cp(s: ref $NativeString, idx: i32) -> ref $NativeString ---
  // (#1470) Code-POINT charAt: like __str_charAt but when the code unit at
  // `idx` is a high surrogate followed by a low surrogate, returns the whole
  // 2-code-unit pair (§22.1.5.1 String iteration / §11.1.4 CodePointAt).
  // Lone surrogates and BMP scalars return the single unit. Used by the
  // for-of / spread / Array.from string-iteration lowerings; callers advance
  // their cursor by the returned string's `len`.
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_charAt_cp", funcIdx);
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const body: Instr[] = [
      // Bounds check: if idx < 0 || idx >= s.len, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: len=0, off=0, empty array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // __str_substring(s, idx, idx + 1 + isPair)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          // isPair = (data[off+idx] & 0xFC00) == 0xD800 && idx + 1 < len
          //          && (data[off+idx+1] & 0xFC00) == 0xDC00
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
          { op: "local.get", index: 1 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "i32.const", value: 0xfc00 },
          { op: "i32.and" },
          { op: "i32.const", value: 0xd800 },
          { op: "i32.eq" },
          { op: "local.get", index: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // .len
          { op: "i32.lt_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              // The low-surrogate read is guarded: only reached when
              // idx + 1 < len, so data[off+idx+1] is in bounds.
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // .data
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // .off
              { op: "local.get", index: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.const", value: 0xfc00 },
              { op: "i32.and" },
              { op: "i32.const", value: 0xdc00 },
              { op: "i32.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          } as Instr,
          { op: "i32.add" }, // end = idx + 1 + isPair
          { op: "call", funcIdx: substringIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_charAt_cp",
      typeIdx,
      locals: [],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_slice(s: ref $NativeString, start: i32, end: i32) -> ref $NativeString ---
  // Like substring but handles negative indices
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_slice", funcIdx);

    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // locals: len (index 3)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // len

      // Resolve negative start: if start < 0, start = len + start
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 1 }, // start (negative)
          { op: "i32.add" },
          { op: "local.set", index: 1 },
        ],
      },
      // Clamp start to >= 0
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 1 },
        ],
      },

      // Resolve negative end: if end < 0, end = len + end
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 2 }, // end (negative)
          { op: "i32.add" },
          { op: "local.set", index: 2 },
        ],
      },
      // Clamp end to >= 0
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 2 },
        ],
      },

      // §22.1.3.21 String.prototype.slice: unlike substring, slice does NOT
      // swap when start > end — it returns the empty string. __str_substring
      // swaps, so guard here: if (start >= end) return "" instead of
      // delegating. (#2123)
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 2 }, // end
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // empty string: len=0, off=0, empty backing array
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // start < end: __str_substring clamps to len; no swap occurs.
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: substringIdx },
        ],
      } as Instr,
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_slice",
      typeIdx,
      locals: [{ name: "len", type: { kind: "i32" } }],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_substr(s: ref $NativeString, start: i32, length: i32) -> ref $NativeString ---
  // Annex B §B.2.2.1 String.prototype.substr(start, length):
  //   len = s.length
  //   if start < 0: start = max(len + start, 0)   (negative counts from end)
  //   length = max(min(length, len - start), 0)   (clamp; absent → len sentinel)
  //   return substring(start, start + length)
  // Unlike `substring`/`slice`, the SECOND argument is a *count*, not an end
  // index, and is never negative-relative. The caller passes 0x7fffffff for an
  // absent length so the min() clamps it to `len - start` (to the end).
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_substr", funcIdx);

    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // locals: len (index 3)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 }, // len

      // Resolve negative start: if start < 0, start = max(len + start, 0)
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 }, // len
          { op: "local.get", index: 1 }, // start (negative)
          { op: "i32.add" }, // len + start
          { op: "local.set", index: 1 }, // start = len + start
          // max(start, 0): (start < 0) ? 0 : start
          { op: "i32.const", value: 0 }, // a = 0
          { op: "local.get", index: 1 }, // b = start
          { op: "local.get", index: 1 }, // start
          { op: "i32.const", value: 0 },
          { op: "i32.lt_s" }, // c = (start < 0)
          { op: "select" }, // c ? 0 : start
          { op: "local.set", index: 1 },
        ],
      },
      // Clamp start to <= len (a start past the end yields the empty string).
      { op: "local.get", index: 1 },
      { op: "local.get", index: 3 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 },
          { op: "local.set", index: 1 },
        ],
      },

      // tail = len - start (chars available from `start` to the end)
      { op: "local.get", index: 3 }, // len
      { op: "local.get", index: 1 }, // start
      { op: "i32.sub" }, // len - start
      { op: "local.set", index: 4 }, // tail = len - start
      // length = min(length, tail): (length < tail) ? length : tail
      { op: "local.get", index: 2 }, // a = length
      { op: "local.get", index: 4 }, // b = tail
      { op: "local.get", index: 2 }, // length
      { op: "local.get", index: 4 }, // tail
      { op: "i32.lt_s" }, // c = (length < tail)
      { op: "select" }, // c ? length : tail
      { op: "local.set", index: 2 }, // length = min(length, tail)
      // Clamp length to >= 0
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 2 },
        ],
      },

      // return __str_substring(s, start, start + length)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 1 }, // start
      { op: "local.get", index: 2 }, // length
      { op: "i32.add" }, // end = start + length
      { op: "call", funcIdx: substringIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_substr",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "tail", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_indexOf(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_indexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      // hLen = haystack.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // nLen = needle.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // if nLen == 0, return clamp(fromIndex, 0, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 2 },
          { op: "i32.const", value: 0 },
          { op: "i32.gt_s" },
          { op: "select" },
          { op: "local.tee", index: 5 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 5 },
          { op: "local.get", index: 3 },
          { op: "i32.lt_s" },
          { op: "select" },
          { op: "return" },
        ],
      },
      // hOff = haystack.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // nOff = needle.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData = haystack.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      // nData = needle.data
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = max(fromIndex, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // outer loop: scan i from fromIndex to hLen - nLen
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i > hLen - nLen, break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "i32.sub" },
              { op: "i32.gt_s" },
              { op: "br_if", depth: 1 },
              // j = 0; inner loop to compare needle chars
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 6 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      // if j >= nLen, match found — return i
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [{ op: "local.get", index: 5 }, { op: "return" }],
                      },
                      // if hData[hOff + i + j] != nData[nOff + j], break inner
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 5 },
                      { op: "i32.add" },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 10 },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "i32.ne" },
                      { op: "br_if", depth: 1 },
                      // j++
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found
      { op: "i32.const", value: -1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_indexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_lastIndexOf(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_lastIndexOf", funcIdx);

    // params: haystack(0), needle(1), fromIndex(2)
    // locals: hLen(3), nLen(4), i(5), j(6), hData(7), nData(8), hOff(9), nOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // (#2875) §22.1.3.9 step 8: start candidates are bounded by
      // min(max(pos, 0), …) — clamp fromIndex to ≥ 0 ONCE here so both the
      // empty-needle arm (min(fromIndex, hLen)) and the scan init
      // (min(fromIndex, hLen - nLen)) see the spec's max(pos, 0). Without it,
      // lastIndexOf('a', -1) started the reverse scan at -1 and returned -1
      // instead of checking position 0.
      // fromIndex = max(fromIndex, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // if nLen == 0, return min(fromIndex, hLen)
      { op: "local.get", index: 4 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 2 },
          { op: "local.get", index: 3 },
          { op: "i32.lt_s" },
          { op: "select" },
          { op: "return" },
        ],
      },
      // hOff, nOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // hData, nData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 8 },
      // i = min(fromIndex, hLen - nLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "i32.sub" },
      { op: "local.tee", index: 5 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 5 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 5 },
      // reverse scan
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              { op: "br_if", depth: 1 },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 6 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [{ op: "local.get", index: 5 }, { op: "return" }],
                      },
                      // hData[hOff + i + j]
                      { op: "local.get", index: 7 },
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 5 },
                      { op: "i32.add" },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      // nData[nOff + j]
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 10 },
                      { op: "local.get", index: 6 },
                      { op: "i32.add" },
                      { op: "array.get_u", typeIdx: strDataTypeIdx },
                      { op: "i32.ne" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found
      { op: "i32.const", value: -1 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_lastIndexOf",
      typeIdx,
      locals: [
        { name: "hLen", type: { kind: "i32" } },
        { name: "nLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "hData", type: strDataRef },
        { name: "nData", type: strDataRef },
        { name: "hOff", type: { kind: "i32" } },
        { name: "nOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_includes(haystack: ref $NativeString, needle: ref $NativeString, fromIndex: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_includes", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "i32.const", value: -1 },
      { op: "i32.ne" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_includes",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_startsWith(s: ref $NativeString, prefix: ref $NativeString, position: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_startsWith", funcIdx);

    // params: s(0), prefix(1), position(2)
    // locals: sLen(3), pLen(4), i(5), sData(6), pData(7), sOff(8), pOff(9)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      // (#2875) §22.1.3.23 step 12: start = min(max(pos, 0), len). Without the
      // clamp, position=INT_MAX (the trunc-sat of Infinity) overflows the
      // `position + pLen` check below into a negative and the scan reads OOB
      // (trap), and a negative position reads sData[sOff-…] (trap) instead of
      // searching from 0 — startsWith('!', Infinity) / ('The', -1).
      // position = max(position, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // position = min(position, sLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // if position + pLen > sLen, return 0
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "i32.add" },
      { op: "local.get", index: 3 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // sOff, pOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 8 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      // sData, pData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      // compare loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },
              // sData[sOff + position + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 8 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              // pData[pOff + i]
              { op: "local.get", index: 7 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // mismatch found
      { op: "i32.const", value: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_startsWith",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "pLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "pData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
        { name: "pOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_endsWith(s: ref $NativeString, suffix: ref $NativeString, endPos: i32) -> i32 ---
  {
    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_endsWith", funcIdx);

    // params: s(0), suffix(1), endPos(2)
    // locals: sxLen(3), i(4), sData(5), xData(6), startPos(7), sLen(8), sOff(9), xOff(10)
    const body: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      // sLen = s.len; clamp endPos to sLen
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 8 },
      // (#2875) §22.1.3.6 step 7: end = min(max(pos, 0), len). The max(0) arm
      // was missing — endsWith('', -1) computed startPos = -1 - 0 < 0 → false,
      // but the spec clamps a negative endPosition to 0 (empty suffix → true).
      // endPos = max(endPos, 0)
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.gt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // endPos = min(endPos, sLen)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 8 },
      { op: "i32.lt_s" },
      { op: "select" },
      { op: "local.set", index: 2 },
      // startPos = endPos - sxLen
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "i32.sub" },
      { op: "local.set", index: 7 },
      // if startPos < 0, return 0
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // sOff, xOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 9 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 10 },
      // sData, xData
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 6 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },
              // sData[sOff + startPos + i]
              { op: "local.get", index: 5 },
              { op: "local.get", index: 9 },
              { op: "local.get", index: 7 },
              { op: "i32.add" },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              // xData[xOff + i]
              { op: "local.get", index: 6 },
              { op: "local.get", index: 10 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.ne" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_endsWith",
      typeIdx,
      locals: [
        { name: "sxLen", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "xData", type: strDataRef },
        { name: "startPos", type: { kind: "i32" } },
        { name: "sLen", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
        { name: "xOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_isWhitespace(codeUnit: i32) -> i32 (helper, not exported) ---
  // §22.1.3.32 TrimString trims WhiteSpace + LineTerminator. The full set
  // (#1963) mirrors the regex `\s` SPACE table in src/codegen/regex/parse.ts:
  //   0x09-0x0D, 0x20, 0xA0, 0x1680, 0x2000-0x200A, 0x2028, 0x2029, 0x202F,
  //   0x205F, 0x3000, 0xFEFF (BOM/ZWNBSP).
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_isWhitespace", funcIdx);

    // Membership test as an OR-chain. `eq(v)` / `range(lo,hi)` each push one i32
    // truthy value; all are OR-ed together. The two ASCII forms (0x20 and
    // 0x09-0x0D) stay first so the common case folds cheaply.
    const eq = (v: number): Instr[] => [{ op: "local.get", index: 0 }, { op: "i32.const", value: v }, { op: "i32.eq" }];
    const range = (lo: number, hi: number): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: lo },
      { op: "i32.ge_u" },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: hi },
      { op: "i32.le_u" },
      { op: "i32.and" },
    ];

    const body: Instr[] = [
      ...eq(0x20),
      ...range(0x09, 0x0d),
      { op: "i32.or" },
      ...eq(0xa0),
      { op: "i32.or" },
      ...eq(0x1680),
      { op: "i32.or" },
      ...range(0x2000, 0x200a),
      { op: "i32.or" },
      ...eq(0x2028),
      { op: "i32.or" },
      ...eq(0x2029),
      { op: "i32.or" },
      ...eq(0x202f),
      { op: "i32.or" },
      ...eq(0x205f),
      { op: "i32.or" },
      ...eq(0x3000),
      { op: "i32.or" },
      ...eq(0xfeff),
      { op: "i32.or" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_isWhitespace",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_trimStart(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_trimStart", funcIdx);

    const isWsIdx = ctx.nativeStrHelpers.get("__str_isWhitespace")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0)
    // locals: len(1), i(2), sData(3), sOff(4)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 }, // sOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 }, // sData
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      // scan forward while whitespace
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // sData[sOff + i]
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "call", funcIdx: isWsIdx },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return substring(s, i, len)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: substringIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_trimStart",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_trimEnd(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_trimEnd", funcIdx);

    const isWsIdx = ctx.nativeStrHelpers.get("__str_isWhitespace")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0)
    // locals: end(1), sData(2), sOff(3)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 }, // end = len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 }, // sOff
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 }, // sData
      // scan backward while whitespace
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 1 },
              { op: "i32.const", value: 0 },
              { op: "i32.le_s" },
              { op: "br_if", depth: 1 },
              // sData[sOff + end - 1]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "call", funcIdx: isWsIdx },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 1 },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: 1 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return substring(s, 0, end)
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: substringIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_trimEnd",
      typeIdx,
      locals: [
        { name: "end", type: { kind: "i32" } },
        { name: "sData", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_trim(s: ref $NativeString) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_trim", funcIdx);

    const trimStartIdx = ctx.nativeStrHelpers.get("__str_trimStart")!;
    const trimEndIdx = ctx.nativeStrHelpers.get("__str_trimEnd")!;

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: trimStartIdx },
      { op: "call", funcIdx: trimEndIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_trim",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_repeat(s: ref $NativeString, count: i32) -> ref $NativeString ---
  {
    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_repeat", funcIdx);

    // params: s(0), count(1)
    // locals: sLen(2), newLen(3), newArr(4), dst(5), srcData(6), copyI(7), sOff(8)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // if count <= 0 or sLen == 0, return empty string
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "i32.le_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          { op: "i32.const", value: 0 }, // off = 0
          { op: "i32.const", value: 0 }, // len = 0
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: strDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          { op: "local.get", index: 2 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [
              { op: "i32.const", value: 0 }, // off = 0
              { op: "i32.const", value: 0 }, // len = 0
              { op: "i32.const", value: 0 },
              { op: "array.new_default", typeIdx: strDataTypeIdx },
              { op: "struct.new", typeIdx: strTypeIdx },
            ],
            else: [
              // sOff = s.off
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
              { op: "local.set", index: 8 },

              // newLen = sLen * count
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.mul" },
              { op: "local.tee", index: 3 },

              // newArr = array.new_default(newLen)
              { op: "array.new_default", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 4 },

              // srcData = s.data
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
              { op: "local.set", index: 6 },

              // dst = 0
              { op: "i32.const", value: 0 },
              { op: "local.set", index: 5 },

              // outer loop: repeat count times
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 3 },
                      { op: "i32.ge_u" },
                      { op: "br_if", depth: 1 },

                      // array.copy newArr[dst..] <- srcData[sOff..sOff+sLen]
                      { op: "local.get", index: 4 }, // dst array
                      { op: "local.get", index: 5 }, // dst offset
                      { op: "local.get", index: 6 }, // src array
                      { op: "local.get", index: 8 }, // src offset = sOff
                      { op: "local.get", index: 2 }, // length = sLen
                      {
                        op: "array.copy",
                        dstTypeIdx: strDataTypeIdx,
                        srcTypeIdx: strDataTypeIdx,
                      },

                      // dst += sLen
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 2 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },

              // return struct.new(newLen, 0, newArr)
              { op: "local.get", index: 3 }, // len = newLen
              { op: "i32.const", value: 0 }, // off = 0
              { op: "local.get", index: 4 }, // data = newArr
              { op: "struct.new", typeIdx: strTypeIdx },
            ],
          },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_repeat",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "newLen", type: { kind: "i32" } },
        { name: "newArr", type: strDataRef },
        { name: "dst", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "copyI", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_padStart(s: ref $NativeString, targetLen: i32, padStr: ref $NativeString) -> ref $NativeString ---
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_padStart", funcIdx);

    // params: s(0), targetLen(1), padStr(2)
    // locals: sLen(3), padLen(4), fillLen(5), repeated(6), prefix(7)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // if sLen >= targetLen, return s
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // padLen = padStr.len
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // if padLen == 0, return s
          { op: "local.get", index: 4 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [{ op: "local.get", index: 0 }],
            else: [
              // fillLen = targetLen - sLen
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },

              // repeated = repeat(padStr, ceil(fillLen / padLen))
              { op: "local.get", index: 2 }, // padStr (1st arg)
              { op: "local.get", index: 5 }, // fillLen
              { op: "local.get", index: 4 }, // padLen
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.get", index: 4 },
              { op: "i32.div_u" }, // count (2nd arg)
              { op: "call", funcIdx: repeatIdx },

              // prefix = repeated.substring(0, fillLen)
              { op: "i32.const", value: 0 },
              { op: "local.get", index: 5 },
              { op: "call", funcIdx: substringIdx },

              // return concat(prefix, s)
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: concatIdx },
            ],
          },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_padStart",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "padLen", type: { kind: "i32" } },
        { name: "fillLen", type: { kind: "i32" } },
        { name: "repeated", type: strRef },
        { name: "prefix", type: strRef },
      ],
      body: wrapBodyWithFlatten(body, [0, 2]),
      exported: false,
    });
  }

  // --- $__str_padEnd(s: ref $NativeString, targetLen: i32, padStr: ref $NativeString) -> ref $NativeString ---
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const repeatIdx = ctx.nativeStrHelpers.get("__str_repeat")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    const typeIdx = addFuncType(ctx, [strRef, { kind: "i32" }, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_padEnd", funcIdx);

    // params: s(0), targetLen(1), padStr(2)
    // locals: sLen(3), padLen(4), fillLen(5)
    const body: Instr[] = [
      // sLen = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },

      // if sLen >= targetLen, return s
      { op: "local.get", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // padLen = padStr.len
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // if padLen == 0, return s
          { op: "local.get", index: 4 },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [{ op: "local.get", index: 0 }],
            else: [
              // fillLen = targetLen - sLen
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "i32.sub" },
              { op: "local.set", index: 5 },

              // repeated = repeat(padStr, ceil(fillLen / padLen))
              { op: "local.get", index: 2 }, // padStr (1st arg)
              { op: "local.get", index: 5 }, // fillLen
              { op: "local.get", index: 4 }, // padLen
              { op: "i32.add" },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.get", index: 4 },
              { op: "i32.div_u" }, // count (2nd arg)
              { op: "call", funcIdx: repeatIdx },

              // suffix = repeated.substring(0, fillLen)
              { op: "i32.const", value: 0 },
              { op: "local.get", index: 5 },
              { op: "call", funcIdx: substringIdx },

              // return concat(s, suffix)
              // stack has: suffix on top. Store it, push s, push suffix back
              { op: "local.set", index: 6 }, // suffix -> local 6
              { op: "local.get", index: 0 }, // s (1st arg to concat)
              { op: "local.get", index: 6 }, // suffix (2nd arg to concat)
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: concatIdx },
            ],
          },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_padEnd",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "padLen", type: { kind: "i32" } },
        { name: "fillLen", type: { kind: "i32" } },
        { name: "suffix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 2]),
      exported: false,
    });
  }

  // --- $__str_toLowerCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps A-Z (65-90) to a-z (97-122), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_toLowerCase", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop over each code unit
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ch = srcData[sOff + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 5 },

              // newArr[i] = (ch >= 65 && ch <= 90) ? ch + 32 : ch
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 65 },
              { op: "i32.ge_u" },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 90 },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "local.get", index: 5 }, { op: "i32.const", value: 32 }, { op: "i32.add" }],
                else: [{ op: "local.get", index: 5 }],
              },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i++
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 }, // len
      { op: "i32.const", value: 0 }, // off = 0
      { op: "local.get", index: 3 }, // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_toLowerCase",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // --- $__str_toUpperCase(s: ref $NativeString) -> ref $NativeString ---
  // ASCII-only: maps a-z (97-122) to A-Z (65-90), copies everything else as-is
  {
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_toUpperCase", funcIdx);

    // params: s(0)
    // locals: len(1), srcData(2), newArr(3), i(4), ch(5), sOff(6)
    const body: Instr[] = [
      // len = s.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },

      // sOff = s.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 6 },

      // srcData = s.data
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },

      // newArr = array.new_default(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 3 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 4 },

      // loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },

              // ch = srcData[sOff + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: 5 },

              // newArr[i] = (ch >= 97 && ch <= 122) ? ch - 32 : ch
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 97 },
              { op: "i32.ge_u" },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 122 },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "local.get", index: 5 }, { op: "i32.const", value: 32 }, { op: "i32.sub" }],
                else: [{ op: "local.get", index: 5 }],
              },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i++
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return struct.new(len, 0, newArr)
      { op: "local.get", index: 1 }, // len
      { op: "i32.const", value: 0 }, // off = 0
      { op: "local.get", index: 3 }, // data = newArr
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_toUpperCase",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "srcData", type: strDataRef },
        { name: "newArr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "sOff", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0]),
      exported: false,
    });
  }

  // (#40) Replace the ASCII-only toUpperCase/toLowerCase above with full Unicode
  // simple + special (1:N) case mapping. emitNativeCaseConversion appends the
  // Unicode helpers and re-points the public `__str_to{Upper,Lower}Case` names in
  // nativeStrHelpers at them (the ASCII blocks become dead, wasm-opt drops them).
  // Emitted here, AFTER __str_flatten is registered, so the Unicode helpers can
  // flatten a cons-string input.
  emitNativeCaseConversion(ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx);

  // (#3068) String.prototype.isWellFormed / toWellFormed — pure UTF-16
  // code-unit scans over the flattened NativeString. Emitted here (after
  // __str_flatten + the NativeString types exist) so the method arms in
  // string-ops.ts find `__str_isWellFormed` / `__str_toWellFormed` in
  // nativeStrHelpers without a mid-body late-import shift.
  emitNativeWellFormedHelpers(ctx, strTypeIdx, strDataTypeIdx);

  // --- $__str_getSubstitution(replacement, matched, prefix, suffix) -> ref $NativeString ---
  // #1822 — expand `$` patterns in a replacement string per ECMAScript
  // §22.1.3.19 GetSubstitution (string-search variant, no capture groups):
  //   $$ → "$"   $& → matched   $` → prefix (text before match)   $' → suffix
  // Any other `$X` (including `$1`..`$9` with no captures) is left literal.
  // Implementation: scan char-by-char, flushing literal runs via substring+concat
  // and inserting the expansion when a recognised pattern is found.
  {
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_getSubstitution", funcIdx);

    // params: replacement(0), matched(1), prefix(2), suffix(3)
    // locals: result(4), len(5), data(6), off(7), i(8), segStart(9), ch(10), next(11)
    const RES = 4;
    const LEN = 5;
    const DATA = 6;
    const OFF = 7;
    const I = 8;
    const SEG = 9;
    const CH = 10;
    const NEXT = 11;

    // Helper: result = concat(result, replacement.substring(SEG, I))
    const flushSegment = (): Instr[] => [
      { op: "local.get", index: RES },
      { op: "ref.as_non_null" },
      // replacement.substring(SEG, I)
      { op: "local.get", index: 0 },
      { op: "local.get", index: SEG },
      { op: "local.get", index: I },
      { op: "call", funcIdx: substringIdx },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: RES },
    ];
    // Helper: result = concat(result, <expansion local index>)
    const appendStr = (srcLocal: number): Instr[] => [
      { op: "local.get", index: RES },
      { op: "ref.as_non_null" },
      { op: "local.get", index: srcLocal },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: RES },
    ];
    // Advance both SEG and I past the 2-char `$X` token.
    const skipTwo: Instr[] = [
      { op: "local.get", index: I },
      { op: "i32.const", value: 2 },
      { op: "i32.add" },
      { op: "local.set", index: SEG },
      { op: "local.get", index: SEG },
      { op: "local.set", index: I },
    ];
    // A recognised `$X` case: flush the literal run [SEG,i), append the
    // expansion, then skip the 2-char token.
    const matchedCase = (appendBody: Instr[]): Instr[] => [...flushSegment(), ...appendBody, ...skipTwo];
    // The literal `$` for `$$` is replacement.substring(i, i+1).
    const appendDollarLiteral: Instr[] = [
      { op: "local.get", index: RES },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 0 },
      { op: "local.get", index: I },
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "call", funcIdx: substringIdx },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: RES },
    ];
    // Dispatch on the char after `$` (already known to exist). Chains
    // next==36 ($$) / 38 ($&) / 96 ($`) / 39 ($') / else literal-advance-1.
    const dollarDispatch = (): Instr[] => {
      const eqCase = (code: number, appendBody: Instr[], elseBody: Instr[]): Instr[] => [
        { op: "local.get", index: NEXT },
        { op: "i32.const", value: code },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: matchedCase(appendBody),
          else: elseBody,
        } as Instr,
      ];
      // unrecognised $X: literal, advance 1
      const literalAdvance: Instr[] = [
        { op: "local.get", index: I },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: I },
      ];
      return [
        // next = data[off + i + 1]
        { op: "local.get", index: DATA },
        { op: "local.get", index: OFF },
        { op: "local.get", index: I },
        { op: "i32.add" },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
        { op: "local.set", index: NEXT },
        ...eqCase(
          36, // $$ → literal '$'
          appendDollarLiteral,
          eqCase(
            38, // $& → matched
            appendStr(1),
            eqCase(
              96, // $` → prefix
              appendStr(2),
              eqCase(39 /* $' → suffix */, appendStr(3), literalAdvance),
            ),
          ),
        ),
      ];
    };

    const body: Instr[] = [
      // result = "" (empty NativeString: len=0, off=0, empty data)
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
      { op: "struct.new", typeIdx: strTypeIdx },
      { op: "local.set", index: RES },

      // len = replacement.len ; data = replacement.data ; off = replacement.off
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },

      // i = 0 ; segStart = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: SEG },

      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },

              // ch = data[off + i]
              { op: "local.get", index: DATA },
              { op: "local.get", index: OFF },
              { op: "local.get", index: I },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
              { op: "local.set", index: CH },

              // if ch == '$' (36) AND i+1 < len: inspect next char
              { op: "local.get", index: CH },
              { op: "i32.const", value: 36 },
              { op: "i32.eq" },
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: LEN },
              { op: "i32.lt_s" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: dollarDispatch(),
                else: [
                  // ch != '$' or at last char: advance 1 (literal)
                  { op: "local.get", index: I },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: I },
                ] as Instr[],
              },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // Flush trailing segment [SEG, len)
      { op: "local.get", index: RES },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 0 },
      { op: "local.get", index: SEG },
      { op: "local.get", index: LEN },
      { op: "call", funcIdx: substringIdx },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: concatIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_getSubstitution",
      typeIdx,
      locals: [
        { name: "result", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "segStart", type: { kind: "i32" } },
        { name: "ch", type: { kind: "i32" } },
        { name: "next", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2, 3]),
      exported: false,
    });
  }

  // --- $__str_replace(s: ref $NativeString, search: ref $NativeString, replacement: ref $NativeString) -> ref $NativeString ---
  // Replaces first occurrence of search with replacement. Pure wasm using indexOf + substring + concat.
  {
    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const getSubstitutionIdx = ctx.nativeStrHelpers.get("__str_getSubstitution")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_replace", funcIdx);

    // params: s(0), search(1), replacement(2)
    // locals: idx(3), searchLen(4), prefix(5-nullable), suffix(6-nullable)
    const body: Instr[] = [
      // idx = indexOf(s, search, 0)
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: indexOfIdx },
      { op: "local.set", index: 3 },

      // if idx == -1, return s unchanged
      { op: "local.get", index: 3 },
      { op: "i32.const", value: -1 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [{ op: "local.get", index: 0 }],
        else: [
          // searchLen = search.len
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 4 },

          // prefix = s.substring(0, idx)
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0 },
          { op: "local.get", index: 3 },
          { op: "call", funcIdx: substringIdx },
          { op: "local.set", index: 5 },

          // suffix = s.substring(idx + searchLen, MAX)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 4 },
          { op: "i32.add" },
          { op: "i32.const", value: 0x7fffffff },
          { op: "call", funcIdx: substringIdx },
          { op: "local.set", index: 6 },

          // #1822 — expand `$` patterns in the replacement before splicing:
          // return concat(concat(prefix, getSubstitution(replacement, search, prefix, suffix)), suffix)
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          // getSubstitution(replacement=2, matched=search=1, prefix=5, suffix=6)
          { op: "local.get", index: 2 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 6 },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: getSubstitutionIdx },
          { op: "call", funcIdx: concatIdx },
          { op: "local.get", index: 6 },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: concatIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_replace",
      typeIdx,
      locals: [
        { name: "idx", type: { kind: "i32" } },
        { name: "searchLen", type: { kind: "i32" } },
        { name: "prefix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "suffix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2]),
      exported: false,
    });
  }

  // --- $__str_replaceAll(s: ref $NativeString, search: ref $NativeString, replacement: ref $NativeString) -> ref $NativeString ---
  // Replaces ALL occurrences of search with replacement. Pure wasm loop using indexOf + substring + concat.
  {
    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const getSubstitutionIdx = ctx.nativeStrHelpers.get("__str_getSubstitution")!;

    const typeIdx = addFuncType(ctx, [strRef, strRef, strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_replaceAll", funcIdx);

    // params: s(0), search(1), replacement(2)
    // locals: result(3-nullable), pos(4), idx(5), searchLen(6), prefix(7-nullable)
    const body: Instr[] = [
      // searchLen = search.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 6 },

      // #1822 — empty search: ECMAScript inserts the replacement before every
      // code unit AND at the end: "ab".replaceAll("","-") → "-a-b-".
      // (replacement has no $-expansion to do here: matched is "", and per the
      // string-search GetSubstitution prefix/suffix only matter for $`/$', which
      // for an empty-match position resolve to s[0..i] / s[i..]; but the common
      // case is a literal replacement, and expanding here would require per-pos
      // substitution. We interleave the literal replacement, matching V8/spec for
      // replacements without $ patterns — the dominant case for empty search.)
      { op: "local.get", index: 6 },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // sLen = s.len  (reuse local 4 as i, local 5 as sLen)
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: 5 },
          // result = replacement (a copy via concat with empty would be simplest;
          // start result = "" then prepend replacement in the loop pattern).
          // Build: result = replacement
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: concatIdx }, // "" + replacement
          { op: "local.set", index: 3 },
          // i = 0
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 4 },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // if i >= sLen break
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 5 },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // result = concat(concat(result, s.substring(i,i+1)), replacement)
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 4 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "call", funcIdx: substringIdx },
                  { op: "ref.as_non_null" },
                  { op: "call", funcIdx: concatIdx },
                  { op: "local.get", index: 2 },
                  { op: "call", funcIdx: concatIdx },
                  { op: "local.set", index: 3 },
                  // i++
                  { op: "local.get", index: 4 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 4 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
        ],
        else: [
          // Build an empty result string (len=0, off=0, empty array)
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "i32.const", value: 0 },
          { op: "array.new_default", typeIdx: ctx.nativeStrDataTypeIdx },
          { op: "struct.new", typeIdx: strTypeIdx },
          { op: "local.set", index: 3 },

          // pos = 0
          { op: "i32.const", value: 0 },
          { op: "local.set", index: 4 },

          // loop: find next occurrence
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // idx = indexOf(s, search, pos)
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 4 },
                  { op: "call", funcIdx: indexOfIdx },
                  { op: "local.set", index: 5 },

                  // if idx == -1, break
                  { op: "local.get", index: 5 },
                  { op: "i32.const", value: -1 },
                  { op: "i32.eq" },
                  { op: "br_if", depth: 1 },

                  // prefix = s.substring(pos, idx)
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 4 },
                  { op: "local.get", index: 5 },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: 7 },

                  // result = concat(result, prefix)
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 7 },
                  { op: "ref.as_non_null" },
                  { op: "call", funcIdx: concatIdx },

                  // #1822 — result = concat(result, getSubstitution(replacement,
                  //   matched=search, prefix=s.substring(0,idx), suffix=s.substring(idx+searchLen)))
                  // GetSubstitution's `$\`` / `$'` use the FULL surrounding text,
                  // not just the inter-match slice.
                  { op: "local.get", index: 2 }, // replacement
                  { op: "local.get", index: 1 }, // matched = search
                  // fullPrefix = s.substring(0, idx)
                  { op: "local.get", index: 0 },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: 5 },
                  { op: "call", funcIdx: substringIdx },
                  { op: "ref.as_non_null" },
                  // fullSuffix = s.substring(idx + searchLen, MAX)
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 6 },
                  { op: "i32.add" },
                  { op: "i32.const", value: 0x7fffffff },
                  { op: "call", funcIdx: substringIdx },
                  { op: "ref.as_non_null" },
                  { op: "call", funcIdx: getSubstitutionIdx },
                  { op: "call", funcIdx: concatIdx },
                  { op: "local.set", index: 3 },

                  // pos = idx + searchLen
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 6 },
                  { op: "i32.add" },
                  { op: "local.set", index: 4 },

                  // continue loop
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },

          // Append remainder: result = concat(result, s.substring(pos, MAX))
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 4 },
          { op: "i32.const", value: 0x7fffffff },
          { op: "call", funcIdx: substringIdx },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: concatIdx },
        ],
      },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_replaceAll",
      typeIdx,
      locals: [
        { name: "result", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "searchLen", type: { kind: "i32" } },
        { name: "prefix", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1, 2]),
      exported: false,
    });
  }

  // --- $__str_split(s: ref $NativeString, sep: ref $NativeString, limit: i32) -> ref $vec_nstr ---
  // Splits s by sep, returns a native array of native strings. `limit` caps the
  // number of pieces (ECMA-262 §22.1.3.23): callers pass 0xFFFFFFFF (= -1 as i32)
  // for "no limit"; `limit === 0` yields the empty array (#2125).
  {
    // Register native string array type: (array (mut (ref null $AnyString)))
    // Use ref_null so array.new_default can initialize with null.
    // Key must match what resolveWasmType generates for string[] (ref_N).
    const nstrElemKey = `ref_${anyStrTypeIdx}`;
    const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
    const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
    const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);
    const nstrVecRef: ValType = { kind: "ref", typeIdx: nstrVecTypeIdx };

    const typeIdx = addFuncType(ctx, [strRef, strRef, { kind: "i32" }], [nstrVecRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_split", funcIdx);

    const indexOfIdx = ctx.nativeStrHelpers.get("__str_indexOf")!;
    const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

    // params: s(0), sep(1), limit(2)
    // locals: sLen(3), sepLen(4), pos(5), idx(6), part(7-nullable),
    //         resultArr(8-nullable), resultLen(9), resultCap(10), newArr(11-nullable)
    const S = 0,
      SEP = 1,
      LIMIT = 2;
    const SLEN = 3,
      SEPLEN = 4,
      POS = 5,
      IDX = 6,
      PART = 7;
    const RARR = 8,
      RLEN = 9,
      RCAP = 10,
      NEWARR = 11;

    const body: Instr[] = [
      // #2125: limit === 0 → return empty array (ECMA-262 §22.1.3.23 step 14).
      // The vec struct is { length: i32, data: ref $arr }, so push length 0
      // then a 0-capacity backing array.
      { op: "local.get", index: LIMIT },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 0 }, // vec length
          { op: "i32.const", value: 0 }, // backing array size
          { op: "array.new_default", typeIdx: nstrArrTypeIdx },
          { op: "struct.new", typeIdx: nstrVecTypeIdx },
          { op: "return" },
        ] as Instr[],
      },

      // sLen = s.len
      { op: "local.get", index: S },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SLEN },

      // sepLen = sep.len
      { op: "local.get", index: SEP },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: SEPLEN },

      // resultArr = array.new_default(8)
      { op: "i32.const", value: 8 },
      { op: "array.new_default", typeIdx: nstrArrTypeIdx },
      { op: "local.set", index: RARR },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: RLEN },
      { op: "i32.const", value: 8 },
      { op: "local.set", index: RCAP },

      // pos = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: POS },

      // Handle empty separator: return array with single element (the whole string)
      { op: "local.get", index: SEPLEN },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // For empty sep, split each character (like JS)
          // But for simplicity and correctness, match JS: "abc".split("") => ["a","b","c"]
          // Realloc if needed for sLen elements
          { op: "local.get", index: SLEN },
          { op: "array.new_default", typeIdx: nstrArrTypeIdx },
          { op: "local.set", index: RARR },
          { op: "local.get", index: SLEN },
          { op: "local.set", index: RCAP },

          // Loop: for each character, create a single-char NativeString
          { op: "i32.const", value: 0 },
          { op: "local.set", index: POS },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  // stop at sLen OR when we've emitted `limit` pieces (#2125)
                  { op: "local.get", index: POS },
                  { op: "local.get", index: SLEN },
                  { op: "i32.ge_s" },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: LIMIT },
                  { op: "i32.ge_u" },
                  { op: "i32.or" },
                  { op: "br_if", depth: 1 },

                  // part = substring(s, pos, pos+1)
                  { op: "local.get", index: S },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: POS },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: PART },

                  // resultArr[pos] = part
                  { op: "local.get", index: RARR },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: PART },
                  { op: "array.set", typeIdx: nstrArrTypeIdx },

                  { op: "local.get", index: POS },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: POS },
                  { op: "br", depth: 0 },
                ] as Instr[],
              },
            ] as Instr[],
          },

          // return struct.new(pos, resultArr) — `pos` is the number of chars
          // actually emitted, which equals min(sLen, limit) (#2125).
          { op: "local.get", index: POS },
          { op: "local.get", index: RARR },
          { op: "ref.as_non_null" },
          { op: "struct.new", typeIdx: nstrVecTypeIdx },
          { op: "return" },
        ] as Instr[],
      },

      // Main split loop: find sep occurrences and extract substrings
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // #2125: stop once `limit` pieces have been collected. From the
              // loop body (not inside an `if`), depth 1 exits the wrapping block.
              { op: "local.get", index: RLEN },
              { op: "local.get", index: LIMIT },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 }, // break outer block

              // idx = indexOf(s, sep, pos)
              { op: "local.get", index: S },
              { op: "local.get", index: SEP },
              { op: "local.get", index: POS },
              { op: "call", funcIdx: indexOfIdx },
              { op: "local.set", index: IDX },

              // if idx == -1: add final part and break
              { op: "local.get", index: IDX },
              { op: "i32.const", value: -1 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // part = substring(s, pos, sLen)
                  { op: "local.get", index: S },
                  { op: "local.get", index: POS },
                  { op: "local.get", index: SLEN },
                  { op: "call", funcIdx: substringIdx },
                  { op: "local.set", index: PART },

                  // Grow result if needed
                  { op: "local.get", index: RLEN },
                  { op: "local.get", index: RCAP },
                  { op: "i32.ge_s" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // newCap = cap * 2
                      { op: "local.get", index: RCAP },
                      { op: "i32.const", value: 2 },
                      { op: "i32.mul" },
                      { op: "local.set", index: RCAP },
                      // newArr = array.new_default(newCap)
                      { op: "local.get", index: RCAP },
                      { op: "array.new_default", typeIdx: nstrArrTypeIdx },
                      { op: "local.set", index: NEWARR },
                      // array.copy(newArr, 0, resultArr, 0, resultLen)
                      { op: "local.get", index: NEWARR },
                      { op: "i32.const", value: 0 },
                      { op: "local.get", index: RARR },
                      { op: "i32.const", value: 0 },
                      { op: "local.get", index: RLEN },
                      {
                        op: "array.copy",
                        dstTypeIdx: nstrArrTypeIdx,
                        srcTypeIdx: nstrArrTypeIdx,
                      },
                      { op: "local.get", index: NEWARR },
                      { op: "local.set", index: RARR },
                    ] as Instr[],
                  },

                  // resultArr[resultLen] = part
                  { op: "local.get", index: RARR },
                  { op: "local.get", index: RLEN },
                  { op: "local.get", index: PART },
                  { op: "array.set", typeIdx: nstrArrTypeIdx },
                  { op: "local.get", index: RLEN },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: RLEN },

                  { op: "br", depth: 2 }, // break outer block
                ] as Instr[],
              },

              // Found separator: part = substring(s, pos, idx)
              { op: "local.get", index: S },
              { op: "local.get", index: POS },
              { op: "local.get", index: IDX },
              { op: "call", funcIdx: substringIdx },
              { op: "local.set", index: PART },

              // Grow result if needed
              { op: "local.get", index: RLEN },
              { op: "local.get", index: RCAP },
              { op: "i32.ge_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: RCAP },
                  { op: "i32.const", value: 2 },
                  { op: "i32.mul" },
                  { op: "local.set", index: RCAP },
                  { op: "local.get", index: RCAP },
                  { op: "array.new_default", typeIdx: nstrArrTypeIdx },
                  { op: "local.set", index: NEWARR },
                  { op: "local.get", index: NEWARR },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: RARR },
                  { op: "i32.const", value: 0 },
                  { op: "local.get", index: RLEN },
                  {
                    op: "array.copy",
                    dstTypeIdx: nstrArrTypeIdx,
                    srcTypeIdx: nstrArrTypeIdx,
                  },
                  { op: "local.get", index: NEWARR },
                  { op: "local.set", index: RARR },
                ] as Instr[],
              },

              // resultArr[resultLen] = part
              { op: "local.get", index: RARR },
              { op: "local.get", index: RLEN },
              { op: "local.get", index: PART },
              { op: "array.set", typeIdx: nstrArrTypeIdx },
              { op: "local.get", index: RLEN },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: RLEN },

              // pos = idx + sepLen
              { op: "local.get", index: IDX },
              { op: "local.get", index: SEPLEN },
              { op: "i32.add" },
              { op: "local.set", index: POS },

              { op: "br", depth: 0 }, // continue loop
            ] as Instr[],
          },
        ] as Instr[],
      },

      // return struct.new(resultLen, resultArr)
      { op: "local.get", index: RLEN },
      { op: "local.get", index: RARR },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: nstrVecTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_split",
      typeIdx,
      locals: [
        { name: "sLen", type: { kind: "i32" } },
        { name: "sepLen", type: { kind: "i32" } },
        { name: "pos", type: { kind: "i32" } },
        { name: "idx", type: { kind: "i32" } },
        { name: "part", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        {
          name: "resultArr",
          type: { kind: "ref_null", typeIdx: nstrArrTypeIdx },
        },
        { name: "resultLen", type: { kind: "i32" } },
        { name: "resultCap", type: { kind: "i32" } },
        { name: "newArr", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      ],
      body: wrapBodyWithFlatten(body, [0, 1]),
      exported: false,
    });
  }

  // --- $__str_fromCodePoint(cp: i32) -> ref $NativeString ---
  // Creates a NativeString from a Unicode code point.
  // BMP (cp <= 0xFFFF): 1-element array.
  // Supplementary (cp > 0xFFFF): 2-element surrogate pair.
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_fromCodePoint", funcIdx);

    // params: cp(0)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0xffff },
      { op: "i32.gt_u" },
      {
        op: "if",
        blockType: { kind: "val", type: strRef },
        then: [
          // Surrogate pair: len=2, off=0, [high, low]
          { op: "i32.const", value: 2 }, // len
          { op: "i32.const", value: 0 }, // off
          // high = ((cp - 0x10000) >> 10) + 0xD800
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 10 },
          { op: "i32.shr_u" },
          { op: "i32.const", value: 0xd800 },
          { op: "i32.add" },
          // low = ((cp - 0x10000) & 0x3FF) + 0xDC00
          { op: "local.get", index: 0 },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 0x3ff },
          { op: "i32.and" },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.add" },
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
        else: [
          // BMP: len=1, off=0, [cp]
          { op: "i32.const", value: 1 }, // len
          { op: "i32.const", value: 0 }, // off
          { op: "local.get", index: 0 }, // cp
          { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
          { op: "struct.new", typeIdx: strTypeIdx },
        ],
      } as Instr,
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_fromCodePoint",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__str_fromCharCode(code: i32) -> ref $NativeString --- (#1598)
  // Creates a single-code-unit NativeString from a UTF-16 code unit. Per spec,
  // String.fromCharCode coerces each argument with ToUint16, so the low 16 bits
  // are taken (no surrogate-pair handling — that is fromCodePoint's job).
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_fromCharCode", funcIdx);

    // params: code(0). Build: struct.new $NativeString(len=1, off=0, [code & 0xFFFF])
    const body: Instr[] = [
      { op: "i32.const", value: 1 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "local.get", index: 0 }, // code
      { op: "i32.const", value: 0xffff },
      { op: "i32.and" }, // ToUint16
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_fromCharCode",
      typeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // --- $__regex_escape(s: ref $AnyString) -> ref $AnyString --- (#2590)
  // Implements ES2025 RegExp.escape / EncodeForRegExpEscape: a pure string
  // transform that escapes regex-syntax-significant code points so the result
  // can be embedded safely in a pattern. No regex engine, no host import.
  //
  // Iterates the input's UTF-16 code units. For each code point c:
  //   - First code point only, if c ∈ [0-9A-Za-z] → "\xHH" (lowercase hex).
  //   - Syntax chars  ^ $ \ . * + ? ( ) [ ] { } |  and solidus /  → "\c".
  //   - ControlEscape  \t \n \v \f \r  (U+0009..U+000D)            → "\t" etc.
  //   - otherPunctuators / WhiteSpace / LineTerminator / lone surrogate:
  //        c ≤ 0xFF  → "\xHH"          (lowercase hex, 2 digits)
  //        else      → "\uHHHH"        (lowercase hex, 4 digits, per code unit)
  //   - Everything else → the code point's UTF-16 code units, unescaped.
  // A high+low surrogate pair forms a scalar code point > 0xFFFF that falls into
  // the final "unescaped" branch and is copied through; only *lone* surrogates
  // hit the \uHHHH branch.
  {
    const concatIdx = ctx.nativeStrHelpers.get("__str_concat")!;
    const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
    const typeIdx = addFuncType(ctx, [strRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__regex_escape", funcIdx);

    // params: s(0)
    // locals: flat(1) ref $NativeString, data(2) ref $__str_data, off(3),
    //         len(4), i(5), out(6) ref $AnyString, cu(7), cu2(8), n0(9), n1(10)
    const FLAT = 1,
      DATA = 2,
      OFF = 3,
      LEN = 4,
      I = 5,
      OUT = 6,
      CU = 7,
      CU2 = 8,
      N0 = 9,
      N1 = 10;

    // nibble→ascii hex char (lowercase): d<10 ? d+0x30 : d+0x57
    const hexNibble = (load: Instr[]): Instr[] => [
      ...load,
      { op: "local.tee", index: N0 },
      { op: "i32.const", value: 10 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "local.get", index: N0 }, { op: "i32.const", value: 0x30 }, { op: "i32.add" }],
        else: [{ op: "local.get", index: N0 }, { op: "i32.const", value: 0x57 }, { op: "i32.add" }],
      } as Instr,
    ];

    // Build "\uHHHH" flat $NativeString for code unit CU (6 code units).
    const uEscape: Instr[] = [
      { op: "i32.const", value: 6 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "i32.const", value: 0x5c }, // '\'
      { op: "i32.const", value: 0x75 }, // 'u'
      ...hexNibble([
        { op: "local.get", index: CU },
        { op: "i32.const", value: 12 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 0xf },
        { op: "i32.and" },
      ]),
      ...hexNibble([
        { op: "local.get", index: CU },
        { op: "i32.const", value: 8 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 0xf },
        { op: "i32.and" },
      ]),
      ...hexNibble([
        { op: "local.get", index: CU },
        { op: "i32.const", value: 4 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 0xf },
        { op: "i32.and" },
      ]),
      ...hexNibble([{ op: "local.get", index: CU }, { op: "i32.const", value: 0xf }, { op: "i32.and" }]),
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 6 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build "\xHH" flat $NativeString for code unit CU (4 code units).
    const xEscape: Instr[] = [
      { op: "i32.const", value: 4 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "i32.const", value: 0x5c }, // '\'
      { op: "i32.const", value: 0x78 }, // 'x'
      ...hexNibble([
        { op: "local.get", index: CU },
        { op: "i32.const", value: 4 },
        { op: "i32.shr_u" },
        { op: "i32.const", value: 0xf },
        { op: "i32.and" },
      ]),
      ...hexNibble([{ op: "local.get", index: CU }, { op: "i32.const", value: 0xf }, { op: "i32.and" }]),
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 4 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build "\<char>" (backslash + the code unit itself), 2 code units.
    const backslashEscape: Instr[] = [
      { op: "i32.const", value: 2 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "i32.const", value: 0x5c }, // '\'
      { op: "local.get", index: CU }, // the char
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build "\<ctrl>" where the named-escape letter is in N1, 2 code units.
    const namedCtrlEscape: Instr[] = [
      { op: "i32.const", value: 2 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "i32.const", value: 0x5c }, // '\'
      { op: "local.get", index: N1 }, // mapped letter t/n/v/f/r
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build a 1-code-unit flat string from CU (pass-through single).
    const oneUnit: Instr[] = [
      { op: "i32.const", value: 1 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "local.get", index: CU },
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 1 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // Build a 2-code-unit flat string from CU,CU2 (valid surrogate pair).
    const twoUnit: Instr[] = [
      { op: "i32.const", value: 2 }, // len
      { op: "i32.const", value: 0 }, // off
      { op: "local.get", index: CU },
      { op: "local.get", index: CU2 },
      { op: "array.new_fixed", typeIdx: strDataTypeIdx, length: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    // out = concat(out, piece); i += adv
    const emitAppend = (piece: Instr[], adv: number): Instr[] => [
      { op: "local.get", index: OUT },
      ...piece,
      { op: "call", funcIdx: concatIdx },
      { op: "local.set", index: OUT },
      { op: "local.get", index: I },
      { op: "i32.const", value: adv },
      { op: "i32.add" },
      { op: "local.set", index: I },
    ];

    // Is CU a syntax char or solidus? (^ $ \ . * + ? ( ) [ ] { } | /)
    const isSyntaxChar = (): Instr[] => {
      const codes = [0x5e, 0x24, 0x5c, 0x2e, 0x2a, 0x2b, 0x3f, 0x28, 0x29, 0x5b, 0x5d, 0x7b, 0x7d, 0x7c, 0x2f];
      const parts: Instr[] = [];
      codes.forEach((c, idx) => {
        parts.push({ op: "local.get", index: CU }, { op: "i32.const", value: c }, { op: "i32.eq" });
        if (idx > 0) parts.push({ op: "i32.or" });
      });
      return parts;
    };

    // Is CU in the "hex-escape" set? otherPunctuators ∪ WhiteSpace ∪
    // LineTerminator ∪ lone-surrogate (control 0x09..0x0D handled earlier).
    // otherPunctuators: , - = < > # & ! % : ; @ ~ ' ` "
    // WhiteSpace (Zs + special): 0x20 0xA0 0x1680 0x2000..0x200A 0x202F 0x205F 0x3000 0xFEFF
    // LineTerminator: 0x2028 0x2029  (0x0A/0x0D are control, handled earlier)
    // lone surrogate: 0xD800..0xDFFF
    const isHexEscapeChar = (): Instr[] => {
      const eqs = [
        0x2c,
        0x2d,
        0x3d,
        0x3c,
        0x3e,
        0x23,
        0x26,
        0x21,
        0x25,
        0x3a,
        0x3b,
        0x40,
        0x7e,
        0x27,
        0x60,
        0x22, // otherPunctuators
        0x20,
        0xa0,
        0x1680,
        0x202f,
        0x205f,
        0x3000,
        0xfeff, // WhiteSpace singletons
        0x2028,
        0x2029, // LineTerminator
      ];
      const parts: Instr[] = [];
      eqs.forEach((c) => {
        parts.push({ op: "local.get", index: CU }, { op: "i32.const", value: c }, { op: "i32.eq" });
      });
      // 0x2000..0x200A range (general punctuation spaces)
      parts.push(
        { op: "local.get", index: CU },
        { op: "i32.const", value: 0x2000 },
        { op: "i32.ge_u" },
        { op: "local.get", index: CU },
        { op: "i32.const", value: 0x200a },
        { op: "i32.le_u" },
        { op: "i32.and" },
      );
      // 0xD800..0xDFFF lone surrogate range
      parts.push(
        { op: "local.get", index: CU },
        { op: "i32.const", value: 0xd800 },
        { op: "i32.ge_u" },
        { op: "local.get", index: CU },
        { op: "i32.const", value: 0xdfff },
        { op: "i32.le_u" },
        { op: "i32.and" },
      );
      const total = eqs.length + 2; // singletons + 2 ranges
      for (let k = 1; k < total; k++) parts.push({ op: "i32.or" });
      return parts;
    };

    // Per-iteration body, executed while i < len.
    // The escape classification cascade (everything except the valid-surrogate-
    // pair passthrough). `cu` is already loaded. Wrapped in the `else` of the
    // pair check so a high surrogate forming a valid astral code point never
    // reaches the lone-surrogate `\uHHHH` branch (StringToCodePoints decodes a
    // valid pair into one >0xFFFF code point, which is in no escape set).
    const classifyBody: Instr[] = [
      // First code point && cu ∈ [0-9A-Za-z] → "\xHH"
      { op: "local.get", index: I },
      { op: "i32.eqz" },
      // digit 0x30..0x39
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x30 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x39 },
      { op: "i32.le_u" },
      { op: "i32.and" },
      // upper 0x41..0x5A
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x41 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x5a },
      { op: "i32.le_u" },
      { op: "i32.and" },
      { op: "i32.or" },
      // lower 0x61..0x7A
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x61 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0x7a },
      { op: "i32.le_u" },
      { op: "i32.and" },
      { op: "i32.or" },
      { op: "i32.and" }, // && (i==0)
      {
        op: "if",
        blockType: { kind: "empty" },
        then: emitAppend(xEscape, 1),
        else: [
          // Syntax char / solidus → "\c"
          ...isSyntaxChar(),
          {
            op: "if",
            blockType: { kind: "empty" },
            then: emitAppend(backslashEscape, 1),
            else: [
              // ControlEscape 0x09..0x0D → named \t \n \v \f \r
              { op: "local.get", index: CU },
              { op: "i32.const", value: 0x09 },
              { op: "i32.ge_u" },
              { op: "local.get", index: CU },
              { op: "i32.const", value: 0x0d },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // N1 = letter: 0x09→t 0x0A→n 0x0B→v 0x0C→f 0x0D→r
                  { op: "local.get", index: CU },
                  { op: "i32.const", value: 0x09 },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: { kind: "i32" } },
                    then: [{ op: "i32.const", value: 0x74 }], // t
                    else: [
                      { op: "local.get", index: CU },
                      { op: "i32.const", value: 0x0a },
                      { op: "i32.eq" },
                      {
                        op: "if",
                        blockType: { kind: "val", type: { kind: "i32" } },
                        then: [{ op: "i32.const", value: 0x6e }], // n
                        else: [
                          { op: "local.get", index: CU },
                          { op: "i32.const", value: 0x0b },
                          { op: "i32.eq" },
                          {
                            op: "if",
                            blockType: { kind: "val", type: { kind: "i32" } },
                            then: [{ op: "i32.const", value: 0x76 }], // v
                            else: [
                              { op: "local.get", index: CU },
                              { op: "i32.const", value: 0x0c },
                              { op: "i32.eq" },
                              {
                                op: "if",
                                blockType: { kind: "val", type: { kind: "i32" } },
                                then: [{ op: "i32.const", value: 0x66 }], // f
                                else: [{ op: "i32.const", value: 0x72 }], // r (0x0D)
                              } as Instr,
                            ],
                          } as Instr,
                        ],
                      } as Instr,
                    ],
                  } as Instr,
                  { op: "local.set", index: N1 },
                  ...emitAppend(namedCtrlEscape, 1),
                ],
                else: [
                  // hex-escape set (otherPunctuators/WS/LT/lone surrogate)
                  ...isHexEscapeChar(),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // c ≤ 0xFF → \xHH ; else → \uHHHH
                      { op: "local.get", index: CU },
                      { op: "i32.const", value: 0xff },
                      { op: "i32.le_u" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: emitAppend(xEscape, 1),
                        else: emitAppend(uEscape, 1),
                      } as Instr,
                    ],
                    // Unescaped single code unit. (Valid surrogate pairs are
                    // handled by the outer pair check; a lone surrogate matched
                    // the hex-escape branch above; so here cu is a plain BMP
                    // scalar or a lone surrogate that already routed to \uHHHH.)
                    else: emitAppend(oneUnit, 1),
                  } as Instr,
                ],
              } as Instr,
            ],
          } as Instr,
        ],
      } as Instr,
    ];

    // isValidPair = cu ∈ [0xD800,0xDBFF] && i+1 < len &&
    //               data[off+i+1] ∈ [0xDC00,0xDFFF]   (sets CU2 = next unit)
    const loopBody: Instr[] = [
      // cu = data[off + i]
      { op: "local.get", index: DATA },
      { op: "local.get", index: OFF },
      { op: "local.get", index: I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: CU },
      // high surrogate?
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xd800 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xdbff },
      { op: "i32.le_u" },
      { op: "i32.and" },
      // && i+1 < len
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.get", index: LEN },
      { op: "i32.lt_u" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // cu2 = data[off+i+1]; check it is a low surrogate
          { op: "local.get", index: DATA },
          { op: "local.get", index: OFF },
          { op: "local.get", index: I },
          { op: "i32.add" },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "array.get_u", typeIdx: strDataTypeIdx },
          { op: "local.tee", index: CU2 },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.ge_u" },
          { op: "local.get", index: CU2 },
          { op: "i32.const", value: 0xdfff },
          { op: "i32.le_u" },
          { op: "i32.and" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: emitAppend(twoUnit, 2), // valid astral pair → passthrough
        else: classifyBody,
      } as Instr,
    ];

    const body: Instr[] = [
      // flat = flatten(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT },
      // data = flat.data ; off = flat.off ; len = flat.len
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      // out = "" (empty NativeString)
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "struct.new", typeIdx: strTypeIdx },
      { op: "local.set", index: OUT },
      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      // while (i < len) { loopBody }
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              ...loopBody,
              { op: "br", depth: 0 },
            ],
          } as Instr,
        ],
      } as Instr,
      // return out
      { op: "local.get", index: OUT },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__regex_escape",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "out", type: strRef },
        { name: "cu", type: { kind: "i32" } },
        { name: "cu2", type: { kind: "i32" } },
        { name: "n0", type: { kind: "i32" } },
        { name: "n1", type: { kind: "i32" } },
      ],
      body: wrapBodyWithFlatten(body, []),
      exported: false,
    });
  }

  // (#3069) Annex B §B.2.2 HTML string-wrapper methods — the `__str_html_escape_quot`
  // helper (CreateHTML step-4.b `"`→`&quot;` escaping). Emitted here, AFTER
  // __str_flatten/__str_concat are registered. The tag/attribute concatenation
  // is built inline at each call site in string-ops.ts via __str_concat.
  emitNativeHtmlWrapperHelpers(ctx, strTypeIdx, strDataTypeIdx, anyStrTypeIdx);
}

/**
 * (#1780) Register the WasmGC struct backing `TextEncoder.encodeInto`'s
 * `{ read, written }` result. Registered under the lib.dom.d.ts interface name
 * `TextEncoderEncodeIntoResult` so that member access on the call result
 * (`r.read`, `r.written`) resolves to this struct via `resolveStructName`
 * (which keys on `tsType.symbol?.name`). Both fields are JS numbers → f64.
 */
function ensureEncodeIntoResultStruct(ctx: CodegenContext): number {
  const name = "TextEncoderEncodeIntoResult";
  const existing = ctx.structMap.get(name);
  if (existing !== undefined) return existing;

  const fields = [
    { name: "read", type: { kind: "f64" as const }, mutable: false },
    { name: "written", type: { kind: "f64" as const }, mutable: false },
  ];
  const typeIdx = ctx.mod.types.length;
  // superTypeIdx: -1 emits the struct as a `(sub (struct …))` with no supertype,
  // giving it a distinct nominal identity. A plain `(struct f64 f64)` would get
  // canonical structural identity and could be merged/aliased with another
  // structurally-identical two-f64 struct, breaking `struct.new`/field access by
  // type-index (mirrors the vec-type pattern in registry/types.ts).
  ctx.mod.types.push({ kind: "struct", name, fields, superTypeIdx: -1 });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
  return typeIdx;
}

export function ensureTextEncodingHelpers(ctx: CodegenContext): {
  encodeIdx: number;
  decodeU8Idx: number;
  vecTypeIdx: number;
  resultTypeIdx: number;
} {
  ensureNativeStringHelpers(ctx);

  const existingEncode = ctx.funcMap.get("__textencoder_encode");
  const existingDecode = ctx.funcMap.get("__textdecoder_decode_u8");
  const elemType: ValType = { kind: "f64" };
  const vecTypeIdx = getOrRegisterVecType(ctx, "f64", elemType);
  const vecArrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const resultTypeIdx = ensureEncodeIntoResultStruct(ctx);
  if (existingEncode !== undefined && existingDecode !== undefined) {
    return {
      encodeIdx: existingEncode,
      decodeU8Idx: existingDecode,
      vecTypeIdx,
      resultTypeIdx,
    };
  }

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (strTypeIdx < 0 || anyStrTypeIdx < 0 || strDataTypeIdx < 0 || vecArrTypeIdx < 0) {
    throw new Error("TextEncoder/TextDecoder require native string and Uint8Array runtime types");
  }

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const vecRef: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const vecNonNullRef: ValType = { kind: "ref", typeIdx: vecTypeIdx };
  const vecArrRef: ValType = { kind: "ref", typeIdx: vecArrTypeIdx };
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten")!;

  if (existingEncode === undefined) {
    const typeIdx = addFuncType(ctx, [strRef], [vecRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__textencoder_encode", funcIdx);
    ctx.funcMap.set("__textencoder_encode", funcIdx);

    const FLAT = 1;
    const DATA = 2;
    const OFF = 3;
    const LEN = 4;
    const OUT = 5;
    const I = 6;
    const O = 7;
    const BYTELEN = 8;
    const CU = 9;
    const CP = 10;
    const LO = 11;

    const writeByte = (valueInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: OUT },
      { op: "local.get", index: O },
      ...valueInstrs,
      { op: "f64.convert_i32_u" },
      { op: "array.set", typeIdx: vecArrTypeIdx },
      { op: "local.get", index: O },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: O },
    ];

    const writeCodePoint: Instr[] = [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x80 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: writeByte([{ op: "local.get", index: CP }]),
        else: [
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x800 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...writeByte([
                { op: "i32.const", value: 0xc0 },
                { op: "local.get", index: CP },
                { op: "i32.const", value: 6 },
                { op: "i32.shr_u" },
                { op: "i32.or" },
              ]),
              ...writeByte([
                { op: "i32.const", value: 0x80 },
                { op: "local.get", index: CP },
                { op: "i32.const", value: 0x3f },
                { op: "i32.and" },
                { op: "i32.or" },
              ]),
            ],
            else: [
              { op: "local.get", index: CP },
              { op: "i32.const", value: 0x10000 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...writeByte([
                    { op: "i32.const", value: 0xe0 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 12 },
                    { op: "i32.shr_u" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 6 },
                    { op: "i32.shr_u" },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                ],
                else: [
                  ...writeByte([
                    { op: "i32.const", value: 0xf0 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 18 },
                    { op: "i32.shr_u" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 12 },
                    { op: "i32.shr_u" },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 6 },
                    { op: "i32.shr_u" },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                  ...writeByte([
                    { op: "i32.const", value: 0x80 },
                    { op: "local.get", index: CP },
                    { op: "i32.const", value: 0x3f },
                    { op: "i32.and" },
                    { op: "i32.or" },
                  ]),
                ],
              },
            ],
          },
        ],
      },
    ];

    const decodeCodePoint: Instr[] = [
      { op: "local.get", index: DATA },
      { op: "local.get", index: OFF },
      { op: "local.get", index: I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: CU },
      { op: "local.get", index: CU },
      { op: "local.set", index: CP },
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: I },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xd800 },
      { op: "i32.ge_u" },
      { op: "local.get", index: CU },
      { op: "i32.const", value: 0xdbff },
      { op: "i32.le_u" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: I },
          { op: "local.get", index: LEN },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: DATA },
              { op: "local.get", index: OFF },
              { op: "local.get", index: I },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.set", index: LO },
              { op: "local.get", index: LO },
              { op: "i32.const", value: 0xdc00 },
              { op: "i32.ge_u" },
              { op: "local.get", index: LO },
              { op: "i32.const", value: 0xdfff },
              { op: "i32.le_u" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "i32.const", value: 0x10000 },
                  { op: "local.get", index: CU },
                  { op: "i32.const", value: 0xd800 },
                  { op: "i32.sub" },
                  { op: "i32.const", value: 10 },
                  { op: "i32.shl" },
                  { op: "i32.add" },
                  { op: "local.get", index: LO },
                  { op: "i32.const", value: 0xdc00 },
                  { op: "i32.sub" },
                  { op: "i32.add" },
                  { op: "local.set", index: CP },
                  { op: "local.get", index: I },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: I },
                ],
                else: [
                  { op: "i32.const", value: 0xfffd },
                  { op: "local.set", index: CP },
                ],
              },
            ],
            else: [
              { op: "i32.const", value: 0xfffd },
              { op: "local.set", index: CP },
            ],
          },
        ],
        else: [
          { op: "local.get", index: CU },
          { op: "i32.const", value: 0xdc00 },
          { op: "i32.ge_u" },
          { op: "local.get", index: CU },
          { op: "i32.const", value: 0xdfff },
          { op: "i32.le_u" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: 0xfffd },
              { op: "local.set", index: CP },
            ],
          },
        ],
      },
      ...writeCodePoint,
    ];

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: OFF },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: DATA },
      { op: "local.get", index: LEN },
      { op: "i32.const", value: 2 },
      { op: "i32.shl" },
      { op: "array.new_default", typeIdx: vecArrTypeIdx },
      { op: "local.set", index: OUT },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: O },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...decodeCodePoint,
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: O },
      { op: "local.get", index: OUT },
      { op: "struct.new", typeIdx: vecTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__textencoder_encode",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "data", type: strDataRef },
        { name: "off", type: { kind: "i32" } },
        { name: "len", type: { kind: "i32" } },
        { name: "out", type: vecArrRef },
        { name: "i", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "maxByteLen", type: { kind: "i32" } },
        { name: "cu", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
        { name: "lo", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  if (existingDecode === undefined) {
    const typeIdx = addFuncType(ctx, [vecRef], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__textdecoder_decode_u8", funcIdx);
    ctx.funcMap.set("__textdecoder_decode_u8", funcIdx);

    const SRC = 1;
    const LEN = 2;
    const DATA = 3;
    const OUT = 4;
    const I = 5;
    const O = 6;
    const B0 = 7;
    const B1 = 8;
    const B2 = 9;
    const B3 = 10;
    const CP = 11;

    const readByteTo = (local: number): Instr[] => [
      { op: "local.get", index: DATA },
      { op: "local.get", index: I },
      { op: "array.get", typeIdx: vecArrTypeIdx },
      { op: "i32.trunc_sat_f64_u" },
      { op: "i32.const", value: 0xff },
      { op: "i32.and" },
      { op: "local.set", index: local },
      { op: "local.get", index: I },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: I },
    ];

    const writeCodePoint: Instr[] = [
      { op: "local.get", index: CP },
      { op: "i32.const", value: 0x10000 },
      { op: "i32.ge_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "i32.const", value: 0xd800 },
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 10 },
          { op: "i32.shr_u" },
          { op: "i32.or" },
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "i32.const", value: 0xdc00 },
          { op: "local.get", index: CP },
          { op: "i32.const", value: 0x10000 },
          { op: "i32.sub" },
          { op: "i32.const", value: 0x3ff },
          { op: "i32.and" },
          { op: "i32.or" },
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: O },
          { op: "i32.const", value: 2 },
          { op: "i32.add" },
          { op: "local.set", index: O },
        ],
        else: [
          { op: "local.get", index: OUT },
          { op: "local.get", index: O },
          { op: "local.get", index: CP },
          { op: "array.set", typeIdx: strDataTypeIdx },
          { op: "local.get", index: O },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: O },
        ],
      },
    ];

    const decodeMultibyte: Instr[] = [
      { op: "local.get", index: B0 },
      { op: "i32.const", value: 0xe0 },
      { op: "i32.lt_u" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: I },
          { op: "local.get", index: LEN },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...readByteTo(B1),
              { op: "local.get", index: B0 },
              { op: "i32.const", value: 0x1f },
              { op: "i32.and" },
              { op: "i32.const", value: 6 },
              { op: "i32.shl" },
              { op: "local.get", index: B1 },
              { op: "i32.const", value: 0x3f },
              { op: "i32.and" },
              { op: "i32.or" },
              { op: "local.set", index: CP },
            ],
            else: [
              { op: "i32.const", value: 0xfffd },
              { op: "local.set", index: CP },
            ],
          },
        ],
        else: [
          { op: "local.get", index: B0 },
          { op: "i32.const", value: 0xf0 },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: LEN },
              { op: "i32.lt_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...readByteTo(B1),
                  ...readByteTo(B2),
                  { op: "local.get", index: B0 },
                  { op: "i32.const", value: 0x0f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shl" },
                  { op: "local.get", index: B1 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shl" },
                  { op: "i32.or" },
                  { op: "local.get", index: B2 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "local.set", index: CP },
                ],
                else: [
                  { op: "i32.const", value: 0xfffd },
                  { op: "local.set", index: CP },
                ],
              },
            ],
            else: [
              { op: "local.get", index: I },
              { op: "i32.const", value: 2 },
              { op: "i32.add" },
              { op: "local.get", index: LEN },
              { op: "i32.lt_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...readByteTo(B1),
                  ...readByteTo(B2),
                  ...readByteTo(B3),
                  { op: "local.get", index: B0 },
                  { op: "i32.const", value: 0x07 },
                  { op: "i32.and" },
                  { op: "i32.const", value: 18 },
                  { op: "i32.shl" },
                  { op: "local.get", index: B1 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 12 },
                  { op: "i32.shl" },
                  { op: "i32.or" },
                  { op: "local.get", index: B2 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.const", value: 6 },
                  { op: "i32.shl" },
                  { op: "i32.or" },
                  { op: "local.get", index: B3 },
                  { op: "i32.const", value: 0x3f },
                  { op: "i32.and" },
                  { op: "i32.or" },
                  { op: "local.set", index: CP },
                ],
                else: [
                  { op: "i32.const", value: 0xfffd },
                  { op: "local.set", index: CP },
                ],
              },
            ],
          },
        ],
      },
    ];

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.as_non_null" },
      { op: "local.set", index: SRC },
      { op: "local.get", index: SRC },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: LEN },
      { op: "local.get", index: SRC },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: DATA },
      { op: "local.get", index: LEN },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: OUT },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: I },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: O },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: I },
              { op: "local.get", index: LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...readByteTo(B0),
              { op: "local.get", index: B0 },
              { op: "i32.const", value: 0x80 },
              { op: "i32.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: B0 },
                  { op: "local.set", index: CP },
                ],
                else: decodeMultibyte,
              },
              ...writeCodePoint,
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: O },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: OUT },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__textdecoder_decode_u8",
      typeIdx,
      locals: [
        { name: "src", type: vecNonNullRef },
        { name: "len", type: { kind: "i32" } },
        { name: "data", type: vecArrRef },
        { name: "out", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
        { name: "o", type: { kind: "i32" } },
        { name: "b0", type: { kind: "i32" } },
        { name: "b1", type: { kind: "i32" } },
        { name: "b2", type: { kind: "i32" } },
        { name: "b3", type: { kind: "i32" } },
        { name: "cp", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }

  return {
    encodeIdx: ctx.funcMap.get("__textencoder_encode")!,
    decodeU8Idx: ctx.funcMap.get("__textdecoder_decode_u8")!,
    vecTypeIdx,
    resultTypeIdx,
  };
}

/**
 * #1470 — Emit `$__any_to_string(v: anyref) -> ref $AnyString`, the standalone
 * (no-JS-host) replacement for the `__extern_toString` host import. Dispatches
 * on the concrete WasmGC type of `v`:
 *   - ref $AnyString    → returned as-is (already a native string)
 *   - ref $AnyValue     → switch on the boxed tag:
 *       0 null      → "null"
 *       1 undefined → "undefined"
 *       2 i32 num   → number_toString(f64.convert_i32_s(i32val))
 *       3 f64 num   → number_toString(f64val)
 *       4 bool      → "true" / "false"
 *       5 string    → externval → any.convert_extern → ref.cast $AnyString
 *       6 ref / else→ "[object Object]"
 *   - anything else     → "[object Object]"
 *
 * Spec-correct dispatch for ordinary objects (walking @@toPrimitive / toString
 * via the object's vtable) lands with #1472; the Phase-1 fallback here is the
 * canonical `"[object Object]"` so a standalone module never traps on a string
 * coercion of an arbitrary value.
 *
 * Idempotent — caches the function index under `nativeStrHelpers["__any_to_string"]`.
 */
/**
 * (#2962) §20.5.3.4 `Error.prototype.toString` for the native `$Error_struct` —
 * `__error_to_string(v: anyref) -> ref $AnyString`, where `v` MUST already be
 * a `$Error_struct` (callers guard with `ref.test`; the entry `ref.cast` is
 * defensive).
 *
 *   1. name = $name field when it is a native string, else the literal
 *      "Error" (our constructors always materialize a non-empty name, so the
 *      spec's empty-name arm is unreachable — see emitErrorStructConstructor).
 *   2. msg  = $message field; `null` (constructed argument-less), a NON-string
 *      (documented residual: §20.5.1.1 stores ToString(message) at
 *      construction, our ctor stores the raw arg), or the empty string all
 *      yield `name` alone per §20.5.3.4 steps 4–6.
 *   3. else `name + ": " + msg`.
 *
 * Standalone/WASI only: in JS-host mode the `__new_<Kind>` imports resolve to
 * the real JS constructors, so thrown errors are host objects and never
 * `$Error_struct`s — the helper would be dead weight. Registering the error
 * struct type here (idempotent) makes the arm order-independent: a module
 * whose first string coercion happens BEFORE its first error construction
 * still gets the arm.
 *
 * Index-shift safety (#1448 pattern): the only baked dependency is
 * `__str_concat` (already emitted by ensureNativeStringHelpers); the body is
 * built and pushed with no intervening helper emission. Registered in
 * `funcMap` so deferred late-import flushes keep the index authoritative.
 *
 * Idempotent — cached under `nativeStrHelpers["__error_to_string"]`.
 */
function ensureErrorToStringHelper(ctx: CodegenContext): number | undefined {
  const cached = ctx.nativeStrHelpers.get("__error_to_string");
  if (cached !== undefined) return cached;
  if (!(ctx.standalone || ctx.wasi)) return undefined; // noJsHost only (see doc above)
  ensureNativeStringHelpers(ctx);
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return undefined;

  const errStructIdx = getOrRegisterErrorStructType(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);

  // params: v(0) anyref · locals: e(1) ref null $Error_struct, tmp(2) anyref,
  // name(3) ref null $AnyString, msg(4) ref null $AnyString
  const L_V = 0;
  const L_E = 1;
  const L_TMP = 2;
  const L_NAME = 3;
  const L_MSG = 4;

  const returnName: Instr[] = [
    { op: "local.get", index: L_NAME },
    { op: "ref.as_non_null" } as Instr,
    { op: "return" } as Instr,
  ];

  const body: Instr[] = [
    { op: "local.get", index: L_V },
    { op: "ref.cast", typeIdx: errStructIdx } as Instr,
    { op: "local.set", index: L_E },
    // name = ($name is a native string) ? it : "Error"
    { op: "local.get", index: L_E },
    { op: "struct.get", typeIdx: errStructIdx, fieldIdx: 2 }, // $name (externref)
    { op: "any.convert_extern" } as Instr,
    { op: "local.tee", index: L_TMP },
    { op: "ref.test", typeIdx: anyStrTypeIdx } as Instr,
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [{ op: "local.get", index: L_TMP }, { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr],
      else: litStr("Error"),
    } as Instr,
    { op: "local.set", index: L_NAME },
    // msg — null / non-string → name alone (steps 4–6; non-string is the
    // documented construction-time-ToString residual).
    { op: "local.get", index: L_E },
    { op: "struct.get", typeIdx: errStructIdx, fieldIdx: 1 }, // $message (externref)
    { op: "any.convert_extern" } as Instr,
    { op: "local.tee", index: L_TMP },
    { op: "ref.test", typeIdx: anyStrTypeIdx } as Instr,
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnName.map((i) => ({ ...i })) } as Instr,
    { op: "local.get", index: L_TMP },
    { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr,
    { op: "local.set", index: L_MSG },
    // empty message → name alone (§20.5.3.4 step 6)
    { op: "local.get", index: L_MSG },
    { op: "struct.get", typeIdx: anyStrTypeIdx, fieldIdx: 0 }, // len
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnName.map((i) => ({ ...i })) } as Instr,
    // name + ": " + msg
    { op: "local.get", index: L_NAME },
    { op: "ref.as_non_null" } as Instr,
    ...litStr(": "),
    { op: "call", funcIdx: strConcatIdx },
    { op: "local.get", index: L_MSG },
    { op: "ref.as_non_null" } as Instr,
    { op: "call", funcIdx: strConcatIdx },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "anyref" }], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__error_to_string", funcIdx);
  ctx.funcMap.set("__error_to_string", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__error_to_string",
    typeIdx,
    locals: [
      { name: "e", type: { kind: "ref_null", typeIdx: errStructIdx } },
      { name: "tmp", type: { kind: "anyref" } },
      { name: "name", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
      { name: "msg", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

export function ensureAnyToStringHelper(ctx: CodegenContext): number {
  ensureNativeStringHelpers(ctx);
  const existing = ctx.nativeStrHelpers.get("__any_to_string");
  if (existing !== undefined) return existing;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const anyref: ValType = { kind: "anyref" };

  // The $AnyValue box must exist for the tag-dispatch arm. It is registered
  // lazily; ensure it here so the struct.get / ref.cast below resolve.
  ensureAnyValueType(ctx);
  const anyValueTypeIdx = ctx.anyValueTypeIdx;

  // (#2962) Emit the §20.5.3.4 `__error_to_string` helper BEFORE this
  // function's own index is baked (it appends a function — no import, so no
  // index shift for anything already emitted). `undefined` in JS-host mode
  // (errors are host objects there) — every arm below then degrades to the
  // prior "[object Object]" literal, keeping host lanes byte-identical.
  const errToStrIdx = ensureErrorToStringHelper(ctx);
  const errStructTypeIdx = errToStrIdx !== undefined ? ctx.errorStructTypeIdx : -1;

  // number_toString returns an externref that is really a `ref $AnyString` in
  // native-strings mode; convert it back with any.convert_extern + ref.cast.
  const numToStrIdx = ctx.funcMap.get("number_toString");

  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);

  // (#2962) Shared terminal for an unrecognized object ref: `$Error_struct` →
  // `__error_to_string` (a real "TypeError: boom"), anything else → the
  // canonical "[object Object]". `loadRef` is a FACTORY (fresh instruction
  // objects per use) because the ref is loaded twice (test + call) — aliasing
  // one instr array into two tree positions double-shifts funcIdx fields when
  // post-codegen passes walk the tree (the #1448 corruption class).
  const objectOrErrorTag = (loadRef: () => Instr[]): Instr[] =>
    errToStrIdx !== undefined && errStructTypeIdx >= 0
      ? [
          ...loadRef(),
          { op: "ref.test", typeIdx: errStructTypeIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [...loadRef(), { op: "call", funcIdx: errToStrIdx } as Instr],
            else: litStr("[object Object]"),
          } as Instr,
        ]
      : litStr("[object Object]");

  // `box` (the $AnyValue ref) lives in local 1; the original anyref param in 0.
  const L_V = 0;
  const L_BOX = 1;
  // #1910/#1472 S2 — scratch anyref for the tag-5 string-vs-wrapper recovery.
  const L_RECOVER = 2;

  const numberArm = (loadNumeric: Instr[]): Instr[] =>
    numToStrIdx !== undefined
      ? [
          ...loadNumeric,
          { op: "call", funcIdx: numToStrIdx },
          { op: "any.convert_extern" } as Instr,
          { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr,
        ]
      : litStr("[object Object]");

  // #1910/#1472 S2 — recover the string for an externref that is tagged as a
  // string (tag 5) but is NOT actually a `$AnyString`. The generic
  // externref→AnyValue boxing tags EVERY externref as tag-5 (see
  // value-tags.ts:185), so a boxed-primitive WRAPPER (`new String`/`new Number`/
  // `new Boolean` → a `$Object` carrying the internal [[PrimitiveValue]] slot)
  // reaches the tag-5 arm; the raw `ref.cast $AnyString` would trap ("illegal
  // cast"). When the value is a `$Object`, reduce it with `__to_primitive`
  // (registered by ensureObjectRuntime BEFORE this helper bakes, so its funcIdx
  // is known here — same no-intervening-shift invariant the rest of this helper
  // relies on), which reads the wrapper's internal slot and returns its boxed
  // primitive. That primitive is then a `$AnyString` (string wrapper) or a
  // `$__box_number_struct`/`$__box_boolean_struct` (number/boolean wrapper), all
  // of which the existing $AnyString test + residual box-recovery format
  // correctly — so we route the reduced value back through that recovery
  // (`stringifyExtern`). Non-`$Object` tag-5 externrefs (boxed primitive carriers
  // crossing the open-any boundary) skip straight to that recovery unchanged.
  const toPrimitiveIdx = ctx.funcMap.get("__to_primitive");
  const objectRtTypes = ctx.objectRuntimeTypes;
  const boxNumIdxEarly = ctx.nativeBoxNumberTypeIdx;
  const boxBoolIdxEarly = ctx.nativeBoxBooleanTypeIdx;
  // Format an externref already known NOT to be a $AnyString: recover a
  // $__box_number_struct / $__box_boolean_struct, else "[object Object]".
  const stringifyBoxedExtern = (loadExtern: Instr[]): Instr[] =>
    boxNumIdxEarly >= 0 && boxBoolIdxEarly >= 0
      ? [
          ...loadExtern,
          { op: "any.convert_extern" } as Instr,
          { op: "local.tee", index: L_RECOVER } as Instr,
          { op: "ref.test", typeIdx: anyStrTypeIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: [{ op: "local.get", index: L_RECOVER }, { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr],
            else: [
              { op: "local.get", index: L_RECOVER },
              { op: "ref.test", typeIdx: boxNumIdxEarly } as Instr,
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: numberArm([
                  { op: "local.get", index: L_RECOVER },
                  { op: "ref.cast", typeIdx: boxNumIdxEarly } as Instr,
                  { op: "struct.get", typeIdx: boxNumIdxEarly, fieldIdx: 0 },
                ]),
                else: [
                  { op: "local.get", index: L_RECOVER },
                  { op: "ref.test", typeIdx: boxBoolIdxEarly } as Instr,
                  {
                    op: "if",
                    blockType: { kind: "val", type: strRef },
                    then: [
                      { op: "local.get", index: L_RECOVER },
                      { op: "ref.cast", typeIdx: boxBoolIdxEarly } as Instr,
                      { op: "struct.get", typeIdx: boxBoolIdxEarly, fieldIdx: 0 },
                      {
                        op: "if",
                        blockType: { kind: "val", type: strRef },
                        then: litStr("true"),
                        else: litStr("false"),
                      } as Instr,
                    ],
                    // (#2962) a `$Error_struct` reaching the tag-5 boxed-extern
                    // recovery (a caught error re-boxed as `any`) renders
                    // "Name: message" instead of "[object Object]".
                    else: objectOrErrorTag(() => [{ op: "local.get", index: L_RECOVER }]),
                  } as Instr,
                ],
              } as Instr,
            ],
          } as Instr,
        ]
      : litStr("[object Object]");
  const recoverNonStringExtern = (loadExtern: Instr[]): Instr[] =>
    toPrimitiveIdx !== undefined && objectRtTypes !== undefined
      ? [
          // if (value is a $Object wrapper) value = __to_primitive(value, default)
          ...loadExtern,
          { op: "any.convert_extern" } as Instr,
          { op: "local.tee", index: L_RECOVER } as Instr,
          { op: "ref.test", typeIdx: objectRtTypes.objectTypeIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: stringifyBoxedExtern([
              { op: "local.get", index: L_RECOVER },
              { op: "extern.convert_any" } as Instr,
              { op: "ref.null.extern" } as Instr, // default hint
              { op: "call", funcIdx: toPrimitiveIdx } as Instr,
            ]),
            else: stringifyBoxedExtern([{ op: "local.get", index: L_RECOVER }, { op: "extern.convert_any" } as Instr]),
          } as Instr,
        ]
      : stringifyBoxedExtern(loadExtern);

  const tagEq = (tag: number): Instr[] => [
    { op: "local.get", index: L_BOX },
    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
  ];

  // tag dispatch as a nested if/else chain producing `ref $AnyString`.
  const boxDispatch: Instr[] = [
    ...tagEq(0),
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: litStr("null"),
      else: [
        ...tagEq(1),
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: litStr("undefined"),
          else: [
            ...tagEq(2),
            {
              op: "if",
              blockType: { kind: "val", type: strRef },
              then: numberArm([
                { op: "local.get", index: L_BOX },
                { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 1 },
                { op: "f64.convert_i32_s" },
              ]),
              else: [
                ...tagEq(3),
                {
                  op: "if",
                  blockType: { kind: "val", type: strRef },
                  then: numberArm([
                    { op: "local.get", index: L_BOX },
                    { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 2 },
                  ]),
                  else: [
                    ...tagEq(4),
                    {
                      op: "if",
                      blockType: { kind: "val", type: strRef },
                      then: [
                        { op: "local.get", index: L_BOX },
                        {
                          op: "struct.get",
                          typeIdx: anyValueTypeIdx,
                          fieldIdx: 1,
                        },
                        {
                          op: "if",
                          blockType: { kind: "val", type: strRef },
                          then: litStr("true"),
                          else: litStr("false"),
                        } as Instr,
                      ],
                      else: [
                        ...tagEq(5),
                        {
                          op: "if",
                          blockType: { kind: "val", type: strRef },
                          // tag 5 (string): the externval is USUALLY a real
                          // `$AnyString`, but the generic externref boxing also
                          // tags boxed-primitive WRAPPER objects (new String /
                          // Number / Boolean → $Object) and other open externrefs
                          // as tag-5 (#1910/#1472 S2). Test $AnyString first; only
                          // cast when it really is a string, otherwise recover via
                          // __extern_toString (reads the wrapper's internal slot
                          // through ToPrimitive). Without this guard the raw cast
                          // traps with "illegal cast" for `new String("1") + x`.
                          then: [
                            { op: "local.get", index: L_BOX },
                            {
                              op: "struct.get",
                              typeIdx: anyValueTypeIdx,
                              fieldIdx: 4,
                            },
                            { op: "any.convert_extern" } as Instr,
                            { op: "local.tee", index: L_RECOVER } as Instr,
                            { op: "ref.test", typeIdx: anyStrTypeIdx } as Instr,
                            {
                              op: "if",
                              blockType: { kind: "val", type: strRef },
                              then: [
                                { op: "local.get", index: L_RECOVER },
                                { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr,
                              ],
                              else: recoverNonStringExtern([
                                { op: "local.get", index: L_RECOVER },
                                { op: "extern.convert_any" } as Instr,
                              ]),
                            } as Instr,
                          ],
                          // tag 6 / unknown → $Error_struct renders
                          // "Name: message" (#2962), else "[object Object]"
                          else: objectOrErrorTag(() => [
                            { op: "local.get", index: L_BOX },
                            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 3 },
                          ]),
                        } as Instr,
                      ],
                    } as Instr,
                  ],
                } as Instr,
              ],
            } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
  ];

  // (#2072) Standalone primitive-box recovery — subsumes the #1988 number-only
  // arm (which lived at this exact residual location and recovered ONLY
  // `$__box_number_struct` → number_toString, e.g. the `1` in `1 + {}` after
  // ToPrimitive). An `any`-held primitive is NOT stored as a $AnyValue box on
  // the WasmGC/standalone path — `coerceType` boxes f64 via `__box_number`
  // ($__box_number_struct), bool via `__box_boolean` ($__box_boolean_struct),
  // then `extern.convert_any` makes it externref (the #1888 externref ABI the
  // test262 comparator relies on, which is why we recover the shape here rather
  // than changing the box). So when the value is neither $AnyString nor
  // $AnyValue, before yielding "[object Object]" we ref.test the boxed-primitive
  // structs and format them, matching what the $AnyValue tag-2/tag-4 arms above
  // already do. Without this, String(v) for `const v: any = 42 / true` returned
  // "[object Object]". The number sub-arm uses `numberArm(...)`, which appends
  // exactly `call number_toString; any.convert_extern; ref.cast $AnyString` —
  // byte-identical to #1988's explicit emit (and falls back to "[object Object]"
  // when `number_toString` is absent), so #1988's `1 + {}` case still holds.
  // Type indices (not func indices) are read here, so no late-import shift
  // hazard; the only func index baked in is `numToStrIdx`, which this helper
  // already bakes for tag 2/3.
  const boxNumIdx = ctx.nativeBoxNumberTypeIdx;
  const boxBoolIdx = ctx.nativeBoxBooleanTypeIdx;
  const residualArm: Instr[] =
    boxNumIdx >= 0 && boxBoolIdx >= 0
      ? [
          // $__box_number_struct? → number_toString(value)
          { op: "local.get", index: L_V },
          { op: "ref.test", typeIdx: boxNumIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: strRef },
            then: numberArm([
              { op: "local.get", index: L_V },
              { op: "ref.cast", typeIdx: boxNumIdx } as Instr,
              { op: "struct.get", typeIdx: boxNumIdx, fieldIdx: 0 },
            ]),
            else: [
              // $__box_boolean_struct? → "true" / "false"
              { op: "local.get", index: L_V },
              { op: "ref.test", typeIdx: boxBoolIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "val", type: strRef },
                then: [
                  { op: "local.get", index: L_V },
                  { op: "ref.cast", typeIdx: boxBoolIdx } as Instr,
                  { op: "struct.get", typeIdx: boxBoolIdx, fieldIdx: 0 },
                  {
                    op: "if",
                    blockType: { kind: "val", type: strRef },
                    then: litStr("true"),
                    else: litStr("false"),
                  } as Instr,
                ],
                // unknown ref → $Error_struct renders "Name: message"
                // (#2962), else "[object Object]"
                else: objectOrErrorTag(() => [{ op: "local.get", index: L_V }]),
              } as Instr,
            ],
          } as Instr,
        ]
      : // No box types registered — still recognize a raw `$Error_struct`
        // (#2962) before the "[object Object]" terminal.
        objectOrErrorTag(() => [{ op: "local.get", index: L_V }]);

  const body: Instr[] = [
    // if (v is a $AnyString) return it directly
    { op: "local.get", index: L_V },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: [{ op: "local.get", index: L_V }, { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr],
      else: [
        // else if (v is a $AnyValue) dispatch on its tag
        { op: "local.get", index: L_V },
        { op: "ref.test", typeIdx: anyValueTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: strRef },
          then: [
            { op: "local.get", index: L_V },
            { op: "ref.cast", typeIdx: anyValueTypeIdx } as Instr,
            { op: "local.set", index: L_BOX },
            ...boxDispatch,
          ],
          // else (boxed primitive externref shape, null ref, plain object, vec,
          // …) → recover number/boolean boxes, then "[object Object]"
          else: residualArm,
        } as Instr,
      ],
    } as Instr,
  ];

  const typeIdx = addFuncType(ctx, [anyref], [strRef]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__any_to_string", funcIdx);
  ctx.funcMap.set("__any_to_string", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__any_to_string",
    typeIdx,
    locals: [
      { name: "box", type: { kind: "ref_null", typeIdx: anyValueTypeIdx } },
      { name: "recover", type: { kind: "anyref" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #2007 — emit a per-vec-type native array-join helper
 * `__vec_join_<elemKind>(v: ref null $__vec_<elemKind>) -> ref $AnyString`.
 *
 * Joins the vec's elements with `","` using native string concat:
 *   - numeric element (f64/i32/i8/i16) → `number_toString` (native string boxed
 *     as externref → convert back to `ref $AnyString`);
 *   - native-string element (`ref $AnyString` / `$NativeString`) → passthrough
 *     (a subtype of `$AnyString`);
 *   - nested-vec element (`ref` to another registered `__vec_*`) → recurse into
 *     THAT vec's own `__vec_join_*` helper, so `[[1,2],[3]]` yields `"1,2,3"`;
 *   - any other ref / externref element → `"[object Object]"` (the same residual
 *     `$__any_to_string` would give — kept simple to avoid a cross-helper call
 *     index that the addUnionImports late shift can desync, #1839).
 *
 * **Index-shift safety (the #1448 regression fix):** every dependency
 * (`number_toString`, a nested `__vec_join_*`) is emitted *first*, so any late
 * import shift it triggers happens BEFORE this body is built; their final
 * indices are read after, then the body is built and pushed with NO intervening
 * helper emission. Otherwise a shift between baking a `call funcIdx` and pushing
 * the body leaves the not-yet-attached body un-walked by `shiftFuncIndices` →
 * stale index → "call expected (ref null 5), found anyref" (the #1448 break).
 *
 * Empty vec → `""`; single element → that element's string. Idempotent: cached
 * under `nativeStrHelpers["__vec_join_<elemKind>"]`.
 */
function ensureNativeVecJoinHelper(
  ctx: CodegenContext,
  elemKind: string,
  vecTypeIdx: number,
  arrTypeIdx: number,
): number | undefined {
  const cacheKey = `__vec_join_${elemKind}`;
  const cached = ctx.nativeStrHelpers.get(cacheKey);
  if (cached !== undefined) return cached;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return undefined;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };

  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemType: ValType = arrDef && arrDef.kind === "array" ? (arrDef.element as ValType) : { kind: "f64" };
  const isNumeric =
    elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "i8" || elemType.kind === "i16";
  const isNativeStrElem =
    (elemType.kind === "ref" || elemType.kind === "ref_null") &&
    (elemType as { typeIdx: number }).typeIdx === anyStrTypeIdx;
  // A non-string ref element whose target is itself a registered vec → nested
  // array; recurse into that vec's join helper.
  let nestedElemKind: string | undefined;
  if ((elemType.kind === "ref" || elemType.kind === "ref_null") && !isNativeStrElem) {
    const elemTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    for (const [k, idx] of ctx.vecTypeMap.entries()) {
      if (idx === elemTypeIdx) {
        nestedElemKind = k;
        break;
      }
    }
  }

  // ── Run EVERY side-effecting emission FIRST, then read ALL indices last ──
  // (#1448) `emitNativeNumberFormat`, a nested `ensureNativeVecJoinHelper`, and
  // `nativeStringLiteralInstrs` (string-constant global / late import
  // registration) can each trigger an `addUnionImports` function-index shift.
  // If we read a funcIdx and THEN one of these shifts, the read index goes
  // stale and the baked `call` targets the wrong function (the #1448
  // catastrophe: number_toString resolved to a (i32)→… and codegen even
  // inserted an `i32.trunc_sat_f64_s` to match it, plus a stray stack value).
  // So perform ALL emissions up front, materialize the literal-string
  // instruction arrays here too, and only THEN snapshot every funcIdx.
  if (isNumeric && ctx.funcMap.get("number_toString") === undefined) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  }
  let nestedJoinIdx: number | undefined;
  if (nestedElemKind !== undefined) {
    const nestedVecTypeIdx = ctx.vecTypeMap.get(nestedElemKind)!;
    const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
    if (nestedArrTypeIdx >= 0) {
      nestedJoinIdx = ensureNativeVecJoinHelper(ctx, nestedElemKind, nestedVecTypeIdx, nestedArrTypeIdx);
    }
  }
  const litStr = (value: string): Instr[] => nativeStringLiteralInstrs(ctx, value);
  // Materialize the constant strings now (last possible shift source) so their
  // string-constant globals register before we snapshot any function index.
  const objObjInstrs = litStr("[object Object]");
  const sepInstrs = litStr(",");
  const emptyInstrs = litStr("");

  // Now snapshot every cross-function index — all shift sources are behind us.
  const numToStrIdx = isNumeric ? ctx.funcMap.get("number_toString") : undefined;
  if (isNumeric && numToStrIdx === undefined) return undefined;
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return undefined;

  // param v(0); locals: data(1), len(2), i(3), result(4)
  const V = 0;
  const DATA = 1;
  const LEN = 2;
  const I = 3;
  const RESULT = 4;

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // element i → ref $AnyString
  const elemToStr: Instr[] = [
    { op: "local.get", index: DATA },
    { op: "local.get", index: I },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
  ];
  if (isNumeric && numToStrIdx !== undefined) {
    if (elemType.kind !== "f64") elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: numToStrIdx });
    elemToStr.push({ op: "any.convert_extern" } as Instr);
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr);
  } else if (isNativeStrElem) {
    // native-string element — already a (ref null $AnyString) subtype; non-null.
    elemToStr.push({ op: "ref.as_non_null" } as Instr);
  } else if (nestedJoinIdx !== undefined) {
    // nested array element → recurse into its own join helper.
    elemToStr.push({ op: "call", funcIdx: nestedJoinIdx });
  } else {
    // any other ref / externref element → residual "[object Object]".
    elemToStr.length = 0;
    elemToStr.push(...objObjInstrs);
  }

  const loopBody: Instr[] = [
    { op: "local.get", index: I },
    { op: "local.get", index: LEN },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // result = (i == 0) ? elem : __str_concat(__str_concat(result, ","), elem)
    { op: "local.get", index: I },
    { op: "i32.const", value: 0 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...elemToStr, { op: "local.set", index: RESULT } as Instr],
      else: [
        { op: "local.get", index: RESULT } as Instr,
        ...sepInstrs,
        { op: "call", funcIdx: strConcatIdx } as Instr,
        ...elemToStr,
        { op: "call", funcIdx: strConcatIdx } as Instr,
        { op: "local.set", index: RESULT } as Instr,
      ],
    } as Instr,

    { op: "local.get", index: I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: I },
    { op: "br", depth: 0 },
  ];

  const body: Instr[] = [
    // null receiver → "" (defensive; concat callers never pass null vecs)
    { op: "local.get", index: V },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: strRef },
      then: emptyInstrs,
      else: [
        // len = v.length (field 0); data = v.data (field 1)
        { op: "local.get", index: V },
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: LEN },
        { op: "local.get", index: V },
        { op: "ref.as_non_null" } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.set", index: DATA },
        // result = ""
        ...litStr(""),
        { op: "local.set", index: RESULT },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
        } as Instr,
        { op: "local.get", index: RESULT },
      ],
    } as Instr,
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "ref_null", typeIdx: vecTypeIdx }], [strRef]);
  const joinFuncIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set(cacheKey, joinFuncIdx);
  ctx.funcMap.set(cacheKey, joinFuncIdx);
  pushDefinedFunc(ctx, joinFuncIdx, {
    name: cacheKey,
    typeIdx,
    locals: [
      { name: "data", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "result", type: strRef },
    ],
    body,
    exported: false,
  });
  return joinFuncIdx;
}

/**
 * #2007 — call-site entry point for the standalone `+`/template concat path.
 * When a concat operand is a statically-known WasmGC vec (array) ref, emit the
 * Array.prototype.join lowering **inline into `fctx.body`** and leave a
 * `ref $AnyString` on the stack. Returns true if it handled the operand.
 *
 * The operand value is assumed already on the stack with the given
 * `vecValType` (a `ref`/`ref_null` to a registered vec struct).
 *
 * **Why inline, not a cached helper (#1448).** Emitting into the current
 * function body is the proven-safe pattern (cf. `compileArrayJoinNative`):
 * `number_toString` / `__str_concat` indices are read here and the resulting
 * `call`s live in `fctx.body`, which the late-import `shiftFuncIndices` pass
 * always walks — so a closure-method operand (`[...].map(fn)`, whose late
 * import registration desyncs a *separate cached helper's* baked indices) can
 * no longer produce an invalid module. Nested-array elements (a ref to another
 * registered vec, common in `[[1,2],[3]]` literals which are closure-free)
 * recurse into the cached per-vec join helper, which is consistent there.
 */
export function tryCompileNativeVecConcatOperand(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecValType: ValType,
): boolean {
  if (vecValType.kind !== "ref" && vecValType.kind !== "ref_null") return false;
  const vecTypeIdx = (vecValType as { typeIdx: number }).typeIdx;
  if (vecTypeIdx === undefined) return false;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return false;
  // Confirm this typeIdx is actually a registered vec (not some other struct
  // that happens to have an array in field 1).
  let isVec = false;
  for (const idx of ctx.vecTypeMap.values()) {
    if (idx === vecTypeIdx) {
      isVec = true;
      break;
    }
  }
  if (!isVec) return false;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (anyStrTypeIdx < 0) return false;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined) return false;

  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemType: ValType = arrDef && arrDef.kind === "array" ? (arrDef.element as ValType) : { kind: "f64" };
  const isNumeric =
    elemType.kind === "f64" || elemType.kind === "i32" || elemType.kind === "i8" || elemType.kind === "i16";
  const isNativeStrElem =
    (elemType.kind === "ref" || elemType.kind === "ref_null") &&
    (elemType as { typeIdx: number }).typeIdx === anyStrTypeIdx;
  // nested array element → recurse into the cached join helper for the inner vec.
  let nestedElemKind: string | undefined;
  if ((elemType.kind === "ref" || elemType.kind === "ref_null") && !isNativeStrElem) {
    const elemTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    for (const [k, idx] of ctx.vecTypeMap.entries()) {
      if (idx === elemTypeIdx) {
        nestedElemKind = k;
        break;
      }
    }
  }

  // Only element kinds we can stringify by value qualify for the join fast-path:
  // numeric, native-string, or a nested vec. An `externref`-element vec is what a
  // closure array method (`[...].map(fn)`) produces — its elements are opaque
  // boxed `any`s, and such operands stringified as "[object Object]" on baseline.
  // Routing them here would (a) need a host/ToString bridge the standalone lane
  // lacks and (b) re-introduce the closure index-desync, so fall back to
  // `$__any_to_string` (the existing "[object Object]" behaviour — no regression).
  if (!isNumeric && !isNativeStrElem && nestedElemKind === undefined) return false;

  // (#1448) If a closure-allocating array method (`map`/`filter`/…) was already
  // lowered in this function, the native array-join lowering corrupts the
  // closure's emitted code (a pre-existing hazard `a.join(",")` exhibits too —
  // see the issue analysis). Fall back to `$__any_to_string` ("[object Object]",
  // the baseline behaviour) in that case rather than emit an invalid module —
  // no regression. The headline `"" + [1,2]` / template cases compile in plain
  // functions that never set this flag, so they keep the join fast-path.
  if (fctx.emittedClosureArrayMethod) return false;

  // Ensure dependencies (these may shift indices — fine, fctx.body is walked).
  let numToStrIdx: number | undefined;
  if (isNumeric) {
    if (ctx.funcMap.get("number_toString") === undefined) {
      emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    }
    numToStrIdx = ctx.funcMap.get("number_toString");
    if (numToStrIdx === undefined) return false;
  }
  let nestedJoinIdx: number | undefined;
  if (nestedElemKind !== undefined) {
    const nestedVecTypeIdx = ctx.vecTypeMap.get(nestedElemKind)!;
    const nestedArrTypeIdx = getArrTypeIdxFromVec(ctx, nestedVecTypeIdx);
    if (nestedArrTypeIdx >= 0) {
      nestedJoinIdx = ensureNativeVecJoinHelper(ctx, nestedElemKind, nestedVecTypeIdx, nestedArrTypeIdx);
    }
  }

  // Locals: the vec ref (tee'd from the stack), data array, length, index, result.
  const vecTmp = allocLocal(fctx, `__vcat_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__vcat_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const lenTmp = allocLocal(fctx, `__vcat_len_${fctx.locals.length}`, { kind: "i32" });
  const iTmp = allocLocal(fctx, `__vcat_i_${fctx.locals.length}`, { kind: "i32" });
  const resultTmp = allocLocal(fctx, `__vcat_res_${fctx.locals.length}`, strRef);

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const elemToStr: Instr[] = [
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx } as Instr,
  ];
  if (isNumeric && numToStrIdx !== undefined) {
    if (elemType.kind !== "f64") elemToStr.push({ op: "f64.convert_i32_s" });
    elemToStr.push({ op: "call", funcIdx: numToStrIdx });
    elemToStr.push({ op: "any.convert_extern" } as Instr);
    elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr);
  } else if (isNativeStrElem) {
    elemToStr.push({ op: "ref.as_non_null" } as Instr);
  } else if (nestedJoinIdx !== undefined) {
    elemToStr.push({ op: "call", funcIdx: nestedJoinIdx });
  } else {
    // any other ref / externref element → residual "[object Object]".
    elemToStr.length = 0;
    elemToStr.push(...nativeStringLiteralInstrs(ctx, "[object Object]"));
  }

  // The vec ref is on the stack — tee into vecTmp, guard null → "".
  fctx.body.push({ op: "local.tee", index: vecTmp });
  // (a null vec stringifies as "" here — concat callers never pass null vecs)
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: strRef },
    then: nativeStringLiteralInstrs(ctx, ""),
    else: [
      { op: "local.get", index: vecTmp },
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: lenTmp },
      { op: "local.get", index: vecTmp },
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: dataTmp },
      ...nativeStringLiteralInstrs(ctx, ""),
      { op: "local.set", index: resultTmp },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: iTmp },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: iTmp },
              { op: "local.get", index: lenTmp },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: iTmp },
              { op: "i32.const", value: 0 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...elemToStr, { op: "local.set", index: resultTmp } as Instr],
                else: [
                  { op: "local.get", index: resultTmp } as Instr,
                  ...nativeStringLiteralInstrs(ctx, ","),
                  { op: "call", funcIdx: strConcatIdx } as Instr,
                  ...elemToStr,
                  { op: "call", funcIdx: strConcatIdx } as Instr,
                  { op: "local.set", index: resultTmp } as Instr,
                ],
              } as Instr,
              { op: "local.get", index: iTmp },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: iTmp },
              { op: "br", depth: 0 },
            ],
          } as Instr,
        ],
      } as Instr,
      { op: "local.get", index: resultTmp },
    ],
  } as Instr);
  return true;
}

/**
 * #1470 — Emit `$__str_to_char_vec(s: ref $AnyString) -> ref $vec_nstr`: the
 * pure-Wasm String-iterator materializer. Splits the string into single
 * **code point** strings per §22.1.5.1 (the String Iteration protocol that
 * `[...s]`, `Array.from(s)` and for-of observe): a well-formed surrogate
 * pair yields one 2-code-unit string; everything else (BMP scalars and lone
 * surrogates) yields a 1-code-unit string.
 *
 * The result reuses the `ref_<anyStr>` vec registration that `__str_split`
 * established, so callers get the exact vec shape `string[]` lowers to
 * (`.length`, indexing, spreads compose without conversion). The backing
 * array is sized `len` (the code-unit count — an upper bound on the code
 * point count); the vec's `len` field carries the actual element count, so
 * trailing unused slots are never observed.
 *
 * Returns both the helper funcIdx (current at call time — late-import shifts
 * keep `nativeStrHelpers` patched, #1839) and the nstr vec type index.
 */
export function ensureStrToCharVecHelper(ctx: CodegenContext): { funcIdx: number; vecTypeIdx: number } {
  ensureNativeStringHelpers(ctx);

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;

  // Same registration key/type as `__str_split` so the vec matches string[].
  const nstrElemKey = `ref_${anyStrTypeIdx}`;
  const nstrElemType: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };
  const nstrArrTypeIdx = getOrRegisterArrayType(ctx, nstrElemKey, nstrElemType);
  const nstrVecTypeIdx = getOrRegisterVecType(ctx, nstrElemKey, nstrElemType);

  const existing = ctx.nativeStrHelpers.get("__str_to_char_vec");
  if (existing !== undefined) return { funcIdx: existing, vecTypeIdx: nstrVecTypeIdx };

  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten")!;
  const substringIdx = ctx.nativeStrHelpers.get("__str_substring")!;

  // param: s(0); locals: flat(1), len(2), off(3), data(4), out(5), n(6),
  // i(7), cu(8), take(9)
  const S = 0;
  const FLAT = 1;
  const LEN = 2;
  const OFF = 3;
  const DATA = 4;
  const OUT = 5;
  const N = 6;
  const I = 7;
  const CU = 8;
  const TAKE = 9;

  const body: Instr[] = [
    // flat = __str_flatten(s); cache len/off/data
    { op: "local.get", index: S },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: FLAT },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: LEN },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: OFF },
    { op: "local.get", index: FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: DATA },

    // out = new (ref null $AnyString)[len] — len is an upper bound on the
    // code-point count; the vec's len field below carries the real count.
    { op: "local.get", index: LEN },
    { op: "array.new_default", typeIdx: nstrArrTypeIdx },
    { op: "local.set", index: OUT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: N },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: I },

    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I },
            { op: "local.get", index: LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // cu = data[off + i]; take = 1
            { op: "local.get", index: DATA },
            { op: "local.get", index: OFF },
            { op: "local.get", index: I },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "local.set", index: CU },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: TAKE },

            // High surrogate with a following low surrogate → take = 2
            // (cu & 0xFC00) == 0xD800 && i + 1 < len
            { op: "local.get", index: CU },
            { op: "i32.const", value: 0xfc00 },
            { op: "i32.and" },
            { op: "i32.const", value: 0xd800 },
            { op: "i32.eq" },
            { op: "local.get", index: I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: LEN },
            { op: "i32.lt_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // (data[off + i + 1] & 0xFC00) == 0xDC00 → take = 2
                { op: "local.get", index: DATA },
                { op: "local.get", index: OFF },
                { op: "local.get", index: I },
                { op: "i32.add" },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "array.get_u", typeIdx: strDataTypeIdx },
                { op: "i32.const", value: 0xfc00 },
                { op: "i32.and" },
                { op: "i32.const", value: 0xdc00 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 2 },
                    { op: "local.set", index: TAKE },
                  ],
                } as Instr,
              ],
            } as Instr,

            // out[n] = __str_substring(flat, i, i + take); n++; i += take
            { op: "local.get", index: OUT },
            { op: "local.get", index: N },
            { op: "local.get", index: FLAT },
            { op: "ref.as_non_null" } as Instr,
            { op: "local.get", index: I },
            { op: "local.get", index: I },
            { op: "local.get", index: TAKE },
            { op: "i32.add" },
            { op: "call", funcIdx: substringIdx },
            { op: "array.set", typeIdx: nstrArrTypeIdx },
            { op: "local.get", index: N },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: N },
            { op: "local.get", index: I },
            { op: "local.get", index: TAKE },
            { op: "i32.add" },
            { op: "local.set", index: I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return { len: n, data: out }
    { op: "local.get", index: N },
    { op: "local.get", index: OUT },
    { op: "ref.as_non_null" } as Instr,
    { op: "struct.new", typeIdx: nstrVecTypeIdx },
  ];

  const typeIdx = addFuncType(ctx, [strRef], [{ kind: "ref", typeIdx: nstrVecTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeStrHelpers.set("__str_to_char_vec", funcIdx);
  ctx.funcMap.set("__str_to_char_vec", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__str_to_char_vec",
    typeIdx,
    locals: [
      { name: "flat", type: { kind: "ref_null", typeIdx: strTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "off", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref_null", typeIdx: strDataTypeIdx } },
      { name: "out", type: { kind: "ref_null", typeIdx: nstrArrTypeIdx } },
      { name: "n", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "cu", type: { kind: "i32" } },
      { name: "take", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return { funcIdx, vecTypeIdx: nstrVecTypeIdx };
}

export function ensureNativeStringExternBridge(ctx: CodegenContext): void {
  ensureNativeStringHelpers(ctx);
  if (ctx.nativeStrExternBridgeEmitted) return;
  ctx.nativeStrExternBridgeEmitted = true;

  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const strRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  if (ctx.mod.memories.length === 0) {
    ctx.mod.memories.push({ min: 1 });
    ctx.mod.exports.push({
      name: "__str_mem",
      desc: { kind: "memory", index: 0 },
    });
  }

  const importsBeforeBridge = ctx.numImportFuncs;
  const fromMemIdx = ensureLateImport(
    ctx,
    "__str_from_mem",
    [{ kind: "i32" }, { kind: "i32" }],
    [{ kind: "externref" }],
  )!;
  const toMemIdx = ensureLateImport(ctx, "__str_to_mem", [{ kind: "externref" }, { kind: "i32" }], [])!;
  const externLenIdx = ensureLateImport(ctx, "__str_extern_len", [{ kind: "externref" }], [{ kind: "i32" }])!;
  // (#2934 slice 3) Close the deferred late-import batch BEFORE baking
  // `fromMemIdx`/`toMemIdx`/`externLenIdx` into the helper bodies below. The
  // deferred flush repairs STALE refs by bumping every `funcIdx >=
  // importsBefore` — it cannot distinguish a freshly-baked, already-final
  // import index (these three) from a stale defined-function ref, so leaving
  // the batch open until some later flush bumps the baked import refs onto
  // whatever defined function lands at that offset (`__str_to_extern`'s
  // `call __str_from_mem` resolved to `__str_copy_tree`, arity 3 — "not
  // enough arguments on the stack" for every object-with-own-toString string
  // coercion, S15.5.4.6_A4_T2). Flushing here settles all pre-batch stale
  // refs and makes the subsequent flush a no-op for this batch. Gated on
  // actually having REGISTERED imports (a funcMap-hit lookup is pure and must
  // not force-flush an outer batch), so already-registered paths are
  // byte-identical.
  if (ctx.numImportFuncs > importsBeforeBridge) {
    flushLateImportShifts(ctx, null);
  }

  {
    const typeIdx = addFuncType(ctx, [strRef], [{ kind: "externref" }]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_to_extern", funcIdx);
    ctx.funcMap.set("__str_to_extern", funcIdx);

    // The param is typed as the AnyString supertype, but the body reads
    // NativeString (FlatString) fields. We must flatten first: a ConsString /
    // Utf8String / template-literal result is NOT a NativeString, so reading
    // its fields via `struct.get NativeString` on the raw param produces an
    // invalid module (struct.get expected NativeString, found AnyString). For
    // an already-flat input __str_flatten is a cheap identity. (#1618 family —
    // surfaced by `process.stdout.write`/`console.log` of a template literal
    // under --target wasi, which emits this bridge.)
    //
    // __str_flatten via funcMap (NOT nativeStrHelpers): this body emits a `call
    // __str_flatten` after the three fd-bridge late imports above have been
    // queued, so the nativeStrHelpers index is stale-low (it's never rewritten by
    // the deferred shift). funcMap IS shift-maintained — __str_flatten is now
    // registered there too — so this resolves and shifts correctly. (#1618)
    const flattenIdx = ctx.funcMap.get("__str_flatten")!;
    const FLAT_LOCAL = 5;

    const body: Instr[] = [
      // flat = __str_flatten(s)  (locals[5])
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: FLAT_LOCAL },

      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: FLAT_LOCAL },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 2 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.store16", align: 1, offset: 0 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: fromMemIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_to_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "sOff", type: { kind: "i32" } },
        { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      ],
      body,
      exported: false,
    });
  }

  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [strRef]);
    const funcIdx = mintDefinedFunc(ctx);
    ctx.nativeStrHelpers.set("__str_from_extern", funcIdx);
    ctx.funcMap.set("__str_from_extern", funcIdx);

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: externLenIdx },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: toMemIdx },
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.shl" },
              { op: "i32.load16_u", align: 1, offset: 0 },
              { op: "array.set", typeIdx: strDataTypeIdx },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__str_from_extern",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "arr", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: false,
    });
  }
}

/**
 * Emit `__test_str_from_externref` and `__test_str_to_externref` exported
 * helpers (#1187). These are the test-runtime bridge that lets vitest tests
 * pass JS strings into Wasm exports whose native-string params have type
 * `(ref $AnyString)`, and read native-string results back as JS strings.
 *
 * Gated on `ctx.testRuntime && ctx.nativeStrings`. Production builds (with
 * `testRuntime` unset) never reach this code, so the helpers are absent
 * from the module entirely — zero runtime overhead.
 *
 * Preconditions (set up by the pre-pass in `generateModule`):
 *   - `addStringImports` has been called → `length`, `charCodeAt`, `concat`,
 *     `substring` are registered as `wasm:js-string` imports.
 *   - `String_fromCharCode` is registered as an `env` host import.
 *   - `ensureNativeStringHelpers` has been called → `__str_flatten` exists.
 */
export function emitTestRuntimeStringHelpers(ctx: CodegenContext): void {
  if (!ctx.testRuntime || !ctx.nativeStrings) return;
  if (ctx.testRuntimeStringHelpersEmitted) return;
  ctx.testRuntimeStringHelpersEmitted = true;

  // Make sure $__str_flatten exists. Called HERE rather than in the pre-pass
  // because emitting native-string helpers early causes a downstream
  // miscompile (the body references function indices that drift before
  // dead-elim runs). At this call site (after user code, before dead-elim)
  // index drift is impossible.
  ensureNativeStringHelpers(ctx);

  const mod = ctx.mod;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString (FlatString)
  const anyStrTypeIdx = ctx.anyStrTypeIdx; // $AnyString

  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const flatStrRef: ValType = { kind: "ref", typeIdx: strTypeIdx };
  const anyStrRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const externref: ValType = { kind: "externref" };

  // Resolve helper / import indices set up by the pre-pass.
  const lengthIdx = ctx.jsStringImports.get("length");
  const charCodeAtIdx = ctx.jsStringImports.get("charCodeAt");
  const concatIdx = ctx.jsStringImports.get("concat");
  const substringIdx = ctx.jsStringImports.get("substring");
  const fromCharCodeIdx = ctx.funcMap.get("String_fromCharCode");
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (
    lengthIdx === undefined ||
    charCodeAtIdx === undefined ||
    concatIdx === undefined ||
    substringIdx === undefined ||
    fromCharCodeIdx === undefined ||
    flattenIdx === undefined
  ) {
    // Pre-pass should have ensured these. Bail silently rather than emit a
    // module that won't validate — the test will fail noisily on missing
    // exports.
    return;
  }

  // ── __test_str_from_externref(externref s) -> (ref $AnyString) ──
  // Walks `s` char-by-char with `wasm:js-string.length` / `charCodeAt` and
  // builds a fresh `$NativeString` (subtype of `$AnyString`).
  //
  // params: s(0)
  // locals: len(1), data(2), i(3)
  {
    const typeIdx = addFuncType(ctx, [externref], [anyStrRef]);
    const funcIdx = mintDefinedFunc(ctx);

    const body: Instr[] = [
      // len = wasm:js-string.length(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lengthIdx },
      { op: "local.set", index: 1 },

      // data = array.new_default $__str_data(len)
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: strDataTypeIdx },
      { op: "local.set", index: 2 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },

      // Outer block (target for the loop's break)
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break out of the surrounding block (depth 1)
              { op: "local.get", index: 3 },
              { op: "local.get", index: 1 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },

              // data[i] = wasm:js-string.charCodeAt(s, i)
              { op: "local.get", index: 2 },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 3 },
              { op: "call", funcIdx: charCodeAtIdx },
              { op: "array.set", typeIdx: strDataTypeIdx },

              // i = i + 1
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },

              // continue loop
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // struct.new $NativeString(len, 0, data) — subtype-flows into ref $AnyString
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 2 },
      { op: "struct.new", typeIdx: strTypeIdx },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__test_str_from_externref",
      typeIdx,
      locals: [
        { name: "len", type: { kind: "i32" } },
        { name: "data", type: strDataRef },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({
      name: "__test_str_from_externref",
      desc: { kind: "func", index: funcIdx },
    });
  }

  // ── __test_str_to_externref((ref $AnyString) s) -> externref ──
  // Flattens to a `$NativeString`, then walks the data array and accumulates
  // a JS string via `wasm:js-string.concat` + `String_fromCharCode`. O(n²) by
  // string concatenation, but fine for the small strings used in tests.
  //
  // The result is seeded with an empty JS string via
  // `wasm:js-string.substring(<any>, 0, 0)` so the first concat has a string
  // operand even when len == 0.
  //
  // params: s(0)
  // locals: flat(1), len(2), off(3), result(4), i(5)
  {
    const typeIdx = addFuncType(ctx, [anyStrRef], [externref]);
    const funcIdx = mintDefinedFunc(ctx);

    const body: Instr[] = [
      // flat = __str_flatten(s)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: 1 },

      // len = flat.len
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 2 },

      // off = flat.off
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 3 },

      // result = substring(String_fromCharCode(0.0), 0, 0) — gives "" as externref
      { op: "f64.const", value: 0 },
      { op: "call", funcIdx: fromCharCodeIdx },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "call", funcIdx: substringIdx },
      { op: "local.set", index: 4 },

      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },

      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len, break (depth 1 = outer block)
              { op: "local.get", index: 5 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },

              // result = concat(result, String_fromCharCode(data[off + i]))
              { op: "local.get", index: 4 }, // result

              { op: "local.get", index: 1 }, // flat
              { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
              { op: "local.get", index: 3 }, // off
              { op: "local.get", index: 5 }, // i
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: fromCharCodeIdx },

              { op: "call", funcIdx: concatIdx },
              { op: "local.set", index: 4 },

              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },

              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // return result
      { op: "local.get", index: 4 },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "__test_str_to_externref",
      typeIdx,
      locals: [
        { name: "flat", type: flatStrRef },
        { name: "len", type: { kind: "i32" } },
        { name: "off", type: { kind: "i32" } },
        { name: "result", type: externref },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({
      name: "__test_str_to_externref",
      desc: { kind: "func", index: funcIdx },
    });
  }
}

/**
 * (#2962) Harness-readable exception rendering for standalone/WASI binaries —
 * the export pair that de-opaques the "uncaught Wasm-GC exception
 * (non-stringifiable payload)" bucket (~5.9k standalone baseline entries).
 *
 * A natively-thrown payload (an `$Error_struct`, a native string, a boxed
 * number, …) is a WasmGC value the HOST cannot stringify — `String(payload)`
 * throws `Cannot convert object to primitive value`, so the test262 harness
 * (`extractWasmExceptionMessage`) could only record the #2870 opaque label.
 * These exports let the harness render the payload with ZERO host imports,
 * following the same harness-support-export pattern as `__sget_*` / `__vec_*`:
 *
 *   - `__exn_render_prepare(payload: externref) -> i32` — runs the payload
 *     through the same `__any_to_string` chain the in-module `String(x)`
 *     coercion uses (so an `$Error_struct` renders `"TypeError: boom"` via
 *     `__error_to_string`, §20.5.3.4), flattens the result, stashes it in a
 *     module global, and returns its code-unit length (`-1` for a null
 *     payload — the harness keeps its legacy label).
 *   - `__exn_render_char(i: i32) -> i32` — code-unit readback from the
 *     prepared buffer (`0` when unprepared / out of range).
 *
 * Emitted at finalize (see the `emitExceptionRenderExports` call in
 * codegen/index.ts) and gated on `(standalone || wasi) && nativeStrings &&
 * exnTagIdx >= 0` — a module that cannot throw through the `$exc` tag gets
 * neither export nor the string-runtime pull-in, keeping non-throwing modules
 * byte-identical. JS-host binaries are untouched (payloads there are real JS
 * values the host formats directly).
 *
 * Index-shift safety: both dependencies (`__any_to_string`, `__str_flatten`)
 * are ensured/read from the authoritative `funcMap`/`nativeStrHelpers` BEFORE
 * either body is built, and both functions are pushed with no intervening
 * helper emission or import registration.
 */
export function emitExceptionRenderExports(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  if (!ctx.nativeStrings) return;
  if (ctx.exnTagIdx < 0) return;
  if (ctx.funcMap.has("__exn_render_prepare")) return;

  // (#2969) Force `number_toString` before `__any_to_string` bakes so its number
  // arm renders a raw thrown number ("42") instead of degrading to
  // "[object Object]" — a throwing module that never itself stringifies a number
  // otherwise leaves the arm unresolved. `emitExceptionRenderExports` is the
  // first (and here, only) consumer of `__any_to_string` for such a module, so
  // ensuring the format helper ahead of the `ensureAnyToStringHelper` call below
  // makes the number arm real. Size cost falls only on throwing standalone/WASI
  // modules. Must precede the ensure call (which snapshots the number_toString
  // funcIdx into the baked arm).
  if (ctx.funcMap.get("number_toString") === undefined) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  }

  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
  const flatTypeIdx = ctx.nativeStrTypeIdx;
  const dataTypeIdx = ctx.nativeStrDataTypeIdx;
  if (anyToStrIdx === undefined || flattenIdx === undefined || flatTypeIdx < 0 || dataTypeIdx < 0) return;

  const mod = ctx.mod;

  // (mut ref null $NativeString) — the prepared render buffer.
  const bufGlobalIdx = ctx.numImportGlobals + mod.globals.length;
  mod.globals.push({
    name: "__exn_render_buf",
    type: { kind: "ref_null", typeIdx: flatTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: flatTypeIdx } as Instr],
  });

  // __exn_render_prepare(payload: externref) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$exn_render_prepare_type");
    const funcIdx = mintDefinedFunc(ctx);
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" } as Instr],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "call", funcIdx: anyToStrIdx },
      { op: "call", funcIdx: flattenIdx },
      { op: "global.set", index: bufGlobalIdx } as Instr,
      { op: "global.get", index: bufGlobalIdx } as Instr,
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
    ];
    ctx.funcMap.set("__exn_render_prepare", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__exn_render_prepare",
      typeIdx,
      locals: [],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({ name: "__exn_render_prepare", desc: { kind: "func", index: funcIdx } });
  }

  // __exn_render_char(i: i32) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }], "$exn_render_char_type");
    const funcIdx = mintDefinedFunc(ctx);
    const L_I = 0;
    const L_BUF = 1;
    const body: Instr[] = [
      { op: "global.get", index: bufGlobalIdx } as Instr,
      { op: "local.tee", index: L_BUF },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" } as Instr],
      },
      // i < 0 || i >= len → 0
      { op: "local.get", index: L_I },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      { op: "local.get", index: L_I },
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 0 }, // len
      { op: "i32.ge_s" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" } as Instr],
      },
      // data[off + i]
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 2 }, // data
      { op: "local.get", index: L_BUF },
      { op: "struct.get", typeIdx: flatTypeIdx, fieldIdx: 1 }, // off
      { op: "local.get", index: L_I },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: dataTypeIdx },
    ];
    ctx.funcMap.set("__exn_render_char", funcIdx);
    pushDefinedFunc(ctx, funcIdx, {
      name: "__exn_render_char",
      typeIdx,
      locals: [{ name: "buf", type: { kind: "ref_null", typeIdx: flatTypeIdx } }],
      body,
      exported: true,
    } as WasmFunction);
    mod.exports.push({ name: "__exn_render_char", desc: { kind: "func", index: funcIdx } });
  }
}
