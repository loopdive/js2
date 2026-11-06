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
import { getArrTypeIdxFromVec, getOrRegisterResizableAbType, getOrRegisterVecType, resolveWasmType } from "../index.js";
import { getOrRegisterHoleyArrayType } from "../registry/types.js";
import { ensureHoleyArrayNew } from "../vec-elem-set.js";
import { sparseArrayNewSplitInstrs } from "../vec-sparse-index.js";
import { holeFilledArrayNewInstrs } from "../array/array-length-holes.js"; // (#6771 S3)
import { compileExpression } from "../shared.js";
import { coerceType } from "../type-coercion.js"; // (#5150) ToIndex via the ToPrimitive chokepoint
import { emitSymbolOperandCoercionThrow } from "../tonumber-symbol-throw.js";
import { buildThrowJsErrorInstrs } from "./helpers.js";
import { compileOneElementArray, widenDenseArrayElementType } from "./array-constructor-carrier.js";
import { inferArrayElementType } from "./new-super.js";
import { emitSabConstruct } from "../buffers/shared-array-buffer.js"; // (#7011)
import { noJsHost } from "../js-errors.js";
import {
  emitArrayBufferAllocFixed,
  emitArrayBufferLengthToIndex,
  emitResizableAbAlloc,
  emitResizableAbLength,
  emitResizableAbMaxLength,
} from "../buffers/array-buffer-native.js"; // (#7274) shared with the IR adapters
import {
  dataViewBufferByteLengthInstrs,
  emitDataViewBufferBrandCheck,
  emitDataViewDefaultLength,
  emitDataViewDetachedCheck,
  emitDataViewLengthFromExtern,
  emitDataViewLengthToIndex,
  emitDataViewOffsetBoundsCheck,
  emitDataViewOffsetToIndex,
  emitDataViewWindow,
} from "../buffers/data-view-construct.js"; // (#7274) shared with the IR adapters

/** Sentinel: the `new` target is not one of the indexed built-in constructors. */
export const NEW_INDEXED_FALLTHROUGH = Symbol("new-indexed-fallthrough");

export function tryCompileIndexedBuiltinNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.NewExpression,
  className: string | undefined,
): ValType | null | typeof NEW_INDEXED_FALLTHROUGH {
  // (#7011) new SharedArrayBuffer(length, options) → the native provider.
  if (className === "SharedArrayBuffer" && noJsHost(ctx) && !ctx.classSet.has(className)) {
    const r = emitSabConstruct(ctx, fctx, expr.arguments ?? [], (e) => compileExpression(ctx, fctx, e));
    if (r !== undefined) return r;
  }
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
      const lenI32 = emitResizableAbLength(ctx, fctx);
      compileExpression(ctx, fctx, maxByteLenInit, { kind: "f64" });
      const maxI32 = emitResizableAbMaxLength(ctx, fctx);
      emitResizableAbAlloc(ctx, fctx, arrTypeIdx, rabTypeIdx, lenI32, maxI32);
      // Return the PARENT vec type: a `$__resizable_ab` IS-A `$__vec_i32_byte`, so
      // every downstream buffer consumer (byteLength, DataView, TA views, slice)
      // treats it identically — only `.resize()`/`.maxByteLength`/`.resizable`
      // `ref.test` the subtype. The runtime value keeps its resizable_ab identity.
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    }

    if (args.length >= 1) {
      // (#3481) §25.1.3.1 step 2 is `? ToIndex(length)`, whose ToNumber throws
      // on a Symbol (§7.1.4 step 5) BEFORE the RangeError bounds check below.
      // Without this guard a symbol's `i32` id converts straight to `f64` and
      // `new ArrayBuffer(Symbol())` quietly allocates a buffer of `id` bytes
      // (built-ins/ArrayBuffer/return-abrupt-from-length-symbol.js).
      if (emitSymbolOperandCoercionThrow(ctx, fctx, args[0]!, "number")) {
        return { kind: "ref_null", typeIdx: vecTypeIdx };
      }
      // new ArrayBuffer(byteLength) → create vec with byteLength elements, all 0
      // (#5150) §25.1.3.1 step 2 is `ToIndex(length)`, whose ToNumber must run a
      // plain object's `valueOf` / `Symbol.toPrimitive`. Compiling straight to
      // the f64 hint skipped ToPrimitive for object arguments, so
      // `new ArrayBuffer({valueOf(){return 42}})` became NaN → RangeError
      // (`toindex-length.js`). Routing a non-numeric argument through
      // `coerceType` hits the standalone externref→f64 chokepoint, which calls
      // `__to_primitive`. A statically numeric argument keeps the direct hint,
      // so the common shape stays byte-identical.
      {
        const numericArg = ctx.oracle.staticJsTypeOf(args[0]!) === "number";
        const lenTy = compileExpression(ctx, fctx, args[0]!, numericArg ? { kind: "f64" } : { kind: "externref" });
        if (lenTy === null) fctx.body.push({ op: "f64.const", value: NaN });
        else if (lenTy.kind !== "f64") coerceType(ctx, fctx, lenTy, { kind: "f64" });
      }

      // ToIndex + the RangeError bounds check (array-buffer-native.ts).
      emitArrayBufferLengthToIndex(ctx, fctx);
    } else {
      fctx.body.push({ op: "i32.const", value: 0 });
    }

    emitArrayBufferAllocFixed(fctx, vecTypeIdx, arrTypeIdx);
    return { kind: "ref_null", typeIdx: vecTypeIdx };
  }

  // new DataView(buffer) / new DataView(buffer, byteOffset) / new DataView(buffer, byteOffset, byteLength)
  if (className === "DataView") {
    const elemType: ValType = { kind: "i8" }; // (#2835) packed byte buffer
    const vecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", elemType);
    const args = expr.arguments ?? [];

    // (#5150) §25.3.2.1 step 2: `buffer` must carry an [[ArrayBufferData]]
    // slot, and that TypeError fires BEFORE `ToIndex(byteOffset)` runs the
    // offset's `valueOf` — `buffer-not-object-throws.js` asserts exactly that
    // order. A statically primitive/foreign first argument also MIS-COMPILED:
    // its f64/i32 result was stored into the externref buffer local and the
    // later `struct.get` failed Wasm validation ("struct.get[0] expected type
    // …"), turning the whole module into a COMPILE_ERROR. Evaluate every
    // argument for its side effects, drop, throw.
    const dvBrandThrow = (): ValType => {
      for (const arg of args) {
        const t = compileExpression(ctx, fctx, arg);
        if (t) fctx.body.push({ op: "drop" });
      }
      fctx.body.push(
        ...buildThrowJsErrorInstrs(ctx, "TypeError", "First argument to DataView constructor must be an ArrayBuffer", {
          flush: fctx,
        }),
      );
      return { kind: "ref_null", typeIdx: vecTypeIdx };
    };
    if (args.length >= 1) {
      const arg0Tag = ctx.oracle.staticJsTypeOf(args[0]!);
      const arg0Builtin = ctx.oracle.builtinReceiverOf(args[0]!);
      const staticallyNotABuffer =
        arg0Tag === "number" ||
        arg0Tag === "string" ||
        arg0Tag === "boolean" ||
        arg0Tag === "bigint" ||
        arg0Tag === "symbol" ||
        arg0Tag === "undefined" ||
        // A statically known OBJECT that is a DIFFERENT builtin (a TypedArray,
        // a DataView, a Map…). Its carrier is not the i32_byte vec, so the
        // downstream `struct.get` is the validation failure described above.
        ((arg0Tag === "object" || arg0Tag === "function") &&
          arg0Builtin !== undefined &&
          arg0Builtin !== "ArrayBuffer" &&
          arg0Builtin !== "SharedArrayBuffer");
      if (staticallyNotABuffer) return dvBrandThrow();
    }

    if (args.length >= 1) {
      // Compile buffer arg first
      const resultType = compileExpression(ctx, fctx, args[0]!);
      const isStructBuf = resultType !== null && (resultType.kind === "ref" || resultType.kind === "ref_null");

      // (#5150) The compiled carrier IS a struct, but not the i32_byte buffer
      // vec (nor its resizable subtype): `new DataView({}, …)` /
      // `new DataView([], …)`. Same validation failure, same spec answer.
      if (isStructBuf) {
        const structIdx = (resultType as { typeIdx?: number }).typeIdx;
        const rabIdx = getOrRegisterResizableAbType(ctx);
        if (structIdx !== undefined && structIdx !== vecTypeIdx && structIdx !== rabIdx) {
          fctx.body.push({ op: "drop" });
          for (let ai = 1; ai < args.length; ai++) {
            const t = compileExpression(ctx, fctx, args[ai]!);
            if (t) fctx.body.push({ op: "drop" });
          }
          fctx.body.push(
            ...buildThrowJsErrorInstrs(
              ctx,
              "TypeError",
              "First argument to DataView constructor must be an ArrayBuffer",
              { flush: fctx },
            ),
          );
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
      }

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

      // (#5150) The buffer's byte length as f64, for both carriers: an
      // already struct-typed local, and the common standalone shape where an
      // `ArrayBuffer` binding is an externref that has to be recovered.
      const bufferByteLength = dataViewBufferByteLengthInstrs(bufLocal, isStructBuf, vecTypeIdx);

      // (#5150) §25.3.2.1 step 2, RUNTIME half: the static type could not decide
      // (an `any` binding, a DataView instance widened to externref). Runs
      // BEFORE ToIndex(byteOffset) — `buffer-does-not-have-arraybuffer-data-
      // throws.js` asserts the offset's `valueOf` never runs.
      if (!isStructBuf) emitDataViewBufferBrandCheck(ctx, fctx, bufLocal, vecTypeIdx);

      if (args.length >= 2) {
        // #1515 ToIndex(byteOffset) per ECMA §7.1.22 (data-view-construct.ts).
        // (#3481) ToIndex → ToNumber throws on a Symbol first. The buffer
        // operand is already evaluated (it is in `bufLocal`), so §13.3.6.1
        // argument order is preserved by guarding here.
        if (emitSymbolOperandCoercionThrow(ctx, fctx, args[1]!, "number")) {
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
        compileExpression(ctx, fctx, args[1]!, { kind: "f64" });
        emitDataViewOffsetToIndex(ctx, fctx, offsetF64);
      } else {
        // No explicit byteOffset — default to 0
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "local.set", index: offsetF64 });
      }

      // (#5150) Step 7 (detached) after ToIndex(byteOffset) — whose `valueOf`
      // must have run exactly once — and before the step-9 bounds check.
      emitDataViewDetachedCheck(ctx, fctx, bufferByteLength);
      if (args.length >= 2) emitDataViewOffsetBoundsCheck(ctx, fctx, offsetF64, bufferByteLength);

      if (args.length >= 3) {
        // #1515 ToIndex(byteLength). (#3481) …including the §7.1.4 Symbol TypeError.
        if (emitSymbolOperandCoercionThrow(ctx, fctx, args[2]!, "number")) {
          return { kind: "ref_null", typeIdx: vecTypeIdx };
        }
        // (#5150) An EXPLICIT `undefined` byteLength means "to the end of the
        // buffer", while `null` keeps coercing to 0: a non-number argument is
        // kept as an externref so the singleton stays distinguishable.
        const lenWasUndefined = allocLocal(fctx, `__dv_len_undef_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: lenWasUndefined });
        if (ctx.oracle.staticJsTypeOf(args[2]!) === "number") {
          compileExpression(ctx, fctx, args[2]!, { kind: "f64" });
        } else {
          const lenExtern = allocLocal(fctx, `__dv_lenx_${fctx.locals.length}`, { kind: "externref" });
          const lenTy = compileExpression(ctx, fctx, args[2]!, { kind: "externref" });
          if (lenTy === null) fctx.body.push({ op: "ref.null.extern" });
          else if (lenTy.kind !== "externref") coerceType(ctx, fctx, lenTy, { kind: "externref" });
          emitDataViewLengthFromExtern(ctx, fctx, lenExtern, lenWasUndefined);
        }
        emitDataViewLengthToIndex(ctx, fctx, { lenF64, offsetF64, lenWasUndefined }, bufferByteLength);
      } else {
        emitDataViewDefaultLength(fctx, lenF64, offsetF64, bufferByteLength);
      }

      // (#2159/#38, #3173) Standalone DataView: a `$__dv_window` over the
      // shared backing buffer, so the native accessors add the base offset and
      // `dv.byteOffset` / `dv.byteLength` reflect the ctor args. The window IS
      // the standalone [[DataView]] brand (an offset-0 view must also be
      // distinguishable from its bare vec); a non-vec buffer passes through
      // unwrapped. No `__dv_register_view` host call: that import is
      // unsatisfiable standalone (#2159).
      emitDataViewWindow(ctx, fctx, { bufLocal, isStructBuf, offsetF64, lenF64 }, vecTypeIdx);
      return { kind: "externref" };
    } else {
      return dvBrandThrow();
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

    const widenedElemWasm = widenDenseArrayElementType(args, elemWasm);
    if (widenedElemWasm.kind !== elemWasm.kind) {
      elemWasm = widenedElemWasm;
      vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
      arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    }

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
        return compileOneElementArray(ctx, fctx, args[0]!, elemWasm, vecTypeIdx);
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
      fctx.body.push(...holeFilledArrayNewInstrs(ctx, fctx, arrTypeIdx)); // (#6771 S3)
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
