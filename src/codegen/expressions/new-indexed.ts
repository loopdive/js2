import type { Instr, ValType } from "../../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Indexed built-in constructor dispatch for `new C(...)` — extracted from
 * `compileNewExpression` (new-super.ts) as WAVE-C decomposition slice 2 (#3281).
 *
 * Covers the className-keyed indexed builtins: ArrayBuffer (incl. resizable),
 * DataView, and Array. Each arm either fully handles the ctor (emitting into
 * `fctx.body` and returning a `ValType | null`) or does nothing and falls
 * through; a single `NEW_INDEXED_FALLTHROUGH` sentinel signals "not one of these
 * indexed builtins" so the caller resumes to its final unsupported-ctor
 * `reportError`. The lifted arms are byte-identical to the inline originals.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { allocLocal } from "../context/locals.js";
import { getOrRegisterDvWindowType, usesNativeDataViewProvider } from "../dataview-native.js";
import { getArrTypeIdxFromVec, getOrRegisterResizableAbType, getOrRegisterVecType, resolveWasmType } from "../index.js";
import { getOrRegisterHoleyArrayType } from "../registry/types.js";
import { ensureHoleyArrayNew } from "../vec-elem-set.js";
import { sparseArrayNewSplitInstrs } from "../vec-sparse-index.js";
import { compileExpression } from "../shared.js";
import { buildThrowJsErrorInstrs } from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { inferArrayElementType } from "./new-super.js";

/** Sentinel: the `new` target is not one of the indexed built-in constructors. */
export const NEW_INDEXED_FALLTHROUGH = Symbol("new-indexed-fallthrough");

export function tryCompileIndexedBuiltinNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  className: string | undefined,
): ValType | null | typeof NEW_INDEXED_FALLTHROUGH {
  // new ArrayBuffer(byteLength) → vec struct with packed i8 elements (1 byte per
  // element, (#2835) — 4× smaller than the former i32-per-byte backing)
  if (className === "ArrayBuffer") {
    const elemType: ValType = { kind: "i8" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const args = expr.arguments ?? [];

    // (#3054 C) Resizable ArrayBuffer: `new ArrayBuffer(n, {maxByteLength: m})`.
    // Per §25.1.3.1 / GetArrayBufferMaxByteLengthOption: a non-object options or
    // an options object without a `maxByteLength` property ⇒ NON-resizable (fall
    // through to the plain path below). We handle the object-literal options form
    // (the entire test262 resizable corpus passes an object literal) at compile
    // time — resolving `maxByteLength` off an arbitrary dynamic object would need
    // the object-runtime and is deferred (a dynamic options object stays
    // non-resizable rather than mis-constructing). BOTH lanes (#3058): the plain
    // `new ArrayBuffer(n)` path below already lowers to the native i32_byte vec
    // in the JS-host lane too (the #3097 construct bridge marshals it to a
    // canonical host ArrayBuffer on first crossing), so the `$__resizable_ab`
    // subtype is equally lane-agnostic. In host mode the runtime consumes the
    // subtype through the `__rab_resize`/`__ab_max_len` exports (resize +
    // maxByteLength/resizable arms in `__extern_method_call`/`__extern_get`)
    // and `_compiledAbToHostBuffer` marshals it to a HOST resizable buffer, so
    // host TypedArray views length-track a later `rab.resize()` natively.
    let maxByteLenInit: ts.Expression | undefined;
    if (args.length >= 2 && ts.isObjectLiteralExpression(args[1]!)) {
      for (const prop of args[1]!.properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
          prop.name.text === "maxByteLength"
        ) {
          maxByteLenInit = prop.initializer;
        }
      }
    }

    if (maxByteLenInit !== undefined) {
      const rabTypeIdx = getOrRegisterResizableAbType(ctx);
      // byteLength (arg 0) → i32, with the same non-negative-integer RangeError
      // guard the plain path uses.
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__rab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: lenF64 });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
          else: [],
        });
      }
      const lenI32 = allocLocal(fctx, `__rab_len_i32_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: lenF64 });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      fctx.body.push({ op: "local.set", index: lenI32 });

      // maxByteLength (options) → i32 via ToIndex: NaN→0, truncate toward zero,
      // and `< 0` → RangeError (the upper 2^53-1 bound is subsumed by the i32 cap).
      compileExpression(ctx, fctx, maxByteLenInit, { kind: "f64" });
      const maxF64 = allocLocal(fctx, `__rab_max_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.set", index: maxF64 });
      // NaN → 0
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "f64.const", value: 0 },
          { op: "local.set", index: maxF64 },
        ],
        else: [],
      });
      // truncate toward zero
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "f64.trunc" });
      fctx.body.push({ op: "local.set", index: maxF64 });
      // maxByteLength < 0 → RangeError
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer max byte length";
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
          else: [],
        });
      }
      const maxI32 = allocLocal(fctx, `__rab_max_i32_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "local.get", index: maxF64 });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      fctx.body.push({ op: "local.set", index: maxI32 });

      // AllocateArrayBuffer: byteLength > maxByteLength → RangeError.
      fctx.body.push({ op: "local.get", index: lenI32 });
      fctx.body.push({ op: "local.get", index: maxI32 });
      fctx.body.push({ op: "i32.gt_s" });
      {
        const rangeErrMsg = "RangeError: ArrayBuffer byteLength exceeds maxByteLength";
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
          else: [],
        });
      }

      // struct.new $__resizable_ab { length = byteLength, data = new i8[byteLength],
      // maxByteLength }. The backing array is sized to the CURRENT byteLength (GC
      // arrays are fixed-length; `.resize()` reallocs + swaps `data`, per A.2).
      fctx.body.push({ op: "local.get", index: lenI32 });
      fctx.body.push({ op: "local.get", index: lenI32 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "local.get", index: maxI32 });
      fctx.body.push({ op: "struct.new", typeIdx: rabTypeIdx });
      // Return the PARENT vec type: a `$__resizable_ab` IS-A `$__vec_i32_byte`, so
      // every downstream buffer consumer (byteLength, DataView, TA views, slice)
      // treats it identically — only `.resize()`/`.maxByteLength`/`.resizable`
      // `ref.test` the subtype. The runtime value keeps its resizable_ab identity.
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (args.length >= 1) {
      // new ArrayBuffer(byteLength) → create vec with byteLength elements, all 0
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });

      // RangeError validation: byteLength must be a non-negative integer < 2^31
      // (We use i32 internally so cap at i32 max)
      const lenF64Local = allocLocal(fctx, `__ab_len_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "local.tee", index: lenF64Local });
      // Check len != floor(len) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check len < 0
      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      {
        const rangeErrMsg = "RangeError: Invalid array buffer length";
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: lenF64Local });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }

    const sizeLocal = allocLocal(fctx, `__ab_size_${fctx.locals.length}`, {
      kind: "i32",
    });
    fctx.body.push({ op: "local.tee", index: sizeLocal });
    fctx.body.push({ op: "local.get", index: sizeLocal });
    fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // new DataView(buffer) / new DataView(buffer, byteOffset) / new DataView(buffer, byteOffset, byteLength)
  if (className === "DataView") {
    const nativeDataView = usesNativeDataViewProvider(ctx);
    const elemType: ValType = { kind: "i8" }; // (#2835) packed byte buffer
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const args = expr.arguments ?? [];

    if (args.length >= 1) {
      // Compile buffer arg first
      const resultType = compileExpression(ctx, fctx, args[0]!);
      const isStructBuf = resultType !== null && (resultType.kind === "ref" || resultType.kind === "ref_null");

      // Always stash the buffer in a local so we can validate, register the
      // view window via __dv_register_view (#1064), and restore it on stack.
      const bufLocalType: ValType = isStructBuf ? resultType! : { kind: "externref" };
      const bufLocal = allocLocal(fctx, `__dv_buf_${fctx.locals.length}`, bufLocalType);
      fctx.body.push({ op: "local.set", index: bufLocal });

      // Offset and length f64 locals (used for validation AND view-metadata
      // registration). Defaults: offset=0, length=bufferByteLength-offset.
      const offsetF64 = allocLocal(fctx, `__dv_offset_f64_${fctx.locals.length}`, { kind: "f64" });
      const lenF64 = allocLocal(fctx, `__dv_len_f64_${fctx.locals.length}`, {
        kind: "f64",
      });

      if (args.length >= 2) {
        // #1515 ToIndex(byteOffset) per ECMA §7.1.22:
        //   1. If undefined → 0
        //   2. integer = ToIntegerOrInfinity(ToNumber(value))   (NaN → 0; truncate toward 0)
        //   3. If integer < 0 or integer > 2^53-1 → RangeError
        // Previous code threw for any non-integer (1.5 → RangeError) and treated NaN
        // as invalid; spec wants 1.5 → 1 and NaN → 0. Both incorrect behaviors
        // failed `toindex-byteoffset.js` test262 cases.
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: offsetF64 });
        // If NaN, replace with 0 (NaN != NaN is the only condition where v != v).
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "f64.const", value: 0 },
            { op: "local.set", index: offsetF64 },
          ],
          else: [],
        });
        // Truncate toward zero (ToIntegerOrInfinity for finite non-NaN).
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: offsetF64 });

        // Check: offset < 0 OR offset > 2^53-1 (ToIndex bounds → RangeError)
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });

        // If buffer is a vec struct, also check offset > bufferByteLength
        if (isStructBuf) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 0,
          }); // buffer length
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Start offset is outside the bounds of the buffer";
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
            else: [],
          });
        }
      } else {
        // No explicit byteOffset — default to 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "local.set", index: offsetF64 });
      }

      if (args.length >= 3) {
        // #1515 ToIndex(byteLength) — same ToIndex semantics as byteOffset above.
        compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        fctx.body.push({ op: "local.set", index: lenF64 });
        // NaN → 0
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.ne" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "f64.const", value: 0 },
            { op: "local.set", index: lenF64 },
          ],
          else: [],
        });
        // Truncate toward zero
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.trunc" });
        fctx.body.push({ op: "local.set", index: lenF64 });

        // Check: len < 0 OR len > 2^53-1 → RangeError
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({ op: "local.get", index: lenF64 });
        fctx.body.push({ op: "f64.const", value: 9007199254740991 }); // 2^53 - 1
        fctx.body.push({ op: "f64.gt" });
        fctx.body.push({ op: "i32.or" });

        // Check: offset + length > bufferByteLength
        if (isStructBuf) {
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "f64.add" });
          fctx.body.push({ op: "local.get", index: bufLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: vecTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "f64.convert_i32_s" });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
        }

        {
          const rangeErrMsg = "RangeError: Invalid DataView length";
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
            else: [],
          });
        }
      } else if (isStructBuf) {
        // Default byteLength = bufferByteLength - offset
        fctx.body.push({ op: "local.get", index: bufLocal });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "f64.convert_i32_s" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "local.set", index: lenF64 });
      } else if (nativeDataView) {
        // (#2159/#38) Standalone externref buffer (the common case — ArrayBuffer
        // locals are typed externref): recover the i32_byte vec struct at runtime
        // (any.convert_extern + ref.cast) and read its byte length, so the default
        // windowed byteLength = bufferByteLength - offset is correct without a
        // host handler.
        fctx.body.push({ op: "local.get", index: bufLocal });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx });
        fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
        fctx.body.push({ op: "f64.convert_i32_s" });
        fctx.body.push({ op: "local.get", index: offsetF64 });
        fctx.body.push({ op: "f64.sub" });
        fctx.body.push({ op: "local.set", index: lenF64 });
      } else {
        // externref buffer (JS-host) — we can't read length at compile time. Use
        // a NaN sentinel; the runtime __dv_register_view handler treats NaN as
        // "compute from __dv_byte_len(buf) - offset" at dispatch time.
        fctx.body.push({ op: "f64.const", value: NaN });
        fctx.body.push({ op: "local.set", index: lenF64 });
      }

      // #1064: register view metadata with host so the runtime bridge can
      // reconstruct a correctly-windowed native DataView on method dispatch.
      // Always register, even for externref buffers — ArrayBuffer variables
      // in user code are lowered to externref (see checker/type-mapper.ts),
      // but the actual wasmGC struct is what the bridge dispatches on.
      //
      // (#2159) Standalone / WASI mode has no JS host: the accessor
      // (`get/set{Int,Uint,Float}N`) is lowered to pure-Wasm byte reads/writes
      // directly on the i32_byte backing struct (see dataview-native.ts), so
      // there is no runtime bridge to register with. Emitting the host call
      // unconditionally leaked an unsatisfiable `env::__dv_register_view`
      // import, making EVERY `new DataView(...)` a hard instantiate failure
      // standalone. Gate the registration on JS-host mode; standalone evaluates
      // the offset/length args above for their side effects + RangeError checks
      // and then operates on the struct directly. (The view-window base offset
      // for `new DataView(buf, n>0)` is a separate representation slice, shared
      // with TypedArray-on-buffer windowing; offset-0 views — the dominant
      // case — are fully native here.)
      if (!nativeDataView) {
        const regIdx = ensureLateImport(
          ctx,
          "__dv_register_view",
          [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }],
          [],
        );
        flushLateImportShifts(ctx, fctx);
        if (regIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: bufLocal });
          if (isStructBuf) {
            fctx.body.push({ op: "extern.convert_any" });
          }
          fctx.body.push({ op: "local.get", index: offsetF64 });
          fctx.body.push({ op: "local.get", index: lenF64 });
          fctx.body.push({ op: "call", funcIdx: regIdx });
        }
      }

      // (#2159/#38, #3173) Standalone DataView: wrap the shared backing buffer
      // in a `$__dv_window {buf, byteOffset, byteLength}` so the native
      // accessors add the base offset and `dv.byteOffset` / `dv.byteLength`
      // reflect the ctor args. (#3173) The wrap is now UNCONDITIONAL (was:
      // windowed views only) — `$__dv_window` IS the standalone [[DataView]]
      // internal-slot brand, so an offset-0 default-length view must also be
      // distinguishable from its bare ArrayBuffer vec (a bare vec receiver on
      // an accessor now throws the §24.3.1.1/2 brand TypeError). The wrap is
      // RUNTIME-GATED on the buffer actually being an `i32_byte` vec (a
      // `$__resizable_ab` passes too — it subtypes the vec): a non-vec buffer
      // (host object, exotic value) passes through unwrapped, exactly the
      // pre-#3173 behaviour, so no new trap is introduced.
      const windowed = nativeDataView;
      if (windowed) {
        const dvWinTypeIdx = getOrRegisterDvWindowType(ctx);
        const wrapWindow: Instr[] = [
          // buf (ref null vec) — the cast is safe under the ref.test gate below.
          { op: "local.get", index: bufLocal },
          ...(!isStructBuf ? ([{ op: "any.convert_extern" }] satisfies Instr[]) : []),
          { op: "ref.cast", typeIdx: vecTypeIdx },
          // byteOffset (i32) — offsetF64 is already ToIndex-normalized & validated.
          { op: "local.get", index: offsetF64 },
          { op: "i32.trunc_sat_f64_s" },
          // byteLength (i32) — lenF64 holds the windowed length (explicit arg or
          // bufferByteLength - offset default computed above).
          { op: "local.get", index: lenF64 },
          { op: "i32.trunc_sat_f64_s" },
          { op: "ref.null.extern" }, // #3371 constructProto (intrinsic default)
          { op: "struct.new", typeIdx: dvWinTypeIdx },
          // DataView locals are externref (EXTERNREF_GLOBAL_NAMES) — hand back an
          // externref so the wrapper survives the variable store and is recovered
          // (any.convert_extern + ref.test $__dv_window) on accessor dispatch.
          { op: "extern.convert_any" },
        ];
        const passThrough: Instr[] = [
          { op: "local.get", index: bufLocal },
          ...(isStructBuf ? ([{ op: "extern.convert_any" }] satisfies Instr[]) : []),
        ];
        // Gate: is the buffer (a subtype of) the i32_byte vec?
        fctx.body.push({ op: "local.get", index: bufLocal });
        if (!isStructBuf) fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: wrapWindow,
          else: passThrough,
        });
        return { kind: "externref" };
      }

      // Restore buffer on stack
      fctx.body.push({ op: "local.get", index: bufLocal });
      if (isStructBuf) return resultType!;
      if (resultType) return resultType;
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    } else {
      // No buffer — create empty ArrayBuffer-like vec
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }
  }

  // new Array() / new Array(n) / new Array(a, b, c)
  if (className === "Array") {
    const holeyCarrier = ctx.holeyArrayConstructorNodes.has(expr);
    // Use contextual type (from variable declaration) if available, else expression type.
    // `new Array()` without type args gives Array<any>, but `var a: number[] = new Array()`
    // needs to produce Array<number> to match the variable's vec type.
    const ctxType = ctx.checker.getContextualType(expr);
    const exprType = ctxType ?? ctx.checker.getTypeAtLocation(expr);
    // If element type is `any` (no contextual type, no explicit type arg),
    // infer from how the array variable is used: scan element assignments
    // like arr[i] = value and arr.push(value) to determine the element type.
    let inferredElemWasm: ValType | null = null;
    const rawTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
    if (!holeyCarrier && rawTypeArgs?.[0] && rawTypeArgs[0].flags & ts.TypeFlags.Any) {
      const inferredElemTsType = inferArrayElementType(ctx, expr);
      if (inferredElemTsType) {
        inferredElemWasm = resolveWasmType(ctx, inferredElemTsType);
      }
    }

    let vecTypeIdx: number;
    let arrTypeIdx: number;
    let elemWasm: ValType;
    if (inferredElemWasm) {
      // Use inferred element type to register/find the right vec type
      const elemKey =
        inferredElemWasm.kind === "ref" || inferredElemWasm.kind === "ref_null"
          ? `ref_${(inferredElemWasm as { typeIdx: number }).typeIdx}`
          : inferredElemWasm.kind;
      vecTypeIdx = getOrRegisterVecType(ctx, elemKey, inferredElemWasm);
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = inferredElemWasm;
    } else {
      const resolved = resolveWasmType(ctx, exprType);
      vecTypeIdx = (resolved as { typeIdx: number }).typeIdx;
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      const typeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
      const elemTsType = typeArgs?.[0];
      elemWasm = elemTsType ? resolveWasmType(ctx, elemTsType) : { kind: "f64" };
    }

    // (#2809 Site B) `new Array(undefined, …)` / `new Array<void>(…)`: keep the
    // construction's element/vec representation in lockstep with the
    // `Array<undefined>`/`Array<void>` → externref rule in `resolveWasmType`'s
    // Array branch (#2806 site #3). The vec type above is taken from
    // `resolveWasmType(exprType)` (an externref vec via #3), but `elemWasm` is
    // resolved from the *scalar* undefined element → i32/f64, so `array.new_fixed`
    // pushes a numeric value into an externref array and validation fails
    // (`array.new_fixed[0] expected type externref, f64`) while consumers
    // mis-read `.length`. Force the element (and vec/arr) to externref so the
    // pushed boxed-undefined values, the array.new_* element type, and the vec
    // struct all agree. Pure Undefined/Void only — `number[]` (f64) / `boolean[]`
    // (i32) carry Number/Boolean and `number | undefined` carries the Union flag,
    // so the guard does not fire and they stay numeric.
    {
      const ctorTypeArgs = ctx.checker.getTypeArguments(exprType as ts.TypeReference);
      const ctorElemTs = ctorTypeArgs?.[0];
      const pureUndefinedVoidElem =
        !!ctorElemTs &&
        (elemWasm.kind === "i32" || elemWasm.kind === "f64") &&
        (ctorElemTs.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 &&
        (ctorElemTs.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0;
      if (pureUndefinedVoidElem) {
        elemWasm = { kind: "externref" };
        vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
        arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      }
    }

    // #1197: i32-specialized number[] override — caller (variable-declaration
    // codegen) flagged this `new Array(...)` as belonging to an i32-specialized
    // local. Override the element kind from f64 to i32. We must also re-resolve
    // vecTypeIdx/arrTypeIdx through the i32 registration.
    if (
      elemWasm.kind === "f64" &&
      (ctx as unknown as { _i32ElemArrayOverride?: boolean })._i32ElemArrayOverride === true
    ) {
      elemWasm = { kind: "i32" };
      vecTypeIdx = getOrRegisterVecType(ctx, "i32", { kind: "i32" });
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    }

    if (holeyCarrier) {
      elemWasm = { kind: "externref" };
      vecTypeIdx = getOrRegisterHoleyArrayType(ctx);
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    }

    if (arrTypeIdx < 0) {
      // Fallback: use externref vec type for Array<any> or unresolvable element types
      vecTypeIdx = getOrRegisterVecType(ctx, "externref", {
        kind: "externref",
      });
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      elemWasm = { kind: "externref" };
    }

    const args = expr.arguments ?? [];

    if (args.length === 0) {
      // new Array() → empty array with default backing capacity
      // JS arrays are dynamically resizable; wasm arrays are fixed-size.
      // Allocate a default backing buffer so index assignments work.
      const DEFAULT_CAPACITY = 64;
      fctx.body.push({ op: "i32.const", value: 0 }); // length = 0
      fctx.body.push({ op: "i32.const", value: DEFAULT_CAPACITY });
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (args.length === 1) {
      // §23.1.1.1 step 5 (ES5 §15.4.2.2): a single argument is a LENGTH only
      // when it is a Number. `new Array(null)` / `new Array("1")` / `new
      // Array(new Number(0))` construct the one-element array `[arg]` with
      // length 1 (test262 S15.4.2.2_A2.3_T1–T4). The length lowering below
      // compiled the arg with an f64 hint (ToNumber), silently turning those
      // into empty length-coerced arrays. Provably-non-number args (the tag is
      // static and ≠ number) take the one-element path; `mixed` (any-typed)
      // args keep the historical length behavior.
      const argTag = ctx.oracle.staticJsTypeOf(args[0]!);
      if (argTag !== "number" && argTag !== "mixed") {
        let oneVecIdx = vecTypeIdx;
        let oneArrIdx = arrTypeIdx;
        if (elemWasm.kind !== "externref") {
          oneVecIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
          oneArrIdx = getArrTypeIdxFromVec(ctx, oneVecIdx);
        }
        compileExpression(ctx, fctx, args[0]!, { kind: "externref" });
        fctx.body.push({ op: "array.new_fixed", typeIdx: oneArrIdx, length: 1 });
        const oneData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: oneArrIdx,
        });
        fctx.body.push({ op: "local.set", index: oneData });
        fctx.body.push({ op: "i32.const", value: 1 });
        fctx.body.push({ op: "local.get", index: oneData });
        fctx.body.push({ op: "struct.new", typeIdx: oneVecIdx });
        return { kind: "ref_null", typeIdx: oneVecIdx };
      }
      // new Array(n) → array with capacity n, length 0
      // For test262 patterns like `var a = new Array(16); a[0] = x;`
      // we create an array of size n with default values and set length to n
      // (JS semantics: sparse array with length n, all slots undefined)
      compileExpression(ctx, fctx, args[0]!, { kind: "f64" });

      // RangeError validation: n must be a non-negative integer < 2^32
      // Check: n != floor(n) || n < 0 || n >= 2^32 → throw RangeError
      const nF64Local = allocLocal(fctx, `__arr_n_f64_${fctx.locals.length}`, {
        kind: "f64",
      });
      fctx.body.push({ op: "local.tee", index: nF64Local });
      // Check n != floor(n) (non-integer or NaN)
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.floor" });
      fctx.body.push({ op: "f64.ne" });
      // Check n < 0
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 0 });
      fctx.body.push({ op: "f64.lt" });
      fctx.body.push({ op: "i32.or" });
      // Check n >= 2^32
      fctx.body.push({ op: "local.get", index: nF64Local });
      fctx.body.push({ op: "f64.const", value: 4294967296 });
      fctx.body.push({ op: "f64.ge" });
      fctx.body.push({ op: "i32.or" });
      // If any check true, throw RangeError
      {
        const rangeErrMsg = "RangeError: Invalid array length";
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
          else: [],
        });
      }

      fctx.body.push({ op: "local.get", index: nF64Local });
      const sizeLocal = allocLocal(fctx, `__arr_size_${fctx.locals.length}`, { kind: "i32" });
      if (holeyCarrier) {
        fctx.body.push({ op: "i32.trunc_sat_f64_s" });
        fctx.body.push({ op: "local.tee", index: sizeLocal });
        fctx.body.push({ op: "call", funcIdx: ensureHoleyArrayNew(ctx) });
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }
      // (#4491 lane J) LENGTH / CAPACITY split above the 16M allocation guard —
      // `new Array(4294967295)` is legal ES5. See vec-sparse-index.ts.
      fctx.body.push(...sparseArrayNewSplitInstrs(sizeLocal));
      fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx });
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    // new Array(a, b, c) → [a, b, c]
    for (const arg of args) {
      compileExpression(ctx, fctx, arg, elemWasm);
    }
    fctx.body.push({
      op: "array.new_fixed",
      typeIdx: arrTypeIdx,
      length: args.length,
    });
    const tmpData = allocLocal(fctx, `__arr_data_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: arrTypeIdx,
    });
    fctx.body.push({ op: "local.set", index: tmpData });
    fctx.body.push({ op: "i32.const", value: args.length });
    fctx.body.push({ op: "local.get", index: tmpData });
    fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }
  return NEW_INDEXED_FALLTHROUGH;
}
