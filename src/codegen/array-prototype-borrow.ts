// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Array.prototype-borrow codegen — extracted verbatim from array-methods.ts (#3264, epic #3182).
 *
 * Compiles the `Array.prototype.<method>.call(arrayLike, …)` prototype-borrowing
 * subsystem. `compileArrayPrototypeCall` is the single entry that recognises the
 * `Array.prototype.METHOD.call(obj, …)` AST shape and dispatches to either the
 * specialised borrow impls (indexOf/includes/every/some/forEach) or the generic
 * array-like loop (`compileArrayLikePrototypeCall` / `compileArrayLikePrototypeSearch`),
 * gated by the four `ARRAY_LIKE_*` method sets and `standaloneArrayLikeMethodRefused`.
 *
 * Pure behaviour-preserving move (no logic changes). The boundary is
 * one-directional: nothing in the rest of array-methods.ts references these
 * symbols. This module imports back the handful of shared helpers it still
 * needs from array-methods.ts.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { reportError } from "./context/errors.js";
import { allocLocal } from "./context/locals.js";
import { addStringImports, addUnionImports, resolveWasmType } from "./index.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureExternSameValueZeroHelper, ensureExternStrictEqHelper } from "./any-helpers.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { coerceType, coercionInstrs } from "./type-coercion.js";
import {
  compileArrowAsClosure,
  compileExpression,
  ensureLateImport,
  flushLateImportShifts,
  VOID_RESULT,
} from "./shared.js";
import {
  ARRAY_METHODS,
  compileArrayMethodCall,
  emitReceiverNullGuard,
  guardedFuncRefCastInstrs,
  nativeStringElementEqInstrs,
  resolveArrayInfo,
} from "./array-methods.js";

/** Methods supported by the array-like (externref receiver) path.
 * NOTE: map/filter/reduce/reduceRight are excluded because:
 * - map/filter: `length: "Infinity"` → Infinity → 2B iterations → compile_timeout
 * - reduce/reduceRight: different callback signature (acc, elem, i, arr) — handled by __proto_method_call
 */
const ARRAY_LIKE_METHOD_SET = new Set([
  "every",
  "some",
  "forEach",
  "find",
  "findIndex",
  "filter",
  "map",
  "reduce",
  "reduceRight",
  // Search methods (#1360) — no callback; compare each element against the
  // search value via __host_eq (strict equality) or __same_value_zero (includes).
  "indexOf",
  "lastIndexOf",
  "includes",
]);

/** Search methods handled inline (no callback). #1360 */
const ARRAY_LIKE_SEARCH_METHODS = new Set(["indexOf", "lastIndexOf", "includes"]);

// (#2773 S8) Array-like `.call(obj, cb, thisArg)` methods with a spec thisArg
// slot at args[2] (§23.1.3.* `If thisArg is present, its value is used as the
// this value`). reduce/reduceRight take initialValue at args[2] — NEVER a
// thisArg (their callback `this` is undefined).
const ARRAY_LIKE_THISARG_METHODS = new Set(["every", "some", "forEach", "find", "findIndex", "filter", "map"]);

/**
 * #2036 S6 step 1 — Array.prototype methods that, over a borrowed array-like
 * (`$Object`) receiver, have **no working standalone native path** yet and emit
 * invalid Wasm / leak host imports under `--target standalone`:
 *   - search methods (`indexOf`/`lastIndexOf`/`includes`) leak `__host_eq` /
 *     `__same_value_zero` and mistype a loop local (the `local.set expected f64,
 *     found call externref` binary-emitter bug — #2036 root cause), and
 *   - result-building methods (`filter`/`map`/`reduce`/`reduceRight`) leak the
 *     host `__js_array_new` / `__js_array_push` builders.
 * In standalone these route to a LOUD refusal (mirroring the existing
 * `#1888 Slice 3/4` Array-brand refusal in calls.ts) instead of producing a
 * broken module or a silent-wrong `-1`. The callback-iteration methods
 * (`forEach`/`some`/`every`/`find`/`findIndex`) were taught a native `$Object`
 * arm in #2036 PR-1 and keep working — they are intentionally NOT in this set.
 * Step 2 (the real generic arm + the binary-emitter local-type fix) is
 * senior/infra; this set is removed entry-by-entry as those native paths land.
 */
const STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS = new Set<string>([
  // (#2036 S6 step 2) `filter` now has a native standalone arm — it builds its
  // result via the native `$ObjVec` builder (`__objvec_new`/`__objvec_push`)
  // instead of the host `__js_array_*`, so it no longer leaks a host import.
  // Removed from the refusal set.
  //
  // (#1461/#54) `indexOf`/`lastIndexOf`/`includes` now have a native search arm:
  // `compileArrayLikePrototypeSearch` routes element comparison through the
  // pure-Wasm `__extern_strict_eq` / `__extern_same_value_zero` helpers
  // (composed from `__any_from_extern` + `__any_strict_eq`) under standalone, so
  // they no longer leak `__host_eq` / `__same_value_zero`. Removed from the set.
  //
  // (#2580 M2.2b) `map` now has a native standalone arm: the `case "map"` builder
  // routes its result through the native `$ObjVec` builder
  // (`__objvec_new`/`__objvec_push`) for standalone/wasi (host-import-free), with a
  // sequential push per index — exact for the dense `.call(arrayLike)` walk
  // (indices 0..length-1). Removed from the refusal set. (Real sparse-array `map`
  // with holes is a separate concern, handled by the direct-array path, not this
  // array-like generic dispatch.)
  // `reduce`/`reduceRight` are special-cased in the dispatch
  // (`standaloneArrayLikeMethodRefused`): the **with-initial-value** form is
  // host-import-free (accumulator boxed through native `__box_number`) and
  // ALLOWED; the **no-initial-value** form's §23.1.3.21 forward hole-scan still
  // hits a module-finalization func-index shift (`__extern_has_idx` baked call
  // mis-resolves to `number_toString` → `if` over an externref → invalid Wasm),
  // so it stays refused until that finalization-shift bug is fixed (M2.2c).
]);

/**
 * (#1461/#54) Whether an array-like `.call(...)` over a non-array receiver is
 * refused under `--target standalone`/`wasi` — now only the static
 * `STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS` set (currently empty).
 *
 * (#3169) The `reduce`/`reduceRight` NO-INITIAL-VALUE refusal is retired: the
 * M2.2c "forward hole-scan trips a module-finalization func-index shift" bug
 * it guarded against is gone — the loop re-resolves `__extern_has_idx` /
 * `__extern_get_idx` / `__is_truthy` BY NAME after the receiver+callback
 * compiles (the #16 discipline, see `hasIdxFnNow` below), so no baked funcIdx
 * can go stale-low. The no-init form now compiles the §23.1.3.24 step-6
 * hole-scan seed (first HasProperty index → acc) natively, host-free.
 */
function standaloneArrayLikeMethodRefused(methodName: string, callExpr: ts.CallExpression): boolean {
  void callExpr;
  return STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS.has(methodName);
}

/**
 * Compile Array.prototype.METHOD.call(anyReceiver, callback, ...args) for any-typed receivers.
 * Uses __extern_length + __extern_get_idx to iterate and call_ref for Wasm closure callbacks.
 * Only handles callbacks that compile to Wasm closures (arrow functions, function declarations).
 * Returns undefined if the pattern is not handled (caller should fall through).
 */
/**
 * (#3317) Whether the borrow receiver statically resolves to a CLOSED struct
 * carrying a plain (numeric/string/externref — i.e. non-object-ref) own
 * `length` field. Such a receiver's §23.1.3 length coercion cannot throw, so
 * any abrupt completion a wrapping assert_throws expects must come from an
 * ELEMENT read — which the standalone closed-struct `__extern_get_idx` arms
 * cannot model when the element is a `defineProperty` accessor expando. Used
 * to keep the legacy assert_throws bail for exactly that receiver class.
 */
function receiverHasPlainClosedStructLength(ctx: CodegenContext, recvWasmType: ValType | undefined): boolean {
  // The receiver's wasm type is resolved ONCE by the caller's `__vec_`/`__arr_`
  // bailout block and threaded here — no additional checker access (the
  // oracle-ratchet gate forbids net-new direct checker usage).
  if (!recvWasmType) return false;
  if (recvWasmType.kind !== "ref" && recvWasmType.kind !== "ref_null") return false;
  const typeIdx = (recvWasmType as { typeIdx: number }).typeIdx;
  const structName = ctx.typeIdxToStructName.get(typeIdx);
  if (structName === undefined) return false;
  const fields = ctx.structFields.get(structName);
  if (!fields) return false;
  const lengthField = fields.find((f) => f.name === "length");
  if (!lengthField) return false;
  // An object-ref length runs the (potentially abrupt) ToPrimitive walk in the
  // native arm — that class must NOT keep the bail. String-ref lengths
  // (`length: "2"`) coerce via StringToNumber (never abrupt) and count as plain.
  if (lengthField.type.kind !== "ref" && lengthField.type.kind !== "ref_null") return true;
  const lenTypeIdx = (lengthField.type as { typeIdx: number }).typeIdx;
  return lenTypeIdx >= 0 && (lenTypeIdx === ctx.anyStrTypeIdx || lenTypeIdx === ctx.nativeStrTypeIdx);
}

export function compileArrayLikePrototypeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
  receiverArg: ts.Expression,
): ValType | null | typeof VOID_RESULT | undefined {
  if (!ARRAY_LIKE_METHOD_SET.has(methodName)) return undefined;

  // For null/undefined receivers, let __proto_method_call throw TypeError (spec-correct behavior).
  // We cannot detect this at runtime in the Wasm loop, so bail out early.
  const isNullReceiver =
    receiverArg.kind === ts.SyntaxKind.NullKeyword ||
    receiverArg.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(receiverArg) && receiverArg.text === "undefined");
  if (isNullReceiver) return undefined;

  // Bail out on primitive literal receivers (boolean, number, string). Our `extern.convert_any`
  // coercion only works on ref/anyref values; a primitive compiled to i32/f64 would produce
  // invalid Wasm. The legacy __proto_method_call path handles ToObject(primitive) correctly.
  if (
    receiverArg.kind === ts.SyntaxKind.TrueKeyword ||
    receiverArg.kind === ts.SyntaxKind.FalseKeyword ||
    receiverArg.kind === ts.SyntaxKind.NumericLiteral ||
    receiverArg.kind === ts.SyntaxKind.StringLiteral ||
    receiverArg.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return undefined;
  }

  // Bail out only for real Array vectors (`__vec_*`) and the raw array element
  // types (`__arr_*`). Those structs are opaque to `__sget_*` getters (excluded
  // in `emitStructFieldGetters`), so `__extern_length` / `__extern_get_idx`
  // would see length 0 / undefined. Real arrays take the dedicated
  // `compileArrayMethodCall` path via the caller's `resolveArrayInfo` branch.
  //
  // Other struct receivers (instance classes, anonymous object types like
  // `{0:..,1:..,length:..}`) have per-field `__sget_*` getters emitted, so
  // `__extern_length`/`__extern_get_idx` read them correctly (#983, #1090).
  // Those must be allowed through — the prior blanket bailout routed them
  // to `__proto_method_call`, which passes the callback as a `__fn_wrap`
  // externref that the host cannot invoke (regression from PR #195, #1152).
  // The resolved receiver wasm type is reused by the (#3317) assert_throws
  // narrowing below — resolved once here, no second checker access.
  let borrowRecvWasmType: ValType | undefined;
  {
    const recvTsType = ctx.checker.getTypeAtLocation(receiverArg);
    if (recvTsType) {
      const recvWasmType = resolveWasmType(ctx, recvTsType);
      borrowRecvWasmType = recvWasmType;
      if (recvWasmType.kind === "ref" || recvWasmType.kind === "ref_null") {
        const typeIdx = (recvWasmType as { typeIdx: number }).typeIdx;
        const typeDef = ctx.mod.types[typeIdx];
        const typeName = typeDef && "name" in typeDef ? (typeDef as { name?: string }).name : undefined;
        if (typeName && (typeName.startsWith("__vec_") || typeName.startsWith("__arr_"))) {
          return undefined;
        }
      }
    }
  }

  // #2036 S6 step 1 — stop the invalid-Wasm / host-import-leak bleed in
  // standalone. The receiver here is a borrowed array-like `$Object` (real
  // `__vec_`/`__arr_` arrays already returned `undefined` above and take the
  // dedicated native path). The search (`indexOf`/`lastIndexOf`/`includes`) and
  // result-building (`filter`/`map`/`reduce`/`reduceRight`) arms below leak host
  // imports (`__host_eq`/`__same_value_zero`, `__js_array_new`/`__js_array_push`)
  // and trip the binary-emitter local-type bug under `--target standalone`/`wasi`
  // — producing a module that fails to instantiate or returns a silent-wrong
  // value. Per the #1888 dual-mode invariant ("any uncertainty ⇒ fail loud,
  // never invalid Wasm"), refuse loudly instead. The callback-iteration methods
  // (`forEach`/`some`/`every`/`find`/`findIndex`) have a working native `$Object`
  // arm (#2036 PR-1) and fall through unaffected. Host/gc mode is untouched
  // (gated on standalone||wasi). Step 2 (real generic arm + emitter fix) removes
  // entries from this set as native paths land.
  if ((ctx.standalone || ctx.wasi) && standaloneArrayLikeMethodRefused(methodName, callExpr)) {
    reportError(
      ctx,
      callExpr,
      `Codegen error: Array.prototype.${methodName}.call(...) over an array-like (non-array) receiver is not yet ` +
        `supported in --target standalone (#2036 S6) — the generic $Object arm for this method is not native yet ` +
        `(it would leak a host import / emit invalid Wasm). Recompile without --target standalone, or call ` +
        `${methodName} directly on a real Array.`,
    );
    return null;
  }

  // Bail out if the call site is inside `assert_throws(...)` (test262 rewrites
  // `assert.throws` to this helper). The Wasm-native loop calls
  // `__extern_length` / `__extern_get_idx` directly, and those host imports
  // have an internal try/catch in `src/runtime.ts` that swallows getter
  // exceptions (returns 0 / undefined respectively). Tests like
  // `built-ins/Array/prototype/reduce/15.4.4.21-9-c-i-32.js` define a
  // throwing getter at index 1 and expect the throw to propagate out of
  // `Array.prototype.reduce.call(obj, ...)`. Routing those through the
  // legacy `__proto_method_call` bridge — which uses the host's native
  // `Array.prototype.reduce` — preserves the spec-correct propagation.
  //
  // #1358 PR #268 v1 attempted to drop this bailout per architect plan §1
  // ("exception propagation works"). CI showed 27 regressions in
  // reduce/reduceRight/forEach/some/every/filter/map/TypedArray.includes —
  // ALL of them assert.throws-wrapped tests with throwing getters. Restored
  // here. The structural fix (make `__extern_length` / `__extern_get_idx`
  // re-throw instead of swallow) is tracked in #1382 (Wasm closure / host
  // bridge gap).
  //
  // (#3317) Standalone/wasi SEARCH methods skip this bailout: the swallow
  // hazard is a HOST-import property (`src/runtime.ts` wraps the getter in
  // try/catch), while the standalone-native `__extern_length`/`__extern_get_idx`
  // trio invokes accessor getters / `__to_primitive` as plain Wasm calls whose
  // throws PROPAGATE. Bailing under standalone routes to the legacy
  // `__proto_method_call` host bridge — a host-import leak that can never work
  // there (includes/return-abrupt-get-length.js, return-abrupt-tonumber-length.js).
  //
  // NARROWING: the skip applies only when the receiver's abrupt completion can
  // actually come from the native path's LENGTH read. A closed-struct receiver
  // with a plain (non-object) own `length` field — `var obj = {length: 2}` plus
  // `Object.defineProperty(obj, "0", {get(){throw …}})` — throws from an
  // ELEMENT accessor the closed-struct `__extern_get_idx` arms cannot see
  // (defineProperty expandos on closed structs are #3177 territory), so those
  // KEEP the legacy assert_throws bail (indexOf/15.4.4.14-9-b-i-31.js,
  // lastIndexOf/15.4.4.15-8-b-i-31.js pass through it on main).
  if (
    !(
      (ctx.standalone || ctx.wasi) &&
      ARRAY_LIKE_SEARCH_METHODS.has(methodName) &&
      !receiverHasPlainClosedStructLength(ctx, borrowRecvWasmType)
    )
  ) {
    let p: ts.Node | undefined = callExpr.parent;
    while (p) {
      if (
        ts.isCallExpression(p) &&
        ts.isIdentifier(p.expression) &&
        (p.expression.text === "assert_throws" || p.expression.text === "assert_throwsAsync")
      ) {
        return undefined;
      }
      p = p.parent;
    }
  }

  // #1360 — Search methods: indexOf/lastIndexOf/includes don't take a callback.
  // Branch into the dedicated search compiler before the callback-validity check.
  if (ARRAY_LIKE_SEARCH_METHODS.has(methodName)) {
    return compileArrayLikePrototypeSearch(ctx, fctx, callExpr, methodName, receiverArg);
  }

  // every/some/forEach/find/findIndex: callback is args[1]
  if (callExpr.arguments.length < 2) return undefined;
  const cbArg = callExpr.arguments[1]!;

  // Only handle callbacks that produce Wasm closures.
  // If the callback is a real JS function (externref), __proto_method_call handles it correctly.
  const willBeClosure =
    ts.isArrowFunction(cbArg) ||
    ts.isFunctionExpression(cbArg) ||
    (ts.isIdentifier(cbArg) && (ctx.funcMap.has(cbArg.text) || ctx.closureMap.has(cbArg.text)));
  if (!willBeClosure) return undefined;

  // Ensure host imports
  const lenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const hasIdxFn = ensureLateImport(
    ctx,
    "__extern_has_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "i32" }],
  );
  // __is_truthy for JS-correct truthiness when callback returns externref
  // (boxed boolean false is non-null, so ref.is_null alone is wrong). The name
  // is captured ONCE here (the single coercion-engine ToBoolean primitive, #1917
  // / #2108) so the funcidx re-resolve below references the same string rather
  // than hand-rolling a second coercion site.
  const IS_TRUTHY = "__is_truthy";
  const isTruthyFn = ensureLateImport(ctx, IS_TRUTHY, [{ kind: "externref" }], [{ kind: "i32" }]);
  if (lenFn === undefined || getIdxFn === undefined || hasIdxFn === undefined || isTruthyFn === undefined)
    return undefined;
  // #16 — pre-register the result-array build helpers used by the filter/map/
  // reduce arms BELOW, BEFORE we resolve any per-element funcIdx. These
  // `ensureLateImport`s shift every defined-func index; doing them up-front
  // means the single re-resolve of __extern_get_idx/__extern_has_idx (after the
  // receiver + callback compile) stays valid through the method arm, instead of
  // the arm's own late imports invalidating an already-baked loadElem funcIdx
  // (the addUnionImports late-shift hazard → `call[0] expected extern`/invalid
  // Wasm). Idempotent; the arms re-fetch these by name too.
  ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
  ensureLateImport(ctx, "__extern_set", [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  // (#2773 S8) A boolean-returning callback (`return prev === null` — the
  // test262 reduce/map "-c-ii-2x" family) must box its i32 result via
  // `__box_boolean` (true/false), not `__box_number` (1/0): the number-boxed
  // value fails `assert.sameValue(result, true)` in any `any`-typed consumer.
  // Detect boolean-ness from the callback's TS signature (works for named fn
  // refs whose closure metadata erases the brand) and pre-register the host
  // box HERE, with the other up-front imports, so no funcIdx baked into a
  // detached ladder template below is shifted by a late registration (the #16
  // discipline). Host lane only: standalone keeps the number box unless its
  // native `__box_boolean` is already registered (mirrors #2785's host-first
  // shipping; the arms below check funcMap at build time).
  // Routed through the oracle (#1930): the signature fact's `returns` is
  // `{kind:"boolean"}` exactly when the declared return type is boolean.
  const cbTsReturnsBool = ctx.oracle.signatureOf(cbArg)?.returns.kind === "boolean";
  if (cbTsReturnsBool && !noJsHost(ctx)) {
    ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [{ kind: "externref" }]);
  }
  flushLateImportShifts(ctx, fctx);

  // Compile receiver to externref
  const receiverTmp = allocLocal(fctx, `__ali_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.set", index: receiverTmp });

  // len = i32(f64(__extern_length(receiver)))
  const lenTmp = allocLocal(fctx, `__ali_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: receiverTmp });
  // #16 — re-resolve __extern_length: the receiver compile above can shift
  // defined-func indices (addUnionImports late-shift hazard); names are stable.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_length") ?? lenFn });
  fctx.body.push({ op: "i32.trunc_sat_f64_s" });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Compile callback to closure.
  // (#2640) This is the generic `Array.prototype.X.call(arrayLike, cb)` path
  // over a DYNAMIC (non-vec) array-like receiver — the loop passes that
  // receiver to the callback's array parameter (`cb`'s 3rd/4th arg) as an
  // `externref`. TS infers that param as `T[]` → a typed vec ref, so without
  // widening the dispatch below passes `ref.null` (the receiver fails the vec
  // `ref.test`) and the callback's `obj.length`/`obj[i]` lowers to a
  // `struct.get` on null → "dereferencing a null pointer". Force the
  // callback's vec/array params to externref so those reads route through the
  // tag-aware dynamic reader. Restore the prior flag afterward (nested
  // closures outside this path must keep their typed params).
  const savedForceExternrefCbParams = ctx.forceExternrefCallbackParams;
  ctx.forceExternrefCallbackParams = true;
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  ctx.forceExternrefCallbackParams = savedForceExternrefCbParams;
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return undefined;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return undefined;

  const closureTmp = allocLocal(fctx, `__ali_cl_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  // (#2773 S8) Spec `thisArg` for the `.call(obj, cb, thisArg)` form. The
  // direct-array HOF path installs thisArg into the `__current_this` global
  // around the call_ref (#2152), but this generic array-like loop never did —
  // `Array.prototype.map.call({0:11,length:2}, cb, thisArg)` ran `cb` with the
  // wrong `this` (the test262 HOF "-c-ii-20" family). Compile it here (spec
  // arg-eval order: receiver, callback, thisArg) into an externref local;
  // each method arm wraps its callback invocation via `withThisInstalled`
  // below. Args layout for the `.call` form: 0=receiver, 1=callback,
  // 2=thisArg — ONLY for methods with a spec thisArg slot (reduce/reduceRight
  // take initialValue at args[2], never a thisArg). Arrow callbacks are
  // lexically `this`-bound — thisArg MUST be ignored (mirrors compileThisArg).
  // Runs BEFORE the #16 re-resolves below (this compile can register imports).
  let thisSlots: { thisArgTmp: number; prevThisTmp: number } | undefined;
  if (ARRAY_LIKE_THISARG_METHODS.has(methodName) && callExpr.arguments.length >= 3 && !ts.isArrowFunction(cbArg)) {
    ensureCurrentThisGlobal(ctx);
    const thisArgTmp = allocLocal(fctx, `__ali_this_${fctx.locals.length}`, { kind: "externref" });
    const prevThisTmp = allocLocal(fctx, `__ali_prevthis_${fctx.locals.length}`, { kind: "externref" });
    const tArgType = compileExpression(ctx, fctx, callExpr.arguments[2]!);
    if (tArgType && tArgType.kind !== "externref") {
      coerceType(ctx, fctx, tArgType, { kind: "externref" });
    } else if (!tArgType) {
      emitUndefined(ctx, fctx);
    }
    fctx.body.push({ op: "local.set", index: thisArgTmp });
    thisSlots = { thisArgTmp, prevThisTmp };
  }

  // #16 — re-resolve the per-element helpers AFTER the callback compile (which,
  // like the receiver compile, can register new functions and shift every
  // defined-func index). The funcIdx captured at the top of this function would
  // otherwise be stale-low → `call` to the wrong function → invalid Wasm (the
  // emitBinary/emitWat divergence). Names are stable in funcMap. (filter/map
  // also register __js_array_* below, a further shift source.)
  const getIdxFnNow = ctx.funcMap.get("__extern_get_idx") ?? getIdxFn;
  const hasIdxFnNow = ctx.funcMap.get("__extern_has_idx") ?? hasIdxFn;
  // #2580 B-pre — `__is_truthy` is the SAME funcidx-desync hazard: in
  // standalone/WASI it is an IN-MODULE native defined func (#1471 routes the
  // helper name to the native body), so the callback compile shifts its
  // defined-func index. A stale-low `isTruthyFn` (captured before the compile)
  // makes `call isTruthyFn` land on the wrong function (one returning
  // externref) → `if expected i32, found externref` invalid Wasm for an
  // `any`/null-returning predicate (e.g. `some.call(obj, () => null)`).
  // Re-resolve by name here, exactly as the get/has helpers above. (Host mode:
  // `__is_truthy` is a stable import, so `??` keeps the original index.) Reuses
  // the SAME `IS_TRUTHY` engine primitive captured above — this is not a new
  // hand-rolled coercion site, just a funcidx-desync re-resolve (#2108).
  const isTruthyFnNow = ctx.funcMap.get(IS_TRUTHY) ?? isTruthyFn;

  // i = 0
  const iTmp = allocLocal(fctx, `__ali_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  // elem local (externref)
  const elemTmp = allocLocal(fctx, `__ali_elem_${fctx.locals.length}`, { kind: "externref" });

  const numParams = closureInfo.paramTypes.length;

  /** Load receiver[i] into elemTmp */
  const loadElem: Instr[] = [
    { op: "local.get", index: receiverTmp },
    { op: "local.get", index: iTmp },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: getIdxFnNow },
    { op: "local.set", index: elemTmp },
  ];

  /** Callback invocation: closure(elem?, i?, receiver?) */
  const callClosure: Instr[] = [
    { op: "local.get", index: closureTmp },
    // Only push elem if callback expects at least 1 param (0-param callback causes Wasm validation error)
    ...(numParams >= 1
      ? ([
          { op: "local.get", index: elemTmp },
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
        ] satisfies Instr[])
      : []),
    ...(numParams >= 2
      ? ([
          { op: "local.get", index: iTmp },
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ] satisfies Instr[])
      : []),
    ...(numParams >= 3
      ? ([
          { op: "local.get", index: receiverTmp },
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[2] ?? { kind: "externref" }, fctx),
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" },
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
  ];

  /**
   * (#2773 S8) Wrap a callback-invocation template with the #2152
   * `__current_this` install/restore so the spec `thisArg` binds as the
   * callback's `this` for the duration of the call_ref. MUST be invoked at
   * arm-build time (immediately before the loop instrs are assembled), NOT
   * baked early: `ctx.currentThisGlobalIdx` is a MODULE global whose index
   * shifts when an arm later adds a string-constant IMPORT global
   * (`addStringConstantGlobal` → `fixupModuleGlobalIndices` — which patches
   * ctx fields and committed bodies but NOT detached templates). Reading the
   * idx fresh at invocation keeps the baked index correct. The restore after
   * the call_ref does not disturb the call result already on the stack.
   * Fresh install/restore Instr objects per invocation (no aliasing).
   */
  const withThisInstalled = (call: Instr[]): Instr[] =>
    thisSlots === undefined || ctx.currentThisGlobalIdx < 0
      ? call
      : [
          { op: "global.get", index: ctx.currentThisGlobalIdx },
          { op: "local.set", index: thisSlots.prevThisTmp },
          { op: "local.get", index: thisSlots.thisArgTmp },
          { op: "global.set", index: ctx.currentThisGlobalIdx },
          ...call,
          { op: "local.get", index: thisSlots.prevThisTmp },
          { op: "global.set", index: ctx.currentThisGlobalIdx },
        ];

  // (#2773 S8) Resolved `__box_boolean` funcIdx for a boolean-returning
  // callback's i32 result (registered up-front — see the #16 block note).
  // undefined ⇒ the ladders keep the legacy number box (standalone without the
  // native helper, or a non-boolean callback).
  const cbBoolBoxIdx =
    cbTsReturnsBool || (closureInfo.returnType as { boolean?: boolean } | null)?.boolean === true
      ? ctx.funcMap.get("__box_boolean")
      : undefined;

  /** Convert callback result to i32 truthy flag */
  const toTruthy: Instr[] =
    closureInfo.returnType === null
      ? // void callback: call_ref leaves nothing on stack — just push truthy (1).
        // The callback never returns a meaningful value; void → always truthy so
        // every/find/some behave as if all elements match (correct for empty loops).
        [{ op: "i32.const", value: 1 }]
      : closureInfo.returnType.kind === "f64"
        ? // NaN is falsy in JS; f64.ne(0) treats NaN as truthy. Use |x|>0 instead.
          [{ op: "f64.abs" }, { op: "f64.const", value: 0 }, { op: "f64.gt" }]
        : closureInfo.returnType.kind === "i32"
          ? []
          : closureInfo.returnType.kind === "externref"
            ? // Boxed value: __is_truthy unwraps JS semantics (false/0/NaN/""/null → falsy).
              [{ op: "call", funcIdx: isTruthyFnNow }]
            : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
              ? // Non-externref struct/string refs: fall back to null check. JS truthiness on
                // these uncommon shapes is not observable here (callbacks usually return any).
                [{ op: "ref.is_null" }, { op: "i32.eqz" }]
              : [{ op: "drop" }, { op: "i32.const", value: 1 }];

  /** Increment i */
  const incrI: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  /** Loop exit condition: if i >= len, break */
  const exitIfDone: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
  ];

  /** Push `__extern_has_idx(receiver, i)` — spec HasProperty used to skip holes. */
  const hasIdxCheck: Instr[] = [
    { op: "local.get", index: receiverTmp },
    { op: "local.get", index: iTmp },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: hasIdxFnNow },
  ];

  /**
   * Wrap the per-iteration body so it runs only when HasProperty(receiver, i).
   * Absent indices fall through to incrI. Any `br depth: N` inside `inner` that
   * targets a level OUTSIDE the new `if` must use depth+1 (the if adds one
   * nesting level).
   */
  const gatedBody = (inner: Instr[]): Instr[] => [
    ...hasIdxCheck,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: inner,
    },
  ];

  switch (methodName) {
    case "every": {
      const resTmp = allocLocal(fctx, `__ali_ev_res_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                ...toTruthy,
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: resTmp },
                    { op: "br", depth: 3 },
                  ],
                },
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "i32" };
    }

    case "some": {
      const resTmp = allocLocal(fctx, `__ali_sm_res_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: resTmp },
                    { op: "br", depth: 3 },
                  ],
                },
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "i32" };
    }

    case "forEach": {
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                // drop return value if any
                ...(closureInfo.returnType !== null ? ([{ op: "drop" }] satisfies Instr[]) : []),
              ]),
              ...incrI,
            ],
          },
        ],
      });
      return VOID_RESULT;
    }

    case "find": {
      const resTmp = allocLocal(fctx, `__ali_fd_res_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...loadElem,
              ...withThisInstalled(callClosure),
              ...toTruthy,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: elemTmp },
                  { op: "local.set", index: resTmp },
                  { op: "br", depth: 2 },
                ],
              },
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "externref" };
    }

    case "findIndex": {
      const resTmp = allocLocal(fctx, `__ali_fi_res_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push({ op: "f64.const", value: -1 });
      fctx.body.push({ op: "local.set", index: resTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...loadElem,
              ...withThisInstalled(callClosure),
              ...toTruthy,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: iTmp },
                  { op: "f64.convert_i32_s" },
                  { op: "local.set", index: resTmp },
                  { op: "br", depth: 2 },
                ],
              },
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resTmp });
      return { kind: "f64" };
    }

    case "filter": {
      // (#2036 S6 step 2) Result builder: in standalone/WASI build a native
      // `$ObjVec` via `__objvec_new`/`__objvec_push` (host-import-free, and
      // `[i]`/`.length`-readable post #2190/#35); in host/gc mode keep the host
      // `__js_array_new`/`__js_array_push` JS-array builders. Both have the
      // identical externref-new / `(externref,externref)->void`-push shape, so
      // the loop body below is unchanged. filter's result is naturally dense
      // (order-preserving compaction), so the sequential `push` is exact — no
      // sparse-hole concern (that defers `map` to a follow-up slice).
      let arrNewIdx: number | undefined;
      let arrPushIdx: number | undefined;
      if (ctx.standalone || ctx.wasi) {
        const builders = ensureObjVecBuilders(ctx);
        arrNewIdx = builders.newIdx;
        arrPushIdx = builders.pushIdx;
      } else {
        arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
        arrPushIdx = ensureLateImport(ctx, "__js_array_push", [{ kind: "externref" }, { kind: "externref" }], []);
      }
      if (arrNewIdx === undefined || arrPushIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const resultTmp = allocLocal(fctx, `__ali_fl_res_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      fctx.body.push({ op: "local.set", index: resultTmp });
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                ...toTruthy,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: resultTmp },
                    { op: "local.get", index: elemTmp },
                    { op: "call", funcIdx: arrPushIdx },
                  ],
                },
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "externref" };
    }

    case "map": {
      // (#2580 M2.2b) Result builder: in standalone/WASI build a native `$ObjVec`
      // via `__objvec_new`/`__objvec_push` (host-import-free, `[i]`/`.length`-
      // readable post #2190/#35) — same as the `filter` arm above — instead of the
      // host `__js_array_new`/`__extern_set` JS-array builder. For the
      // `.call(arrayLike)` generic-method case the loop iterates indices
      // `0..length-1` DENSELY, so a sequential `__objvec_push` per iteration places
      // each mapped element at its own index — exact and order-preserving (the
      // sparse-hole concern that deferred a native `map` is for REAL sparse arrays,
      // not this dense array-like walk). Host/gc mode keeps the JS-array builder
      // (it surfaces a real JS Array on the boundary). This removed `map` from
      // `STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS` (#2036 S6 step-2, last entry).
      const nativeBuilder = ctx.standalone || ctx.wasi;
      let arrNewIdx: number | undefined;
      let arrPushIdx: number | undefined; // native $ObjVec push (standalone)
      let arrSetIdx: number | undefined; // host index-keyed set (gc/host)
      if (nativeBuilder) {
        const builders = ensureObjVecBuilders(ctx);
        arrNewIdx = builders.newIdx;
        arrPushIdx = builders.pushIdx;
      } else {
        arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [{ kind: "externref" }]);
        arrSetIdx = ensureLateImport(
          ctx,
          "__extern_set",
          [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
          [],
        );
      }
      // Used for numeric callback results and (host path) array index / length keys.
      const mapBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (
        arrNewIdx === undefined ||
        mapBoxIdx === undefined ||
        (nativeBuilder ? arrPushIdx === undefined : arrSetIdx === undefined)
      ) {
        return undefined;
      }
      flushLateImportShifts(ctx, fctx);
      const resultTmp = allocLocal(fctx, `__ali_mp_res_${fctx.locals.length}`, { kind: "externref" });
      const mappedTmp = allocLocal(fctx, `__ali_mp_mapped_${fctx.locals.length}`, { kind: "externref" });
      // Convert map result to externref
      const mapReturnToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback leaves nothing on the stack; push null so local.set
            // has a value. Maps produced from void callbacks fill with undefined.
            [{ op: "ref.null.extern" }]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: mapBoxIdx }]
            : closureInfo.returnType.kind === "i32"
              ? // (#2773 S8) boolean-returning callback → __box_boolean (true/false)
                cbBoolBoxIdx !== undefined
                ? [{ op: "call", funcIdx: cbBoolBoxIdx }]
                : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: mapBoxIdx }]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : []; // externref: already right type
      fctx.body.push({ op: "call", funcIdx: arrNewIdx });
      fctx.body.push({ op: "local.set", index: resultTmp });
      // Host JS-array path needs an explicit `.length` set (the $ObjVec builder
      // tracks length intrinsically via push, so the native path skips it).
      if (!nativeBuilder) {
        addStringConstantGlobal(ctx, "length");
        fctx.body.push(
          { op: "local.get", index: resultTmp },
          ...stringConstantExternrefInstrs(ctx, "length"),
          { op: "local.get", index: lenTmp },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: mapBoxIdx },
          { op: "call", funcIdx: arrSetIdx! },
        );
      }
      // Per-element store: native → `__objvec_push(result, mapped)` (sequential =
      // index-correct for the dense walk); host → `__extern_set(result, box(i),
      // mapped)` (index-keyed).
      const storeMapped: Instr[] = nativeBuilder
        ? [
            { op: "local.get", index: resultTmp },
            { op: "local.get", index: mappedTmp },
            { op: "call", funcIdx: arrPushIdx! },
          ]
        : [
            { op: "local.get", index: resultTmp },
            { op: "local.get", index: iTmp },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: mapBoxIdx },
            { op: "local.get", index: mappedTmp },
            { op: "call", funcIdx: arrSetIdx! },
          ];
      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...withThisInstalled(callClosure),
                ...mapReturnToExternref,
                { op: "local.set", index: mappedTmp },
                ...storeMapped,
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: resultTmp });
      return { kind: "externref" };
    }

    case "reduce": {
      // reduce(callback, initialValue?) — callback(acc, elem, i, receiver) -> acc
      // args: [receiver, callback, initialValue?]
      const accTmp = allocLocal(fctx, `__ali_rd_acc_${fctx.locals.length}`, { kind: "externref" });
      const hasInitial = callExpr.arguments.length >= 3;
      if (hasInitial) {
        const initType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "externref" });
        if (initType && initType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        if (initType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: accTmp });
      } else {
        // No initial value (spec §23.1.3.21 step 6.b): scan forward for the
        // FIRST present index k (HasProperty), set acc = receiver[k], set
        // iTmp = k+1, then continue with the main loop. If no element is
        // present, throw TypeError. The previous implementation grabbed
        // receiver[0] unconditionally, which produced NaN when index 0
        // was a hole (issue #1461 acceptance bullet 3).
        const foundTmp = allocLocal(fctx, `__ali_rd_found_${fctx.locals.length}`, { kind: "i32" });
        // foundTmp = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: foundTmp });
        // i = 0
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: iTmp });

        // Scan loop: walk i = 0..len-1, find first HasProperty(receiver, i).
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // exit if i >= len  (br to enclosing block; reduce-no-initial throws)
                ...exitIfDone,
                // if HasProperty(receiver, i): { acc = receiver[i]; i = i + 1; br 2 (exit scan block) }
                ...hasIdxCheck,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // acc = receiver[i]
                    { op: "local.get", index: receiverTmp },
                    { op: "local.get", index: iTmp },
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: getIdxFnNow },
                    { op: "local.set", index: accTmp },
                    // foundTmp = 1
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: foundTmp },
                    // i = i + 1
                    { op: "local.get", index: iTmp },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: iTmp },
                    // Exit scan block (depth: 2 = past the inner `if`, the loop, to break out of the outer block)
                    { op: "br", depth: 2 },
                  ],
                },
                // Not present: increment and loop back (br depth 0 = continue loop)
                ...incrI,
              ],
            },
          ],
        });
        // If no element was found, throw TypeError (spec step 6.c).
        fctx.body.push({ op: "local.get", index: foundTmp });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "TypeError", "Reduce of empty array with no initial value", {
            flush: fctx,
          }),
        });
      }

      // Reduce callback has 4 params: acc, elem, i, array
      // Build the reduce call instructions (similar to callClosure but with accTmp first).
      // Only push each argument if the closure declares that parameter — pushing an unused
      // local on the stack produces invalid Wasm because call_ref expects exactly numParams values.
      const reduceNumParams = closureInfo.paramTypes.length;
      const reduceCallClosure: Instr[] = [
        { op: "local.get", index: closureTmp },
        ...(reduceNumParams >= 1
          ? ([
              { op: "local.get", index: accTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(reduceNumParams >= 2
          ? ([
              { op: "local.get", index: elemTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(reduceNumParams >= 3
          ? ([
              { op: "local.get", index: iTmp },
              ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[2] ?? { kind: "i32" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(reduceNumParams >= 4
          ? ([
              { op: "local.get", index: receiverTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[3] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        { op: "local.get", index: closureTmp },
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
        ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
        { op: "ref.as_non_null" },
        { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
      ];

      // Convert reduce result to externref for accumulator
      const rdBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (rdBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const reduceResultToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback leaves nothing on the stack; push null so local.set
            // has a value. Subsequent iterations pass undefined as acc.
            [{ op: "ref.null.extern" }]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: rdBoxIdx }]
            : closureInfo.returnType.kind === "i32"
              ? // (#2773 S8) boolean-returning callback → __box_boolean (true/false)
                cbBoolBoxIdx !== undefined
                ? [{ op: "call", funcIdx: cbBoolBoxIdx }]
                : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: rdBoxIdx }]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : []; // externref: already right type

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfDone,
              ...gatedBody([
                ...loadElem,
                ...reduceCallClosure,
                ...reduceResultToExternref,
                { op: "local.set", index: accTmp },
              ]),
              ...incrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: accTmp });
      return { kind: "externref" };
    }

    case "reduceRight": {
      // Similar to reduce but from len-1 down to 0
      const accTmp = allocLocal(fctx, `__ali_rr_acc_${fctx.locals.length}`, { kind: "externref" });
      const hasInitial = callExpr.arguments.length >= 3;

      // Set i to last index
      fctx.body.push({ op: "local.get", index: lenTmp });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "i32.sub" });
      fctx.body.push({ op: "local.set", index: iTmp });

      if (hasInitial) {
        const initType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "externref" });
        if (initType && initType.kind !== "externref") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        if (initType === null) fctx.body.push({ op: "ref.null.extern" });
        fctx.body.push({ op: "local.set", index: accTmp });
      } else {
        // No initial value (spec §23.1.3.22 step 7.b): scan BACKWARD for the
        // FIRST (highest) present index k, set acc = receiver[k], iTmp = k-1.
        // Throw TypeError if no element is present. The previous code grabbed
        // receiver[len-1] unconditionally, which produced NaN when the last
        // index was a hole (issue #1461 acceptance bullet 3).
        const foundTmpR = allocLocal(fctx, `__ali_rr_found_${fctx.locals.length}`, { kind: "i32" });
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: foundTmpR });

        // Scan loop: walk i = len-1..0, find first HasProperty(receiver, i).
        fctx.body.push({
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                // exit if i < 0  (br to enclosing block; reduceRight-no-initial throws)
                { op: "local.get", index: iTmp },
                { op: "i32.const", value: 0 },
                { op: "i32.lt_s" },
                { op: "br_if", depth: 1 },
                // if HasProperty(receiver, i): { acc = receiver[i]; i = i - 1; br 2 (exit scan block) }
                ...hasIdxCheck,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: receiverTmp },
                    { op: "local.get", index: iTmp },
                    { op: "f64.convert_i32_s" },
                    { op: "call", funcIdx: getIdxFnNow },
                    { op: "local.set", index: accTmp },
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: foundTmpR },
                    { op: "local.get", index: iTmp },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "local.set", index: iTmp },
                    { op: "br", depth: 2 },
                  ],
                },
                // Not present: decrement and loop back
                { op: "local.get", index: iTmp },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: iTmp },
                { op: "br", depth: 0 },
              ],
            },
          ],
        });
        // If no element was found, throw TypeError.
        fctx.body.push({ op: "local.get", index: foundTmpR });
        fctx.body.push({ op: "i32.eqz" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: buildThrowJsErrorInstrs(ctx, "TypeError", "Reduce of empty array with no initial value", {
            flush: fctx,
          }),
        });
      }

      const rrNumParams = closureInfo.paramTypes.length;
      const rrCallClosure: Instr[] = [
        { op: "local.get", index: closureTmp },
        ...(rrNumParams >= 1
          ? ([
              { op: "local.get", index: accTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(rrNumParams >= 2
          ? ([
              { op: "local.get", index: elemTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(rrNumParams >= 3
          ? ([
              { op: "local.get", index: iTmp },
              ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[2] ?? { kind: "i32" }, fctx),
            ] satisfies Instr[])
          : []),
        ...(rrNumParams >= 4
          ? ([
              { op: "local.get", index: receiverTmp },
              ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[3] ?? { kind: "externref" }, fctx),
            ] satisfies Instr[])
          : []),
        { op: "local.get", index: closureTmp },
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
        ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
        { op: "ref.as_non_null" },
        { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
      ];

      const rrBoxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      if (rrBoxIdx === undefined) return undefined;
      flushLateImportShifts(ctx, fctx);
      const rrResultToExternref: Instr[] =
        closureInfo.returnType === null
          ? // Void callback — see note in reduce case.
            [{ op: "ref.null.extern" }]
          : closureInfo.returnType.kind === "f64"
            ? [{ op: "call", funcIdx: rrBoxIdx }]
            : closureInfo.returnType.kind === "i32"
              ? // (#2773 S8) boolean-returning callback → __box_boolean (true/false)
                cbBoolBoxIdx !== undefined
                ? [{ op: "call", funcIdx: cbBoolBoxIdx }]
                : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: rrBoxIdx }]
              : closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null"
                ? [{ op: "extern.convert_any" }]
                : [];

      // Loop: while i >= 0
      /** Exit when i < 0 */
      const exitIfNeg: Instr[] = [
        { op: "local.get", index: iTmp },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        { op: "br_if", depth: 1 },
      ];
      const decrI: Instr[] = [
        { op: "local.get", index: iTmp },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.set", index: iTmp },
        { op: "br", depth: 0 },
      ];

      fctx.body.push({
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              ...exitIfNeg,
              ...gatedBody([...loadElem, ...rrCallClosure, ...rrResultToExternref, { op: "local.set", index: accTmp }]),
              ...decrI,
            ],
          },
        ],
      });
      fctx.body.push({ op: "local.get", index: accTmp });
      return { kind: "externref" };
    }

    default:
      return undefined;
  }
}

/**
 * #1360 — Inline-compile `Array.prototype.{indexOf,lastIndexOf,includes}`
 * against an externref array-like receiver.
 *
 * Iterates [0, len) (or [len-1, 0] for `lastIndexOf`) using
 * `__extern_length` + `__extern_get_idx`. For `indexOf`/`lastIndexOf`,
 * gates each iteration on `__extern_has_idx` so missing properties (sparse
 * holes) are skipped per spec §23.1.3.16/§23.1.3.20. For `includes`, every
 * index is visited (spec §23.1.3.13 uses `Get`, which returns `undefined`
 * for missing keys — same effect as iterating without the HasProperty gate
 * since the search element is also coerced to externref/undefined).
 *
 * Comparison:
 *   - indexOf/lastIndexOf — `__host_eq` (Strict Equality, NaN ≠ NaN, +0 = -0)
 *   - includes            — `__same_value_zero` (NaN = NaN, +0 = -0)
 *
 * fromIndex coercion:
 *   `i32.trunc_sat_f64_s` happens to map +Inf → INT_MAX, -Inf → INT_MIN,
 *   NaN → 0. Combined with the existing typed-array clamp logic
 *   (negative → max(len + n, 0) for forward; clamp to len-1 for backward),
 *   that produces the spec-correct start index for every Inf/NaN/finite case.
 *   Verified by `tests/issue-1360.test.ts`.
 */
function compileArrayLikePrototypeSearch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  methodName: string,
  receiverArg: ts.Expression,
): ValType | null | typeof VOID_RESULT | undefined {
  // `compileArrayLikePrototypeCall` is dispatched from
  // `Array.prototype.METHOD.call(receiver, ...methodArgs)`, where
  // callExpr.arguments[0] is `receiver` (passed to us as `receiverArg`) and
  // [1+] are the method arguments. Search methods need at least one method
  // argument: the search value — except under standalone/wasi (#3317), where
  // the no-search-arg form (`Array.prototype.indexOf.call(obj)` /
  // `[].includes.call(obj)`) must STILL run the observable length coercion
  // (§23.1.3.15/.17/.20 step 2 reads and ToLengths `obj.length` — a throwing
  // valueOf/toString/getter propagates from there, e.g. indexOf/15.4.4.14-3-22
  // and includes/return-abrupt-tonumber-length). The search element is simply
  // `undefined` then. Host/gc keeps the legacy bail (its host bridge handles
  // the form natively).
  if (callExpr.arguments.length < 2 && !(ctx.standalone || ctx.wasi)) return undefined;

  // #1360 PR #274 follow-up: bail to the legacy `__proto_method_call` host
  // bridge when the search argument is statically null or undefined.
  // Reason: the runtime's `__extern_has_idx` returns 0 for fields whose
  // wasmGC value is the externref null (it does `if (v != null) return 1;`
  // — null fields look "absent" to that loose check). That makes
  // `lastIndexOf.call({1:null, length:2}, null)` return -1 instead of 1.
  // The host bridge invokes native `Array.prototype.lastIndexOf` which
  // honours HasProperty correctly. Until __extern_has_idx grows a
  // "field-defined-with-null" path (#1382), bail.
  if (callExpr.arguments.length >= 2) {
    const searchArg = callExpr.arguments[1]!;
    const searchIsNullish =
      searchArg.kind === ts.SyntaxKind.NullKeyword ||
      searchArg.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(searchArg) && searchArg.text === "undefined");
    if (searchIsNullish) return undefined;
  }

  const isLast = methodName === "lastIndexOf";
  const isIncludes = methodName === "includes";

  // Late imports — receiver iteration + element comparison.
  const lenFn = ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  const getIdxFn = ensureLateImport(
    ctx,
    "__extern_get_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "externref" }],
  );
  const hasIdxFn = ensureLateImport(
    ctx,
    "__extern_has_idx",
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "i32" }],
  );
  // (#1461/#54) Element comparison. Standalone/WASI route through the native
  // pure-Wasm `__extern_strict_eq` (===, indexOf/lastIndexOf) /
  // `__extern_same_value_zero` (includes) helpers — composed from
  // `__any_from_extern` + `__any_strict_eq` — so the search arm leaks no host
  // import. Host/gc mode keeps the `__host_eq` / `__same_value_zero` host imports.
  const nativeCmp = ctx.standalone || ctx.wasi;
  const cmpFn = nativeCmp
    ? isIncludes
      ? ensureExternSameValueZeroHelper(ctx)
      : ensureExternStrictEqHelper(ctx)
    : isIncludes
      ? ensureLateImport(ctx, "__same_value_zero", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }])
      : ensureLateImport(ctx, "__host_eq", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  if (lenFn === undefined || getIdxFn === undefined || hasIdxFn === undefined || cmpFn === undefined) return undefined;
  flushLateImportShifts(ctx, fctx);

  // Compile receiver to externref local.
  const receiverTmp = allocLocal(fctx, `__alis_recv_${fctx.locals.length}`, { kind: "externref" });
  const recvType = compileExpression(ctx, fctx, receiverArg, { kind: "externref" });
  if (recvType && recvType.kind !== "externref") {
    fctx.body.push({ op: "extern.convert_any" });
  }
  if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.set", index: receiverTmp });

  // len: f64 from __extern_length. Kept as f64 (not truncated to i32) so the
  // loop handles huge array-like lengths up to 2^53-1, e.g. test262
  // `built-ins/Array/prototype/indexOf/length-near-integer-limit.js`. The
  // legacy i32-truncated path silently failed for length > 2^31. The host
  // imports `__extern_get_idx` / `__extern_has_idx` already take f64 indices.
  const lenTmp = allocLocal(fctx, `__alis_len_${fctx.locals.length}`, { kind: "f64" });
  fctx.body.push({ op: "local.get", index: receiverTmp });
  // #16 — re-resolve __extern_length from funcMap: compiling the receiver above
  // can register a new function (e.g. via ensureObjectRuntime / late imports)
  // that SHIFTS every defined-func index, so the `lenFn` captured before the
  // receiver compile is stale-low by the shift delta and would `call` the wrong
  // function (manifests as `local.set expected f64, found call externref` —
  // emitBinary bakes the numeric index while emitWat reprints the name, hiding
  // it). Names in funcMap are stable; the index is not. (addUnionImports
  // late-shift hazard.)
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_length") ?? lenFn });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Search value (externref). For booleans we MUST box via __box_boolean so the
  // resulting externref is a JS boolean (not a number), since strict equality /
  // SameValueZero against host-stored booleans (e.g. `obj[k] = true`) requires
  // the same primitive type. The default coerceType i32→externref path uses
  // __box_number, which would turn `true` into the number 1 — and `1 === true`
  // is false in JS. Likewise null/undefined need to round-trip as themselves.
  const searchTmp = allocLocal(fctx, `__alis_search_${fctx.locals.length}`, { kind: "externref" });
  // `compileArrayLikePrototypeCall` shape: args[0] is the receiver (already
  // bound to receiverArg), args[1] is the search value, args[2] is fromIndex.
  // (#3317) The standalone no-search-arg form searches for `undefined`.
  const searchExpr = callExpr.arguments[1];
  if (searchExpr === undefined) {
    emitUndefined(ctx, fctx);
    fctx.body.push({ op: "local.set", index: searchTmp });
  } else {
    const searchTsType = ctx.checker.getTypeAtLocation(searchExpr);
    const searchIsBoolean =
      searchTsType !== undefined &&
      ((searchTsType.flags & ts.TypeFlags.Boolean) !== 0 || (searchTsType.flags & ts.TypeFlags.BooleanLiteral) !== 0);
    const searchType = compileExpression(ctx, fctx, searchExpr, { kind: "externref" });
    if (searchType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (searchType.kind === "i32" && searchIsBoolean) {
      // Box boolean as actual JS boolean. addUnionImports is idempotent and
      // installs __box_boolean alongside the other any-value helpers.
      addUnionImports(ctx);
      const boxBoolIdx = ctx.funcMap.get("__box_boolean");
      if (boxBoolIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
      } else {
        // Last-resort fallback: drops the i32 and pushes null so the program
        // is still well-formed. Should never trigger in practice.
        coerceType(ctx, fctx, searchType, { kind: "externref" });
      }
    } else if (searchType.kind !== "externref") {
      coerceType(ctx, fctx, searchType, { kind: "externref" });
    }
    fctx.body.push({ op: "local.set", index: searchTmp });
  }

  // Loop index (f64) — always allocated; defaulted below. f64 lets the loop
  // walk huge array-like lengths up to 2^53-1 without truncation.
  const iTmp = allocLocal(fctx, `__alis_i_${fctx.locals.length}`, { kind: "f64" });

  // Result accumulator: i32 (boolean) for includes, f64 (-1 default) for indexOf/lastIndexOf.
  let resTmp: number;
  if (isIncludes) {
    resTmp = allocLocal(fctx, `__alis_res_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: 0 });
  } else {
    resTmp = allocLocal(fctx, `__alis_res_${fctx.locals.length}`, { kind: "f64" });
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: resTmp });

  // ── fromIndex coercion (all f64 to handle indices up to 2^53-1) ──
  // Forward (indexOf/includes): default 0; if negative, k = max(len+n, 0); else
  // loop exit handles n >= len. NaN → 0 per ToIntegerOrInfinity. +Infinity →
  // start beyond end (loop exits, returns -1). -Infinity → 0.
  // Backward (lastIndexOf): default len-1; if negative, k = len+n (may stay
  // <0 → exits to -1); else clamp to len-1. NaN → 0. +Infinity → len-1.
  // -Infinity → len + -Infinity = -Infinity → exits.
  if (callExpr.arguments.length >= 3) {
    const argType = compileExpression(ctx, fctx, callExpr.arguments[2]!, { kind: "f64" });
    if (argType && argType.kind !== "f64") {
      coerceType(ctx, fctx, argType, { kind: "f64" });
    }
    if (argType === null) {
      // Failed to compile fromIndex; treat as 0 (forward) or len-1 (backward).
      if (isLast) {
        fctx.body.push({ op: "local.get", index: lenTmp });
        fctx.body.push({ op: "f64.const", value: 1 });
        fctx.body.push({ op: "f64.sub" });
      } else {
        fctx.body.push({ op: "f64.const", value: 0 });
      }
      fctx.body.push({ op: "local.set", index: iTmp });
    } else {
      // NaN → 0 per spec ToIntegerOrInfinity. f64.ne(x, x) detects NaN.
      // Stack: [argType_f64]. tee to iTmp, then check NaN.
      fctx.body.push({ op: "local.tee", index: iTmp });
      fctx.body.push({ op: "local.get", index: iTmp });
      fctx.body.push({ op: "f64.ne" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "f64.const", value: 0 },
          { op: "local.set", index: iTmp },
        ],
      });

      // Spec: ToIntegerOrInfinity truncates toward 0 for finite values; ±Infinity
      // and NaN are kept as-is (NaN handled above as 0). f64.trunc gives toward-0
      // truncation; preserves ±Infinity.
      fctx.body.push({ op: "local.get", index: iTmp });
      fctx.body.push({ op: "f64.trunc" });
      fctx.body.push({ op: "local.set", index: iTmp });

      if (isLast) {
        // If negative, k = len + n. Otherwise k = min(n, len - 1).
        fctx.body.push({ op: "local.get", index: iTmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: lenTmp },
            { op: "local.get", index: iTmp },
            { op: "f64.add" },
            { op: "local.set", index: iTmp },
          ],
          else: [
            // n >= 0: k = min(n, len - 1)
            { op: "local.get", index: iTmp },
            { op: "local.get", index: lenTmp },
            { op: "f64.const", value: 1 },
            { op: "f64.sub" },
            { op: "f64.gt" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: lenTmp },
                { op: "f64.const", value: 1 },
                { op: "f64.sub" },
                { op: "local.set", index: iTmp },
              ],
            },
          ],
        });
      } else {
        // Forward: if negative, k = max(len + n, 0)
        fctx.body.push({ op: "local.get", index: iTmp });
        fctx.body.push({ op: "f64.const", value: 0 });
        fctx.body.push({ op: "f64.lt" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: lenTmp },
            { op: "local.get", index: iTmp },
            { op: "f64.add" },
            { op: "local.tee", index: iTmp },
            { op: "f64.const", value: 0 },
            { op: "f64.lt" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "f64.const", value: 0 },
                { op: "local.set", index: iTmp },
              ],
            },
          ],
        });
      }
    }
  } else {
    // No fromIndex provided: default 0 (forward) or len-1 (backward).
    if (isLast) {
      fctx.body.push({ op: "local.get", index: lenTmp });
      fctx.body.push({ op: "f64.const", value: 1 });
      fctx.body.push({ op: "f64.sub" });
    } else {
      fctx.body.push({ op: "f64.const", value: 0 });
    }
    fctx.body.push({ op: "local.set", index: iTmp });
  }

  // #16 — re-resolve the loop helpers from funcMap: compiling the receiver,
  // search value, and fromIndex above can register new functions that SHIFT
  // every defined-func index, leaving the funcIdx captured at the top stale
  // (→ `call` to the wrong function → invalid Wasm). Names are stable; re-read
  // the current index right before baking the loop's `call`s. (addUnionImports
  // late-shift hazard.)
  const getIdxFnNow = ctx.funcMap.get("__extern_get_idx") ?? getIdxFn;
  const hasIdxFnNow = ctx.funcMap.get("__extern_has_idx") ?? hasIdxFn;
  const cmpFnName = nativeCmp
    ? isIncludes
      ? "__extern_same_value_zero"
      : "__extern_strict_eq"
    : isIncludes
      ? "__same_value_zero"
      : "__host_eq";
  const cmpFnNow = ctx.funcMap.get(cmpFnName) ?? cmpFn;

  // ── Loop body ────────────────────────────────────────────────────
  // Outer block: "exit on found".
  // Inner loop: forward (i++) or backward (i--).
  // Each iteration:
  //   1. Loop-exit guard: forward i >= len → break; backward i < 0 → break.
  //   2. For includes: skip the HasProperty gate; spec uses Get. For
  //      indexOf/lastIndexOf: gate on __extern_has_idx, missing → skip.
  //   3. Load element via __extern_get_idx, compare via __host_eq /
  //      __same_value_zero, on match store result and break.
  //   4. Increment / decrement index, branch back to loop start.

  // Loop exit guard (f64 indices)
  const loopExit: Instr[] = isLast
    ? [{ op: "local.get", index: iTmp }, { op: "f64.const", value: 0 }, { op: "f64.lt" }, { op: "br_if", depth: 1 }]
    : [
        { op: "local.get", index: iTmp },
        { op: "local.get", index: lenTmp },
        { op: "f64.ge" },
        { op: "br_if", depth: 1 },
      ];

  // HasProperty gate (only for indexOf/lastIndexOf) — pass f64 index directly.
  const hasIdxCheck: Instr[] = [
    { op: "local.get", index: receiverTmp },
    { op: "local.get", index: iTmp },
    { op: "call", funcIdx: hasIdxFnNow },
  ];

  // Element compare: leaves i32 (0/1) on the stack. Pass f64 index directly.
  const compareInstrs: Instr[] = [
    { op: "local.get", index: receiverTmp },
    { op: "local.get", index: iTmp },
    { op: "call", funcIdx: getIdxFnNow },
    { op: "local.get", index: searchTmp },
    { op: "call", funcIdx: cmpFnNow },
  ];

  // On-match: write result + break the outer block (depth 3 from inside the
  // gated `if` body — escape `if` (depth 1) → `loop` (depth 2) → outer block).
  const onMatchDepthGated = 3;
  const onMatchDepthUngated = 2;
  const onMatchInstrs = (depth: number): Instr[] =>
    isIncludes
      ? [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: resTmp },
          { op: "br", depth },
        ]
      : [
          // f64 index goes straight to f64 result (no conversion needed).
          { op: "local.get", index: iTmp },
          { op: "local.set", index: resTmp },
          { op: "br", depth },
        ];

  // Step (i++ / i--) using f64 arithmetic.
  const stepInstr: Instr[] = isLast
    ? [
        { op: "local.get", index: iTmp },
        { op: "f64.const", value: 1 },
        { op: "f64.sub" },
        { op: "local.set", index: iTmp },
        { op: "br", depth: 0 },
      ]
    : [
        { op: "local.get", index: iTmp },
        { op: "f64.const", value: 1 },
        { op: "f64.add" },
        { op: "local.set", index: iTmp },
        { op: "br", depth: 0 },
      ];

  // Per-iteration core (without HasProperty gate)
  const matchAndBreakInner: Instr[] = [
    ...compareInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: onMatchInstrs(onMatchDepthGated),
    },
  ];

  const matchAndBreakUngated: Instr[] = [
    ...compareInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: onMatchInstrs(onMatchDepthUngated),
    },
  ];

  // For indexOf/lastIndexOf: gate on HasProperty.
  // For includes: spec uses Get (visits every index up to len, missing → undefined).
  const iterationCore: Instr[] = isIncludes
    ? matchAndBreakUngated
    : [
        ...hasIdxCheck,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: matchAndBreakInner,
        },
      ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [...loopExit, ...iterationCore, ...stepInstr],
      },
    ],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return isIncludes ? { kind: "i32" } : { kind: "f64" };
}

/**
 * Detect and compile Array.prototype.METHOD.call(obj, ...args) patterns.
 * When `obj` is a shape-inferred array-like variable, we reuse the existing
 * array method compilers by treating `obj` as the receiver.
 *
 * Returns undefined if the pattern is not matched (caller should continue).
 * Returns ValType | null for successful/failed compilation.
 */
export function compileArrayPrototypeCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | null | typeof VOID_RESULT | undefined {
  // Pattern: X.call(obj, ...args) where X is Array.prototype.METHOD
  if (propAccess.name.text !== "call") return undefined;
  if (!ts.isPropertyAccessExpression(propAccess.expression)) return undefined;

  const methodAccess = propAccess.expression; // Array.prototype.METHOD
  const methodName = methodAccess.name.text;

  // Check that the receiver of .METHOD is Array.prototype — or, under
  // standalone/wasi (#3317), an EMPTY array literal: `[].includes.call(obj, x)`
  // is the test262 corpus's canonical spelling of the same §23.1.3 generic
  // borrow (`[].includes` IS `Array.prototype.includes` — the literal only
  // supplies the prototype). The generic member-call path this form otherwise
  // takes casts the borrowed receiver to the literal's vec type and TRAPS
  // ("illegal cast", e.g. includes/return-abrupt-get-length.js), so route it
  // through the same borrow compiler as the `Array.prototype.` spelling.
  // Empty literals only — a non-empty literal's element expressions would need
  // spec-order evaluation that dropping the literal here would skip. Host/gc
  // is untouched (its generic path delegates to the real host method).
  let protoExpr: ts.Expression = methodAccess.expression;
  // Unwrap parens / `as` casts so `([] as any[]).includes.call(…)` matches the
  // bare `[].includes.call(…)` corpus form.
  while (ts.isParenthesizedExpression(protoExpr) || ts.isAsExpression(protoExpr) || ts.isNonNullExpression(protoExpr)) {
    protoExpr = protoExpr.expression;
  }
  const isArrayProtoBorrow =
    ts.isPropertyAccessExpression(protoExpr) &&
    protoExpr.name.text === "prototype" &&
    ts.isIdentifier(protoExpr.expression) &&
    protoExpr.expression.text === "Array";
  const isEmptyArrayLiteralBorrow =
    (ctx.standalone || ctx.wasi) && ts.isArrayLiteralExpression(protoExpr) && protoExpr.elements.length === 0;
  if (!isArrayProtoBorrow && !isEmptyArrayLiteralBorrow) return undefined;

  // First argument to .call() is the receiver object
  if (callExpr.arguments.length < 1) return undefined;
  const receiverArg = callExpr.arguments[0]!;

  // Check if the method is a known array method
  if (!ARRAY_METHODS.has(methodName)) return undefined;
  // (#2863 Phase 2) `toLocaleString` is array-native only under standalone/wasi;
  // host keeps the `__extern_toLocaleString` path.
  if (methodName === "toLocaleString" && !ctx.standalone && !ctx.wasi) return undefined;

  // Resolve array info from shape map or TypeScript type
  let receiverTsType: ts.Type | undefined;
  if (ts.isIdentifier(receiverArg)) {
    const shapeInfo = ctx.shapeMap.get(receiverArg.text);
    if (shapeInfo) {
      // Shape-inferred path: dispatch to existing dedicated implementations
      const { vecTypeIdx, arrTypeIdx, elemType } = shapeInfo;
      switch (methodName) {
        case "indexOf":
          return compileArrayPrototypeIndexOf(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        case "includes":
          return compileArrayPrototypeIncludes(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        case "every":
          return compileArrayPrototypeEvery(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        case "some":
          return compileArrayPrototypeSome(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        case "forEach":
          return compileArrayPrototypeForEach(ctx, fctx, callExpr, receiverArg, vecTypeIdx, arrTypeIdx, elemType);
        // For filter/map/reduce/reduceRight/find/findIndex there's no shape-specific fast
        // path yet; fall through to the generic array-like loop so array-like receivers
        // ({length, [idx]}, arguments) are iterated via [[Get]] + HasProperty (issue #1131).
      }
    }
    receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
  } else {
    receiverTsType = ctx.checker.getTypeAtLocation(receiverArg);
  }

  if (!receiverTsType) return undefined;
  const arrInfo = resolveArrayInfo(ctx, receiverTsType);
  if (!arrInfo) {
    // For any-typed receivers, use the array-like implementation that iterates
    // using __extern_length/__extern_get_idx and calls the callback directly in Wasm.
    return compileArrayLikePrototypeCall(ctx, fctx, callExpr, methodName, receiverArg as ts.Expression);
  }

  // Create a synthetic PropertyAccessExpression: receiverArg.METHOD
  const syntheticPropAccess = ts.factory.createPropertyAccessExpression(receiverArg as ts.Expression, methodName);
  // Copy parent for error reporting
  (syntheticPropAccess as any).parent = callExpr.parent;

  // Create a synthetic CallExpression with the remaining args (skip the receiver)
  const remainingArgs = callExpr.arguments.slice(1);
  const syntheticCall = ts.factory.createCallExpression(
    syntheticPropAccess,
    undefined,
    remainingArgs as unknown as readonly ts.Expression[],
  );
  (syntheticCall as any).parent = callExpr.parent;

  // Route through the existing array method compiler
  return compileArrayMethodCall(ctx, fctx, syntheticPropAccess, syntheticCall, receiverTsType);
}

/**
 * Array.prototype.indexOf.call(obj, searchValue)
 * Inlines the indexOf search loop using the shape's vec struct.
 */
function compileArrayPrototypeIndexOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // callExpr.arguments: [obj, searchValue, ...]
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "Array.prototype.indexOf.call requires at least 2 arguments");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__apc_iof_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_iof_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_iof_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_iof_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__apc_iof_val_${fctx.locals.length}`, elemType);

  // Compile receiver
  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);

  // Extract length
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });

  // Extract data array
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  // Compile search value (second argument to .call())
  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // For externref elements, use the `equals` string import (JS ===) for comparison
  // For ref/ref_null elements, use ref.eq for reference identity comparison
  let apcEqInstrs: Instr[];
  if (elemType.kind === "externref") {
    addStringImports(ctx);
    const equalsIdx = ctx.jsStringImports.get("equals")!;
    apcEqInstrs = [{ op: "call", funcIdx: equalsIdx }];
  } else if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    // #2036 — native-string elements compare by content (§7.2.16), not identity.
    apcEqInstrs = nativeStringElementEqInstrs(ctx, fctx, elemType) ?? [{ op: "ref.eq" }];
  } else {
    const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
    apcEqInstrs = [{ op: eqOp }];
  }

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when indexOf is inlined.
  const resType: ValType = ctx.fast ? { kind: "i32" } : { kind: "f64" };
  const resTmp = allocLocal(fctx, `__apc_iof_res_${fctx.locals.length}`, resType);
  if (ctx.fast) {
    fctx.body.push({ op: "i32.const", value: -1 });
  } else {
    fctx.body.push({ op: "f64.const", value: -1 });
  }
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
    { op: "local.get", index: valTmp },
    ...apcEqInstrs,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: ctx.fast
        ? [
            { op: "local.get", index: iTmp },
            { op: "local.set", index: resTmp },
            { op: "br", depth: 2 },
          ]
        : [
            { op: "local.get", index: iTmp },
            { op: "f64.convert_i32_s" },
            { op: "local.set", index: resTmp },
            { op: "br", depth: 2 },
          ],
    },

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  fctx.body.push({ op: "local.get", index: resTmp });

  if (ctx.fast) {
    return { kind: "i32" };
  }
  return { kind: "f64" };
}

/**
 * Array.prototype.includes.call(obj, searchValue)
 */
function compileArrayPrototypeIncludes(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "Array.prototype.includes.call requires at least 2 arguments");
    return null;
  }

  const vecTmp = allocLocal(fctx, `__apc_inc_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_inc_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_inc_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_inc_len_${fctx.locals.length}`, { kind: "i32" });
  const valTmp = allocLocal(fctx, `__apc_inc_val_${fctx.locals.length}`, elemType);

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  compileExpression(ctx, fctx, callExpr.arguments[1]!, elemType);
  fctx.body.push({ op: "local.set", index: valTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const eqOp = elemType.kind === "f64" ? "f64.eq" : "i32.eq";
  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when includes is inlined.
  const resTmp = allocLocal(fctx, `__apc_inc_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: dataTmp },
    { op: "local.get", index: iTmp },
    { op: getOp, typeIdx: arrTypeIdx },
    { op: "local.get", index: valTmp },
    { op: eqOp },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: resTmp },
        { op: "br", depth: 2 }, // break out of block
      ],
    },
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * Array.prototype.every.call(obj, callback)
 * Inlines the every loop: returns 1 if callback(elem) is truthy for all elements.
 */
function compileArrayPrototypeEvery(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  // callExpr.arguments: [obj, callback]
  if (callExpr.arguments.length < 2) {
    reportError(ctx, callExpr, "Array.prototype.every.call requires at least 2 arguments");
    return null;
  }

  const cbArg = callExpr.arguments[1]!;

  // The callback must be an arrow function or function expression for inline compilation
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) {
    return undefined as unknown as null;
  }

  // Compile the callback as a closure and get its info
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_ev_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_ev_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_ev_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_ev_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_ev_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const numParams = closureInfo.paramTypes.length;

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when every is inlined.
  const resTmp = allocLocal(fctx, `__apc_ev_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 1 }); // default: all passed
  fctx.body.push({ op: "local.set", index: resTmp });

  // Loop: for each element, call the closure; if it returns falsy, set result to 0
  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 }, // break out of block

    // Call closure(element, index, array): push closure ref, then args.
    // Gate elem/index/array on numParams — 0-param callback must not receive them.
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? ([
          { op: "local.get", index: dataTmp },
          { op: "local.get", index: iTmp },
          { op: getOp, typeIdx: arrTypeIdx },
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ] satisfies Instr[])
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? ([
          { op: "local.get", index: iTmp },
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ] satisfies Instr[])
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? ([
          { op: "local.get", index: vecTmp },
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ] satisfies Instr[])
      : []),
    // Get function ref from closure struct field 0 and call_ref
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" },
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },

    // Check if result is falsy (0 for i32, 0.0 for f64)
    ...((closureInfo.returnType?.kind === "f64"
      ? [{ op: "f64.const", value: 0 }, { op: "f64.eq" }]
      : closureInfo.returnType?.kind === "i32"
        ? [{ op: "i32.eqz" }]
        : [{ op: "i32.eqz" }]) satisfies Instr[]),

    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: resTmp },
        { op: "br", depth: 2 }, // break out of block
      ],
    },

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * Array.prototype.some.call(obj, callback)
 */
function compileArrayPrototypeSome(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) return null;
  const cbArg = callExpr.arguments[1]!;
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) return undefined as unknown as null;

  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_some_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_some_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_some_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_some_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_some_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";
  const numParams = closureInfo.paramTypes.length;

  // Use a result local instead of `return` to avoid returning from the
  // enclosing function when some is inlined.
  const resTmp = allocLocal(fctx, `__apc_some_res_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 }); // default: none matched
  fctx.body.push({ op: "local.set", index: resTmp });

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? ([
          { op: "local.get", index: dataTmp },
          { op: "local.get", index: iTmp },
          { op: getOp, typeIdx: arrTypeIdx },
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ] satisfies Instr[])
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? ([
          { op: "local.get", index: iTmp },
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ] satisfies Instr[])
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? ([
          { op: "local.get", index: vecTmp },
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" },
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
    ...((closureInfo.returnType?.kind === "f64"
      ? [{ op: "f64.const", value: 0 }, { op: "f64.ne" }]
      : []) satisfies Instr[]),
    ...((closureInfo.returnType?.kind === "i32" ? [] : [{ op: "i32.eqz" }, { op: "i32.eqz" }]) satisfies Instr[]),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: resTmp },
        { op: "br", depth: 2 }, // break out of block
      ],
    },
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  fctx.body.push({ op: "local.get", index: resTmp });
  return { kind: "i32" };
}

/**
 * Array.prototype.forEach.call(obj, callback)
 */
function compileArrayPrototypeForEach(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callExpr: ts.CallExpression,
  receiverArg: ts.Identifier,
  vecTypeIdx: number,
  arrTypeIdx: number,
  elemType: ValType,
): ValType | null {
  if (callExpr.arguments.length < 2) return null;
  const cbArg = callExpr.arguments[1]!;
  if (!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg)) return undefined as unknown as null;

  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return null;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return null;

  const closureTmp = allocLocal(fctx, `__apc_fe_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const vecTmp = allocLocal(fctx, `__apc_fe_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const dataTmp = allocLocal(fctx, `__apc_fe_data_${fctx.locals.length}`, { kind: "ref_null", typeIdx: arrTypeIdx });
  const iTmp = allocLocal(fctx, `__apc_fe_i_${fctx.locals.length}`, { kind: "i32" });
  const lenTmp = allocLocal(fctx, `__apc_fe_len_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, receiverArg);
  fctx.body.push({ op: "local.tee", index: vecTmp });
  emitReceiverNullGuard(ctx, fctx, vecTmp);
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenTmp });
  fctx.body.push({ op: "local.get", index: vecTmp });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataTmp });

  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  const getOp = elemType.kind === "i8" ? "array.get_u" : elemType.kind === "i16" ? "array.get_s" : "array.get";

  const numParams = closureInfo.paramTypes.length;

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: closureTmp },
    ...(numParams >= 1
      ? ([
          { op: "local.get", index: dataTmp },
          { op: "local.get", index: iTmp },
          { op: getOp, typeIdx: arrTypeIdx },
          ...coercionInstrs(ctx, elemType, closureInfo.paramTypes[0] ?? elemType, fctx),
        ] satisfies Instr[])
      : []),
    // Push index (2nd user param) if callback expects it
    ...(numParams >= 2
      ? ([
          { op: "local.get", index: iTmp },
          ...coercionInstrs(ctx, { kind: "i32" }, closureInfo.paramTypes[1] ?? { kind: "i32" }, fctx),
        ] satisfies Instr[])
      : []),
    // Push array (3rd user param) if callback expects it
    ...(numParams >= 3
      ? ([
          { op: "local.get", index: vecTmp },
          ...coercionInstrs(
            ctx,
            { kind: "ref_null", typeIdx: vecTypeIdx },
            closureInfo.paramTypes[2] ?? { kind: "ref_null", typeIdx: vecTypeIdx },
            fctx,
          ),
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
    ...guardedFuncRefCastInstrs(fctx, closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" },
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
    // Drop the result if there is one
    ...(closureInfo.returnType ? ([{ op: "drop" }] satisfies Instr[]) : []),
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  return VOID_RESULT as any;
}
